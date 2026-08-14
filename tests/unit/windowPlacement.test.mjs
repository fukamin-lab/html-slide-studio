import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreWindowPlacement, scaleBoundsForDisplayTransition } from "../../src/main/windowPlacement.ts";

function fakeWindow({ failAt } = {}) {
  const calls = [];
  const call = (name) => {
    calls.push(name);
    if (name === failAt) throw new Error(`injected ${name} failure`);
  };
  return {
    calls,
    setFullScreen: (value) => call(`fullscreen:${value}`),
    unmaximize: () => call("unmaximize"),
    setBounds: (bounds, animate) => call(`bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}:${animate}`),
    maximize: () => call("maximize"),
    isMinimized: () => { call("isMinimized"); return true; },
    restore: () => call("restore"),
    show: () => call("show"),
    focus: () => call("focus")
  };
}

test("maximized editor is unmaximized, returned to its original bounds, then maximized again", () => {
  const window = fakeWindow();
  restoreWindowPlacement(window, {
    bounds: { x: 20, y: 30, width: 1400, height: 900 },
    displayScaleFactor: 1.25,
    wasFullScreen: false,
    wasMaximized: true
  });
  assert.deepEqual(window.calls, [
    "fullscreen:false",
    "unmaximize",
    "bounds:20,30,1400,900:false",
    "maximize",
    "isMinimized",
    "restore",
    "show",
    "focus"
  ]);
});

test("window restoration continues through later safety steps when placement throws", () => {
  const window = fakeWindow({ failAt: "bounds:20,30,1400,900:false" });
  assert.throws(() => restoreWindowPlacement(window, {
    bounds: { x: 20, y: 30, width: 1400, height: 900 },
    displayScaleFactor: 1,
    wasFullScreen: true,
    wasMaximized: true
  }), AggregateError);
  assert.ok(window.calls.includes("maximize"));
  assert.ok(window.calls.includes("fullscreen:true"));
  assert.ok(window.calls.includes("show"));
  assert.ok(window.calls.includes("focus"));
});

test("window size is compensated when restoring from a lower-scale display", () => {
  const window = fakeWindow();
  restoreWindowPlacement(window, {
    bounds: { x: 20, y: 30, width: 1000, height: 800 },
    displayScaleFactor: 1.25,
    wasFullScreen: false,
    wasMaximized: false
  }, 1);
  assert.ok(window.calls.includes("bounds:20,30,800,640:false"));
});

test("invalid scale factors leave the captured bounds unchanged", () => {
  const bounds = { x: 20, y: 30, width: 1000, height: 800 };
  assert.equal(scaleBoundsForDisplayTransition(bounds, 0, 1), bounds);
  assert.equal(scaleBoundsForDisplayTransition(bounds, -1, 1), bounds);
  assert.equal(scaleBoundsForDisplayTransition(bounds, Number.POSITIVE_INFINITY, 1), bounds);
  assert.equal(scaleBoundsForDisplayTransition(bounds, 1.25, Number.NaN), bounds);
});

test("window size is compensated in the reverse scale direction without moving its origin", () => {
  assert.deepEqual(
    scaleBoundsForDisplayTransition({ x: -1900, y: 24, width: 800, height: 640 }, 1, 1.25),
    { x: -1900, y: 24, width: 1000, height: 800 }
  );
});

test("same-scale and repeated calculations are stable", () => {
  const bounds = { x: 20, y: 30, width: 1000, height: 800 };
  assert.equal(scaleBoundsForDisplayTransition(bounds, 1.25, 1.25), bounds);
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(scaleBoundsForDisplayTransition(bounds, 1.25, 1), {
      x: 20,
      y: 30,
      width: 800,
      height: 640
    });
  }
});
