import type { EditableStyle, Patch, PatchTarget } from "../types/patches";
import type { SelectedElement } from "../types/selection";

export function upsertTextPatch(patches: Patch[], selectedElement: SelectedElement | null, text: string): Patch[] {
  if (!selectedElement) {
    return patches;
  }

  const now = new Date().toISOString();
  const existing = patches.find(
    (patch) => patch.type === "text" && patch.target.hssId === selectedElement.hssId
  );

  if (existing) {
    return patches.map((patch) =>
      patch.id === existing.id && patch.type === "text" ? { ...patch, text, updatedAt: now } : patch
    );
  }

  return [
    ...patches,
    {
      id: createPatchId(),
      type: "text",
      target: {
        hssId: selectedElement.hssId,
        selector: selectedElement.selector
      },
      text,
      updatedAt: now
    }
  ];
}

export function upsertStylePatch(
  patches: Patch[],
  selectedElement: SelectedElement | null,
  style: EditableStyle,
  metadata?: { locked?: boolean }
): Patch[] {
  if (!selectedElement) {
    return patches;
  }

  return upsertStylePatchForTarget(
    patches,
    {
      hssId: selectedElement.hssId,
      selector: selectedElement.selector
    },
    style,
    metadata
  );
}

export function upsertStylePatchForTarget(
  patches: Patch[],
  target: PatchTarget,
  style: EditableStyle,
  metadata?: { locked?: boolean }
): Patch[] {
  const now = new Date().toISOString();
  const existing = patches.find(
    (patch) => patch.type === "style" && patch.target.hssId === target.hssId
  );

  if (existing) {
    return patches.map((patch) =>
      patch.id === existing.id && patch.type === "style"
        ? { ...patch, ...metadata, style: { ...patch.style, ...style }, updatedAt: now }
        : patch
    );
  }

  return [
    ...patches,
    {
      id: createPatchId(),
      type: "style",
      target,
      style,
      ...metadata,
      updatedAt: now
    }
  ];
}

export function findStylePatch(patches: Patch[], hssId: string | undefined): Extract<Patch, { type: "style" }> | null {
  if (!hssId) {
    return null;
  }

  const patch = patches.find((candidate) => candidate.type === "style" && candidate.target.hssId === hssId);
  return patch?.type === "style" ? patch : null;
}

export function isDomTargetLocked(patches: Patch[], hssId: string | undefined): boolean {
  return Boolean(findStylePatch(patches, hssId)?.locked);
}

function createPatchId(): string {
  if (crypto.randomUUID) {
    return `patch-${crypto.randomUUID().slice(0, 8)}`;
  }

  return `patch-${Math.random().toString(36).slice(2, 10)}`;
}
