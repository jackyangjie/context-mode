import "./setup-home";
/**
 * V2 tests for the OpenCode plugin entry point (src/adapters/opencode/plugin-v2.ts).
 *
 * ContextModePluginV2.setup(ctx) registers every v2 hook/transform/subscription
 * through a mock domain context. We assert:
 *   - all expected registrations land (context, prompt, compaction,
 *     tool.execute.before, tool.execute.after, tool.transform, event.subscribe)
 *   - the native tool transform registers exactly the 11 ctx_* tools
 *   - each registered handler behaves like its V1 counterpart:
 *       execute.before blocks curl/wget and passes unrouted tools
 *       execute.after captures session events into the DB
 *       prompt captures user_prompt and filters synthetic tags
 *       compaction builds a resume snapshot after events are captured
 *       context injects the routing block + claims a resume snapshot
 *   - teardown() runs without throwing
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ContextModePluginV2 } from "../src/adapters/opencode/plugin-v2.js";
import { resolveSessionDbPath, SessionDB } from "../src/session/db.js";
import { OpenCodeAdapter } from "../src/adapters/opencode/index.js";

// MCP readiness sentinel — routing.mjs checks process.ppid in-process
// (same env as tests/opencode-plugin.test.ts).
const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);

beforeEach(() => {
  writeFileSync(mcpSentinel, String(process.pid));
});
afterEach(() => {
  try {
    unlinkSync(mcpSentinel);
  } catch {
    /* best effort */
  }
});

// ── Mock v2 context ────────────────────────────────────────
// Captures every registration so individual handlers can be invoked directly.
type HookHandler = (event: any) => void | Promise<void>;
type NativeToolDef = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<{ content: string }>;
};

interface CapturedCtx {
  hooks: Map<string, HookHandler>;
  nativeTools: NativeToolDef[];
  transformCalled: boolean;
  subscribeCalled: boolean;
  subscribeSignal?: AbortSignal;
  teardown?: () => void;
}

async function createV2Plugin(tempDir: string): Promise<CapturedCtx> {
  const captured: CapturedCtx = {
    hooks: new Map(),
    nativeTools: [],
    transformCalled: false,
    subscribeCalled: false,
  };

  const mockCtx: any = {
    app: { version: "test-v2" },
    location: { directory: tempDir, project: { id: "p", canonical: tempDir } },
    options: {},
    session: {
      async hook(name: string, handler: HookHandler) {
        captured.hooks.set(`session:${name}`, handler);
        return { dispose: async () => {} };
      },
    },
    tool: {
      async hook(name: string, handler: HookHandler) {
        captured.hooks.set(`tool:${name}`, handler);
        return { dispose: async () => {} };
      },
      async transform(editor: (editor: any) => void) {
        captured.transformCalled = true;
        editor({
          add: (def: NativeToolDef) => {
            captured.nativeTools.push(def);
          },
        });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe(input?: { signal?: AbortSignal }) {
        captured.subscribeCalled = true;
        captured.subscribeSignal = input?.signal;
        // Empty async iterator — the real stream is exercised end-to-end
        // against the opencode binary, not here.
        return (async function* () {
          /* no events */
        })();
      },
    },
  };

  captured.teardown = await ContextModePluginV2.setup(mockCtx);
  return captured;
}

function dbFor(projectDir: string): SessionDB {
  const adapter = new OpenCodeAdapter("opencode");
  return new SessionDB({
    dbPath: resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() }),
  });
}

describe("ContextModePluginV2 (opencode v2 setup)", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "opencode-v2-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ── Registration surface ───────────────────────────────

  describe("setup registrations", () => {
    it("registers all expected v2 hooks/transforms/subscriptions", async () => {
      const captured = await createV2Plugin(join(tempDir, "regs"));
      expect(captured.hooks.has("session:context")).toBe(true);
      expect(captured.hooks.has("session:prompt")).toBe(true);
      expect(captured.hooks.has("session:compaction")).toBe(true);
      expect(captured.hooks.has("tool:execute.before")).toBe(true);
      expect(captured.hooks.has("tool:execute.after")).toBe(true);
      expect(captured.transformCalled).toBe(true);
      expect(captured.subscribeCalled).toBe(true);
    });

    it("registers exactly the 11 ctx_* native tools via ctx.tool.transform", async () => {
      const captured = await createV2Plugin(join(tempDir, "native-tools"));
      expect(captured.nativeTools.map((t) => t.name).sort()).toEqual([
        "ctx_batch_execute",
        "ctx_doctor",
        "ctx_execute",
        "ctx_execute_file",
        "ctx_fetch_and_index",
        "ctx_index",
        "ctx_insight",
        "ctx_purge",
        "ctx_search",
        "ctx_stats",
        "ctx_upgrade",
      ]);
    });

    it("passes an AbortSignal to ctx.event.subscribe", async () => {
      const captured = await createV2Plugin(join(tempDir, "signal"));
      expect(captured.subscribeSignal).toBeInstanceOf(AbortSignal);
    });

    it("teardown() runs without throwing", async () => {
      const captured = await createV2Plugin(join(tempDir, "teardown"));
      expect(() => captured.teardown?.()).not.toThrow();
    });
  });

  // ── tool.execute.before: routing enforcement ──────────
  // curl/wget handling is gated on the live MCP sentinel
  // (hooks/core/mcp-ready.mjs): when no live sentinel exists, routing
  // degrades to passthrough so the agent is not stuck when ctx_* tools
  // are unavailable. The V1 test's beforeEach sentinel therefore applies.

  describe("tool:execute.before", () => {
    it("redirects curl to a sandboxed fetch when the MCP sentinel is live", async () => {
      const captured = await createV2Plugin(join(tempDir, "before-curl"));
      const handler = captured.hooks.get("tool:execute.before")!;
      const event = { tool: "Bash", input: { command: "curl https://example.com/data" } };
      await handler(event);
      // Routing rewrites the command to an echo explaining the redirect.
      expect(event.input.command).toMatch(/^echo /);
      expect(event.input.command).toContain("context-mode");
    });

    it("redirects wget to a sandboxed fetch", async () => {
      const captured = await createV2Plugin(join(tempDir, "before-wget"));
      const handler = captured.hooks.get("tool:execute.before")!;
      const event = { tool: "Bash", input: { command: "wget https://example.com/file" } };
      await handler(event);
      expect(event.input.command).toMatch(/^echo /);
      expect(event.input.command).toContain("context-mode");
    });

    it("passes through unrouted tools without throwing", async () => {
      const captured = await createV2Plugin(join(tempDir, "before-pass"));
      const handler = captured.hooks.get("tool:execute.before")!;
      await expect(
        handler({ tool: "TaskCreate", input: { subject: "test" } }),
      ).resolves.toBeUndefined();
    });

    it("is a no-op on an empty event", async () => {
      const captured = await createV2Plugin(join(tempDir, "before-empty"));
      const handler = captured.hooks.get("tool:execute.before")!;
      await expect(handler({})).resolves.toBeUndefined();
    });
  });

  // ── tool.execute.after: session capture ───────────────

  describe("tool:execute.after", () => {
    it("captures file read events without throwing", async () => {
      const projectDir = join(tempDir, "after-read");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("tool:execute.after")!;
      await expect(
        handler({
          tool: "Read",
          sessionID: "v2-sess",
          input: { file_path: "/test/file.ts" },
          output: { title: "Read", output: "file contents here" },
        }),
      ).resolves.toBeUndefined();

      const db = dbFor(projectDir);
      const events = db.getEvents("v2-sess") as any[];
      db.close();
      expect(events.length).toBeGreaterThan(0);
    });

    it("captures git events from Bash output string", async () => {
      const projectDir = join(tempDir, "after-git");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("tool:execute.after")!;
      await expect(
        handler({
          tool: "Bash",
          sessionID: "v2-git",
          input: { command: "git commit -m 'test'" },
          output: "[main abc1234] test",
        }),
      ).resolves.toBeUndefined();

      const db = dbFor(projectDir);
      const events = db.getEvents("v2-git") as any[];
      db.close();
      expect(events.length).toBeGreaterThan(0);
    });

    it("handles empty input gracefully", async () => {
      const captured = await createV2Plugin(join(tempDir, "after-empty"));
      const handler = captured.hooks.get("tool:execute.after")!;
      await expect(handler({})).resolves.toBeUndefined();
    });
  });

  // ── session:prompt: user-prompt capture ────────────────

  describe("session:prompt", () => {
    it("captures user prompt as user_prompt event", async () => {
      const projectDir = join(tempDir, "prompt-capture");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("session:prompt")!;
      const msg = "switch to mission mode and prefer the elegant solution";
      await handler({
        sessionID: "v2-prompt",
        parts: [{ type: "text", text: msg }],
      });

      const db = dbFor(projectDir);
      const events = db.getEvents("v2-prompt") as any[];
      db.close();
      const userPrompt = events.find((e: any) => e.type === "user_prompt");
      expect(userPrompt).toBeDefined();
      expect(userPrompt.data).toContain("mission mode");
    });

    it("reads parts nested under event.message.parts (v2 variant)", async () => {
      const projectDir = join(tempDir, "prompt-nested");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("session:prompt")!;
      await handler({
        sessionID: "v2-nested",
        message: { parts: [{ type: "text", text: "hello nested" }] },
      });
      const db = dbFor(projectDir);
      const events = db.getEvents("v2-nested") as any[];
      db.close();
      expect(events.find((e: any) => e.type === "user_prompt")?.data).toContain("hello nested");
    });

    it("filters synthetic system tags", async () => {
      const projectDir = join(tempDir, "prompt-filter");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("session:prompt")!;
      await handler({
        sessionID: "v2-synth",
        parts: [{ type: "text", text: "<system-reminder>internal nudge</system-reminder>" }],
      });
      const db = dbFor(projectDir);
      const events = db.getEvents("v2-synth") as any[];
      db.close();
      expect(events.find((e: any) => e.type === "user_prompt")).toBeUndefined();
    });

    it("handles missing/empty parts gracefully", async () => {
      const captured = await createV2Plugin(join(tempDir, "prompt-empty"));
      const handler = captured.hooks.get("session:prompt")!;
      await expect(handler({ sessionID: "v2-empty" })).resolves.toBeUndefined();
    });
  });

  // ── session:compaction: snapshot generation ───────────

  describe("session:compaction", () => {
    it("pushes a resume snapshot onto event.context after events are captured", async () => {
      const projectDir = join(tempDir, "compact-snap");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);

      // Seed events via the execute.after handler (same DB).
      const after = captured.hooks.get("tool:execute.after")!;
      await after({
        tool: "Read",
        sessionID: "v2-compact",
        input: { file_path: "/src/index.ts" },
        output: { output: "export default {}" },
      });
      await after({
        tool: "Edit",
        sessionID: "v2-compact",
        input: { file_path: "/src/index.ts", old_string: "{}", new_string: "{ foo: 1 }" },
        output: { output: "" },
      });

      const event = { sessionID: "v2-compact", context: [] as string[] };
      const compaction = captured.hooks.get("session:compaction")!;
      await compaction(event);

      expect(event.context.length).toBeGreaterThan(0);
      const snapshot = event.context.find((c) => c.includes("session_resume"));
      expect(snapshot).toBeDefined();
      expect(snapshot).toContain("index.ts");
    });

    it("is a no-op when no events were captured", async () => {
      const projectDir = join(tempDir, "compact-empty");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const event = { sessionID: "v2-empty-compact", context: [] as string[] };
      const compaction = captured.hooks.get("session:compaction")!;
      await compaction(event);
      expect(event.context.length).toBe(0);
    });
  });

  // ── session:context: routing block + resume snapshot ──

  describe("session:context", () => {
    it("injects the routing block preserving system[0] header", async () => {
      const projectDir = join(tempDir, "ctx-routing");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("session:context")!;
      const system = [{ type: "text", text: "HEADER" }];
      await handler({ sessionId: "v2-ctx-fresh", system });
      expect(system[0].text).toBe("HEADER");
      expect(system.length).toBe(2);
      expect(system[1].text).toContain("<context_window_protection>");
    });

    it("claims a previously-recorded resume snapshot into system", async () => {
      const projectDir = join(tempDir, "ctx-resume");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);

      // Seed + compact in a prior session.
      const after = captured.hooks.get("tool:execute.after")!;
      await after({
        tool: "Read",
        sessionID: "v2-donor",
        input: { file_path: "/a.ts" },
        output: { output: "content" },
      });
      await captured.hooks.get("session:compaction")!({
        sessionID: "v2-donor",
        context: [] as string[],
      });

      // New session enters via context hook.
      const system = [{ type: "text", text: "HEADER" }];
      await captured.hooks.get("session:context")!({ sessionId: "v2-consumer", system });
      expect(system[0].text).toBe("HEADER");
      expect(system.some((s) => s.text.includes("session_resume"))).toBe(true);
      expect(system.some((s) => s.text.includes("<context_window_protection>"))).toBe(true);
    });

    it("does NOT re-inject the same session's own snapshot (self-injection guard)", async () => {
      const projectDir = join(tempDir, "ctx-self");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);

      const after = captured.hooks.get("tool:execute.after")!;
      await after({
        tool: "Read",
        sessionID: "B",
        input: { file_path: "/p.ts" },
        output: { output: "p" },
      });
      await captured.hooks.get("session:compaction")!({
        sessionID: "B",
        context: [] as string[],
      });

      // B's next context hook must NOT claim B's own row.
      const system = [{ type: "text", text: "HEADER" }];
      await captured.hooks.get("session:context")!({ sessionId: "B", system });
      expect(system.some((s) => s.text.includes("session_resume"))).toBe(false);
      // Routing block still injects (session-agnostic, OC-1 contract).
      expect(system.some((s) => s.text.includes("<context_window_protection>"))).toBe(true);
    });

    it("skips routing block when system already carries context-mode markers", async () => {
      const projectDir = join(tempDir, "ctx-dedup");
      mkdirSync(projectDir, { recursive: true });
      const captured = await createV2Plugin(projectDir);
      const handler = captured.hooks.get("session:context")!;
      const agentsContent = [
        "# context-mode rules",
        "<context_window_protection> applies to this project.",
        "Use ctx_search for memory recall.",
        "Use ctx_index to store new content.",
      ].join("\n");
      const system = [{ type: "text", text: "HEADER" }, { type: "text", text: agentsContent }];
      await handler({ sessionId: "v2-dedup", system });
      // Length unchanged — no new routing block spliced (quorum met).
      expect(system.length).toBe(2);
    });

    it("is a no-op when sessionID is missing", async () => {
      const captured = await createV2Plugin(join(tempDir, "ctx-nosid"));
      const handler = captured.hooks.get("session:context")!;
      const system = [{ type: "text", text: "HEADER" }];
      await handler({ system });
      expect(system.length).toBe(1);
    });
  });
});
