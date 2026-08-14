import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathPayload, isSavePayload } from "../../src/main/filePayloadGuards.ts";

const validSave = {
  filePath: "C:\\slides\\deck.html",
  html: "<!doctype html><html><body><section>Slide</section></body></html>",
  expectedFingerprint: "a".repeat(64),
  expectedSlideCount: 1
};

test("file IPC payload guards accept only exact bounded schemas", () => {
  assert.equal(isPathPayload({ filePath: validSave.filePath }), true);
  assert.equal(isPathPayload({ filePath: validSave.filePath, extra: true }), false);
  assert.equal(isPathPayload({ filePath: "relative.html" }), false);
  assert.equal(isPathPayload({ filePath: "C:\\deck.html\0ignored" }), false);

  assert.equal(isSavePayload(validSave), true);
  assert.equal(isSavePayload({ ...validSave, extra: true }), false);
  assert.equal(isSavePayload({ ...validSave, expectedFingerprint: "not-a-sha256" }), false);
  assert.equal(isSavePayload({ ...validSave, expectedSlideCount: 0 }), false);
  assert.equal(isSavePayload({ ...validSave, html: "x".repeat(64 * 1024 * 1024 + 1) }), false);
});

test("file IPC payload guards reject arrays and inherited request objects", () => {
  assert.equal(isPathPayload([validSave.filePath]), false);
  assert.equal(isSavePayload(Object.create(validSave)), false);
});
