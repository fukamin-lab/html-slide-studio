import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/resolve-ts-hook.mjs", import.meta.url);

const {
  estimateSpeakerNotes,
  formatSpeakerNotesDuration
} = await import("../../src/renderer/editor/speakerNotes.ts");

// updateSpeakerNotesInHtml() is covered by the Electron DOM E2E flow.

test("estimateSpeakerNotes: empty or whitespace-only notes yield all zeros", () => {
  assert.deepEqual(estimateSpeakerNotes(""), { characters: 0, words: 0, seconds: 0 });
  assert.deepEqual(estimateSpeakerNotes("   \n  "), { characters: 0, words: 0, seconds: 0 });
});

test("estimateSpeakerNotes: counts latin words and applies a 5-second floor", () => {
  assert.deepEqual(estimateSpeakerNotes("Hello world"), { characters: 10, words: 2, seconds: 5 });
});

test("estimateSpeakerNotes: counts Japanese characters via the CJK/kana ranges", () => {
  assert.deepEqual(estimateSpeakerNotes("こんにちは世界、これはテストです。"), { characters: 17, words: 2, seconds: 5 });
});

test("estimateSpeakerNotes: handles mixed Japanese/Latin text", () => {
  assert.deepEqual(estimateSpeakerNotes("Hello 世界 test"), { characters: 11, words: 2, seconds: 5 });
});

test("estimateSpeakerNotes: digit-only text is treated as a single latin word", () => {
  assert.deepEqual(estimateSpeakerNotes("12345"), { characters: 5, words: 1, seconds: 5 });
});

test("formatSpeakerNotesDuration: zero and negative seconds both render as 0:00", () => {
  assert.equal(formatSpeakerNotesDuration(0), "0:00");
  assert.equal(formatSpeakerNotesDuration(-5), "0:00");
});

test("formatSpeakerNotesDuration: formats m:ss with zero-padded seconds", () => {
  assert.equal(formatSpeakerNotesDuration(5), "0:05");
  assert.equal(formatSpeakerNotesDuration(65), "1:05");
  assert.equal(formatSpeakerNotesDuration(120), "2:00");
  assert.equal(formatSpeakerNotesDuration(600), "10:00");
});

test("estimateSpeakerNotes treats rich-looking markers as literal plain text", () => {
  const estimate = estimateSpeakerNotes("**強調** [red]注意[/red]");
  assert.equal(estimate.characters, 19);
  assert.ok(estimate.seconds >= 5);
});
