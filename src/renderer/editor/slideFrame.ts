import type { SlideDescriptor } from "../types/project";
import {
  DEFAULT_SLIDE_FRAME_SIZE,
  MAX_SLIDE_FRAME_DIMENSION,
  type SlideFrameSize
} from "../../shared/slideFrameContract.ts";

export {
  DEFAULT_SLIDE_FRAME_SIZE,
  MAX_SLIDE_FRAME_DIMENSION,
  type SlideFrameSize
} from "../../shared/slideFrameContract.ts";

export function readSlideFrameSize(
  document: Document,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  fallback: SlideFrameSize = DEFAULT_SLIDE_FRAME_SIZE
): SlideFrameSize {
  const slide = slides.find((candidate) => candidate.id === currentSlideId) ?? slides[0] ?? null;
  const root = slide ? document.querySelector(slide.selector) : document.body;
  const target = root ?? document.body ?? document.documentElement;
  const rect = target?.getBoundingClientRect();

  return normalizeSlideFrameSize(rect?.width, rect?.height, fallback);
}

export function sameSlideFrameSize(left: SlideFrameSize, right: SlideFrameSize): boolean {
  return left.width === right.width && left.height === right.height;
}

function normalizeSlideFrameSize(
  width: number | undefined,
  height: number | undefined,
  fallback: SlideFrameSize
): SlideFrameSize {
  if (!isSafeDimension(width) || !isSafeDimension(height)) {
    return { ...fallback };
  }

  return {
    width: roundDimension(width),
    height: roundDimension(height)
  };
}

function isSafeDimension(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= MAX_SLIDE_FRAME_DIMENSION;
}

function roundDimension(value: number): number {
  return Math.round(value * 100) / 100;
}
