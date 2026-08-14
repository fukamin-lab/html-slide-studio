export type ReviewReferenceSource = "attribute" | "srcset" | "css";

export const REVIEW_URL_ATTRIBUTES = new Set([
  "src", "href", "xlink:href", "poster", "action", "formaction", "data", "background"
]);

export const REVIEW_CSS_URL_ATTRIBUTES = new Set([
  "style", "fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"
]);

export function extractExternalReferenceValues(source: ReviewReferenceSource, value: string): string[] {
  const candidates = source === "srcset"
    ? extractSrcsetValues(value)
    : source === "css"
      ? extractCssReferenceValues(value)
      : [value.trim()];
  return [...new Set(candidates.map((candidate) => decodePercentEncoding(candidate.trim())).filter(isExternalReference))];
}

function extractSrcsetValues(value: string): string[] {
  return value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

function extractCssReferenceValues(css: string): string[] {
  const clean = removeCssComments(css);
  const variants = [css, decodeCssEscapes(css), clean, decodeCssEscapes(clean)];
  return [...new Set(variants.flatMap(scanCssReferenceValues))];
}

function removeCssComments(css: string): string {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === '"' || character === "'") {
      const parsed = consumeCssString(css, index);
      result += css.slice(index, parsed.nextIndex);
      index = parsed.nextIndex;
    } else if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}

function scanCssReferenceValues(css: string): string[] {
  const references: string[] = [];
  let index = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      continue;
    }
    const character = css[index];
    if (character === '"' || character === "'") {
      index = consumeCssString(css, index).nextIndex;
      continue;
    }
    if (character === "@" && startsCssWord(css, index + 1, "import")) {
      const cursor = skipCssSpaceAndComments(css, index + 7);
      if (css[cursor] === '"' || css[cursor] === "'") {
        const parsed = consumeCssString(css, cursor);
        references.push(parsed.value);
        index = parsed.nextIndex;
        continue;
      }
    }
    if (startsCssWord(css, index, "url")) {
      let cursor = index + 3;
      while (/\s/.test(css[cursor] ?? "")) cursor += 1;
      if (css[cursor] === "(") {
        cursor += 1;
        while (/\s/.test(css[cursor] ?? "")) cursor += 1;
        if (css[cursor] === '"' || css[cursor] === "'") {
          const parsed = consumeCssString(css, cursor);
          references.push(parsed.value);
          index = skipToCssClosingParenthesis(css, parsed.nextIndex);
          continue;
        }
        const start = cursor;
        while (cursor < css.length && css[cursor] !== ")") cursor = css[cursor] === "\\" ? consumeCssEscape(css, cursor) : cursor + 1;
        references.push(css.slice(start, cursor).trim());
        index = cursor < css.length ? cursor + 1 : cursor;
        continue;
      }
    }
    index += 1;
  }
  return references.filter(Boolean);
}

function consumeCssString(css: string, quoteIndex: number): { value: string; nextIndex: number } {
  const quote = css[quoteIndex];
  let cursor = quoteIndex + 1;
  const start = cursor;
  while (cursor < css.length) {
    if (css[cursor] === quote) return { value: css.slice(start, cursor), nextIndex: cursor + 1 };
    cursor = css[cursor] === "\\" ? consumeCssEscape(css, cursor) : cursor + 1;
  }
  return { value: css.slice(start), nextIndex: css.length };
}

function consumeCssEscape(css: string, slashIndex: number): number {
  let cursor = slashIndex + 1;
  let hexDigits = 0;
  while (cursor < css.length && /[0-9a-f]/i.test(css[cursor]) && hexDigits < 6) {
    cursor += 1;
    hexDigits += 1;
  }
  if (hexDigits > 0 && /\s/.test(css[cursor] ?? "")) return cursor + 1;
  return Math.min(css.length, cursor + (hexDigits === 0 ? 1 : 0));
}

function skipToCssClosingParenthesis(css: string, start: number): number {
  let cursor = start;
  while (/\s/.test(css[cursor] ?? "")) cursor += 1;
  return css[cursor] === ")" ? cursor + 1 : cursor;
}

function skipCssSpaceAndComments(css: string, start: number): number {
  let cursor = start;
  while (cursor < css.length) {
    while (/\s/.test(css[cursor] ?? "")) cursor += 1;
    if (!css.startsWith("/*", cursor)) break;
    const end = css.indexOf("*/", cursor + 2);
    cursor = end < 0 ? css.length : end + 2;
  }
  return cursor;
}

function startsCssWord(css: string, index: number, word: string): boolean {
  if (css.slice(index, index + word.length).toLowerCase() !== word) return false;
  const before = css[index - 1] ?? "";
  const after = css[index + word.length] ?? "";
  return !/[\w-]/.test(before) && !/[\w-]/.test(after);
}

function decodeCssEscapes(value: string): string {
  let result = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\") {
      result += value[index];
      index += 1;
      continue;
    }
    index += 1;
    let hex = "";
    while (index < value.length && /[0-9a-f]/i.test(value[index]) && hex.length < 6) {
      hex += value[index];
      index += 1;
    }
    if (hex) {
      result += String.fromCodePoint(Number.parseInt(hex, 16));
      if (/\s/.test(value[index] ?? "")) index += 1;
    } else if (index < value.length) {
      result += value[index];
      index += 1;
    }
  }
  return result;
}

function decodePercentEncoding(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isExternalReference(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
