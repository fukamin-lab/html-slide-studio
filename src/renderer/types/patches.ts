import type { SlideDescriptor } from "./project";

export type PatchTarget = {
  hssId: string;
  selector: string;
};

export type EditableStyle = {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  lineHeight?: string;
  textAlign?: string;
  alignItems?: string;
  justifyContent?: string;
  borderRadius?: string;
  borderColor?: string;
  borderStyle?: string;
  borderWidth?: string;
  objectFit?: string;
  objectPosition?: string;
  position?: string;
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
  margin?: string;
  boxSizing?: string;
  transform?: string;
  width?: string;
  height?: string;
  display?: string;
};

export type TextPatch = {
  id: string;
  type: "text";
  target: PatchTarget;
  text: string;
  updatedAt: string;
};

export type StylePatch = {
  id: string;
  type: "style";
  target: PatchTarget;
  style: EditableStyle;
  locked?: boolean;
  updatedAt: string;
};

export type Patch = TextPatch | StylePatch;

type OverlayBase = {
  id: string;
  slideId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  style: EditableStyle;
  hidden?: boolean;
  locked?: boolean;
  updatedAt: string;
};

export type OverlayText = OverlayBase & {
  type: "overlayText";
};

export type OverlayImage = OverlayBase & {
  type: "overlayImage";
  src: string;
};

export type Overlay = OverlayText | OverlayImage;

export type DocumentWarning = {
  id: string;
  severity: "info" | "warning";
  message: string;
};

export type PatchManifest = {
  version: 1;
  app: "html-slide-studio";
  savedAt: string;
  warnings: DocumentWarning[];
  slides: SlideDescriptor[];
  patches: Patch[];
  overlays: Overlay[];
};
