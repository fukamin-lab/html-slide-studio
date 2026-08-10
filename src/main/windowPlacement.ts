export type SavedWindowPlacement = {
  bounds: { x: number; y: number; width: number; height: number };
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

export function restoreWindowPlacement(window: RestorableWindow, placement: SavedWindowPlacement): void {
  const errors: unknown[] = [];
  const attempt = (operation: () => void): void => {
    try { operation(); } catch (error) { errors.push(error); }
  };
  attempt(() => window.setFullScreen(false));
  attempt(() => window.unmaximize());
  attempt(() => window.setBounds(placement.bounds, false));
  if (placement.wasMaximized) attempt(() => window.maximize());
  if (placement.wasFullScreen) attempt(() => window.setFullScreen(true));
  attempt(() => { if (window.isMinimized()) window.restore(); });
  attempt(() => window.show());
  attempt(() => window.focus());
  if (errors.length > 0) throw new AggregateError(errors, "Editor window placement could not be restored completely");
}
