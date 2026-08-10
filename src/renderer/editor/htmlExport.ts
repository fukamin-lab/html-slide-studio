import type { EditableStyle, Overlay, Patch, PatchManifest, PatchTarget } from "../types/patches";
import { camelToKebab, cssEscape } from "./css";
import { normalizePatchesForSource } from "./patchNormalize";
import { detectSlidesForPreview } from "./slideStructure";

export type HtmlExportResult = {
  html: string;
  warnings: string[];
};

const rootLayoutProperties = new Set([
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

export function buildEditedHtmlExport(sourceHtml: string, manifest: PatchManifest): HtmlExportResult {
  const document = new DOMParser().parseFromString(sourceHtml, "text/html");
  const warnings: string[] = [];

  removeEditorRuntimeArtifacts(document);

  const slideNodes = detectSlideNodes(document);
  const slideRoots = new Set<Element>(slideNodes);
  const slidesById = new Map(slideNodes.map((node, index) => [`slide-${String(index + 1).padStart(3, "0")}`, node]));

  applyExportPatches(document, normalizePatchesForSource(sourceHtml, manifest.patches), slideRoots, warnings);
  appendExportOverlays(document, manifest.overlays ?? [], slidesById);

  return {
    html: `<!doctype html>\n${document.documentElement.outerHTML}`,
    warnings
  };
}

function removeEditorRuntimeArtifacts(document: Document): void {
  document.querySelectorAll("[data-hss-original-text], [data-hss-original-style]").forEach((element) => {
    element.removeAttribute("data-hss-original-text");
    element.removeAttribute("data-hss-original-style");
  });

  document
    .querySelectorAll(
      'style[data-hss-editor-style="true"], base[data-hss-base="true"], base[data-hss-export-base="true"]'
    )
    .forEach((element) => element.remove());
}

function detectSlideNodes(document: Document): Element[] {
  return detectSlidesForPreview(document).nodes;
}

function applyExportPatches(document: Document, patches: Patch[], slideRoots: Set<Element>, warnings: string[]): void {
  for (const patch of patches) {
    const element = findPatchTarget(document, patch.target);
    if (!element) {
      warnings.push(`Export skipped missing patch target: ${patch.target.hssId}`);
      continue;
    }

    if (patch.type === "text") {
      if (slideRoots.has(element)) {
        warnings.push(`Export ignored slide-root text patch: ${patch.target.hssId}`);
        continue;
      }

      element.textContent = patch.text;
      continue;
    }

    if (!isHtmlElement(element)) {
      continue;
    }

    const style = slideRoots.has(element) ? sanitizeRootStyle(patch.style) : patch.style;
    for (const [property, value] of Object.entries(style)) {
      const cssProperty = camelToKebab(property);
      if (value) {
        element.style.setProperty(cssProperty, value, "important");
      } else {
        element.style.removeProperty(cssProperty);
      }
    }
  }
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

function sanitizeRootStyle(style: EditableStyle): EditableStyle {
  const next = { ...style };
  for (const property of rootLayoutProperties) {
    delete next[property as keyof EditableStyle];
  }
  return next;
}

function appendExportOverlays(
  document: Document,
  overlays: Overlay[],
  slidesById: Map<string, Element>
): void {
  const firstSlide = slidesById.values().next().value ?? document.body;
  const layers = new Map<Element, HTMLElement>();

  overlays.filter((overlay) => !overlay.hidden).forEach((overlay, index) => {
    const slideRoot = (overlay.slideId ? slidesById.get(overlay.slideId) : firstSlide) ?? firstSlide;
    if (!isHtmlElement(slideRoot)) {
      return;
    }

    const layer = getOrCreateOverlayLayer(document, slideRoot, layers);
    layer.appendChild(createOverlayElement(document, overlay, index));
  });
}

function getOrCreateOverlayLayer(document: Document, slideRoot: HTMLElement, layers: Map<Element, HTMLElement>): HTMLElement {
  const existing = layers.get(slideRoot);
  if (existing) {
    return existing;
  }

  slideRoot.style.setProperty("position", "relative");
  if (!slideRoot.style.getPropertyValue("overflow")) {
    slideRoot.style.setProperty("overflow", "hidden");
  }

  const layer = document.createElement("div");
  layer.setAttribute("class", "hss-export-overlay-layer");
  layer.setAttribute("data-hss-export-layer", "true");
  setStyles(layer, {
    position: "absolute",
    inset: "0",
    zIndex: "2147483000",
    pointerEvents: "none"
  });

  slideRoot.appendChild(layer);
  layers.set(slideRoot, layer);
  return layer;
}

function createOverlayElement(document: Document, overlay: Overlay, index: number): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("class", `hss-export-overlay hss-export-overlay--${overlay.type}`);
  element.setAttribute("data-hss-overlay-id", overlay.id);

  setStyles(element, {
    position: "absolute",
    left: `${overlay.x}px`,
    top: `${overlay.y}px`,
    width: `${overlay.width}px`,
    height: `${overlay.height}px`,
    zIndex: String(index + 1),
    margin: "0",
    padding: "0",
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    overflow: overlay.type === "overlayImage" ? "hidden" : "visible",
    pointerEvents: "auto",
    color: overlay.style.color,
    backgroundColor: overlay.style.backgroundColor,
    fontFamily: overlay.style.fontFamily,
    fontSize: overlay.style.fontSize,
    fontWeight: overlay.style.fontWeight,
    fontStyle: overlay.style.fontStyle,
    textDecoration: overlay.style.textDecoration,
    lineHeight: overlay.style.lineHeight,
    textAlign: overlay.style.textAlign,
    display: overlay.style.display,
    alignItems: overlay.style.alignItems,
    justifyContent: overlay.style.justifyContent,
    borderRadius: overlay.style.borderRadius,
    borderColor: overlay.style.borderColor,
    borderStyle: overlay.style.borderStyle,
    borderWidth: overlay.style.borderWidth
  });

  if (overlay.type === "overlayImage") {
    const image = document.createElement("img");
    image.setAttribute("alt", overlay.text);
    image.setAttribute("src", overlay.src);
    setStyles(image, {
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: overlay.style.objectFit ?? "contain",
      objectPosition: overlay.style.objectPosition ?? "center",
      transformOrigin: "center center"
    });
    element.appendChild(image);
    return element;
  }

  element.textContent = overlay.text;
  return element;
}

function setStyles(element: HTMLElement, styles: Record<string, string | undefined>): void {
  for (const [property, value] of Object.entries(styles)) {
    if (!value) {
      continue;
    }

    element.style.setProperty(camelToKebab(property), value);
  }
}

function isHtmlElement(element: Element | null | undefined): element is HTMLElement {
  return Boolean(element) && element instanceof HTMLElement;
}
