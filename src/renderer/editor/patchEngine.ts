import type { EditableStyle, Patch, PatchTarget } from "../types/patches";
import type { SlideDescriptor } from "../types/project";
import { camelToKebab, cssEscape } from "./css";

const textSnapshotsByDocument = new WeakMap<Document, Map<Element, Node[]>>();
const styleSnapshotsByDocument = new WeakMap<Document, Map<HTMLElement, Map<string, StyleSnapshotEntry>>>();

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

      rememberOriginalTextForPatch(element);
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

export function rememberOriginalTextForPatch(element: Element): void {
  const snapshots = getTextSnapshots(element.ownerDocument);
  if (!snapshots.has(element)) {
    snapshots.set(element, Array.from(element.childNodes, (node) => node.cloneNode(true)));
  }
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
  const textSnapshots = textSnapshotsByDocument.get(document);
  if (textSnapshots) {
    for (const [element, nodes] of textSnapshots) {
      element.replaceChildren(...nodes.map((node) => node.cloneNode(true)));
    }
    textSnapshotsByDocument.delete(document);
  }

  const styleSnapshots = styleSnapshotsByDocument.get(document);
  if (styleSnapshots) {
    for (const [element, entries] of styleSnapshots) {
      for (const entry of entries.values()) {
        if (entry.value) {
          element.style.setProperty(entry.property, entry.value, entry.priority);
        } else {
          element.style.removeProperty(entry.property);
        }
      }
    }
    styleSnapshotsByDocument.delete(document);
  }
}

type StyleSnapshotEntry = {
  property: string;
  value: string;
  priority: string;
};

function storeStyleSnapshot(element: HTMLElement, properties: string[]): void {
  const documentSnapshots = getStyleSnapshots(element.ownerDocument);
  const existing = documentSnapshots.get(element) ?? new Map<string, StyleSnapshotEntry>();
  documentSnapshots.set(element, existing);

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
}

function getTextSnapshots(document: Document): Map<Element, Node[]> {
  const existing = textSnapshotsByDocument.get(document);
  if (existing) {
    return existing;
  }
  const created = new Map<Element, Node[]>();
  textSnapshotsByDocument.set(document, created);
  return created;
}

function getStyleSnapshots(document: Document): Map<HTMLElement, Map<string, StyleSnapshotEntry>> {
  const existing = styleSnapshotsByDocument.get(document);
  if (existing) {
    return existing;
  }
  const created = new Map<HTMLElement, Map<string, StyleSnapshotEntry>>();
  styleSnapshotsByDocument.set(document, created);
  return created;
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
