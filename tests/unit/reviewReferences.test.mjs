import { test } from "node:test";
import assert from "node:assert/strict";

const { extractExternalReferenceValues } = await import("../../src/renderer/editor/reviewReferences.ts");

test("external reference extraction covers srcset candidates", () => {
  assert.deepEqual(
    extractExternalReferenceValues("srcset", "data:image/png;base64,AAAA 1x, images/local.png 2x, https://example.com/remote.png 3x"),
    ["https://example.com/remote.png"]
  );
});

test("external reference extraction covers CSS url and import including escapes", () => {
  assert.deepEqual(
    extractExternalReferenceValues("css", "@import 'https://example.com/theme.css'; background:url(h\\74tps://example.com/bg.png)"),
    ["https://example.com/theme.css", "https://example.com/bg.png"]
  );
});

test("external reference extraction accepts SVG URL-bearing attributes", () => {
  assert.deepEqual(
    extractExternalReferenceValues("attribute", "https://example.com/icons.svg#check"),
    ["https://example.com/icons.svg#check"]
  );
});
