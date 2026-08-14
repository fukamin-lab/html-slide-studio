import assert from "node:assert/strict";
import test from "node:test";
import { isClippedTextOverflow } from "../../src/renderer/editor/textOverflow.ts";

test("visible glyph ink outside a line box is not classified as clipping", () => {
  assert.equal(isClippedTextOverflow({
    overflowX: "visible",
    overflowY: "visible",
    clientWidth: 337,
    clientHeight: 42,
    scrollWidth: 337,
    scrollHeight: 49
  }), false);
});

test("healthy wrapping with visible overflow is not classified as clipping", () => {
  assert.equal(isClippedTextOverflow({
    overflowX: "visible",
    overflowY: "visible",
    clientWidth: 180,
    clientHeight: 96,
    scrollWidth: 180,
    scrollHeight: 101
  }), false);
});

test("hidden inline-flex overflow remains classified as clipping", () => {
  assert.equal(isClippedTextOverflow({
    overflowX: "hidden",
    overflowY: "hidden",
    clientWidth: 6,
    clientHeight: 24,
    scrollWidth: 240,
    scrollHeight: 24
  }), true);
});

test("scrollable and clipped vertical overflow remain classified as clipping", () => {
  const base = { clientWidth: 200, clientHeight: 40, scrollWidth: 200, scrollHeight: 80 };
  assert.equal(isClippedTextOverflow({ ...base, overflowX: "auto", overflowY: "auto" }), true);
  assert.equal(isClippedTextOverflow({ ...base, overflowX: "scroll", overflowY: "scroll" }), true);
  assert.equal(isClippedTextOverflow({ ...base, overflowX: "visible", overflowY: "clip" }), true);
});

test("rounding within the existing two pixel tolerance is not clipping", () => {
  assert.equal(isClippedTextOverflow({
    overflowX: "hidden",
    overflowY: "hidden",
    clientWidth: 100,
    clientHeight: 40,
    scrollWidth: 102,
    scrollHeight: 42
  }), false);
});
