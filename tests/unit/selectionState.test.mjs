import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// selectionState.ts imports `./transform` with no file extension, which is
// valid under the project's bundler-style tsconfig but not under plain Node
// ESM resolution. Register a small local hook that also tries `<spec>.ts`.
// See tests/unit/support/resolve-ts-hook.mjs and tests/unit/README.md.
// Because static `import` specifiers are resolved before any top-level code
// in this file runs, the module under test must be loaded via a dynamic
// `import()` AFTER `register()` has executed.
register("./support/resolve-ts-hook.mjs", import.meta.url);

const {
  replaceSelection,
  areSelectionListsEqual,
  areSelectionsEqual,
  updateSelectedStyle,
  createDomMoveStateUpdates,
  applyDomMoveStateUpdate,
  toggleSelection,
  mergeSelections,
  toggleId,
  mergeIds
} = await import("../../src/renderer/editor/selectionState.ts");

function mkSel(hssId, overrides = {}) {
  return {
    hssId,
    tagName: "p",
    selector: `p#${hssId}`,
    textContent: "text",
    childElementCount: 0,
    canEditTextDirectly: true,
    computedStyle: { transform: "none" },
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides
  };
}

test("replaceSelection: swaps in the updated selection by matching hssId, leaves others untouched", () => {
  const selA = mkSel("a");
  const selB = mkSel("b");
  const selA2 = mkSel("a", { textContent: "changed" });
  const result = replaceSelection([selA, selB], selA2);
  assert.equal(result[0].textContent, "changed");
  assert.equal(result[1], selB);
});

test("areSelectionListsEqual / areSelectionsEqual: compares by hssId/selector/text/locked/rounded bbox/computedStyle JSON", () => {
  const selA = mkSel("a");
  assert.equal(areSelectionListsEqual([selA], [mkSel("a")]), true);
  assert.equal(areSelectionListsEqual([selA], [selA, mkSel("b")]), false);
  assert.equal(areSelectionListsEqual([selA], [mkSel("a", { textContent: "changed" })]), false);
  assert.equal(areSelectionsEqual(null, null), true);
  assert.equal(areSelectionsEqual(selA, null), false);
});

test("areSelectionsEqual: bbox comparison rounds to the nearest integer", () => {
  const left = mkSel("a", { bbox: { x: 1.4, y: 0, width: 10, height: 10 } });
  const right = mkSel("a", { bbox: { x: 1.6, y: 0, width: 10, height: 10 } });
  // 1.4 rounds to 1, 1.6 rounds to 2 -> different, so NOT equal despite both
  // being "close" to 1.5.
  assert.equal(areSelectionsEqual(left, right), false);
});

test("updateSelectedStyle: merges style into computedStyle; passes null through unchanged", () => {
  const selA = mkSel("a");
  const updated = updateSelectedStyle(selA, { color: "#fff" });
  assert.deepEqual(updated.computedStyle, { transform: "none", color: "#fff" });
  assert.equal(updateSelectedStyle(null, { color: "#fff" }), null);
});

test("createDomMoveStateUpdates / applyDomMoveStateUpdate: computes a delta from the current transform and applies it to bbox", () => {
  const moveSel = mkSel("m", { computedStyle: { transform: "translate(10px, 10px)" } });
  const updates = createDomMoveStateUpdates([{ selection: moveSel, transform: "translate(30px, 40px)" }], []);
  assert.deepEqual(Array.from(updates.entries()), [["m", { deltaX: 20, deltaY: 30, transform: "translate(30px, 40px)" }]]);

  const applied = applyDomMoveStateUpdate(moveSel, updates);
  assert.equal(applied.computedStyle.transform, "translate(30px, 40px)");
  assert.deepEqual(applied.bbox, { x: 20, y: 30, width: 10, height: 10 });

  // A selection with no matching update passes through unchanged.
  const selA = mkSel("a");
  assert.equal(applyDomMoveStateUpdate(selA, updates), selA);
});

test("toggleSelection: adds when absent, removes when present (matched by hssId)", () => {
  const selA = mkSel("a");
  const selB = mkSel("b");
  assert.equal(toggleSelection([selA], selB).length, 2);
  assert.deepEqual(toggleSelection([selA, selB], selA).map((s) => s.hssId), ["b"]);
});

test("mergeSelections: later additions overwrite earlier entries with the same hssId, order is Map insertion order", () => {
  const selA = mkSel("a");
  const selB = mkSel("b");
  const selA2 = mkSel("a", { textContent: "changed" });
  const merged = mergeSelections([selA], [selA2, selB]);
  assert.deepEqual(merged.map((s) => [s.hssId, s.textContent]), [
    ["a", "changed"],
    ["b", "text"]
  ]);
});

test("toggleId / mergeIds: simple string-array toggle and de-duplicating merge", () => {
  assert.deepEqual(toggleId(["x"], "y"), ["x", "y"]);
  assert.deepEqual(toggleId(["x", "y"], "y"), ["x"]);
  assert.deepEqual(mergeIds(["x", "y"], ["y", "z"]), ["x", "y", "z"]);
});
