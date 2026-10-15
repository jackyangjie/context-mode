#!/usr/bin/env bash
# Tier-2 smoke runner — OpenCode host.
#
# Boots a real OpenCode V2 binary headless (`opencode run`) with the
# context-mode plugin installed, then asserts the plugin actually loaded
# into the runtime and that setup() did not break.
#
# ── Why this is NOT a copy of run-pi-smoke.sh ────────────────────────────
# Two deliberate differences, both verified empirically against v2.0.29:
#
#  1. Plugin install = copy the bundle AND its `hooks/` dir into
#     `.opencode/plugins/`. OpenCode auto-discovers that directory, so no
#     config entry is needed. The loader then emits a greppable line:
#         msg="loading plugin" id=<path> entrypoint=file://<path>
#     Archives do NOT work: `plugins: ["file:///....tgz"]` is rejected with
#         WARN message="configured plugin path must be a directory"
#     so a .tgz is not a viable install target here.
#     `hooks/` is mandatory, not optional: setup() imports
#     hooks/core/routing.mjs and hooks/auto-injection.mjs relative to the
#     bundle. Missing either loads the plugin with routing enforcement
#     silently disabled — see HARD 4 below.
#
#  2. No `/ctx-stats` capture and no bundled-CLI fallback.
#     OpenCode exposes the 11 ctx_* tools natively (no plugin slash
#     commands), and `cli.bundle.mjs stats --json` does not exist — the CLI
#     has no `stats` subcommand at all. That means run-pi-smoke.sh:95 is
#     dead code, not just a Pi-specific shortcut. Tool-usage evidence for
#     this host is therefore read from the OpenCode server log instead.
#
#  3. CONTEXT_MODE_DIR is pinned to a run-local dir. The OpenCode adapter
#     overrides its session dir to ~/.config/opencode/... (XDG_CONFIG_HOME
#     on Linux), which would otherwise read a developer's real store.
#     CONTEXT_MODE_DIR wins over that adapter override (src/session/db.ts),
#     so pinning it keeps the smoke hermetic and shareable with the CLI.
#
# Requires:
#   - OC_BIN              path to the opencode executable (default: $(which opencode))
#   - ANTHROPIC_API_KEY   model provider key, capped on the Anthropic console
#   - FIXTURE             prompt fixture path (default: fixtures/search-corpus.txt)
#   - OC_MODEL            provider/model, OpenCode form (default: anthropic/$ANTHROPIC_MODEL)
#
# Exit code 0 on pass, non-zero on fail.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$REPO_ROOT/scripts/tier2-smoke"
LOG_DIR="${RUNNER_TEMP:-/tmp}/tier2-smoke-opencode"
mkdir -p "$LOG_DIR"

OC_BIN="${OC_BIN:-$(command -v opencode || true)}"
FIXTURE="${FIXTURE:-$SMOKE_DIR/fixtures/search-corpus.txt}"
PLUG_DIR="$LOG_DIR/proj/.opencode/plugins"
OC_OUT="$LOG_DIR/opencode-out.txt"
OC_LOG="$LOG_DIR/opencode.log"
# Run-local state. Must be absolute: an empty CONTEXT_MODE_DIR is ignored and
# a relative one is rejected (src/session/db.ts).
STATE_DIR="${CONTEXT_MODE_DIR:-$LOG_DIR/state}"
OC_MODEL="${OC_MODEL:-${ANTHROPIC_MODEL:-}}"
# OpenCode wants "provider/model"; the workflow pins the bare family name, so
# prefix it when the caller didn't already supply the full form.
if [ -n "$OC_MODEL" ] && [[ "$OC_MODEL" != */* ]]; then
  OC_MODEL="anthropic/$OC_MODEL"
fi

echo "=== Tier-2 smoke (OpenCode) ==="
echo "Repo:    $REPO_ROOT"
echo "OC bin:  ${OC_BIN:-<not found>}"
echo "Model:   ${OC_MODEL:-<provider default>}"
echo "Fixture: $FIXTURE"
echo "Logs:    $LOG_DIR"
echo "State:   $STATE_DIR  (CONTEXT_MODE_DIR)"
echo

if [ -z "${OC_BIN:-}" ] || [ ! -x "$OC_BIN" ]; then
  echo "FATAL  opencode binary not found. Install with:" >&2
  echo "       curl -fsSL https://opencode.ai/v2/install | bash" >&2
  exit 2
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL  ANTHROPIC_API_KEY not set. Configure it as a repo secret." >&2
  exit 2
fi

if [ ! -f "$FIXTURE" ]; then
  echo "FATAL  Fixture not found at $FIXTURE" >&2
  exit 2
fi

if [ ! -f "$REPO_ROOT/plugin.bundle.mjs" ]; then
  echo "FATAL  plugin.bundle.mjs missing — run 'npm run build' first" >&2
  exit 2
fi

echo "--- OpenCode version ---"
"$OC_BIN" --version 2>&1 | tee -a "$OC_LOG"
echo

# ── Install the plugin ────────────────────────────────────────────────────
# Auto-discovery means the .opencode/plugins/ entry is the only *wiring*
# needed. But the bundle is not self-contained: setup() resolves
#   hooks/core/routing.mjs      — routing enforcement
#   hooks/auto-injection.mjs    — post-compact auto-injection
# relative to its own directory. Ship a bundle without hooks/ and the plugin
# loads fine while routing enforcement is silently off — which is exactly the
# kind of half-broken install a smoke test should catch, so assert it below.
echo "--- Installing plugin into $PLUG_DIR ---"
mkdir -p "$PLUG_DIR"
cp "$REPO_ROOT/plugin.bundle.mjs" "$PLUG_DIR/context-mode.js"
cp -r "$REPO_ROOT/hooks" "$PLUG_DIR/hooks"
ls -l "$PLUG_DIR"
echo

# ── Run ───────────────────────────────────────────────────────────────────
# --standalone gives us a private server, which is what makes --print-logs
# reachable at all; against the shared background service the server logs go
# elsewhere.
# --print-logs / --log-level debug land on STDERR; the assistant reply lands
# on STDOUT. They are captured separately on purpose — every assertion below
# greps the log, never the reply.
#
# We deliberately do NOT use --format json: its schema is not part of the
# plugin contract and has changed across releases, so pinning assertions to
# it would make this smoke fail for reasons unrelated to context-mode.
echo "--- Running fixture prompt ---"
PROMPT="$(cat "$FIXTURE")"
OC_FLAGS=(--standalone --print-logs --log-level debug)
if [ -n "$OC_MODEL" ]; then
  OC_FLAGS+=(--model "$OC_MODEL")
fi
set +e
( cd "$LOG_DIR/proj" && CONTEXT_MODE_DIR="$STATE_DIR" \
    "$OC_BIN" run "${OC_FLAGS[@]}" "$PROMPT" \
    > "$OC_OUT" 2> "$OC_LOG" )
OC_EXIT=$?
set -e
echo "opencode run exited $OC_EXIT"
echo

# ── Assertions ────────────────────────────────────────────────────────────
# HARD gates prove the plugin loaded into a real OpenCode runtime. That is
# exactly what has never been verified in CI, and it holds even when the LLM
# call fails (e.g. an expired provider key), which is why these three run
# before any model-dependent check.
#
# SOFT signals report model-observed tool usage. They are informational only:
# the fixture asks the model to call ctx_* tools, but a stochastic model may
# not comply, and the log format is not part of the plugin contract. Promote
# them to HARD once someone has confirmed the log shape on a pinned release.
fail=0
hard() {
  if [ "$2" = "1" ]; then echo "  PASS  $1"; else echo "  FAIL  $1${3:+ — $3}"; fail=$((fail + 1)); fi
}
soft() {
  echo "  INFO  $1${2:+ — $2}"
}

echo "--- Assertions ---"

# HARD 1 — the loader picked our bundle up.
hard "plugin bundle loaded into OpenCode" \
  "$(grep -Eq 'msg="loading plugin".*context-mode' "$OC_LOG" && echo 1 || echo 0)" \
  "no 'loading plugin' log line mentioning context-mode"

# HARD 2 — the loader did not reject it. The failure form is
# WARN message="failed to load plugin" target=... cause=...
hard "no plugin load failure" \
  "$(grep -Eq 'failed to load plugin' "$OC_LOG" && echo 0 || echo 1)" \
  "OpenCode reported a plugin load failure"

# HARD 3 — a plugin crash in setup() aborts the run. Distinguish that from a
# model/auth failure, which is a credential problem rather than a plugin one.
if [ "$OC_EXIT" -ne 0 ]; then
  if grep -Eiq 'deprecated|invalid api key|authentication|not authorized|unauthorized' "$OC_LOG"; then
    hard "opencode run completed" 0 \
      "exit $OC_EXIT — model/auth error, not a plugin fault; check ANTHROPIC_API_KEY and OC_MODEL"
  else
    hard "opencode run completed" 0 \
      "exit $OC_EXIT — see $OC_LOG"
  fi
else
  hard "opencode run completed" 1
fi

# HARD 4 — the plugin reported no degradation. plugin-v2.ts writes these to
# stderr (the only sink that reaches the user; console.log, process.stdout
# and ctx.app.log are all dropped by V2), so they land in OC_LOG alongside
# the server log. Any match means the plugin loaded but a capability is off.
hard "plugin reported no capability degradation" \
  "$(grep -Eq '\[context-mode:opencode-v2\] WARN' "$OC_LOG" && echo 0 || echo 1)" \
  "degradation warning(s) present — see $OC_LOG"

if grep -Eq '\[context-mode:opencode-v2\] WARN' "$OC_LOG"; then
  grep -E '\[context-mode:opencode-v2\] WARN' "$OC_LOG" | sed 's/^/         /'
fi

# HARD 5 — a ctx_* tool was actually invoked by the model. Layers 1–4 prove
# the plugin loaded and setup() did not degrade; they cannot prove the 11
# native ctx_* tools were registered at all. OpenCode V2's editor.add silently
# rejects a schema it doesn't understand, so a build whose input schema was
# malformed loads cleanly, logs no WARN, yet exposes zero tools to the model.
#
# The fixture deliberately never writes the underscore form `ctx_stats` (it
# only references the slash form `/ctx-stats`), so a `ctx_stats` match can only
# come from a model-issued tool call, never a fixture echo. Grepping that
# single tool is the tightest layer-3 signal that does not depend on the log
# shape of arbitrary tool names (the SOFT block below still counts the rest).
hard "model invoked a ctx_* tool (layer 3)" \
  "$(grep -Eq 'ctx_stats' "$OC_LOG" && echo 1 || echo 0)" \
  "no ctx_stats tool-call in server log — the native tools were not registered (editor.add input-schema mismatch)"

# SOFT — did the model actually use any ctx_* tool? Counted from the log.
# `|| true` keeps grep's no-match exit from tripping `set -e` mid-report.
CTX_HITS="$(grep -oE 'ctx_(search|execute|index)' "$OC_LOG" | wc -l | tr -d ' ' || true)"
soft "ctx_* tool mentions in server log" "$CTX_HITS hit(s)"

# SOFT — did the plugin write session state under the pinned CONTEXT_MODE_DIR?
DB_COUNT="$(find "$STATE_DIR" -name '*.db' 2>/dev/null | wc -l | tr -d ' ' || true)"
soft "session/content DBs under CONTEXT_MODE_DIR" "$DB_COUNT file(s)"

if [ "$fail" -gt 0 ]; then
  echo >&2
  echo "Tier-2 smoke (OpenCode) FAILED ($fail hard assertion(s))." >&2
  echo "Artifacts: $OC_LOG (server log), $OC_OUT (assistant reply)" >&2
  exit 1
fi

echo
echo "Tier-2 smoke (OpenCode) PASSED."
