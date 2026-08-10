import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertTextPatch,
  upsertStylePatch,
  upsertStylePatchForTarget,
  findStylePatch,
  isDomTargetLocked
} from "../../src/renderer/editor/patchMutations.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PATCH_ID_RE = /^patch-[0-9a-z]+$/;

function mkSelected(hssId, selector = `#${hssId}`) {
  return { hssId, selector };
}

test("upsertTextPatch: no-op on a null selection", () => {
  assert.deepEqual(upsertTextPatch([], null, "ignored"), []);
});

test("upsertTextPatch: creates a new text patch with a generated id and ISO timestamp", () => {
  const patches = upsertTextPatch([], mkSelected("a"), "hello");
  assert.equal(patches.length, 1);
  const [patch] = patches;
  assert.equal(patch.type, "text");
  assert.equal(patch.text, "hello");
  assert.deepEqual(patch.target, { hssId: "a", selector: "#a" });
  assert.match(patch.id, PATCH_ID_RE);
  assert.match(patch.updatedAt, ISO_DATE_RE);
});

test("upsertTextPatch: updates the existing patch for the same hssId in place (same id, new text)", () => {
  const first = upsertTextPatch([], mkSelected("a"), "hello");
  const second = upsertTextPatch(first, mkSelected("a"), "world");
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(second[0].text, "world");
});

test("upsertStylePatch: no-op on a null selection", () => {
  assert.deepEqual(upsertStylePatch([], null, { color: "#fff" }), []);
});

test("upsertStylePatch: creates a new style patch", () => {
  const patches = upsertStylePatch([], mkSelected("a"), { color: "#fff" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].type, "style");
  assert.deepEqual(patches[0].style, { color: "#fff" });
  assert.equal(patches[0].locked, undefined);
});

test("upsertStylePatch: merges new style properties onto the existing patch's style, and can set locked", () => {
  const first = upsertStylePatch([], mkSelected("a"), { color: "#fff" });
  const second = upsertStylePatch(first, mkSelected("a"), { fontSize: "12px" }, { locked: true });
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].style, { color: "#fff", fontSize: "12px" });
  assert.equal(second[0].locked, true);
});

test("upsertStylePatchForTarget: operates on a raw PatchTarget (no SelectedElement needed)", () => {
  const patches = upsertStylePatchForTarget([], { hssId: "z", selector: "#z" }, { display: "none" });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].target, { hssId: "z", selector: "#z" });
});

test("findStylePatch: finds by hssId, returns null when missing or hssId is undefined", () => {
  const patches = upsertStylePatch([], mkSelected("a"), { color: "#fff" }, { locked: true });
  assert.equal(findStylePatch(patches, "a").target.hssId, "a");
  assert.equal(findStylePatch(patches, "zzz"), null);
  assert.equal(findStylePatch(patches, undefined), null);
});

test("isDomTargetLocked: reflects the locked flag on the matching style patch", () => {
  const patches = upsertStylePatch([], mkSelected("a"), { color: "#fff" }, { locked: true });
  assert.equal(isDomTargetLocked(patches, "a"), true);
  assert.equal(isDomTargetLocked([], "a"), false);
});
