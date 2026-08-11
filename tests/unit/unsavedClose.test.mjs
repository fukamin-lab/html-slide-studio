import { test } from "node:test";
import assert from "node:assert/strict";
import { registerUnsavedClosePrompt } from "../../src/main/unsavedClose.ts";

function createSource() {
  let listener = null;
  return {
    source: {
      on(event, nextListener) {
        assert.equal(event, "will-prevent-unload");
        listener = nextListener;
      }
    },
    emit(event) {
      assert.ok(listener);
      listener(event);
    }
  };
}

test("dirty close remains blocked when the owner cancels", () => {
  const fixture = createSource();
  let prevented = false;
  registerUnsavedClosePrompt(fixture.source, () => false);
  fixture.emit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test("dirty close proceeds only when the owner chooses to discard changes", () => {
  const fixture = createSource();
  let prevented = false;
  registerUnsavedClosePrompt(fixture.source, () => true);
  fixture.emit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});
