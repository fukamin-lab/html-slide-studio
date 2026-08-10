import type { EditableStyle, Overlay, OverlayImage, OverlayText } from "../types/patches";
import { parseTranslate } from "./transform";

type OverlayUpdate = Partial<
  Omit<OverlayText, "id" | "type"> &
    Omit<OverlayImage, "id" | "type">
>;

export function updateOverlay(overlays: Overlay[], overlayId: string, update: OverlayUpdate): Overlay[] {
  const updatedAt = new Date().toISOString();

  return overlays.map((overlay) =>
    overlay.id === overlayId
      ? {
          ...overlay,
          ...update,
          updatedAt
        }
      : overlay
  );
}

export function updateOverlayStyle(overlays: Overlay[], overlayId: string, style: EditableStyle): Overlay[] {
  const translate = style.transform ? parseTranslate(style.transform) : null;
  const width = style.width ? Number.parseFloat(style.width) : null;
  const height = style.height ? Number.parseFloat(style.height) : null;
  const styleUpdate: EditableStyle = { ...style };
  delete styleUpdate.transform;
  delete styleUpdate.width;
  delete styleUpdate.height;

  return overlays.map((overlay) => {
    if (overlay.id !== overlayId) {
      return overlay;
    }

    return {
      ...overlay,
      x: translate ? translate.x : overlay.x,
      y: translate ? translate.y : overlay.y,
      width: width !== null && Number.isFinite(width) ? Math.max(8, width) : overlay.width,
      height: height !== null && Number.isFinite(height) ? Math.max(8, height) : overlay.height,
      style: {
        ...overlay.style,
        ...styleUpdate
      },
      updatedAt: new Date().toISOString()
    };
  });
}
