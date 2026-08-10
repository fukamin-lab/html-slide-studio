export type PresentationDisplay = {
  id: number;
  bounds: {
    width: number;
    height: number;
  };
};

export function selectPresentationDisplays<T extends PresentationDisplay>(
  displays: T[],
  primaryDisplayId: number
): { presenter: T; audience: T | null } {
  if (displays.length === 0) throw new Error("No display is available");
  const presenter = displays.find((display) => display.id === primaryDisplayId) ?? displays[0];
  const audience = displays
    .filter((display) => display.id !== presenter.id)
    .sort((left, right) => {
      const areaDifference = right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height;
      return areaDifference !== 0 ? areaDifference : left.id - right.id;
    })[0] ?? null;
  return { presenter, audience };
}
