export type Translate = {
  x: number;
  y: number;
};

export function parseTranslate(transform: string | undefined): Translate {
  if (!transform || transform === "none") {
    return { x: 0, y: 0 };
  }

  const translate = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)px(?:,\s*(-?\d+(?:\.\d+)?)px)?\s*\)/i);
  if (translate) {
    return {
      x: Number(translate[1]),
      y: Number(translate[2] ?? 0)
    };
  }

  const matrix = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/i);
  if (matrix) {
    return {
      x: Number(matrix[1]),
      y: Number(matrix[2])
    };
  }

  return { x: 0, y: 0 };
}

export function formatTranslate(x: number, y: number): string {
  return `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function readPixelValue(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}
