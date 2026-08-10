import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// overlayMutations.ts imports `./transform` with no extension; see
// tests/unit/support/resolve-ts-hook.mjs and tests/unit/README.md for why
// this hook is registered and why the module must be dynamically imported.
register("./support/resolve-ts-hook.mjs", import.meta.url);

const { updateOverlay, updateOverlayStyle } = await import(
  "../../src/renderer/editor/overlayMutations.ts"
);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function mkOverlays() {
  return [
    { id: "o1", type: "overlayText", slideId: "s1", x: 0, y: 0, width: 10, height: 10, text: "hi", style: {}, updatedAt: "t0" },
    { id: "o2", type: "overlayText", slideId: "s1", x: 20, y: 20, width: 10, height: 10, text: "second", style: {}, updatedAt: "t0" },
    { id: "o3", type: "overlayImage", slideId: "s1", x: 40, y: 40, width: 10, height: 10, text: "image", src: "assets/image.png", style: {}, updatedAt: "t0" }
  ];
}

test("updateOverlay: patches only the matching overlay and stamps it with a fresh ISO updatedAt", () => {
  const result = updateOverlay(mkOverlays(), "o1", { text: "changed" });
  assert.equal(result[0].text, "changed");
  assert.match(result[0].updatedAt, ISO_DATE_RE);
  // Untouched overlays keep their original (non-ISO) placeholder updatedAt.
  assert.equal(result[1].updatedAt, "t0");
  assert.equal(result[2].updatedAt, "t0");
});

test("updateOverlayStyle: parses transform into x/y, clamps width/height to a minimum of 8, and strips transform/width/height from the stored style", () => {
  const result = updateOverlayStyle(mkOverlays(), "o2", {
    transform: "translate(15px, 25px)",
    width: "3px",
    height: "200px",
    color: "#123456"
  });
  const o2 = result.find((o) => o.id === "o2");
  assert.equal(o2.x, 15);
  assert.equal(o2.y, 25);
  assert.equal(o2.width, 8); // clamped up from 3
  assert.equal(o2.height, 200);
  assert.deepEqual(o2.style, { color: "#123456" });
  assert.match(o2.updatedAt, ISO_DATE_RE);

  const untouched = result.find((o) => o.id === "o1");
  assert.equal(untouched.x, 0);
  assert.equal(untouched.updatedAt, "t0");
});

test("updateOverlayStyle: with no transform/width/height in the style, x/y/width/height are preserved", () => {
  const result = updateOverlayStyle(mkOverlays(), "o1", { color: "#000" });
  const o1 = result.find((o) => o.id === "o1");
  assert.equal(o1.x, 0);
  assert.equal(o1.y, 0);
  assert.equal(o1.width, 10);
  assert.equal(o1.height, 10);
});
