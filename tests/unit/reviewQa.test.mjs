import { test } from "node:test";
import assert from "node:assert/strict";

const { buildReviewResult } = await import("../../src/renderer/editor/reviewQa.ts");

const slides = [
  { id: "slide-001", label: "はじめに", selector: "[data-hss-slide-id=slide-001]", index: 0 },
  { id: "slide-002", label: "まとめ", selector: "[data-hss-slide-id=slide-002]", index: 1 }
];

const manifest = {
  version: 1,
  app: "html-slide-studio",
  savedAt: "2026-08-14T00:00:00.000Z",
  warnings: [],
  slides,
  patches: [],
  overlays: []
};

test("buildReviewResult reports issues from every slide with navigation metadata", () => {
  const result = buildReviewResult([
    snapshot("slide-001", "はじめに", [{
      id: "title",
      source: "dom",
      type: "text",
      label: "h1: はじめに",
      slideId: "slide-001",
      text: "はじめに",
      bounds: { x: 20, y: 20, width: 400, height: 80 },
      fontSize: 48
    }]),
    snapshot("slide-002", "まとめ", [{
      id: "tiny-text",
      source: "dom",
      type: "text",
      label: "p: 注釈",
      slideId: "slide-002",
      text: "注釈",
      bounds: { x: 20, y: 120, width: 300, height: 30 },
      fontSize: 10
    }])
  ], manifest);

  assert.equal(result.summary.checkedSlideCount, 2);
  assert.equal(result.summary.warningCount, 1);
  assert.deepEqual(
    result.issues.map(({ kind, slideId, slideLabel, slideIndex, targetId, targetSource }) => ({ kind, slideId, slideLabel, slideIndex, targetId, targetSource })),
    [{
      kind: "small-text",
      slideId: "slide-002",
      slideLabel: "まとめ",
      slideIndex: 1,
      targetId: "tiny-text",
      targetSource: "dom"
    }]
  );
});

test("buildReviewResult deduplicates document-wide references across slide snapshots", () => {
  const first = snapshot("slide-001", "はじめに", []);
  const second = snapshot("slide-002", "まとめ", []);
  first.externalReferences = [{ kind: "attribute", value: "https://example.com/image.png", label: "img" }];
  second.externalReferences = [...first.externalReferences];

  const result = buildReviewResult([first, second], manifest);

  assert.equal(result.summary.checkedSlideCount, 2);
  assert.equal(result.issues.filter((issue) => issue.kind === "external-reference").length, 1);
});

test("buildReviewResult keeps slide and target navigation for an external reference", () => {
  const second = snapshot("slide-002", "まとめ", [{
    id: "external-link",
    source: "dom",
    type: "text",
    label: "a: 外部参照",
    slideId: "slide-002",
    text: "外部参照",
    bounds: { x: 20, y: 120, width: 180, height: 30 },
    fontSize: 20
  }]);
  second.externalReferences = [{
    kind: "attribute",
    value: "https://example.com/reference",
    label: "a",
    attributeName: "href",
    slideId: "slide-002",
    targetId: "external-link",
    targetLabel: "a: 外部参照",
    targetSource: "dom"
  }];

  const [issue] = buildReviewResult([second], manifest).issues;
  assert.deepEqual(
    { slideId: issue.slideId, slideIndex: issue.slideIndex, targetId: issue.targetId, targetSource: issue.targetSource },
    { slideId: "slide-002", slideIndex: 1, targetId: "external-link", targetSource: "dom" }
  );
});

function snapshot(slideId, slideLabel, targets) {
  return {
    checkedAt: "2026-08-14T00:00:00.000Z",
    slideId,
    slideLabel,
    slides,
    slideBounds: { x: 0, y: 0, width: 1366, height: 768 },
    targets,
    externalReferences: []
  };
}
