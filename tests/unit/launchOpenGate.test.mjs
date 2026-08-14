import { test } from "node:test";
import assert from "node:assert/strict";
import { createLaunchOpenGate } from "../../src/renderer/launchOpenGate.ts";

test("second-instance launch remains pending throughout an active save", async () => {
  const applied = [];
  let consumeCount = 0;
  const queued = [{ filePath: "B.html" }];
  const gate = createLaunchOpenGate({
    consume: async () => {
      consumeCount += 1;
      return queued.shift() ?? null;
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
  assert.equal(consumeCount, 2, "the queue is drained until main reports it empty");
  assert.deepEqual(applied, ["B.html"]);
});

test("launch result already in flight is deferred when save starts", async () => {
  const applied = [];
  let releaseConsume;
  const consumeGate = new Promise((resolve) => { releaseConsume = resolve; });
  const queued = [{ filePath: "B.html" }];
  const gate = createLaunchOpenGate({
    consume: async () => {
      await consumeGate;
      return queued.shift() ?? null;
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
  const queued = [{ filePath: "A.html", fingerprint: "old" }];
  const gate = createLaunchOpenGate({
    consume: async () => {
      await openGate;
      return queued.shift() ?? null;
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

test("one coalesced notification drains queued launch files in FIFO order", async () => {
  const queued = [
    { filePath: "A.html" },
    { filePath: "B.html" },
    { filePath: "C.html" }
  ];
  const applied = [];
  const gate = createLaunchOpenGate({
    consume: async () => queued.shift() ?? null,
    apply: (value) => applied.push(value.filePath),
    onConsumeStart: () => undefined,
    onConsumeEnd: () => undefined,
    onError: (error) => assert.fail(error)
  });

  await gate.notify();
  assert.deepEqual(applied, ["A.html", "B.html", "C.html"]);
});

test("bounded launch draining yields before consuming the next batch", async () => {
  const queued = Array.from({ length: 65 }, (_, index) => ({ filePath: `${index + 1}.html` }));
  const applied = [];
  let consumeCount = 0;
  const gate = createLaunchOpenGate({
    consume: async () => {
      consumeCount += 1;
      return queued.shift() ?? null;
    },
    apply: (value) => applied.push(value.filePath),
    onConsumeStart: () => undefined,
    onConsumeEnd: () => undefined,
    onError: (error) => assert.fail(error)
  });

  await gate.notify();
  while (applied.length < 65) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consumeCount, 66, "the 65th value must remain queued until the next bounded drain");
  assert.equal(applied.length, 65);
  assert.equal(applied[64], "65.html");
});
