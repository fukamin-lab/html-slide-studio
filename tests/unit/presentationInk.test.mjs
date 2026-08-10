import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LASER_LIFETIME_MS,
  applyPresentationDraw,
  clearPresentationInk,
  createEmptyPresentationInk,
  laserOpacity,
  visiblePresentationStrokes
} from "../../src/renderer/presentationInk.ts";

const start = { slideId: "slide-1", tool: "laser", color: "#ef4444", phase: "start", strokeId: "laser-1", x: 10, y: 20 };

test("laser trail fades and is removed after its bounded lifetime", () => {
  const state = applyPresentationDraw(createEmptyPresentationInk(), start, 1_000);
  const stroke = state.strokes[0];
  assert.equal(visiblePresentationStrokes(state, "slide-1", 1_000).length, 1);
  assert.equal(stroke.color, "#ef4444");
  assert.ok(laserOpacity(stroke, 1_000 + LASER_LIFETIME_MS / 2) > 0.4);
  assert.equal(visiblePresentationStrokes(state, "slide-1", 1_000 + LASER_LIFETIME_MS).length, 0);
});

test("pen strokes remain until the current slide is explicitly cleared", () => {
  let state = applyPresentationDraw(createEmptyPresentationInk(), { ...start, tool: "pen", strokeId: "pen-1" }, 1_000);
  state = applyPresentationDraw(state, { ...start, tool: "pen", phase: "move", strokeId: "pen-1", x: 30, y: 40 }, 2_000);
  assert.equal(visiblePresentationStrokes(state, "slide-1", 999_999).length, 1);
  assert.equal(state.strokes[0].points.length, 2);
  assert.equal(clearPresentationInk(state, "slide-1").strokes.length, 0);
});

test("clearing one slide preserves pen strokes on other slides", () => {
  let state = applyPresentationDraw(createEmptyPresentationInk(), { ...start, tool: "pen", strokeId: "pen-1" }, 1_000);
  state = applyPresentationDraw(state, { ...start, slideId: "slide-2", tool: "pen", strokeId: "pen-2" }, 1_000);
  const cleared = clearPresentationInk(state, "slide-1");
  assert.deepEqual(cleared.strokes.map((stroke) => stroke.slideId), ["slide-2"]);
});

test("each stroke keeps the selected fixed palette color", () => {
  let state = applyPresentationDraw(createEmptyPresentationInk(), { ...start, tool: "pen", color: "#2563eb", strokeId: "pen-blue" }, 1_000);
  state = applyPresentationDraw(state, { ...start, tool: "pen", color: "#ffffff", phase: "move", strokeId: "pen-blue", x: 20, y: 30 }, 1_100);
  assert.equal(state.strokes[0].color, "#2563eb");
});
