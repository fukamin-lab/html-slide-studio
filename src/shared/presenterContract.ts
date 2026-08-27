import type { PatchManifest } from "../renderer/types/patches";
import type { PresenterCommand, PresenterSnapshot } from "../renderer/types/presenter";
import type { SlideDescriptor } from "../renderer/types/project";
import { MAX_SLIDE_FRAME_DIMENSION } from "./slideFrameContract.ts";

const MAX_SOURCE_LENGTH = 64 * 1024 * 1024;
const MAX_SLIDES = 2_000;
const MAX_PATCHES = 20_000;
const MAX_OVERLAYS = 10_000;

export function isPresenterCommand(value: unknown): value is PresenterCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "set-slide") {
    return Object.keys(value).length === 2 && isBoundedString(value.slideId, 1, 512);
  }
  if (value.type === "update-notes") {
    return Object.keys(value).length === 3 && isBoundedString(value.slideId, 1, 512) && isBoundedString(value.notes, 0, 1_000_000);
  }
  if (value.type === "finish-notes" || value.type === "clear-drawing") {
    return Object.keys(value).length === 2 && isBoundedString(value.slideId, 1, 512);
  }
  if (value.type === "draw") {
    return Object.keys(value).length === 2 && isPresentationDrawEvent(value.event);
  }
  return (
    (value.type === "previous-slide" || value.type === "next-slide" || value.type === "end-presentation") &&
    Object.keys(value).length === 1
  );
}

function isPresentationDrawEvent(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["slideId", "tool", "color", "phase", "strokeId", "x", "y"]) &&
    isBoundedString(value.slideId, 1, 512) &&
    (value.tool === "laser" || value.tool === "pen") &&
    (value.color === "#ef4444" || value.color === "#facc15" || value.color === "#2563eb" || value.color === "#111827" || value.color === "#ffffff") &&
    (value.phase === "start" || value.phase === "move" || value.phase === "end") &&
    isBoundedString(value.strokeId, 1, 128) &&
    isFiniteRange(value.x, 0, MAX_SLIDE_FRAME_DIMENSION) &&
    isFiniteRange(value.y, 0, MAX_SLIDE_FRAME_DIMENSION);
}

export function isPresenterSnapshot(value: unknown): value is PresenterSnapshot {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["sourceHtml", "sourceBaseUrl", "manifest", "slides", "currentSlideId", "deckName", "updatedAt"])) return false;
  if (!isBoundedString(value.sourceHtml, 1, MAX_SOURCE_LENGTH)) return false;
  if (value.sourceBaseUrl !== undefined && (!isBoundedString(value.sourceBaseUrl, 1, 8_192) || !value.sourceBaseUrl.startsWith("file:"))) return false;
  if (value.deckName !== undefined && !isBoundedString(value.deckName, 0, 1_024)) return false;
  if (!isBoundedString(value.updatedAt, 1, 128) || !Number.isFinite(Date.parse(value.updatedAt))) return false;
  if (!Array.isArray(value.slides) || value.slides.length === 0 || value.slides.length > MAX_SLIDES || !value.slides.every(isSlideDescriptor)) return false;
  if (value.currentSlideId !== null && !isBoundedString(value.currentSlideId, 1, 512)) return false;
  if (value.currentSlideId !== null && !value.slides.some((slide) => slide.id === value.currentSlideId)) return false;
  return isPatchManifest(value.manifest, value.slides);
}

function isPatchManifest(value: unknown, slides: SlideDescriptor[]): value is PatchManifest {
  if (!isRecord(value) || value.version !== 1 || value.app !== "html-slide-studio") return false;
  if (!hasOnlyKeys(value, ["version", "app", "savedAt", "warnings", "slides", "patches", "overlays"])) return false;
  if (!isBoundedString(value.savedAt, 1, 128) || !Number.isFinite(Date.parse(value.savedAt))) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every(isDocumentWarning)) return false;
  if (!Array.isArray(value.slides) || value.slides.length !== slides.length || !value.slides.every(isSlideDescriptor)) return false;
  if (!Array.isArray(value.patches) || value.patches.length > MAX_PATCHES || !value.patches.every(isPatch)) return false;
  if (!Array.isArray(value.overlays) || value.overlays.length > MAX_OVERLAYS || !value.overlays.every(isOverlay)) return false;
  return value.slides.every((slide, index) => slide.id === slides[index]?.id);
}

function isSlideDescriptor(value: unknown): value is SlideDescriptor {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["id", "label", "selector", "index", "speakerNotes", "hasDataLabel", "hasSpeakerNotes", "tagName", "className", "width", "height"])) return false;
  if (!isBoundedString(value.id, 1, 512) || !isBoundedString(value.label, 0, 4_096) || !isBoundedString(value.selector, 0, 8_192)) return false;
  if (!Number.isInteger(value.index) || Number(value.index) < 0) return false;
  if (value.speakerNotes !== undefined && !isBoundedString(value.speakerNotes, 0, 1_000_000)) return false;
  for (const key of ["hasDataLabel", "hasSpeakerNotes"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  for (const key of ["tagName", "className"] as const) {
    if (value[key] !== undefined && !isBoundedString(value[key], 0, 8_192)) return false;
  }
  for (const key of ["width", "height"] as const) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || Number(value[key]) < 0 || Number(value[key]) > MAX_SLIDE_FRAME_DIMENSION)) return false;
  }
  return true;
}

function isDocumentWarning(value: unknown): boolean {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "severity", "message"]) &&
    isBoundedString(value.id, 1, 512) &&
    (value.severity === "info" || value.severity === "warning") &&
    isBoundedString(value.message, 0, 16_384);
}

function isPatch(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedString(value.id, 1, 512) || !isBoundedString(value.updatedAt, 1, 128) || !isPatchTarget(value.target)) return false;
  if (value.type === "text") return hasOnlyKeys(value, ["id", "type", "target", "text", "updatedAt"]) && isBoundedString(value.text, 0, 1_000_000);
  if (value.type === "style") return hasOnlyKeys(value, ["id", "type", "target", "style", "locked", "updatedAt"]) && isStringRecord(value.style) && (value.locked === undefined || typeof value.locked === "boolean");
  return false;
}

function isPatchTarget(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["hssId", "selector"]) && isBoundedString(value.hssId, 1, 512) && isBoundedString(value.selector, 1, 8_192);
}

function isOverlay(value: unknown): boolean {
  if (!isRecord(value) || (value.type !== "overlayText" && value.type !== "overlayImage")) return false;
  const allowedKeys = ["id", "type", "slideId", "x", "y", "width", "height", "text", "style", "hidden", "locked", "updatedAt"];
  if (!hasOnlyKeys(value, value.type === "overlayImage" ? [...allowedKeys, "src"] : allowedKeys)) return false;
  if (!isBoundedString(value.id, 1, 512) || (value.slideId !== null && !isBoundedString(value.slideId, 1, 512))) return false;
  if (![value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  if (!isBoundedString(value.text, 0, 1_000_000) || !isStringRecord(value.style) || !isBoundedString(value.updatedAt, 1, 128)) return false;
  if (value.hidden !== undefined && typeof value.hidden !== "boolean") return false;
  if (value.locked !== undefined && typeof value.locked !== "boolean") return false;
  return value.type !== "overlayImage" || isBoundedString(value.src, 1, 32_768);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
