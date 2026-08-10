import type { EditableStyle, Patch, PatchTarget } from "../types/patches";
import type { SlideDescriptor } from "../types/project";
import { camelToKebab, cssEscape } from "./css";

const ORIGINAL_TEXT_ATTR = "data-hss-original-text";
const ORIGINAL_STYLE_ATTR = "data-hss-original-style";

export function applyPatchesToDocument(document: Document, patches: Patch[]): string[] {
  resetPatchApplications(document);
  const warnings: string[] = [];

  for (const patch of patches) {
    const element = findPatchTarget(document, patch.target);
    if (!element) {
      warnings.push(`Patch target was not found: ${patch.target.hssId}`);
      continue;
    }

    if (patch.type === "text") {
      if (isSlideRootElement(element)) {
        warnings.push(`Slide root text patch was ignored: ${patch.target.hssId}`);
        continue;
      }

      if (!element.hasAttribute(ORIGINAL_TEXT_ATTR)) {
        element.setAttribute(ORIGINAL_TEXT_ATTR, element.innerHTML);
      }
      element.textContent = patch.text;
      continue;
    }

    if (patch.type === "style" && "style" in element) {
      const htmlElement = element as HTMLElement;
      const style = sanitizePatchStyleForElement(element, patch.style);
      if (Object.keys(style).length === 0) {
        warnings.push(`Slide root layout patch was ignored: ${patch.target.hssId}`);
        continue;
      }

      storeStyleSnapshot(
        htmlElement,
        Object.keys(style).map((property) => camelToKebab(property))
      );

      for (const [property, value] of Object.entries(style)) {
        const cssProperty = camelToKebab(property);
        if (value) {
          htmlElement.style.setProperty(cssProperty, value, "important");
        } else {
          htmlElement.style.removeProperty(cssProperty);
        }
      }
    }
  }

  return warnings;
}

function sanitizePatchStyleForElement(element: Element, style: EditableStyle): EditableStyle {
  if (!isSlideRootElement(element)) {
    return style;
  }

  const sanitized = { ...style };
  delete sanitized.transform;
  delete sanitized.width;
  delete sanitized.height;
  delete sanitized.position;
  delete sanitized.left;
  delete sanitized.top;
  delete sanitized.right;
  delete sanitized.bottom;
  delete sanitized.margin;
  delete sanitized.boxSizing;
  delete sanitized.display;
  delete sanitized.borderColor;
  delete sanitized.borderStyle;
  delete sanitized.borderWidth;
  return sanitized;
}

export function applySlideVisibility(document: Document, currentSlideId: string | null, slides: SlideDescriptor[]): void {
  if (!currentSlideId || slides.length < 2) {
    return;
  }

  for (const slide of slides) {
    const node = document.querySelector(slide.selector);
    if (!node || node === document.body || !("style" in node)) {
      continue;
    }

    const slideElement = node as HTMLElement;
    if (slide.id === currentSlideId) {
      slideElement.style.removeProperty("display");
    } else {
      slideElement.style.setProperty("display", "none", "important");
    }
  }
}

function resetPatchApplications(document: Document): void {
  for (const element of document.querySelectorAll(`[${ORIGINAL_TEXT_ATTR}]`)) {
    element.innerHTML = element.getAttribute(ORIGINAL_TEXT_ATTR) ?? "";
    element.removeAttribute(ORIGINAL_TEXT_ATTR);
  }

  for (const element of document.querySelectorAll(`[${ORIGINAL_STYLE_ATTR}]`)) {
    if (!("style" in element)) {
      element.removeAttribute(ORIGINAL_STYLE_ATTR);
      continue;
    }

    const htmlElement = element as HTMLElement;
    for (const entry of readStyleSnapshot(htmlElement)) {
      if (entry.value) {
        htmlElement.style.setProperty(entry.property, entry.value, entry.priority);
      } else {
        htmlElement.style.removeProperty(entry.property);
      }
    }

    htmlElement.removeAttribute(ORIGINAL_STYLE_ATTR);
  }
}

type StyleSnapshotEntry = {
  property: string;
  value: string;
  priority: string;
};

function storeStyleSnapshot(element: HTMLElement, properties: string[]): void {
  const existing = new Map(readStyleSnapshot(element).map((entry) => [entry.property, entry]));

  for (const property of properties) {
    if (existing.has(property)) {
      continue;
    }

    existing.set(property, {
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    });
  }

  element.setAttribute(ORIGINAL_STYLE_ATTR, JSON.stringify(Array.from(existing.values())));
}

function readStyleSnapshot(element: HTMLElement): StyleSnapshotEntry[] {
  const raw = element.getAttribute(ORIGINAL_STYLE_ATTR);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isStyleSnapshotEntry);
  } catch {
    return [];
  }
}

function isStyleSnapshotEntry(value: unknown): value is StyleSnapshotEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<StyleSnapshotEntry>;
  return typeof maybe.property === "string" && typeof maybe.value === "string" && typeof maybe.priority === "string";
}

function findPatchTarget(document: Document, target: PatchTarget): Element | null {
  const byHssId = document.querySelector(`[data-hss-id="${cssEscape(target.hssId)}"]`);
  if (byHssId) {
    return byHssId;
  }

  try {
    const bySelector = document.querySelector(target.selector);
    if (bySelector) {
      bySelector.setAttribute("data-hss-id", target.hssId);
      return bySelector;
    }
  } catch {
    return null;
  }

  return null;
}

function isSlideRootElement(element: Element): boolean {
  return element.hasAttribute("data-hss-slide-id");
}
