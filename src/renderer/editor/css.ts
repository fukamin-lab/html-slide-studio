export function cssEscape(value: string): string {
  if ("CSS" in window && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

export function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

export function cssColorToHex(color: string | undefined, fallback = "#ffffff"): string {
  if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
    return fallback;
  }

  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }

  const rgba = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgba) {
    return fallback;
  }

  const [, r, g, b] = rgba;
  return `#${toHex(Number(r))}${toHex(Number(g))}${toHex(Number(b))}`;
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}
