import { test } from "node:test";
import assert from "node:assert/strict";
import { isEditorSender, registerEditorWindow, requireEditorSender } from "../../src/main/editorWindowRegistry.ts";

test("editor sender registry accepts only the registered live WebContents", () => {
  const sender = { isDestroyed: () => false };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
    once: () => undefined
  };
  registerEditorWindow(window);
  assert.equal(isEditorSender(sender), true);
  assert.equal(requireEditorSender(sender), window);
  assert.equal(isEditorSender({ isDestroyed: () => false }), false);
  assert.throws(() => requireEditorSender({ isDestroyed: () => false }), /did not originate/);
});
