import { test } from "node:test";
import assert from "node:assert/strict";
import { camelToKebab, cssColorToHex } from "../../src/renderer/editor/css.ts";

// NOTE: `cssEscape` from this module is intentionally NOT tested here.
// It unconditionally evaluates `"CSS" in window`, and `window` is not
// defined in a plain Node environment (confirmed: calling it throws
// `ReferenceError: window is not defined`). See tests/unit/README.md.

test("camelToKebab: converts camelCase property names to kebab-case", () => {
  assert.equal(camelToKebab("backgroundColor"), "background-color");
  assert.equal(camelToKebab("fontSize"), "font-size");
  assert.equal(camelToKebab("borderTopLeftRadius"), "border-top-left-radius");
});

test("camelToKebab: leaves already-lowercase and empty strings unchanged", () => {
  assert.equal(camelToKebab("color"), "color");
  assert.equal(camelToKebab(""), "");
});

test("cssColorToHex: undefined, transparent, and rgba(0,0,0,0) all resolve to the fallback", () => {
  assert.equal(cssColorToHex(undefined), "#ffffff");
  assert.equal(cssColorToHex("transparent"), "#ffffff");
  assert.equal(cssColorToHex("rgba(0, 0, 0, 0)"), "#ffffff");
});

test("cssColorToHex: a custom fallback is honored", () => {
  assert.equal(cssColorToHex("not-a-color", "#000000"), "#000000");
});

test("cssColorToHex: a lowercase 6-digit hex string passes through unchanged", () => {
  assert.equal(cssColorToHex("#1a2b3c"), "#1a2b3c");
});

test("characterization: an uppercase 6-digit hex string passes through WITHOUT lowercasing", () => {
  // The regex test is case-insensitive (`/i`) but the matched branch returns
  // `color` verbatim rather than the lowercased form. Kept as-is.
  assert.equal(cssColorToHex("#1A2B3C"), "#1A2B3C");
});

test("cssColorToHex: converts rgb()/rgba() to hex, clamping to a byte per channel", () => {
  assert.equal(cssColorToHex("rgb(255, 0, 128)"), "#ff0080");
  assert.equal(cssColorToHex("rgba(10, 20, 30, 1)"), "#0a141e");
});

test("characterization: a negative channel breaks the rgba(...) regex match entirely, falling back", () => {
  // `(\d+)` cannot match a leading "-", so `rgba(300, -10, 999, 0.5)` fails
  // the whole match (no partial/clamped parse is attempted) and the
  // function returns the fallback color instead of a clamped value.
  assert.equal(cssColorToHex("rgba(300, -10, 999, 0.5)"), "#ffffff");
});
