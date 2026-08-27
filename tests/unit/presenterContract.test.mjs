import { test } from "node:test";
import assert from "node:assert/strict";
import { isPresenterCommand, isPresenterSnapshot } from "../../src/shared/presenterContract.ts";

function validSnapshot() {
  const slide = {
    id: "slide-1",
    label: "はじめに",
    selector: '[data-hss-slide-id="slide-1"]',
    index: 0,
    speakerNotes: "話す内容"
  };
  return {
    sourceHtml: "<!doctype html><html><body><section class=\"slide\">Hello</section></body></html>",
    sourceBaseUrl: "file:///C:/slides/",
    manifest: {
      version: 1,
      app: "html-slide-studio",
      savedAt: "2026-08-10T00:00:00.000Z",
      warnings: [],
      slides: [slide],
      patches: [],
      overlays: []
    },
    slides: [slide],
    currentSlideId: "slide-1",
    deckName: "AI講義",
    updatedAt: "2026-08-10T00:00:01.000Z"
  };
}

test("Presenter command guard accepts navigation, notes, and bounded drawing command shapes", () => {
  assert.equal(isPresenterCommand({ type: "previous-slide" }), true);
  assert.equal(isPresenterCommand({ type: "next-slide" }), true);
  assert.equal(isPresenterCommand({ type: "end-presentation" }), true);
  assert.equal(isPresenterCommand({ type: "set-slide", slideId: "slide-1" }), true);
  assert.equal(isPresenterCommand({ type: "update-notes", slideId: "slide-1", notes: "更新" }), true);
  assert.equal(isPresenterCommand({ type: "finish-notes", slideId: "slide-1" }), true);
  assert.equal(isPresenterCommand({ type: "clear-drawing", slideId: "slide-1" }), true);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "laser", color: "#ef4444", phase: "start", strokeId: "stroke-1", x: 683, y: 384 } }), true);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "pen", color: "#2563eb", phase: "move", strokeId: "stroke-2", x: 1600, y: 900 } }), true);
  assert.equal(isPresenterCommand({ type: "unknown" }), false);
  assert.equal(isPresenterCommand({ type: "next-slide", extra: true }), false);
  assert.equal(isPresenterCommand({ type: "set-slide", slideId: "" }), false);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "laser", color: "#ef4444", phase: "move", strokeId: "stroke-1", x: -1, y: 10 } }), false);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "brush", color: "#ef4444", phase: "move", strokeId: "stroke-1", x: 10, y: 10 } }), false);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "laser", color: "hotpink", phase: "move", strokeId: "stroke-1", x: 10, y: 10 } }), false);
  assert.equal(isPresenterCommand({ type: "draw", event: { slideId: "slide-1", tool: "laser", color: "#ef4444", phase: "move", strokeId: "stroke-1", x: 16_385, y: 10 } }), false);
  assert.equal(isPresenterCommand({ type: "update-notes", slideId: "slide-1", notes: "ok", extra: true }), false);
});

test("Presenter snapshot guard validates nested arrays, the current slide, and the file base URL", () => {
  const snapshot = validSnapshot();
  assert.equal(isPresenterSnapshot(snapshot), true);
  assert.equal(isPresenterSnapshot({ ...snapshot, currentSlideId: "missing" }), false);
  assert.equal(isPresenterSnapshot({ ...snapshot, sourceBaseUrl: "https://example.com/" }), false);
  assert.equal(isPresenterSnapshot({ ...snapshot, manifest: { ...snapshot.manifest, patches: [{ type: "unknown" }] } }), false);
  assert.equal(isPresenterSnapshot({ ...snapshot, unexpectedProjectPath: "C:\\private\\deck.html" }), false);
});
