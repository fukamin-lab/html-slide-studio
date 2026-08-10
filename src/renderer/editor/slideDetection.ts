import type { SlideDescriptor } from "../types/project";
import { detectSlidesForPreview } from "./slideStructure";

export type PreparedSlideDocument = {
  html: string;
  slides: SlideDescriptor[];
  warnings: string[];
};

export function prepareSlideDocument(rawHtml: string, sourceBaseHref?: string): PreparedSlideDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, "text/html");
  const warnings: string[] = [];
  const sourceDiagnostics = inspectSourceBeforeSanitizing(doc);

  removeExecutableContent(doc, warnings);
  ensureDocumentBasics(doc);
  ensureSourceBase(doc, sourceBaseHref);

  const detected = detectSlideNodes(doc);
  if (detected.usedFallback) {
    warnings.push("明示的なスライド構造を判定できません。プレビューは表示しますが、スライドの追加・複製・並べ替えは無効です。");
  }

  warnings.push(...sourceDiagnostics);

  const slideNodes = detected.nodes;
  const slides = slideNodes.map((node, index) => {
    const id = `slide-${String(index + 1).padStart(3, "0")}`;
    node.setAttribute("data-hss-slide-id", id);

    return {
      id,
      label: getSlideLabel(node, index),
      selector: `[data-hss-slide-id="${id}"]`,
      index,
      speakerNotes: getSpeakerNotes(node),
      hasDataLabel: Boolean(node.getAttribute("data-label")?.trim()),
      hasSpeakerNotes: hasSpeakerNotes(node),
      tagName: node.tagName.toLowerCase(),
      className: node.getAttribute("class") ?? undefined,
      ...readSlideDimensions(node)
    };
  });

  return {
    html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
    slides,
    warnings
  };
}

function inspectSourceBeforeSanitizing(doc: Document): string[] {
  const warnings: string[] = [];

  if (doc.querySelector('script[type="bundler/template"], script[type="bundler/manifest"]')) {
    warnings.push("Claude Design-style bundler scripts were detected. Packed assets may need normalization before final delivery.");
  }

  return warnings;
}

function ensureSourceBase(doc: Document, sourceBaseHref?: string): void {
  doc.head.querySelectorAll('base[data-hss-base="true"]').forEach((base) => base.remove());

  if (!sourceBaseHref) {
    return;
  }

  const existingBase = doc.head.querySelector("base:not([data-hss-base])");
  if (existingBase) {
    warningsSafeRemove(existingBase);
  }

  const base = doc.createElement("base");
  base.setAttribute("data-hss-base", "true");
  base.setAttribute("href", sourceBaseHref);
  doc.head.prepend(base);
}

function warningsSafeRemove(element: Element): void {
  element.remove();
}

function removeExecutableContent(doc: Document, warnings: string[]): void {
  const scripts = Array.from(doc.querySelectorAll("script"));
  if (scripts.length > 0) {
    warnings.push(`Removed ${scripts.length} script tag(s) while loading the slide safely.`);
  }

  scripts.forEach((script) => script.remove());

  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        warnings.push(`Removed inline event handler ${attribute.name} while loading the slide safely.`);
      }

      if ((name === "href" || name === "src" || name === "xlink:href") && value.startsWith("javascript:")) {
        element.removeAttribute(attribute.name);
        warnings.push(`Removed javascript: URL from ${element.tagName.toLowerCase()} while loading the slide safely.`);
      }
    }
  });
}

function ensureDocumentBasics(doc: Document): void {
  if (!doc.head.querySelector("meta[charset]")) {
    const meta = doc.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    doc.head.prepend(meta);
  }

  const editorStyle = doc.createElement("style");
  editorStyle.setAttribute("data-hss-editor-style", "true");
  editorStyle.textContent = `
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    html { background: transparent; }
    body { min-width: 100%; min-height: 100%; margin: 0; }
    a { cursor: default; }
  `;
  doc.head.append(editorStyle);
}

function detectSlideNodes(doc: Document): { nodes: Element[]; usedFallback: boolean } {
  return detectSlidesForPreview(doc);
}

function getSlideLabel(node: Element, index: number): string {
  const dataLabel = node.getAttribute("data-label")?.trim();
  if (dataLabel) {
    return truncate(dataLabel, 34);
  }

  const heading = node.querySelector("h1, h2, h3");
  const text = heading?.textContent?.trim() || node.getAttribute("aria-label") || node.getAttribute("title");
  return text ? truncate(text, 34) : `Slide ${index + 1}`;
}

function getSpeakerNotes(node: Element): string | undefined {
  const directNotes = node.getAttribute("data-speaker-notes")?.trim();
  if (directNotes) {
    return directNotes;
  }

  const notesElement = node.querySelector("[data-speaker-notes], aside.notes, .speaker-notes, .notes");
  const nestedNotes = notesElement?.getAttribute("data-speaker-notes")?.trim() || notesElement?.textContent?.trim();
  return nestedNotes || undefined;
}

function hasSpeakerNotes(node: Element): boolean {
  return Boolean(getSpeakerNotes(node));
}

function readSlideDimensions(node: Element): { width?: number; height?: number } {
  if (!(node instanceof HTMLElement)) {
    return {};
  }

  const inlineWidth = parseCssPixels(node.style.width);
  const inlineHeight = parseCssPixels(node.style.height);
  return {
    width: inlineWidth,
    height: inlineHeight
  };
}

function parseCssPixels(value: string): number | undefined {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)px$/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
