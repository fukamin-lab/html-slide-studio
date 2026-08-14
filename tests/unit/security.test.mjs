import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternalUrl, isSameRendererLocation } from "../../src/main/securityPolicy.ts";

test("external URL policy permits only HTTPS and mailto", () => {
  assert.equal(isAllowedExternalUrl("https://example.com/path"), true);
  assert.equal(isAllowedExternalUrl("mailto:security@example.com"), true);
  for (const value of [
    "http://example.com",
    "file:///C:/secret.html",
    "javascript:alert(1)",
    "data:text/html,hello",
    "not-a-url"
  ]) assert.equal(isAllowedExternalUrl(value), false);
});

test("renderer navigation requires exact protocol, host, path, and query", () => {
  const current = "file:///C:/app/out/renderer/index.html?view=presenter";
  assert.equal(isSameRendererLocation(current, current), true);
  assert.equal(isSameRendererLocation(current, "file:///C:/app/out/renderer/index.html"), false);
  assert.equal(isSameRendererLocation(current, "file:///C:/app/out/renderer/other.html?view=presenter"), false);
  assert.equal(isSameRendererLocation(current, "https://example.com/index.html?view=presenter"), false);
});
