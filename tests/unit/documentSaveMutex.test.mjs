import { test } from "node:test";
import assert from "node:assert/strict";
import { withDocumentSaveLock } from "../../src/main/documentSaveMutex.ts";

test("same-document saves run strictly in arrival order", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withDocumentSaveLock("C:\\slides\\deck.html", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = withDocumentSaveLock("c:\\SLIDES\\DECK.HTML", async () => {
    events.push("second-start");
    events.push("second-end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("different documents are not blocked by each other", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withDocumentSaveLock("C:\\slides\\a.html", async () => {
    events.push("a-start");
    await firstGate;
  });
  const second = withDocumentSaveLock("C:\\slides\\b.html", async () => events.push("b-start"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.sort(), ["a-start", "b-start"]);
  releaseFirst();
  await Promise.all([first, second]);
});

test("same-document open and recovery wait for an active save", async () => {
  const events = [];
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const save = withDocumentSaveLock("C:\\slides\\deck.html", async () => {
    events.push("save-start");
    await saveGate;
    events.push("save-end");
  });
  const open = withDocumentSaveLock("c:\\SLIDES\\DECK.HTML", async () => {
    events.push("open-and-recovery");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["save-start"]);
  releaseSave();
  await Promise.all([save, open]);
  assert.deepEqual(events, ["save-start", "save-end", "open-and-recovery"]);
});
