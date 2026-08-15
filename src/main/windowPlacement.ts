export type SavedWindowPlacement = {
  bounds: { x: number; y: number; width: number; height: number };
  displayScaleFactor: number;
  wasFullScreen: boolean;
  wasMaximized: boolean;
};

export type RestorableWindow = {
  setFullScreen: (value: boolean) => void;
  unmaximize: () => void;
  setBounds: (bounds: SavedWindowPlacement["bounds"], animate?: boolean) => void;
  maximize: () => void;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
};

export function restoreWindowPlacement(
  window: RestorableWindow,
  placement: SavedWindowPlacement,
  currentDisplayScaleFactor = placement.displayScaleFactor
): void {
  const errors: unknown[] = [];
  const attempt = (operation: () => void): void => {
    try { operation(); } catch (error) { errors.push(error); }
  };
  const restoredBounds = scaleBoundsForDisplayTransition(
    placement.bounds,
    placement.displayScaleFactor,
    currentDisplayScaleFactor
  );
  attempt(() => window.setFullScreen(false));
  attempt(() => window.unmaximize());
  attempt(() => window.setBounds(restoredBounds, false));
  if (placement.wasMaximized) attempt(() => window.maximize());
  if (placement.wasFullScreen) attempt(() => window.setFullScreen(true));
  attempt(() => { if (window.isMinimized()) window.restore(); });
  attempt(() => window.show());
  attempt(() => window.focus());
  if (errors.length > 0) throw new AggregateError(errors, "Editor window placement could not be restored completely");
}

export function scaleBoundsForDisplayTransition(
  bounds: SavedWindowPlacement["bounds"],
  targetScaleFactor: number,
  currentScaleFactor: number
): SavedWindowPlacement["bounds"] {
  if (!Number.isFinite(targetScaleFactor) || targetScaleFactor <= 0 ||
      !Number.isFinite(currentScaleFactor) || currentScaleFactor <= 0 ||
      targetScaleFactor === currentScaleFactor) {
    return bounds;
  }
  const scale = currentScaleFactor / targetScaleFactor;
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  };
}
