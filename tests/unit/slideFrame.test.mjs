import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SLIDE_FRAME_SIZE,
  readSlideFrameSize,
  sameSlideFrameSize
} from "../../src/renderer/editor/slideFrame.ts";

test("readSlideFrameSize uses the rendered dimensions of the active slide", () => {
  const slideElement = {
    getBoundingClientRect: () => ({ width: 1600, height: 900 })
  };
  const document = {
    body: { getBoundingClientRect: () => ({ width: 1366, height: 768 }) },
    documentElement: null,
    querySelector: (selector) => selector === "#slide-002" ? slideElement : null
  };
  const slides = [
    { id: "slide-001", selector: "#slide-001" },
    { id: "slide-002", selector: "#slide-002" }
  ];

  assert.deepEqual(readSlideFrameSize(document, "slide-002", slides), { width: 1600, height: 900 });
});

test("readSlideFrameSize falls back for missing or unsafe rendered dimensions", () => {
  const slides = [{ id: "slide-001", selector: "#slide-001" }];
  const missingDocument = {
    body: null,
    documentElement: null,
    querySelector: () => null
  };
  const oversizedDocument = {
    body: null,
    documentElement: null,
    querySelector: () => ({
      getBoundingClientRect: () => ({ width: 100_000, height: 90_000 })
    })
  };

  assert.deepEqual(readSlideFrameSize(missingDocument, "slide-001", slides), DEFAULT_SLIDE_FRAME_SIZE);
  assert.deepEqual(readSlideFrameSize(oversizedDocument, "slide-001", slides), DEFAULT_SLIDE_FRAME_SIZE);
});

test("sameSlideFrameSize compares both dimensions", () => {
  assert.equal(sameSlideFrameSize({ width: 1600, height: 900 }, { width: 1600, height: 900 }), true);
  assert.equal(sameSlideFrameSize({ width: 1600, height: 900 }, { width: 1366, height: 768 }), false);
});
