import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternalUrl, isSameRendererLocation } from "../../src/main/securityPolicy.ts";
import { isUnsafeSlideUrl } from "../../src/renderer/editor/slideUrlPolicy.ts";
import { resolveElectronBinaryPath } from "../../scripts/lib/electron-binary-path.mjs";

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

test("slide URL sanitizer blocks executable and embedded-document schemes", () => {
  for (const value of [
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "VBScript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/id"
  ]) assert.equal(isUnsafeSlideUrl(value), true, value);

  for (const value of ["https://example.com/image.png", "file:///C:/slides/image.png", "./image.png", "#section"]) {
    assert.equal(isUnsafeSlideUrl(value), false, value);
  }
});

test("Electron binary path stays inside the package dist directory", () => {
  const root = "C:\\workspace\\node_modules\\electron";
  assert.equal(resolveElectronBinaryPath(root, "electron.exe\r\n"), "C:\\workspace\\node_modules\\electron\\dist\\electron.exe");
  for (const value of ["", "../electron.exe", "subdir/electron.exe", "C:\\Windows\\System32\\cmd.exe"]) {
    assert.equal(resolveElectronBinaryPath(root, value), null, value);
  }
});
