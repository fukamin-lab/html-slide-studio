import { cssEscape } from "./css";

export function ensureHssId(element: Element): string {
  const existing = element.getAttribute("data-hss-id");
  if (existing) {
    return existing;
  }

  const id = `el-${hashId(getStructuralSelector(element))}`;
  element.setAttribute("data-hss-id", id);
  return id;
}

export function getStructuralSelector(element: Element): string {
  const document = element.ownerDocument;
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body && current !== document.documentElement) {
    parts.unshift(selectorPart(current));
    const candidate = parts.join(" > ");

    if (document.querySelectorAll(candidate).length === 1) {
      return candidate;
    }

    current = current.parentElement;
  }

  return parts.length > 0 ? parts.join(" > ") : element.tagName.toLowerCase();
}

function selectorPart(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const elementId = element.getAttribute("id");
  if (elementId) {
    return `${tag}#${cssEscape(elementId)}`;
  }

  const className = Array.from(element.classList)
    .filter((name) => !name.startsWith("hss-"))
    .slice(0, 3)
    .map((name) => `.${cssEscape(name)}`)
    .join("");

  return `${tag}${className}:nth-of-type(${nthOfType(element)})`;
}

function nthOfType(element: Element): number {
  let index = 1;
  let sibling = element.previousElementSibling;

  while (sibling) {
    if (sibling.tagName === element.tagName) {
      index += 1;
    }

    sibling = sibling.previousElementSibling;
  }

  return index;
}

function hashId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}
