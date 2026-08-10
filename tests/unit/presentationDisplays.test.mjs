import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPresentationDisplays } from "../../src/main/presentationDisplays.ts";

function display(id, width, height) {
  return { id, bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: 0, width, height } };
}

test("selectPresentationDisplays rejects an empty display list", () => {
  assert.throws(() => selectPresentationDisplays([], 1), /No display/);
});

test("selectPresentationDisplays uses the only display for the presenter and no audience", () => {
  const only = display(7, 1920, 1080);
  assert.deepEqual(selectPresentationDisplays([only], 7), { presenter: only, audience: null });
});

test("selectPresentationDisplays keeps the primary for the presenter and chooses the largest non-primary audience", () => {
  const primary = display(10, 3840, 2160);
  const small = display(20, 1280, 720);
  const large = display(30, 2560, 1440);
  assert.deepEqual(selectPresentationDisplays([small, primary, large], 10), { presenter: primary, audience: large });
});

test("selectPresentationDisplays resolves equal-size audience displays by ascending display id", () => {
  const primary = display(10, 1920, 1080);
  const higherId = display(30, 1920, 1080);
  const lowerId = display(20, 1920, 1080);
  assert.deepEqual(selectPresentationDisplays([higherId, primary, lowerId], 10), { presenter: primary, audience: lowerId });
});
