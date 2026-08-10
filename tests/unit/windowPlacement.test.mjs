import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreWindowPlacement } from "../../src/main/windowPlacement.ts";

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
    wasFullScreen: true,
    wasMaximized: true
  }), AggregateError);
  assert.ok(window.calls.includes("maximize"));
  assert.ok(window.calls.includes("fullscreen:true"));
  assert.ok(window.calls.includes("show"));
  assert.ok(window.calls.includes("focus"));
});
