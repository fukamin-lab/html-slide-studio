import { test } from "node:test";
import assert from "node:assert/strict";
import { setPendingLaunchHtmlPath, takePendingLaunchHtmlPath } from "../../src/main/launchFiles.ts";

test("pending launch paths are retained in FIFO order", () => {
  setPendingLaunchHtmlPath(null);
  setPendingLaunchHtmlPath("A.html");
  setPendingLaunchHtmlPath("B.html");
  setPendingLaunchHtmlPath("C.html");
  assert.equal(takePendingLaunchHtmlPath(), "A.html");
  assert.equal(takePendingLaunchHtmlPath(), "B.html");
  assert.equal(takePendingLaunchHtmlPath(), "C.html");
  assert.equal(takePendingLaunchHtmlPath(), null);
});
