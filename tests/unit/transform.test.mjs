import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranslate, formatTranslate, readPixelValue } from "../../src/renderer/editor/transform.ts";

test("parseTranslate: undefined and 'none' both yield the zero vector", () => {
  assert.deepEqual(parseTranslate(undefined), { x: 0, y: 0 });
  assert.deepEqual(parseTranslate("none"), { x: 0, y: 0 });
});

test("parseTranslate: parses a two-argument translate(...)", () => {
  assert.deepEqual(parseTranslate("translate(10px, 20px)"), { x: 10, y: 20 });
});

test("parseTranslate: parses negative and fractional values", () => {
  assert.deepEqual(parseTranslate("translate(-5.5px, 0px)"), { x: -5.5, y: 0 });
});

test("parseTranslate: a single-argument translate() defaults y to 0", () => {
  assert.deepEqual(parseTranslate("translate(10px)"), { x: 10, y: 0 });
});

test("parseTranslate: falls back to the matrix(...) 5th/6th arguments", () => {
  assert.deepEqual(parseTranslate("matrix(1, 0, 0, 1, 15, 25)"), { x: 15, y: 25 });
});

test("parseTranslate: unrecognized transform strings yield the zero vector", () => {
  assert.deepEqual(parseTranslate("rotate(45deg)"), { x: 0, y: 0 });
});

test("characterization: a space before the comma in translate(...) breaks the match (current behavior)", () => {
  // The regex requires the comma to directly follow the "px" of the first
  // number (`px(?:,\s*...)?`), so `translate( 3px , 4px )` fails to match
  // entirely and silently falls back to { x: 0, y: 0 } instead of parsing
  // 3/4. This looks like a bug but is asserted here as-is per the
  // characterization contract.
  assert.deepEqual(parseTranslate("translate( 3px , 4px )"), { x: 0, y: 0 });
});

test("formatTranslate: rounds to the nearest pixel", () => {
  assert.equal(formatTranslate(10.4, 20.6), "translate(10px, 21px)");
  assert.equal(formatTranslate(0, 0), "translate(0px, 0px)");
  assert.equal(formatTranslate(2.5, 3.5), "translate(3px, 4px)");
});

test("characterization: Math.round(-5.5) rounds toward +Infinity, i.e. to -5", () => {
  assert.equal(formatTranslate(-5.5, -5.5), "translate(-5px, -5px)");
});

test("readPixelValue: parses a numeric-with-unit string", () => {
  assert.equal(readPixelValue("12px", 0), 12);
  assert.equal(readPixelValue("12.5px", 0), 12.5);
});

test("readPixelValue: falls back when the value is undefined, empty, or unparsable", () => {
  assert.equal(readPixelValue(undefined, 5), 5);
  assert.equal(readPixelValue("", 7), 7);
  assert.equal(readPixelValue("abc", 3), 3);
});
