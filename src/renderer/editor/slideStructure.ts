export type SlideStructure = {
  nodes: HTMLElement[];
  container: HTMLElement;
  kind: "reveal" | "section-slide" | "data-slide" | "article-slide" | "body-sections" | "body-articles";
};

export type SlideMutation =
  | { type: "add"; index: number }
  | { type: "duplicate"; index: number }
  | { type: "move"; index: number; direction: -1 | 1 };

export type SlideMutationResult = {
  html: string;
  selectedIndex: number;
  slideCount: number;
};

export type SlideMutationAvailability = {
  enabled: boolean;
  reason?: string;
};

const IDREF_TOKEN_ATTRIBUTES = ["for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "headers"];

export function detectSlideStructure(document: Document): SlideStructure | null {
  const revealContainer = document.querySelector(".reveal .slides");
  if (revealContainer instanceof HTMLElement) {
    const nodes = directChildrenMatching(revealContainer, "section");
    if (nodes.length > 0) {
      return { nodes, container: revealContainer, kind: "reveal" };
    }
    return null;
  }

  for (const [selector, kind] of [
    ["section.slide", "section-slide"],
    ["[data-slide]", "data-slide"],
    ["article.slide", "article-slide"]
  ] as const) {
    const structure = commonParentStructure(document, selector, kind);
    if (structure) {
      return structure;
    }
  }

  const bodySections = directChildrenMatching(document.body, "section");
  if (bodySections.length > 0) {
    return { nodes: bodySections, container: document.body, kind: "body-sections" };
  }
  const bodyArticles = directChildrenMatching(document.body, "article");
  if (bodyArticles.length > 0) {
    return { nodes: bodyArticles, container: document.body, kind: "body-articles" };
  }
  return null;
}

export function detectSlidesForPreview(document: Document): { nodes: HTMLElement[]; usedFallback: boolean } {
  const structure = detectSlideStructure(document);
  return structure
    ? { nodes: structure.nodes, usedFallback: structure.kind === "body-sections" || structure.kind === "body-articles" }
    : { nodes: [document.body], usedFallback: true };
}

export function getSlideMutationAvailability(sourceHtml: string): SlideMutationAvailability {
  const document = new DOMParser().parseFromString(sourceHtml, "text/html");
  const structure = detectSlideStructure(document);
  if (!structure || structure.nodes.length === 0) {
    return { enabled: false, reason: "スライド構造を安全に判定できないため、構成変更は利用できません。" };
  }
  if (structure.kind === "body-sections" || structure.kind === "body-articles") {
    return { enabled: false, reason: "汎用の section / article とスライドを区別できないため、追加・複製・並べ替えは利用できません。" };
  }
  return { enabled: true };
}

export function mutateSlideDocument(sourceHtml: string, mutation: SlideMutation): SlideMutationResult {
  const document = new DOMParser().parseFromString(sourceHtml, "text/html");
  const structure = detectSlideStructure(document);
  if (
    !structure ||
    structure.nodes.length === 0 ||
    structure.kind === "body-sections" ||
    structure.kind === "body-articles"
  ) {
    throw new Error("スライド構造を安全に判定できないため、追加・複製・並べ替えはできません。");
  }

  const index = clampIndex(mutation.index, structure.nodes.length);
  let selectedIndex = index;
  if (mutation.type === "add") {
    const next = createBlankSlide(document, structure.nodes[index]);
    structure.nodes[index].after(next);
    selectedIndex = index + 1;
  } else if (mutation.type === "duplicate") {
    const clone = structure.nodes[index].cloneNode(true) as HTMLElement;
    regenerateCloneIdentifiers(clone, document);
    clone.setAttribute("data-label", duplicateLabel(structure.nodes[index], index));
    structure.nodes[index].after(clone);
    selectedIndex = index + 1;
  } else {
    const destination = index + mutation.direction;
    if (destination < 0 || destination >= structure.nodes.length) {
      return { html: serializeHtmlDocument(document), selectedIndex: index, slideCount: structure.nodes.length };
    }
    const node = structure.nodes[index];
    if (mutation.direction < 0) {
      structure.nodes[destination].before(node);
    } else {
      structure.nodes[destination].after(node);
    }
    selectedIndex = destination;
  }

  const updated = detectSlideStructure(document);
  if (!updated) {
    throw new Error("スライド操作後の構造検証に失敗しました。");
  }
  updated.nodes.forEach((node) => node.removeAttribute("data-hss-slide-id"));
  return {
    html: serializeHtmlDocument(document),
    selectedIndex,
    slideCount: updated.nodes.length
  };
}

export function serializeHtmlDocument(document: Document): string {
  const doctype = document.doctype ? `<!doctype ${document.doctype.name}>\n` : "<!doctype html>\n";
  return `${doctype}${document.documentElement.outerHTML}`;
}

function commonParentStructure(
  document: Document,
  selector: string,
  kind: SlideStructure["kind"]
): SlideStructure | null {
  const all = Array.from(document.querySelectorAll(selector)).filter((node): node is HTMLElement => node instanceof HTMLElement);
  const topLevel = all.filter((node) => !all.some((candidate) => candidate !== node && candidate.contains(node)));
  if (topLevel.length === 0) {
    return null;
  }
  const parent = topLevel[0].parentElement;
  if (!parent || topLevel.some((node) => node.parentElement !== parent)) {
    return null;
  }
  const nodes = Array.from(parent.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.matches(selector));
  return nodes.length > 0 ? { nodes, container: parent, kind } : null;
}

function directChildrenMatching(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.matches(selector));
}

function createBlankSlide(document: Document, reference: HTMLElement): HTMLElement {
  const slide = document.createElement(reference.tagName.toLowerCase());
  for (const attribute of Array.from(reference.attributes)) {
    if (
      attribute.name === "id" ||
      attribute.name === "data-label" ||
      attribute.name === "data-speaker-notes" ||
      attribute.name.startsWith("data-hss-")
    ) {
      continue;
    }
    slide.setAttribute(attribute.name, attribute.value);
  }
  slide.setAttribute("data-label", "新しいスライド");
  slide.setAttribute("data-speaker-notes", "");

  const headingReference = reference.querySelector("h1, h2, h3");
  const heading = document.createElement(headingReference?.tagName.toLowerCase() ?? "h2");
  if (headingReference?.getAttribute("class")) {
    heading.setAttribute("class", headingReference.getAttribute("class") ?? "");
  }
  heading.textContent = "新しいスライド";

  const bodyReference = reference.querySelector("p, [data-body]");
  const body = document.createElement(bodyReference?.tagName.toLowerCase() ?? "p");
  if (bodyReference?.getAttribute("class")) {
    body.setAttribute("class", bodyReference.getAttribute("class") ?? "");
  }
  body.textContent = "内容を入力";
  slide.append(heading, body);
  return slide;
}

function regenerateCloneIdentifiers(clone: HTMLElement, document: Document): void {
  const idMap = new Map<string, string>();
  const all = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (const element of all) {
    const existingId = element.getAttribute("id");
    if (existingId) {
      const nextId = uniqueDocumentId(document, `${existingId}-copy`);
      idMap.set(existingId, nextId);
      element.setAttribute("id", nextId);
    }
    for (const attributeName of ["data-hss-id", "data-hss-overlay-id"]) {
      if (element.hasAttribute(attributeName)) {
        element.setAttribute(attributeName, createEditorId(attributeName === "data-hss-id" ? "hss" : "overlay"));
      }
    }
    element.removeAttribute("data-hss-slide-id");
  }

  for (const element of all) {
    for (const attributeName of IDREF_TOKEN_ATTRIBUTES) {
      const value = element.getAttribute(attributeName);
      if (!value) continue;
      element.setAttribute(attributeName, value.split(/\s+/).map((token) => idMap.get(token) ?? token).join(" "));
    }
    for (const attributeName of ["href", "xlink:href"]) {
      const value = element.getAttribute(attributeName);
      if (value?.startsWith("#") && idMap.has(value.slice(1))) {
        element.setAttribute(attributeName, `#${idMap.get(value.slice(1))}`);
      }
    }
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.value.includes("url(#")) continue;
      element.setAttribute(
        attribute.name,
        attribute.value.replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${idMap.get(id) ?? id})`)
      );
    }
  }
}

function uniqueDocumentId(document: Document, base: string): string {
  let candidate = base;
  let sequence = 2;
  while (document.getElementById(candidate)) {
    candidate = `${base}-${sequence}`;
    sequence += 1;
  }
  return candidate;
}

function createEditorId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value.slice(0, 12)}`;
}

function duplicateLabel(node: HTMLElement, index: number): string {
  const label = node.getAttribute("data-label")?.trim() || node.querySelector("h1, h2, h3")?.textContent?.trim() || `Slide ${index + 1}`;
  return `${label}（複製）`;
}

function clampIndex(index: number, length: number): number {
  return Math.min(length - 1, Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0));
}
