import type { EditableStyle, Patch } from "../types/patches";
import type { DomMoveChange, SelectedElement } from "../types/selection";
import { parseTranslate } from "./transform";

type DomMoveStateUpdate = {
  deltaX: number;
  deltaY: number;
  transform: string;
};

export function replaceSelection(current: SelectedElement[], selected: SelectedElement): SelectedElement[] {
  return current.map((selection) => (selection.hssId === selected.hssId ? selected : selection));
}

export function areSelectionListsEqual(left: SelectedElement[], right: SelectedElement[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((selection, index) => areSelectionsEqual(selection, right[index] ?? null));
}

export function areSelectionsEqual(left: SelectedElement | null, right: SelectedElement | null): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.hssId === right.hssId &&
    left.selector === right.selector &&
    left.textContent === right.textContent &&
    left.locked === right.locked &&
    Math.round(left.bbox.x) === Math.round(right.bbox.x) &&
    Math.round(left.bbox.y) === Math.round(right.bbox.y) &&
    Math.round(left.bbox.width) === Math.round(right.bbox.width) &&
    Math.round(left.bbox.height) === Math.round(right.bbox.height) &&
    JSON.stringify(left.computedStyle) === JSON.stringify(right.computedStyle);
}

export function updateSelectedStyle<T extends SelectedElement | null>(selected: T, style: EditableStyle): T {
  if (!selected) {
    return selected;
  }

  return {
    ...selected,
    computedStyle: {
      ...selected.computedStyle,
      ...style
    }
  };
}

export function createDomMoveStateUpdates(moves: DomMoveChange[], patches: Patch[]): Map<string, DomMoveStateUpdate> {
  const updates = new Map<string, DomMoveStateUpdate>();

  for (const move of moves) {
    const stylePatch = patches.find((patch) => patch.type === "style" && patch.target.hssId === move.selection.hssId);
    const currentTranslate = parseTranslate(
      stylePatch?.type === "style" ? stylePatch.style.transform : move.selection.computedStyle.transform
    );
    const nextTranslate = parseTranslate(move.transform);
    updates.set(move.selection.hssId, {
      deltaX: nextTranslate.x - currentTranslate.x,
      deltaY: nextTranslate.y - currentTranslate.y,
      transform: move.transform
    });
  }

  return updates;
}

export function applyDomMoveStateUpdate<T extends SelectedElement | null>(selected: T, updates: Map<string, DomMoveStateUpdate>): T {
  if (!selected) {
    return selected;
  }

  const update = updates.get(selected.hssId);
  if (!update) {
    return selected;
  }

  return {
    ...selected,
    computedStyle: {
      ...selected.computedStyle,
      transform: update.transform
    },
    bbox: {
      ...selected.bbox,
      x: selected.bbox.x + update.deltaX,
      y: selected.bbox.y + update.deltaY
    }
  };
}

export function toggleSelection(current: SelectedElement[], selected: SelectedElement): SelectedElement[] {
  if (current.some((selection) => selection.hssId === selected.hssId)) {
    return current.filter((selection) => selection.hssId !== selected.hssId);
  }

  return [...current, selected];
}

export function mergeSelections(current: SelectedElement[], additions: SelectedElement[]): SelectedElement[] {
  const byId = new Map(current.map((selection) => [selection.hssId, selection]));
  for (const addition of additions) {
    byId.set(addition.hssId, addition);
  }

  return Array.from(byId.values());
}

export function toggleId(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id];
}

export function mergeIds(current: string[], additions: string[]): string[] {
  return Array.from(new Set([...current, ...additions]));
}
