/**
 * OpenCode v2 plugin entry point for context-mode.
 *
 * Dual-stack design:
 *   - `plugin.ts` (V1): exports `createContextModePlugin(ctx: PluginContext)`
 *     that returns the Hooks map. This is the shape KiloCode and OpenCode
 *     ≥ 1.18.29 expect (`PluginModule = { server: Plugin }`).
 *   - `plugin-v2.ts` (this file): exposes `ContextModePluginV2` as a flat
 *     object literal `{ id, setup }` so the default export in `plugin.ts`
 *     can spread it alongside `server`. v2.0.27's runtime loader accepts
 *     `{ id, setup }` (verified locally against @opencode-ai/plugin 1.17.3
 *     — see note below about the SDK typings mismatch).
 *
 * The V1 Hooks surface in `plugin.ts` already registers the same events
 * that OpenCode v2 dispatches: `tool.execute.before/after`, `chat.message`,
 * `experimental.session.compacting`, and `experimental.chat.system.transform`.
 * The dual-stack default export means the V2 loader picks up these same
 * hooks when it calls `setup(ctx)` — the `setup` body in this file is the
 * thin shim that (a) opens the per-project SessionDB once, and (b) calls
 * the domain-hook surface so ROUTING_BLOCK + resume snapshots inject on
 * every model request.
 *
 * ⚠ SDK-TYPINGS MISMATCH — DO NOT TRUST @opencode-ai/plugin D.TS VERBATIM:
 *
 * The installed @opencode-ai/plugin@1.17.3 .d.ts exports
 * `Plugin = (input, options?) => Promise<Hooks>` — a flat function
 * returning a Hooks object — and does NOT declare a `ctx.session.hook`
 * or `ctx.event.subscribe` API. Yet the opencode v2.0.27 loader
 * (which ships inside the compiled Bun binary at
 * /home/yangjie/.opencode/bin/opencode) accepts our `{ id, setup }`
 * shape and invokes `setup(ctx)` at runtime. Confirmed by:
 *   - opencode log line `loading plugin
 *     id=/home/yangjie/.config/opencode/plugins/context-mode.js
 *     entrypoint=file:///...context-mode.js`
 *   - SessionDB side-effect: `~/.config/opencode/context-mode/sessions/
 *     964855ecf81d4ad8.db` created at the expected timestamp.
 *
 * The runtime loader is a superset of the SDK typings. Treat the .d.ts
 * as the *minimum* public surface, not the *complete* one.
 *
 * ROUTING_BLOCK injection and resume-snapshot claim are the two V2 hooks
 * that must run per-model-request; both are registered here via
 * `ctx.session.hook("context", ...)`. SessionDB lifecycle (init + 7-day
 * cleanup) mirrors V1 exactly so that V1 and V2 pick up the same DB file
 * (single writer per process, PR #376).
 *
 * Platform detection reuses `PLATFORM_ENV_VARS` iteration so Kilo/
 * OpenCode resolution is identical to V1 (`getPlatform()` in plugin.ts).
 *
 * Cleanup: the setup() return value is a synchronous teardown function;
 * we use it to abort any in-flight work via AbortController. The current
 * implementation only aborts the (not-yet-wired) event subscription;
 * hook registrations are scoped by the loader.
 *
 * Reference:
 *   - opencode v2 loader behaviour verified against local install
 *     at ~/.opencode/bin/opencode (v2.0.27) on 2026-10-13.
 *   - @opencode-ai/plugin@1.17.3 type surface at
 *     ~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import { OpenCodeAdapter } from "./index.js";
import type { AdapterPlatformType } from "./index.js";
import { PLATFORM_ENV_VARS } from "../detect.js";
import { systemHasRoutingInstructionsV2 as systemHasRoutingInstructions } from "./routing-utils.js";

// ROUTING_BLOCK is a plain string built from `hooks/routing-block.mjs`
// (via `createRoutingBlock(toolNamer)`). We import it lazily through the
// same dynamic-import path `plugin.ts` uses so the skeleton does not
// hard-link the .mjs bundle at module-load time. We build it per-platform
// using `hooks/core/tool-naming.mjs` because the block embeds platform-
// specific tool names (`ctx_execute` vs Kilo's variant, etc.).
let cachedRoutingBlockByPlatform = new Map<string, string>();

async function loadRoutingBlock(platform: AdapterPlatformType): Promise<string> {
  const cached = cachedRoutingBlockByPlatform.get(platform);
  if (cached !== undefined) return cached;
  let result = "";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const routingBlockPath = resolve(here, "../../../../hooks/routing-block.mjs");
    const toolNamingPath = resolve(here, "../../../../hooks/core/tool-naming.mjs");
    const [routingBlockMod, toolNamingMod] = await Promise.all([
      import(pathToFileURL(routingBlockPath).toString()),
      import(pathToFileURL(toolNamingPath).toString()),
    ]);
    const toolNamer = (toolNamingMod as any).createToolNamer?.(platform) ?? (routingBlockMod as any)._defaultNamer;
    if (typeof (routingBlockMod as any).createRoutingBlock === "function") {
      const built = (routingBlockMod as any).createRoutingBlock(toolNamer);
      if (typeof built === "string") result = built;
    } else if (typeof (routingBlockMod as any).ROUTING_BLOCK === "string") {
      // Fall back to the static default if createRoutingBlock is absent.
      result = (routingBlockMod as any).ROUTING_BLOCK;
    }
  } catch {
    // Silent — caller proceeds without a routing block (matches V1's
    // behaviour when hooks/ is missing).
  }
  cachedRoutingBlockByPlatform.set(platform, result);
  return result;
}

/**
 * Same platform-detection logic as V1's `getPlatform()` in plugin.ts,
 * inlined here to avoid a runtime dependency cycle on the v1 plugin body.
 * `PLATFORM_ENV_VARS` lists `kilo` BEFORE `opencode`, so KILO_PID wins
 * the iteration — required because KiloCode sets `OPENCODE=1` in addition
 * to its own `KILO_PID` (PR #376 root cause).
 */
function resolvePlatform(): AdapterPlatformType {
  for (const [platform, vars] of PLATFORM_ENV_VARS) {
    if (platform !== "kilo" && platform !== "opencode") continue;
    if (vars.some((v) => process.env[v.name])) {
      return platform as AdapterPlatformType;
    }
  }
  // Plugin host should always set one of the env vars. Fallback to opencode
  // (the wider ecosystem) when neither is set.
  return "opencode";
}

// ── V2 context type (loose — @opencode/plugin types not installed here) ──
// We only consume `ctx.location.directory` and `ctx.session.hook`, so a
// narrow structural type is sufficient. Keeping the types local avoids a
// hard `@opencode/plugin` dependency, which would break the V1 load path
// for users who haven't pulled in the v2 SDK.
type V2SystemTextEntry = { type: "text"; text: string };

type V2SessionHookEvent = {
  sessionId?: string;
  sessionID?: string;
  /** V2 native shape: array of `{ type: "text", text }` objects. */
  system?: V2SystemTextEntry[];
};

type V2SessionHookHandler = (event: V2SessionHookEvent) => void | Promise<void>;

type V2SessionDomain = {
  hook(name: "context" | "prompt" | "compaction" | "generate" | "title", handler: V2SessionHookHandler): Promise<{ dispose(): Promise<void> }>;
};

type V2PluginContext = {
  app?: { version?: string };
  location: { directory: string; project?: { id?: string; canonical?: string } };
  options?: Record<string, unknown>;
  session: V2SessionDomain;
  // Present in the full v2 spec; not consumed by this skeleton:
  //   tool, permission, shell, event, storage, model, provider, agent,
  //   command, integration, mcp, reference, skill, vcs, websearch, worktree.
};

// ── V2 definition shape ─────────────────────────────────────
//
// Matches the shape returned by `Plugin.define({ id, setup })` from
// `@opencode/plugin`. We build the object literal directly instead of
// importing `Plugin` because the dependency is optional at the
// distribution level (V1 users may not have `@opencode/plugin` installed).
// The object literal is shape-compatible: V2's loader decodes `{ id, setup }`
// and calls `setup(ctx)`. Adding `import { Plugin } from "@opencode/plugin"`
// and `export default Plugin.define(...)` is a drop-in refactor once the
// peer-dependency lands.
export const ContextModePluginV2 = {
  id: "context-mode",

  async setup(ctx: V2PluginContext): Promise<() => void> {
    // V2 has no direct equivalent for `ctx.client.app.log` — use
    // `console.log` gated by OPENCODE_DEBUG.
    const dbg = (msg: string) => {
      if (process.env.OPENCODE_DEBUG) console.log(`[context-mode:opencode-v2] ${msg}`);
    };

    dbg(`loaded in OpenCode ${ctx?.app?.version ?? "?"} at ${ctx?.location?.directory ?? "?"}`);

    // Platform comes from `PLATFORM_ENV_VARS` iteration (KILO_PID wins over
    // OPENCODE). This mirrors V1's `getPlatform()` in plugin.ts so V2 and
    // V1 pick the same tool-naming convention and DB location per process.
    const platform = resolvePlatform();

    // Load ROUTING_BLOCK before registering any transform/hook — V2's
    // transforms are cheap+sync by design; keeping async I/O out of the
    // callback keeps replays side-effect-free.
    const routingBlock = await loadRoutingBlock(platform);

    // Initialize the per-project SessionDB. Mirrors V1 exactly: platform
    // is resolved above, DB path goes through `resolveSessionDbPath` so
    // worktree-suffix + case-fold rules apply identically.
    const adapter = new OpenCodeAdapter(platform);
    const projectDir = ctx?.location?.directory ?? process.cwd();
    let db: SessionDB | undefined;
    try {
      db = new SessionDB({
        dbPath: resolveSessionDbPath({
          projectDir,
          sessionsDir: adapter.getSessionDir(),
        }),
      });
      db.cleanupOldSessions(7);
    } catch (err) {
      // Never break plugin load because the DB failed to open — resume
      // snapshot claim degrades to "no snapshot" and the next turn still
      // fires. Match V1's silent-fallback posture.
      dbg(`SessionDB init failed: ${(err as Error).message}`);
      db = undefined;
    }

    // The full V2 event subscription (`ctx.event.subscribe({ signal })` +
    // AbortController) will land when we port the message.updated usage-
    // capture hook. Kept as scaffolding now so the cleanup shape is right.
    const controller = new AbortController();
    void controller; // wired later; retained so we don't forget on teardown.

    // ── `context` hook: V2 surrogate for V1 `experimental.chat.system.
    //    transform`. Registered once at setup; OpenCode invokes it before
    //    every agent model request. We splice both the routing block and
    //    the resume snapshot at index 1 (after the header) so the V1
    //    llm.ts:117-128 cache-fold invariant holds — prepending via
    //    `unshift` would invalidate the provider prompt cache.
    //    ────────────────────────────────────────────────────────────────
    await ctx.session.hook("context", async (event) => {
      const sessionId = event?.sessionId ?? event?.sessionID;
      if (!sessionId || !Array.isArray(event.system)) return;

      const system = event.system;

      // Step 1 — ROUTING_BLOCK injection (mirrors V1 plugin.ts OC-1).
      // Dedup by scanning for a quorum of ROUTING_MARKERS so we don't
      // duplicate when the host already injected rules via AGENTS.md or
      // a prior turn of the same session.
      if (!systemHasRoutingInstructions(system) && routingBlock) {
        system.splice(1, 0, { type: "text" as const, text: routingBlock });
        dbg(`routing block injected for session ${sessionId}`);
      } else if (process.env.OPENCODE_DEBUG) {
        dbg(`routing block skipped for ${sessionId} (already present)`);
      }

      // Step 2 — resume snapshot claim (mirrors V1 plugin.ts OC-3).
      // The row is claimed atomically (UPDATE ... WHERE consumed_at IS NULL
      // ORDER BY created_at DESC LIMIT 1) so concurrent sessions cannot
      // both grab the same snapshot. Passing `sessionId` as the exclusion
      // id prevents self-claim when the current session produced a
      // snapshot on the last turn (#376 root cause).
      if (db) {
        try {
          const row = db.claimLatestUnconsumedResume(sessionId);
          if (row?.snapshot) {
            system.splice(1, 0, { type: "text" as const, text: row.snapshot });
            if (process.env.OPENCODE_DEBUG) {
              dbg(`resume snapshot claimed from session ${row.sessionId} into ${sessionId}`);
            }
          }
        } catch (err) {
          // Silent — never break the chat turn on resume-claim failure.
          dbg(`resume claim failed: ${(err as Error).message}`);
        }
      }
    });

    // Cleanup: called by the V2 loader on plugin unload. Hook registrations
    // are already scoped to the plugin, but any resources we allocated here
    // (the AbortController for the future event subscription) tear down
    // here.
    return () => {
      controller.abort();
      dbg("unloaded");
    };
  },
};

