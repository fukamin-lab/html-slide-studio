import type { PatchManifest } from "./patches";
import type { SlideDescriptor } from "./project";

export type PresenterSnapshot = {
  sourceHtml: string;
  sourceBaseUrl?: string;
  manifest: PatchManifest;
  slides: SlideDescriptor[];
  currentSlideId: string | null;
  deckName?: string;
  updatedAt: string;
};

export type PresentationTool = "laser" | "pen";
export type PresentationColor = "#ef4444" | "#facc15" | "#2563eb" | "#111827" | "#ffffff";
export type PresentationDrawPhase = "start" | "move" | "end";

export type PresentationDrawEvent = {
  slideId: string;
  tool: PresentationTool;
  color: PresentationColor;
  phase: PresentationDrawPhase;
  strokeId: string;
  x: number;
  y: number;
};

export type PresenterCommand =
  | { type: "previous-slide" }
  | { type: "next-slide" }
  | { type: "set-slide"; slideId: string }
  | { type: "update-notes"; slideId: string; notes: string }
  | { type: "finish-notes"; slideId: string }
  | { type: "draw"; event: PresentationDrawEvent }
  | { type: "clear-drawing"; slideId: string }
  | { type: "end-presentation" };
