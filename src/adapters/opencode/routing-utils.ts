/**
 * Shared routing-block markers and text helpers used by both the V1
 * (`plugin.ts`) and V2 (`plugin-v2.ts`) OpenCode plugin entry points.
 *
 * Kept as its own module to avoid a runtime import cycle: plugin.ts re-
 * exports `ROUTING_MARKERS` for backward compatibility with existing
 * unit tests (see `export { ROUTING_MARKERS }` there), and plugin-v2.ts
 * imports directly from this module.
 */

/**
 * Quorum markers — must NOT be substrings of each other (#487).
 *
 * Each token uniquely identifies the routing block / context-mode rules
 * without overlapping any other marker. The XML tag is the primary signal;
 * the two distinctive bare tool names are the secondary signals. Together
 * any 2 of 3 confirm the system prompt already carries routing instructions.
 */
export const ROUTING_MARKERS: readonly string[] = [
  "<context_window_protection>",
  "ctx_search",
  "ctx_index",
];

/**
 * V1 flavour: walk a `string[]` system prompt. Returns true when at
 * least two of ROUTING_MARKERS appear with word-boundary guards.
 *
 * The XML tag `<context_window_protection>` doesn't need a boundary
 * check (the `<` is already a non-word char). Bare tokens like
 * `ctx_search` need boundary guards to avoid false positives on
 * namespaced variants (`ctx_search_v2`, `not_ctx_search`).
 */
export function systemHasRoutingInstructionsV1(system: readonly string[]): boolean {
  const text = system.join("\n");
  const wordBoundary = (m: string): boolean => {
    if (m.startsWith("<")) return text.includes(m);
    const re = new RegExp(
      `(?:^|\\W)${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\W|$)`,
    );
    return re.test(text);
  };
  return ROUTING_MARKERS.filter(wordBoundary).length >= 2;
}

/**
 * V2 flavour: walk an array of `{ type: "text", text }` objects. V2's
 * `event.system` uses this shape rather than a plain string array.
 *
 * Tolerates bare strings too, in case a loader variant hands us a
 * flattened list — same word-boundary rule as V1.
 */
export function systemHasRoutingInstructionsV2(
  system: ReadonlyArray<{ type: string; text: string } | string>,
): boolean {
  const texts = system.map((s) =>
    typeof s === "string" ? s : (s?.text ?? ""),
  );
  return systemHasRoutingInstructionsV1(texts);
}
