export type PreventUnloadEvent = {
  preventDefault: () => void;
};

export type PreventUnloadSource = {
  on: (event: "will-prevent-unload", listener: (event: PreventUnloadEvent) => void) => void;
};

export function registerUnsavedClosePrompt(
  source: PreventUnloadSource,
  confirmDiscard: () => boolean
): void {
  source.on("will-prevent-unload", (event) => {
    if (confirmDiscard()) event.preventDefault();
  });
}
