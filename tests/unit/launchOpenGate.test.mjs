import { test } from "node:test";
import assert from "node:assert/strict";
import { createLaunchOpenGate } from "../../src/renderer/launchOpenGate.ts";

test("second-instance launch remains pending throughout an active save", async () => {
  const applied = [];
  let consumeCount = 0;
  const gate = createLaunchOpenGate({
    consume: async () => {
      consumeCount += 1;
      return { filePath: "B.html" };
    },
    apply: (value) => applied.push(value.filePath),
    onConsumeStart: () => undefined,
    onConsumeEnd: () => undefined,
    onError: (error) => assert.fail(error)
  });

  gate.beginBlockingOperation();
  await gate.notify();
  assert.equal(consumeCount, 0, "the pending launch path must not be consumed during save");
  assert.deepEqual(applied, []);

  await gate.endBlockingOperation();
  assert.equal(consumeCount, 1);
  assert.deepEqual(applied, ["B.html"]);
});

test("launch result already in flight is deferred when save starts", async () => {
  const applied = [];
  let releaseConsume;
  const consumeGate = new Promise((resolve) => { releaseConsume = resolve; });
  const gate = createLaunchOpenGate({
    consume: async () => {
      await consumeGate;
      return { filePath: "B.html" };
    },
    apply: (value) => applied.push(value.filePath),
    onConsumeStart: () => undefined,
    onConsumeEnd: () => undefined,
    onError: (error) => assert.fail(error)
  });

  const launched = gate.notify();
  await new Promise((resolve) => setImmediate(resolve));
  gate.beginBlockingOperation();
  releaseConsume();
  await launched;
  assert.deepEqual(applied, [], "an in-flight launch must not replace the document during save");

  await gate.endBlockingOperation();
  assert.deepEqual(applied, ["B.html"]);
});

test("same-path launch open owns the document operation until its payload is applied", async () => {
  const applied = [];
  let documentOperation = null;
  let releaseOpen;
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const gate = createLaunchOpenGate({
    consume: async () => {
      await openGate;
      return { filePath: "A.html", fingerprint: "old" };
    },
    apply: (value) => applied.push(`${value.filePath}:${value.fingerprint}`),
    onConsumeStart: () => {
      assert.equal(documentOperation, null);
      documentOperation = "launch-open";
    },
    onConsumeEnd: () => {
      assert.equal(documentOperation, "launch-open");
      documentOperation = null;
    },
    onError: (error) => assert.fail(error)
  });

  const launched = gate.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentOperation, "launch-open");

  const saveStarted = documentOperation === null;
  assert.equal(saveStarted, false, "save must not start while the same-path launch open is in flight");

  releaseOpen();
  await launched;
  assert.equal(documentOperation, null);
  assert.deepEqual(applied, ["A.html:old"]);
});
