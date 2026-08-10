import type { EditableStyle, Overlay, OverlayImage, OverlayText } from "../types/patches";
import { detectSlidesForPreview, serializeHtmlDocument } from "./slideStructure";

export type RehydratedDocument = {
  sourceHtml: string;
  overlays: Overlay[];
  warnings: string[];
};

export function rehydratePersistedOverlays(html: string): RehydratedDocument {
  const document = new DOMParser().parseFromString(html, "text/html");
  const slides = detectSlidesForPreview(document).nodes;
  const overlays: Overlay[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  for (const layer of Array.from(document.querySelectorAll('[data-hss-export-layer="true"]'))) {
    const slideIndex = slides.findIndex((slide) => slide === layer.parentElement || slide.contains(layer));
    const slideId = `slide-${String(Math.max(0, slideIndex) + 1).padStart(3, "0")}`;
    for (const element of Array.from(layer.children)) {
      if (!(element instanceof HTMLElement) || !element.hasAttribute("data-hss-overlay-id")) {
        continue;
      }
      const overlay = readPersistedOverlay(element, slideId, seenIds);
      if (!overlay) {
        warnings.push("旧形式の図形または表は内容を守るためHTML要素として残しました。");
        continue;
      }
      overlays.push(overlay);
      seenIds.add(overlay.id);
      element.remove();
    }
    if (layer.childElementCount === 0) {
      layer.remove();
    }
  }

  return { sourceHtml: serializeHtmlDocument(document), overlays, warnings: [...new Set(warnings)] };
}

function readPersistedOverlay(element: HTMLElement, slideId: string, seenIds: Set<string>): Overlay | null {
  const id = uniqueOverlayId(element.getAttribute("data-hss-overlay-id") ?? "", seenIds);
  const common = {
    id,
    slideId,
    x: readPixels(element.style.left, 120),
    y: readPixels(element.style.top, 120),
    width: Math.max(8, readPixels(element.style.width, 320)),
    height: Math.max(8, readPixels(element.style.height, 120)),
    style: readEditableStyle(element),
    updatedAt: new Date().toISOString()
  };

  if (element.classList.contains("hss-export-overlay--overlayText")) {
    return {
      ...common,
      type: "overlayText",
      text: element.textContent ?? ""
    } satisfies OverlayText;
  }

  if (element.classList.contains("hss-export-overlay--overlayImage")) {
    const image = element.querySelector(":scope > img");
    if (!(image instanceof HTMLImageElement)) {
      return null;
    }
    return {
      ...common,
      type: "overlayImage",
      text: image.getAttribute("alt") ?? "",
      src: image.getAttribute("src") ?? "",
      style: {
        ...common.style,
        objectFit: image.style.objectFit || "contain",
        objectPosition: image.style.objectPosition || "center"
      }
    } satisfies OverlayImage;
  }

  return null;
}

function readEditableStyle(element: HTMLElement): EditableStyle {
  return compactStyle({
    color: element.style.color,
    backgroundColor: element.style.backgroundColor,
    fontSize: element.style.fontSize,
    fontFamily: element.style.fontFamily,
    fontWeight: element.style.fontWeight,
    fontStyle: element.style.fontStyle,
    textDecoration: element.style.textDecoration,
    lineHeight: element.style.lineHeight,
    textAlign: element.style.textAlign,
    display: element.style.display,
    alignItems: element.style.alignItems,
    justifyContent: element.style.justifyContent,
    borderRadius: element.style.borderRadius,
    borderColor: element.style.borderColor,
    borderStyle: element.style.borderStyle,
    borderWidth: element.style.borderWidth
  });
}

function compactStyle(style: EditableStyle): EditableStyle {
  return Object.fromEntries(Object.entries(style).filter(([, value]) => Boolean(value))) as EditableStyle;
}

function readPixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueOverlayId(value: string, seenIds: Set<string>): string {
  if (value && !seenIds.has(value)) {
    return value;
  }
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `overlay-${random.slice(0, 12)}`;
}
