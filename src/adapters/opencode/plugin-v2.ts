/**
 * OpenCode v2 plugin entry point for context-mode.
 *
 * Dual-stack design:
 *   - `plugin.ts` (V1): exports `createContextModePlugin(ctx: PluginContext)`
 *     that returns the Hooks map. This is the shape KiloCode and OpenCode
 *     ≥ 1.18.29 expect (`PluginModule = { server: Plugin }`).
 *   - `plugin-v2.ts` (this file): exposes `ContextModePluginV2` as a flat
 *     object literal `{ id, setup }` so the default export in `plugin.ts`
 *     can spread it alongside `server`. The v2 loader accepts `{ id, setup }`
 *     and calls `setup(ctx)` at runtime (verified locally against opencode
 *     v2.0.27 — see SDK-typings note below).
 *
 * This file is the FEATURE-COMPLETE v2 port: every V1 hook in `plugin.ts` is
 * mirrored here through the v2 domain API, following the official migration
 * table at https://opencode.ai/v2/docs/build/plugins/migrate-v1 :
 *
 *   V1 hook                                   → v2 registration
 *   ────────────────────────────────────────────────────────────────
 *   tool map                                  → ctx.tool.transform(editor.add)
 *   tool.execute.before                       → ctx.tool.hook("execute.before")
 *   tool.execute.after                        → ctx.tool.hook("execute.after")
 *   event (message.updated usage)             → ctx.event.subscribe({ signal })
 *   chat.message (user-prompt capture)        → ctx.session.hook("prompt")
 *   experimental.session.compacting           → ctx.session.hook("compaction")
 *   experimental.chat.system.transform        → ctx.session.hook("context")
 *
 * Key v2 difference: each callback receives ONE mutable `event` (not separate
 * input/output objects), and `event.system` is an array of `{ type:"text",
 * text }` objects rather than a plain `string[]`.
 *
 * ⚠ SDK-TYPINGS MISMATCH — DO NOT TRUST @opencode-ai/plugin D.TS VERBATIM:
 *
 * The installed @opencode-ai/plugin@1.17.3 .d.ts exports
 * `Plugin = (input, options?) => Promise<Hooks>` and does NOT declare
 * `ctx.session.hook`, `ctx.tool.hook`, `ctx.tool.transform`, or
 * `ctx.event.subscribe`. Yet the opencode v2.0.27 runtime loader (compiled
 * into the Bun binary at ~/.opencode/bin/opencode) accepts our `{ id, setup }`
 * shape and invokes `setup(ctx)` with the full domain context. Confirmed by:
 *   - opencode log line `loading plugin id=...context-mode.js entrypoint=...`
 *   - SessionDB side-effect: `~/.config/opencode/context-mode/sessions/
 *     964855ecf81d4ad8.db` created at the expected timestamp.
 *   - `ctx.session.hook("context", ...)` firing per model request.
 *
 * The runtime loader is a superset of the SDK typings. We use loose local
 * structural types (V2PluginContext + per-hook event types) so the file
 * typechecks without a hard `@opencode/plugin` dependency, which would break
 * the V1 load path for users who haven't pulled in the v2 SDK.
 *
 * DEFENSIVE POSTURE: the v2 event field names for execute.after / prompt /
 * compaction are not exhaustively documented; every hook body reads fields
 * with optional chaining and wraps its work in try/catch so a wrong field
 * name degrades to a silent no-op — matching V1's "never break the chat
 * turn" rule. The already-verified `context` hook (routing block + resume
 * snapshot) is unchanged.
 *
 * Reference:
 *   - https://opencode.ai/v2/docs/build/plugins/migrate-v1 (hook mapping table)
 *   - https://opencode.ai/v2/docs/build/plugins (ctx domain reference)
 *   - verified against local install ~/.opencode/bin/opencode (v2.0.27).
 */

import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import {
  extractEvents,
  extractUserEvents,
  parseOpencodeUsage,
  buildAgentUsageEvent,
} from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import { buildResumeSnapshot } from "../../session/snapshot.js";
import type { SessionEvent } from "../../types.js";
import { OpenCodeAdapter } from "./index.js";
import type { AdapterPlatformType } from "./index.js";
import { PLATFORM_ENV_VARS } from "../detect.js";
import { zod3ShapeToV4 } from "./zod3tov4.js";
import { systemHasRoutingInstructionsV2 as systemHasRoutingInstructions } from "./routing-utils.js";

// ── V2 context / event types (loose — @opencode/plugin types not installed) ──
// Narrow structural types covering only the fields each hook consumes.
// Field names mirror the v1 hook payloads (v2 merges input+output into one
// mutable event) plus the shapes documented in the migrate-v1 guide.

type V2SystemTextEntry = { type: "text"; text: string };

type V2SessionHookEvent = {
  sessionId?: string;
  sessionID?: string;
  /** v2 native shape: array of `{ type: "text", text }` objects. */
  system?: V2SystemTextEntry[];
};

type V2SessionHookHandler = (event: V2SessionHookEvent) => void | Promise<void>;

type V2SessionDomain = {
  hook(
    name: "context" | "prompt" | "compaction" | "generate" | "title",
    handler: V2SessionHookHandler,
  ): Promise<{ dispose(): Promise<void> }>;
};

/** v2 prompt-hook event — surrogate for v1 chat.message output. */
type V2PromptEvent = {
  sessionId?: string;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  /** v1 carried parts on the output object; v2 may carry them on the event. */
  parts?: Array<{ type?: string; text?: string }>;
  message?: { parts?: Array<{ type?: string; text?: string }> };
};

/** v2 compaction-hook event — surrogate for v1 experimental.session.compacting output. */
type V2CompactionEvent = {
  sessionId?: string;
  sessionID?: string;
  context?: string[];
  prompt?: string;
};

type V2ToolHookEvent = {
  tool?: string;
  sessionID?: string;
  sessionId?: string;
  callID?: string;
  callId?: string;
  /** v2 merges the v1 `output.args` into `input`. */
  input?: Record<string, unknown>;
  /** v2 execute.after carries the tool result (string or ToolResult-ish). */
  output?: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
};

type V2ToolHookHandler = (event: V2ToolHookEvent) => void | Promise<void>;

type V2ToolDomain = {
  hook(name: "execute.before" | "execute.after", handler: V2ToolHookHandler): Promise<{ dispose(): Promise<void> }>;
  transform(editor: (editor: V2ToolEditor) => void): Promise<{ dispose(): Promise<void> }>;
};

type V2ToolEditor = {
  add?(def: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<{ content: string }>;
  }): void;
};

type V2EventStream = {
  subscribe(input?: { signal?: AbortSignal }): AsyncIterable<{ type?: string; properties?: Record<string, unknown> }>;
};

type V2PluginContext = {
  app?: { version?: string };
  location: { directory: string; project?: { id?: string; canonical?: string } };
  options?: Record<string, unknown>;
  session: V2SessionDomain;
  tool?: V2ToolDomain;
  event?: V2EventStream;
  // Present in the full v2 spec; not consumed by this plugin:
  //   permission, shell, agent, command, integration, mcp, reference,
  //   skill, vcs, websearch, worktree, storage, model, provider.
};

// Synthetic message tags emitted by harnesses (CCv2 inline filter). When the
// user "message" is actually a system-generated nudge (e.g. tool-result,
// system reminder), capturing it as user_prompt would flood the DB with noise.
const SYNTHETIC_MESSAGE_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<context_guidance>",
  "<tool-result>",
];

function isSyntheticMessage(text: string): boolean {
  const trimmed = text.trim();
  return SYNTHETIC_MESSAGE_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ── Platform resolution ────────────────────────────────────
// Same logic as V1's `getPlatform()` in plugin.ts, inlined here to avoid a
// runtime dependency cycle on the v1 plugin body. `PLATFORM_ENV_VARS` lists
// `kilo` BEFORE `opencode`, so KILO_PID wins the iteration — required because
// KiloCode sets `OPENCODE=1` in addition to its own `KILO_PID` (PR #376).
function resolvePlatform(): AdapterPlatformType {
  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (platform !== "kilo" && platform !== "opencode") continue;
    if (vars.some((v) => process.env[v.name])) {
      return platform as AdapterPlatformType;
    }
  }
  return "opencode";
}

// ── ROUTING_BLOCK loader ───────────────────────────────────
// ROUTING_BLOCK is a plain string built from `hooks/routing-block.mjs` via
// `createRoutingBlock(toolNamer)`. Loaded lazily through the same dynamic-
// import path `plugin.ts` uses, per-platform (tool names differ between
// opencode and kilo via hooks/core/tool-naming.mjs).
let cachedRoutingBlockByPlatform = new Map<string, string>();

async function loadRoutingBlock(platform: AdapterPlatformType): Promise<string> {
  const cached = cachedRoutingBlockByPlatform.get(platform);
  if (cached !== undefined) return cached;
  let result = "";
  try {
    // Anchor the hooks/ dir relative to this module and probe candidate
    // roots (this file lives at a different depth depending on layout):
    //   - source (src/adapters/opencode/plugin-v2.ts under tsx/vitest) → 3 up
    //   - repo-root bundle (plugin.bundle.mjs)                        → 0 up
    //   - opencode install dir (e.g. ~/.config/opencode/plugins/)     → varies
    // Probe depths 0..5 up from this module's directory and use the first
    // root where both hooks files exist, so the loader is layout-agnostic.
    const here = dirname(fileURLToPath(import.meta.url));
    const { existsSync } = await import("node:fs");
    const candidateRoots: string[] = [];
    for (const up of ["", "..", "../..", "../../..", "../../../..", "../../../../.."]) {
      candidateRoots.push(up === "" ? here : resolve(here, up));
    }
    let routingBlockMod: any;
    let toolNamingMod: any;
    for (const layout of candidateRoots) {
      const routingBlockPath = resolve(layout, "hooks/routing-block.mjs");
      const toolNamingPath = resolve(layout, "hooks/core/tool-naming.mjs");
      if (!existsSync(routingBlockPath) || !existsSync(toolNamingPath)) continue;
      [routingBlockMod, toolNamingMod] = await Promise.all([
        import(pathToFileURL(routingBlockPath).toString()),
        import(pathToFileURL(toolNamingPath).toString()),
      ]);
      break;
    }
    const toolNamer = (toolNamingMod as any)?.createToolNamer?.(platform);
    if (typeof (routingBlockMod as any).createRoutingBlock === "function" && typeof toolNamer === "function") {
      const built = (routingBlockMod as any).createRoutingBlock(toolNamer);
      if (typeof built === "string") result = built;
    } else if (typeof (routingBlockMod as any)?.ROUTING_BLOCK === "string") {
      // Static fallback is claude-code naming; acceptable degradation.
      result = (routingBlockMod as any).ROUTING_BLOCK;
    }
  } catch {
    // Silent — caller proceeds without a routing block (matches V1).
  }
  cachedRoutingBlockByPlatform.set(platform, result);
  return result;
}

// ── V2 definition ──────────────────────────────────────────
// Matches the shape returned by `Plugin.define({ id, setup })`. Built as an
// object literal so the distribution does not require `@opencode/plugin` at
// runtime (V1 users may not have it installed). Shape-compatible: the v2
// loader decodes `{ id, setup }` and calls `setup(ctx)`.
export const ContextModePluginV2 = {
  id: "context-mode",

  async setup(ctx: V2PluginContext): Promise<() => void> {
    const dbg = (msg: string) => {
      if (process.env.OPENCODE_DEBUG) console.log(`[context-mode:opencode-v2] ${msg}`);
    };

    dbg(`loaded in OpenCode ${ctx?.app?.version ?? "?"} at ${ctx?.location?.directory ?? "?"}`);

    const platform = resolvePlatform();
    const projectDir = ctx?.location?.directory ?? process.cwd();

    // ── Load hook helpers once, up front (async I/O belongs in setup, NOT
    //    inside the synchronous transform/hook callbacks — migrate-v1:
    //    "Load external data before registration, capture it in the callback").
    //
    // Layout-agnostic module lookup: this file lives at a different depth
    // depending on build mode — source (src/adapters/opencode/plugin-v2.ts,
    // 3 levels above hooks/) vs repo-root bundle (1 level above hooks/) vs
    // opencode's install dir (arbitrary). Probe a range of candidate roots
    // from this module's directory and use the first where the module
    // exists, so the loader is layout-agnostic.
    const here = dirname(fileURLToPath(import.meta.url));
    const { existsSync } = await import("node:fs");
    const candidateRoots: string[] = [here];
    for (const up of ["..", "../..", "../../..", "../../../..", "../../../../..", "../../../../../.."]) {
      candidateRoots.push(resolve(here, up));
    }
    const findModule = async (relative: string): Promise<{ default?: unknown } & Record<string, unknown>> => {
      for (const root of candidateRoots) {
        const p = resolve(root, relative);
        if (existsSync(p)) return import(pathToFileURL(p).toString());
      }
      throw new Error(`module ${relative} not found from ${here}`);
    };
    // buildRoot is what initSecurity looks at for a fallback security.js;
    // it's only used when the bundle path is missing, so the first root
    // that has hooks/ is a fine default.
    const buildRoot = candidateRoots.find((r) => existsSync(resolve(r, "hooks")) ?? false) ?? candidateRoots[0];

    let routing: any = null;
    let autoInjectionMod: any = null;
    try {
      routing = await findModule("hooks/core/routing.mjs");
      await (routing as { initSecurity?: (d: string) => Promise<unknown> }).initSecurity?.(buildRoot);
    } catch {
      dbg(`routing init failed — enforcement degrades to passthrough`);
      routing = null;
    }
    try {
      autoInjectionMod = await findModule("hooks/auto-injection.mjs");
    } catch {
      autoInjectionMod = null;
    }

    const routingBlock = await loadRoutingBlock(platform);

    // ── Per-project SessionDB (mirrors V1 exactly: same path resolution,
    //    same 7-day cleanup, single writer per process — PR #376).
    const adapter = new OpenCodeAdapter(platform);
    let db: SessionDB | undefined;
    try {
      db = new SessionDB({
        dbPath: resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() }),
      });
      db.cleanupOldSessions(7);
    } catch (err) {
      dbg(`SessionDB init failed: ${(err as Error).message}`);
      db = undefined;
    }

    // OC-4 (#487 follow-up): per-session AGENTS.md capture gate. Idempotent
    // per sessionId so multi-session reuse within a long-lived plugin process
    // still captures exactly once per session. Mirrors V1's captureAgentsMd.
    const agentsMdCaptured = new Set<string>();
    function captureAgentsMd(sessionId: string): void {
      if (!db || agentsMdCaptured.has(sessionId)) return;
      agentsMdCaptured.add(sessionId);
      const candidates = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];
      for (const name of candidates) {
        try {
          const p = join(projectDir, name);
          if (!existsSync(p)) continue;
          const content = readFileSync(p, "utf-8");
          if (!content.trim()) continue;
          db.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1 } as SessionEvent, "PluginInit");
          db.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1 } as SessionEvent, "PluginInit");
        } catch {
          // file missing or unreadable — skip silently
        }
      }
    }

    // ── Native tool registration (v2: ctx.tool.transform) ──────
    // v1 returned a `tool` map built from server.REGISTERED_CTX_TOOLS; v2
    // registers the same definitions through a synchronous transform editor.
    // Tool schemas reuse the zod-v4 shape conversion (zod3ShapeToV4) that v1
    // uses — the opencode host bundles zod v4 and consumes the shape the same
    // way. execute() returns v2's { content } envelope.
    async function buildV2NativeTools(): Promise<
      Array<{ name: string; description: string; input: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<{ content: string }> }>
    > {
      const prevEmbedded = process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
      process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
      let mod: typeof import("../../server.js");
      try {
        mod = await import("../../server.js");
      } finally {
        if (prevEmbedded === undefined) delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
        else process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = prevEmbedded;
      }
      const out: Array<{ name: string; description: string; input: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<{ content: string }> }> = [];
      for (const registered of mod.REGISTERED_CTX_TOOLS) {
        const config = registered.config as Record<string, unknown>;
        const inputSchema = config.inputSchema as
          | { shape?: unknown; _def?: { shape?: unknown }; parse?: (input: unknown) => unknown }
          | undefined;
        const shape =
          typeof inputSchema?.shape === "object" && inputSchema.shape !== null
            ? inputSchema.shape
            : typeof inputSchema?._def?.shape === "function"
              ? (inputSchema._def.shape as () => unknown)()
              : {};
        const argsForHost = zod3ShapeToV4(shape as Record<string, unknown>);
        out.push({
          name: registered.name,
          description: String(config.description ?? ""),
          input: argsForHost as Record<string, unknown>,
          async execute(args) {
            // Run the zod schema BEFORE the handler (same contract as MCP SDK
            // safeParseAsync / v1 buildNativeTools) so z.preprocess coercions
            // and .default() values fire (#621).
            let parsedArgs: Record<string, unknown> = args ?? {};
            if (typeof inputSchema?.parse === "function") {
              try {
                parsedArgs = inputSchema.parse(args ?? {}) as Record<string, unknown>;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`Invalid arguments for ${registered.name}: ${message}`);
              }
            }
            const result = await mod.withProjectDirOverride(
              { projectDir, sessionId: undefined },
              async () => registered.handler(parsedArgs),
            );
            const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
            const text = Array.isArray(r?.content)
              ? r.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n")
              : typeof result === "string"
                ? result
                : JSON.stringify(result ?? "");
            if (r?.isError) throw new Error(text || `${registered.name} returned an error`);
            return { content: text };
          },
        });
      }
      return out;
    }

    // Register native tools defensively — a schema/registration failure must
    // never break the rest of setup (users fall back to MCP stdio).
    if (ctx.tool?.transform) {
      try {
        const nativeTools = await buildV2NativeTools();
        await ctx.tool.transform((editor: V2ToolEditor) => {
          for (const t of nativeTools) {
            try {
              editor.add?.(t);
            } catch {
              // Skip a single tool whose schema the editor rejects.
            }
          }
        });
        dbg(`registered ${nativeTools.length} native ctx_* tools via ctx.tool.transform`);
      } catch (err) {
        dbg(`native tool registration failed: ${(err as Error).message}`);
      }
    }

    // ── tool.execute.before: routing enforcement (v1 OC routing) ────
    if (ctx.tool?.hook) {
      try {
        await ctx.tool.hook("execute.before", async (event) => {
          const toolName = event?.tool ?? "";
          const toolInput = (event?.input ?? {}) as Record<string, unknown>;
          if (!toolName || !routing) return;
          let decision: any;
          try {
            decision = routing.routePreToolUse(toolName, toolInput, projectDir, platform);
          } catch {
            return; // routing failure → passthrough
          }
          if (!decision) return;
          if (decision.action === "deny" || decision.action === "ask") {
            throw new Error(decision.reason ?? "Blocked by context-mode");
          }
          if (decision.action === "modify" && decision.updatedInput && event.input) {
            Object.assign(event.input, decision.updatedInput);
          }
          if (decision.action === "context" && decision.additionalContext && event.input) {
            event.input.additionalContext = decision.additionalContext;
          }
        });
      } catch (err) {
        dbg(`tool.execute.before registration failed: ${(err as Error).message}`);
      }
    }

    // ── tool.execute.after: session event capture + AGENTS.md scan ──
    if (ctx.tool?.hook) {
      try {
        await ctx.tool.hook("execute.after", async (event) => {
          const sessionId = event?.sessionID ?? event?.sessionId;
          if (!sessionId || !db) return;
          try {
            db.ensureSession(sessionId, projectDir);
            captureAgentsMd(sessionId);
            // v2 merges v1 output.output into event.output (string or obj).
            const out = event?.output;
            const toolResponse: string =
              typeof out === "string" ? out : typeof (out as any)?.output === "string" ? (out as any).output : "";
            const hookInput: HookInput = {
              tool_name: event?.tool ?? "",
              tool_input: (event?.input ?? {}) as Record<string, unknown>,
              tool_response: toolResponse,
              tool_output: undefined,
            };
            const events = extractEvents(hookInput);
            for (const ev of events) {
              db.insertEvent(sessionId, ev as SessionEvent, "PostToolUse");
            }
          } catch {
            // Silent — session capture must never break the tool call
          }
        });
      } catch (err) {
        dbg(`tool.execute.after registration failed: ${(err as Error).message}`);
      }
    }

    // ── event.subscribe: per-turn token + cost capture ────────────
    // v1's `event` hook → v2's async event subscription. We filter
    // message.updated (published on each assistant-message update) and read
    // tokens/cost/modelID off properties.info, same parseOpencodeUsage path.
    const controller = new AbortController();
    const eventSubscribe = ctx.event?.subscribe?.bind(ctx.event);
    if (eventSubscribe) {
      try {
        void (async () => {
          for await (const ev of eventSubscribe({ signal: controller.signal })) {
            try {
              if (!ev || ev.type !== "message.updated") continue;
              const sessionId = (ev.properties?.info as { sessionID?: string })?.sessionID;
              if (!sessionId || typeof sessionId !== "string" || !db) continue;
              const counts = parseOpencodeUsage(ev);
              if (!counts) continue;
              const usageEvent = buildAgentUsageEvent(counts);
              if (!usageEvent) continue;
              db.ensureSession(sessionId, projectDir);
              db.insertEvent(sessionId, usageEvent, "MessageUpdated");
            } catch {
              // Silent — usage capture must never break the session
            }
          }
        })();
      } catch (err) {
        dbg(`event.subscribe failed: ${(err as Error).message}`);
      }
    }

    // ── ctx.session.hook("prompt"): user-prompt capture (v1 chat.message) ──
    try {
      await ctx.session.hook("prompt", async (event: V2PromptEvent) => {
        const sessionId = event?.sessionID ?? event?.sessionId;
        if (!sessionId || !db) return;
        try {
          // v1 read parts from the output object; v2 may attach them to the
          // event directly or nest under event.message.parts.
          const parts = event?.parts ?? event?.message?.parts;
          const arr = Array.isArray(parts) ? parts : [];
          const textPart = arr.find(
            (p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0,
          );
          if (!textPart || !textPart.text) return;
          const message = textPart.text;
          if (isSyntheticMessage(message)) return;

          db.ensureSession(sessionId, projectDir);
          captureAgentsMd(sessionId);
          db.insertEvent(sessionId, {
            type: "user_prompt",
            category: "user-prompt",
            data: message,
            priority: 1,
          } as SessionEvent, "UserPromptSubmit");
          const userEvents = extractUserEvents(message);
          for (const ev of userEvents) {
            db.insertEvent(sessionId, ev as SessionEvent, "UserPromptSubmit");
          }
        } catch {
          // Silent — prompt hook must never break the turn
        }
      });
    } catch (err) {
      dbg(`session.hook("prompt") registration failed: ${(err as Error).message}`);
    }

    // ── ctx.session.hook("compaction"): snapshot + auto-injection ──────
    // v1 experimental.session.compacting → v2 compaction hook. v2 carries
    // the output `context: string[]` on the event itself.
    try {
      await ctx.session.hook("compaction", async (event: V2CompactionEvent) => {
        const sessionId = event?.sessionID ?? event?.sessionId;
        if (!sessionId || !db) return;
        try {
          db.ensureSession(sessionId, projectDir);
          const events = db.getEvents(sessionId);
          if (events.length === 0) return;
          const stats = db.getSessionStats(sessionId);
          const snapshot = buildResumeSnapshot(events, { compactCount: (stats?.compact_count ?? 0) + 1 });
          db.upsertResume(sessionId, snapshot, events.length);
          db.incrementCompactCount(sessionId);
          if (Array.isArray(event?.context)) {
            event.context.push(snapshot);
            try {
              const autoBlock: string = autoInjectionMod?.buildAutoInjection?.(events) ?? "";
              if (autoBlock && autoBlock.length > 0) event.context.push(autoBlock);
            } catch {
              // Auto-injection failure must NOT break the snapshot path.
            }
          }
          dbg(`compaction snapshot built for ${sessionId}`);
        } catch {
          // Silent — never break the compaction flow
        }
      });
    } catch (err) {
      dbg(`session.hook("compaction") registration failed: ${(err as Error).message}`);
    }

    // ── ctx.session.hook("context"): ROUTING_BLOCK + resume snapshot ──
    // (unchanged from the verified skeleton — the one v2 hook confirmed
    // against opencode v2.0.27 at runtime.) Registered last so the ordering
    // matches the v1 Hooks map (system.transform is the final entry).
    await ctx.session.hook("context", async (event) => {
      const sessionId = event?.sessionId ?? event?.sessionID;
      if (!sessionId || !Array.isArray(event.system)) return;

      const system = event.system;

      // Step 1 — ROUTING_BLOCK injection (mirrors v1 plugin.ts OC-1).
      // Dedup by a quorum of ROUTING_MARKERS so we don't duplicate when the
      // host already injected rules via AGENTS.md or a prior turn.
      if (!systemHasRoutingInstructions(system) && routingBlock) {
        system.splice(1, 0, { type: "text" as const, text: routingBlock });
        dbg(`routing block injected for session ${sessionId}`);
      } else if (process.env.OPENCODE_DEBUG) {
        dbg(`routing block skipped for ${sessionId} (already present)`);
      }

      // Step 2 — resume snapshot claim (mirrors v1 plugin.ts OC-3).
      // Atomic claim (UPDATE ... WHERE consumed_at IS NULL ORDER BY
      // created_at DESC LIMIT 1); sessionId excludes self-injection (#376).
      if (db) {
        try {
          const row = db.claimLatestUnconsumedResume(sessionId);
          if (row?.snapshot) {
            system.splice(1, 0, { type: "text" as const, text: row.snapshot });
            dbg(`resume snapshot claimed from session ${row.sessionId} into ${sessionId}`);
          }
        } catch (err) {
          dbg(`resume claim failed: ${(err as Error).message}`);
        }
      }
    });

    // Cleanup: called by the v2 loader on plugin unload. Hook/transform
    // registrations are scoped to the plugin and dispose automatically; the
    // AbortController tears down the event subscription we started.
    return () => {
      controller.abort();
      dbg("unloaded");
    };
  },
};
