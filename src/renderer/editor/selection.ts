import type { SelectedElement } from "../types/selection";
import { cssEscape } from "./css";
import { ensureHssId, getStructuralSelector } from "./elementIdentity";

const selectableTags = new Set([
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "SPAN",
  "DIV",
  "LI",
  "IMG",
  "SVG",
  "TABLE",
  "TD",
  "TH",
  "A",
  "SECTION",
  "ARTICLE"
]);

const ignoredTags = new Set(["HTML", "BODY", "HEAD", "SCRIPT", "STYLE", "META", "LINK"]);

export function selectElementFromMouseEvent(event: MouseEvent): SelectedElement | null {
  const element = findBestSelectableElement(event) ?? findSelectableElement(event.target);
  if (!element) {
    return null;
  }

  const selector = getStructuralSelector(element);
  const hssId = ensureHssId(element);
  return readSelectedElement(element, selector, hssId);
}

export function selectElementAtPoint(document: Document, x: number, y: number): SelectedElement | null {
  const candidates = new Map<Element, number>();
  for (const stackedElement of document.elementsFromPoint(x, y)) {
    let current: Element | null = stackedElement;

    while (current && !ignoredTags.has(current.tagName)) {
      if (isSelectable(current)) {
        candidates.set(current, scoreSelectableElement(current));
      }

      current = current.parentElement;
    }
  }

  const element = Array.from(candidates.entries()).sort((left, right) => left[1] - right[1])[0]?.[0] ?? null;
  return element ? readSelectedElement(element) : null;
}

export function selectElementsInRect(document: Document, rect: DOMRectLike): SelectedElement[] {
  const candidates = Array.from(document.querySelectorAll("*"))
    .filter((element) => isSelectable(element))
    .filter((element) => isVisible(element))
    .filter((element) => intersectsRect(element.getBoundingClientRect(), rect));
  const withoutContainers = candidates.filter(
    (element) =>
      !isContainerElement(element) ||
      !candidates.some((candidate) => candidate !== element && element.contains(candidate))
  );

  return withoutContainers
    .sort((left, right) => scoreSelectableElement(left) - scoreSelectableElement(right))
    .map((element) => readSelectedElement(element));
}

export function readSelectedElement(element: Element, selector = getStructuralSelector(element), hssId = ensureHssId(element)): SelectedElement {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return {
    hssId,
    tagName: element.tagName.toLowerCase(),
    selector,
    textContent: element.textContent ?? "",
    className: getClassName(element),
    elementId: element.getAttribute("id") ?? undefined,
    childElementCount: element.childElementCount,
    canEditTextDirectly: canEditTextDirectly(element),
    computedStyle: {
      color: computed?.color,
      backgroundColor: computed?.backgroundColor,
      fontSize: computed?.fontSize,
      fontFamily: computed?.fontFamily,
      fontWeight: computed?.fontWeight,
      fontStyle: computed?.fontStyle,
      textDecoration: computed?.textDecoration,
      lineHeight: computed?.lineHeight,
      textAlign: computed?.textAlign,
      alignItems: computed?.alignItems,
      justifyContent: computed?.justifyContent,
      borderRadius: computed?.borderRadius,
      borderColor: computed?.borderColor,
      borderStyle: computed?.borderStyle,
      borderWidth: computed?.borderWidth,
      position: computed?.position,
      left: computed?.left,
      top: computed?.top,
      right: computed?.right,
      bottom: computed?.bottom,
      margin: computed?.margin,
      boxSizing: computed?.boxSizing,
      transform: computed?.transform,
      width: computed?.width,
      height: computed?.height,
      display: computed?.display
    },
    bbox: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  };
}

type DOMRectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function findElementByHssTarget(document: Document, hssId: string, selector?: string): Element | null {
  const byId = document.querySelector(`[data-hss-id="${cssEscape(hssId)}"]`);
  if (byId) {
    return byId;
  }

  if (!selector) {
    return null;
  }

  try {
    const bySelector = document.querySelector(selector);
    if (bySelector) {
      bySelector.setAttribute("data-hss-id", hssId);
      return bySelector;
    }
  } catch {
    return null;
  }

  return null;
}

function findSelectableElement(target: EventTarget | null): Element | null {
  const element = toElement(target);
  if (!element) {
    return null;
  }

  let current: Element | null = element;
  while (current && !ignoredTags.has(current.tagName)) {
    if (isSelectable(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function findBestSelectableElement(event: MouseEvent): Element | null {
  const target = toElement(event.target);
  const document = target?.ownerDocument;
  if (!document) {
    return null;
  }

  const candidates = new Map<Element, number>();
  for (const stackedElement of document.elementsFromPoint(event.clientX, event.clientY)) {
    let current: Element | null = stackedElement;

    while (current && !ignoredTags.has(current.tagName)) {
      if (isSelectable(current)) {
        candidates.set(current, scoreSelectableElement(current));
      }

      current = current.parentElement;
    }
  }

  return Array.from(candidates.entries()).sort((left, right) => left[1] - right[1])[0]?.[0] ?? null;
}

function scoreSelectableElement(element: Element): number {
  const rect = element.getBoundingClientRect();
  let score = rect.width * rect.height;

  if (element.matches("h1, h2, h3, h4, h5, h6, p, span, li, td, th, a, img, svg")) {
    score -= 100_000;
  }

  if (element.tagName === "DIV") {
    score += element.children.length > 0 ? 500_000 : 20_000;
  }

  if (element.tagName === "SECTION" || element.tagName === "ARTICLE") {
    score += 1_000_000;
  }

  if (!element.textContent?.trim() && !element.matches("img, svg, table")) {
    score += 1_000_000;
  }

  return score;
}

function toElement(target: EventTarget | null): Element | null {
  if (!target || typeof target !== "object" || !("nodeType" in target)) {
    return null;
  }

  return (target as Node).nodeType === 1 ? (target as Element) : null;
}

function isSelectable(element: Element): boolean {
  if (!selectableTags.has(element.tagName)) {
    return false;
  }

  if (isSlideRootElement(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) {
    return false;
  }

  if (element.tagName === "DIV" || element.tagName === "SECTION" || element.tagName === "ARTICLE") {
    return Boolean(element.textContent?.trim()) || Boolean(element.querySelector("img, svg, table"));
  }

  return true;
}

function isVisible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);
  if (computed?.display === "none" || computed?.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width >= 4 && rect.height >= 4;
}

function isContainerElement(element: Element): boolean {
  return element.tagName === "DIV" || element.tagName === "SECTION" || element.tagName === "ARTICLE";
}

function isSlideRootElement(element: Element): boolean {
  return element.hasAttribute("data-hss-slide-id");
}

function canEditTextDirectly(element: Element): boolean {
  if (element.tagName === "SECTION" || element.tagName === "ARTICLE") {
    return false;
  }

  if ((element.tagName === "DIV" || element.tagName === "LI" || element.tagName === "SPAN") && element.childElementCount > 0) {
    return false;
  }

  return !["IMG", "SVG", "TABLE", "VIDEO", "AUDIO", "CANVAS"].includes(element.tagName);
}

function intersectsRect(left: DOMRectLike, right: DOMRectLike): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function getClassName(element: Element): string | undefined {
  const className = element.getAttribute("class");
  return className || undefined;
}
