export type SlideFrameSize = {
  width: number;
  height: number;
};

export const DEFAULT_SLIDE_FRAME_SIZE: Readonly<SlideFrameSize> = {
  width: 1366,
  height: 768
};

export const MAX_SLIDE_FRAME_DIMENSION = 16_384;
