import type { PresentationColor, PresentationDrawEvent } from "./types/presenter";

export const LASER_LIFETIME_MS = 1800;
export const DEFAULT_PRESENTATION_COLOR: PresentationColor = "#ef4444";
export const PRESENTATION_COLOR_OPTIONS: ReadonlyArray<{ color: PresentationColor; label: string }> = [
  { color: "#ef4444", label: "赤" },
  { color: "#facc15", label: "黄" },
  { color: "#2563eb", label: "青" },
  { color: "#111827", label: "黒" },
  { color: "#ffffff", label: "白" }
];
const MAX_POINTS_PER_STROKE = 2_048;

export type PresentationInkPoint = {
  x: number;
  y: number;
  at: number;
};

export type PresentationInkStroke = {
  id: string;
  slideId: string;
  tool: "laser" | "pen";
  color: PresentationColor;
  points: PresentationInkPoint[];
};

export type PresentationInkState = {
  strokes: PresentationInkStroke[];
};

export function createEmptyPresentationInk(): PresentationInkState {
  return { strokes: [] };
}

export function applyPresentationDraw(
  state: PresentationInkState,
  event: PresentationDrawEvent,
  now = Date.now()
): PresentationInkState {
  const point = { x: event.x, y: event.y, at: now };
  const existingIndex = state.strokes.findIndex((stroke) => stroke.id === event.strokeId && stroke.slideId === event.slideId);

  if (event.phase === "start" || existingIndex < 0) {
    return pruneExpiredLaser({
      strokes: [
        ...state.strokes.filter((stroke) => !(stroke.id === event.strokeId && stroke.slideId === event.slideId)),
        { id: event.strokeId, slideId: event.slideId, tool: event.tool, color: event.color, points: [point] }
      ]
    }, now);
  }

  const strokes = state.strokes.map((stroke, index) => index === existingIndex
    ? { ...stroke, points: [...stroke.points.slice(-(MAX_POINTS_PER_STROKE - 1)), point] }
    : stroke);
  return pruneExpiredLaser({ strokes }, now);
}

export function clearPresentationInk(state: PresentationInkState, slideId: string): PresentationInkState {
  return { strokes: state.strokes.filter((stroke) => stroke.slideId !== slideId) };
}

export function visiblePresentationStrokes(
  state: PresentationInkState,
  slideId: string,
  now = Date.now()
): PresentationInkStroke[] {
  return pruneExpiredLaser(state, now).strokes.filter((stroke) => stroke.slideId === slideId);
}

export function laserOpacity(stroke: PresentationInkStroke, now = Date.now()): number {
  if (stroke.tool !== "laser") return 1;
  const latest = stroke.points.at(-1)?.at ?? 0;
  return Math.max(0, Math.min(1, 1 - (now - latest) / LASER_LIFETIME_MS));
}

function pruneExpiredLaser(state: PresentationInkState, now: number): PresentationInkState {
  const strokes = state.strokes.filter((stroke) =>
    stroke.tool === "pen" || now - (stroke.points.at(-1)?.at ?? 0) < LASER_LIFETIME_MS
  );
  return strokes.length === state.strokes.length ? state : { strokes };
}
