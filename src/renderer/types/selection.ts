import type { EditableStyle } from "./patches";

export type SelectedElement = {
  hssId: string;
  tagName: string;
  selector: string;
  textContent: string;
  className?: string;
  elementId?: string;
  imageSource?: string;
  childElementCount: number;
  canEditTextDirectly: boolean;
  locked?: boolean;
  computedStyle: {
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
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type DomMoveChange = {
  selection: SelectedElement;
  transform: string;
};

export type DomResizeChange = {
  selection: SelectedElement;
  transform: string;
  width: string;
  height: string;
  style?: EditableStyle;
};

export type OverlayMoveChange = {
  overlayId: string;
  x: number;
  y: number;
};

export type OverlayResizeChange = {
  overlayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
