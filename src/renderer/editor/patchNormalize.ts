import type { EditableStyle, Patch, PatchTarget, StylePatch, TextPatch } from "../types/patches";
import { camelToKebab, cssEscape } from "./css";

const rootLayoutProperties = new Set<keyof EditableStyle>([
  "transform",
  "width",
  "height",
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "margin",
  "boxSizing",
  "display",
  "borderColor",
  "borderStyle",
  "borderWidth"
]);

export function normalizePatchesForSource(sourceHtml: string, patches: Patch[]): Patch[] {
  if (patches.length === 0) {
    return patches;
  }

  const document = new DOMParser().parseFromString(sourceHtml, "text/html");
  const merged = mergePatchIntents(patches);
  return merged.flatMap((patch) => normalizePatch(document, patch));
}

function mergePatchIntents(patches: Patch[]): Patch[] {
  const textPatches = new Map<string, TextPatch>();
  const stylePatches = new Map<string, StylePatch>();
  const order: string[] = [];

  for (const patch of patches) {
    const key = `${patch.type}:${patch.target.hssId}`;
    if (!order.includes(key)) {
      order.push(key);
    }

    if (patch.type === "text") {
      textPatches.set(key, patch);
      continue;
    }

    const existing = stylePatches.get(key);
    stylePatches.set(key, existing
      ? {
          ...existing,
          target: patch.target,
          style: { ...existing.style, ...patch.style },
          locked: patch.locked ?? existing.locked,
          updatedAt: patch.updatedAt
        }
      : patch
    );
  }

  return order.flatMap((key) => {
    const patch = textPatches.get(key) ?? stylePatches.get(key);
    return patch ? [patch] : [];
  });
}

function normalizePatch(document: Document, patch: Patch): Patch[] {
  const element = findPatchTarget(document, patch.target);
  if (!element) {
    return [patch];
  }

  if (patch.type === "text") {
    return normalizeTextPatch(element, patch);
  }

  return normalizeStylePatch(document, element, patch);
}

function normalizeTextPatch(element: Element, patch: TextPatch): Patch[] {
  return normalizeText(element.textContent ?? "") === normalizeText(patch.text) ? [] : [patch];
}

function normalizeStylePatch(document: Document, element: Element, patch: StylePatch): Patch[] {
  if (!(element instanceof HTMLElement)) {
    return patch.locked ? [{ ...patch, style: {} }] : [];
  }

  const style = isSlideRootElement(element)
    ? stripRootLayoutProperties(patch.style)
    : patch.style;
  const nextStyle = removeNoopStyleEntries(document, element, style);

  if (Object.keys(nextStyle).length === 0 && !patch.locked) {
    return [];
  }

  return [{ ...patch, style: nextStyle }];
}

function stripRootLayoutProperties(style: EditableStyle): EditableStyle {
  const next = { ...style };
  for (const property of rootLayoutProperties) {
    delete next[property];
  }
  return next;
}

function removeNoopStyleEntries(document: Document, element: HTMLElement, style: EditableStyle): EditableStyle {
  const next: EditableStyle = {};

  for (const [property, value] of Object.entries(style) as Array<[keyof EditableStyle, string | undefined]>) {
    if (typeof value === "undefined") {
      continue;
    }

    const cssProperty = camelToKebab(property);
    const originalInlineValue = element.style.getPropertyValue(cssProperty);
    if (!value) {
      if (originalInlineValue) {
        next[property] = value;
      }
      continue;
    }

    if (!areCssValuesEquivalent(document, cssProperty, originalInlineValue, value)) {
      next[property] = value;
    }
  }

  return next;
}

function areCssValuesEquivalent(document: Document, property: string, left: string, right: string): boolean {
  return normalizeCssValue(document, property, left) === normalizeCssValue(document, property, right);
}

function normalizeCssValue(document: Document, property: string, value: string): string {
  if (!value) {
    return "";
  }

  const probe = document.createElement("div");
  probe.style.setProperty(property, value);
  return probe.style.getPropertyValue(property).trim() || value.trim();
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function findPatchTarget(document: Document, target: PatchTarget): Element | null {
  const byHssId = document.querySelector(`[data-hss-id="${cssEscape(target.hssId)}"]`);
  if (byHssId) {
    return byHssId;
  }

  try {
    const bySelector = document.querySelector(target.selector);
    if (bySelector) {
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
