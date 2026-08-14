import { parse } from "parse5";

type HtmlAttribute = {
  name: string;
  value: string;
  prefix?: string | null;
};

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode | null;
  value?: string;
};

export type HtmlReference = {
  value: string;
  source: "attribute" | "srcset" | "css";
  attributeName?: string;
};

export type HtmlSemanticSnapshot = {
  slideCount: number;
  idCount: number;
  internalReferenceCount: number;
};

const URL_ATTRIBUTES = new Set(["src", "href", "xlink:href", "poster", "action", "formaction", "data", "background"]);
const CSS_URL_ATTRIBUTES = new Set([
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor"
]);
const IDREF_ATTRIBUTES = new Set([
  "for",
  "form",
  "headers",
  "list",
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns"
]);

export function extractHtmlReferences(html: string): HtmlReference[] {
  return extractReferencesFromDocument(parseDocument(html));
}

export function decodeHtmlReference(reference: HtmlReference): string {
  const trimmed = reference.value.trim();
  const decoded = reference.source === "css" ? decodeCssEscapes(trimmed) : trimmed;
  return decodePercentEncoding(decoded).trim();
}

export function htmlReferenceCandidates(reference: HtmlReference): string[] {
  const raw = decodePercentEncoding(reference.value.trim()).trim();
  if (reference.source !== "css") return [raw];
  return [...new Set([raw, decodePercentEncoding(decodeCssEscapes(reference.value.trim())).trim()])];
}

export function validateHtmlSemanticOutput(html: string, expectedSlideCount: number): HtmlSemanticSnapshot {
  if (!Number.isInteger(expectedSlideCount) || expectedSlideCount < 1 || expectedSlideCount > 10_000) {
    throw new Error("Saved HTML slide count contract is invalid");
  }

  const document = parseDocument(html);
  const elements = allElements(document);
  const ids = new Set<string>();
  for (const element of elements) {
    const id = attributeValue(element, "id");
    if (!id) continue;
    if (ids.has(id)) {
      throw new Error(`Saved HTML contains a duplicate id: ${id}`);
    }
    ids.add(id);
  }

  const internalReferences: string[] = [];
  for (const element of elements) {
    for (const attribute of element.attrs ?? []) {
      const name = qualifiedAttributeName(attribute);
      if (IDREF_ATTRIBUTES.has(name)) {
        internalReferences.push(...attribute.value.trim().split(/\s+/).filter(Boolean));
      }
      if ((name === "href" || name === "xlink:href") && attribute.value.trim().startsWith("#")) {
        const reference = decodePercentEncoding(attribute.value.trim()).slice(1);
        if (reference) internalReferences.push(reference);
      }
    }
  }
  for (const reference of extractReferencesFromDocument(document)) {
    if (reference.source !== "css") continue;
    const decoded = decodeHtmlReference(reference);
    if (decoded.startsWith("#") && decoded.length > 1) internalReferences.push(decoded.slice(1));
  }

  for (const reference of internalReferences) {
    if (!ids.has(reference)) {
      throw new Error(`Saved HTML contains an unresolved internal reference: ${reference}`);
    }
  }

  const slideCount = detectSlideCount(document);
  if (slideCount !== expectedSlideCount) {
    throw new Error(`Saved HTML slide count changed unexpectedly (${slideCount} instead of ${expectedSlideCount})`);
  }

  return {
    slideCount,
    idCount: ids.size,
    internalReferenceCount: internalReferences.length
  };
}

function parseDocument(html: string): HtmlNode {
  return parse(html) as unknown as HtmlNode;
}

function extractReferencesFromDocument(document: HtmlNode, embeddedDepth = 0): HtmlReference[] {
  const references: HtmlReference[] = [];
  for (const element of allElements(document)) {
    for (const attribute of element.attrs ?? []) {
      const name = qualifiedAttributeName(attribute);
      if (URL_ATTRIBUTES.has(name)) {
        references.push({ value: attribute.value, source: "attribute", attributeName: name });
      } else if (name === "srcset" || name === "imagesrcset") {
        if (/\bdata:/i.test(attribute.value)) {
          references.push({ value: "data:", source: "srcset", attributeName: name });
          continue;
        }
        for (const candidate of attribute.value.split(",")) {
          const value = candidate.trim().split(/\s+/)[0] ?? "";
          if (value) references.push({ value, source: "srcset", attributeName: name });
        }
      } else if (name === "style" || CSS_URL_ATTRIBUTES.has(name)) {
        for (const value of extractCssReferenceValues(attribute.value)) {
          references.push({ value, source: "css", attributeName: name });
        }
      }
    }

    const srcdoc = attributeValue(element, "srcdoc");
    if (srcdoc !== null) {
      references.push({ value: "srcdoc:", source: "attribute", attributeName: "srcdoc" });
      if (embeddedDepth < 4) references.push(...extractReferencesFromDocument(parseDocument(srcdoc), embeddedDepth + 1));
    }
    if (element.tagName?.toLowerCase() === "meta" && attributeValue(element, "http-equiv")?.trim().toLowerCase() === "refresh") {
      const content = attributeValue(element, "content") ?? "";
      const match = /(?:^|;)\s*url\s*=\s*(?:(["'])(.*?)\1|([^;\s]+))/i.exec(content);
      const value = match?.[2] ?? match?.[3];
      if (value) references.push({ value, source: "attribute", attributeName: "content" });
    }

    if (element.tagName?.toLowerCase() === "style") {
      const css = (element.childNodes ?? [])
        .filter((child) => child.nodeName === "#text")
        .map((child) => child.value ?? "")
        .join("");
      for (const value of extractCssReferenceValues(css)) references.push({ value, source: "css" });
    }
  }
  return references;
}

function extractCssReferenceValues(css: string): string[] {
  const withoutComments = removeCssComments(css);
  const variants = [css, decodeCssEscapes(css), withoutComments, decodeCssEscapes(withoutComments)];
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
      continue;
    }
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      continue;
    }
    result += character;
    index += 1;
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
      let cursor = skipCssSpaceAndComments(css, index + 7);
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
        while (cursor < css.length && css[cursor] !== ")") {
          if (css[cursor] === "\\") cursor = consumeCssEscape(css, cursor);
          else cursor += 1;
        }
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
    if (css[cursor] === "\\") cursor = consumeCssEscape(css, cursor);
    else cursor += 1;
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
    if (index >= value.length) break;
    if (value[index] === "\n" || value[index] === "\r" || value[index] === "\f") {
      if (value[index] === "\r" && value[index + 1] === "\n") index += 1;
      index += 1;
      continue;
    }
    let hex = "";
    while (index < value.length && /[0-9a-f]/i.test(value[index]) && hex.length < 6) {
      hex += value[index];
      index += 1;
    }
    if (hex) {
      const codePoint = Number.parseInt(hex, 16);
      result += codePoint === 0 || codePoint > 0x10ffff ? "\uFFFD" : String.fromCodePoint(codePoint);
      if (/\s/.test(value[index] ?? "")) index += 1;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function decodePercentEncoding(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function detectSlideCount(document: HtmlNode): number {
  const elements = allElements(document);
  const revealSlides = elements.find((element) => hasClass(element, "slides") && ancestors(element).some((ancestor) => hasClass(ancestor, "reveal")));
  if (revealSlides) {
    const sections = elementChildren(revealSlides).filter((element) => element.tagName?.toLowerCase() === "section");
    return sections.length > 0 ? sections.length : 1;
  }

  for (const matcher of [
    (element: HtmlNode) => element.tagName?.toLowerCase() === "section" && hasClass(element, "slide"),
    (element: HtmlNode) => hasAttribute(element, "data-slide"),
    (element: HtmlNode) => element.tagName?.toLowerCase() === "article" && hasClass(element, "slide")
  ]) {
    const all = elements.filter(matcher);
    const topLevel = all.filter((element) => !ancestors(element).some(matcher));
    if (topLevel.length === 0) continue;
    const parent = topLevel[0].parentNode;
    if (!parent || topLevel.some((element) => element.parentNode !== parent)) continue;
    const tag = topLevel[0].tagName?.toLowerCase();
    if (topLevel.some((element) => element.tagName?.toLowerCase() !== tag)) continue;
    const siblings = elementChildren(parent).filter(matcher);
    if (siblings.length > 0) return siblings.length;
  }

  const body = elements.find((element) => element.tagName?.toLowerCase() === "body");
  if (!body) return 1;
  const sections = elementChildren(body).filter((element) => element.tagName?.toLowerCase() === "section");
  if (sections.length > 0) return sections.length;
  const articles = elementChildren(body).filter((element) => element.tagName?.toLowerCase() === "article");
  return articles.length > 0 ? articles.length : 1;
}

function allElements(root: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.tagName) result.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return result;
}

function elementChildren(node: HtmlNode): HtmlNode[] {
  return (node.childNodes ?? []).filter((child) => Boolean(child.tagName));
}

function ancestors(node: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  let current = node.parentNode ?? null;
  while (current) {
    if (current.tagName) result.push(current);
    current = current.parentNode ?? null;
  }
  return result;
}

function hasClass(element: HtmlNode, className: string): boolean {
  return (attributeValue(element, "class") ?? "").split(/\s+/).includes(className);
}

function hasAttribute(element: HtmlNode, name: string): boolean {
  return (element.attrs ?? []).some((attribute) => qualifiedAttributeName(attribute) === name);
}

function attributeValue(element: HtmlNode, name: string): string | null {
  return (element.attrs ?? []).find((attribute) => qualifiedAttributeName(attribute) === name)?.value ?? null;
}

function qualifiedAttributeName(attribute: HtmlAttribute): string {
  return `${attribute.prefix ? `${attribute.prefix}:` : ""}${attribute.name}`.toLowerCase();
}
