import type { Overlay, Patch } from "../types/patches";

const MAX_HISTORY = 60;

type EditorSnapshot = {
  sourceHtml: string;
  patches: Patch[];
  overlays: Overlay[];
};

export type EditorHistoryState = EditorSnapshot & {
  past: EditorSnapshot[];
  future: EditorSnapshot[];
  activeGroup: string | null;
};

export type EditorHistoryAction =
  | { type: "edit"; sourceHtml?: string; patches?: Patch[]; overlays?: Overlay[]; historyGroup?: string }
  | { type: "replace"; sourceHtml?: string; patches: Patch[]; overlays?: Overlay[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "end-group" };

export function createEmptyEditorHistory(): EditorHistoryState {
  return {
    sourceHtml: "",
    patches: [],
    overlays: [],
    past: [],
    future: [],
    activeGroup: null
  };
}

export function editorHistoryReducer(state: EditorHistoryState, action: EditorHistoryAction): EditorHistoryState {
  switch (action.type) {
    case "edit": {
      const nextSnapshot = cloneEditorSnapshot({
        sourceHtml: action.sourceHtml ?? state.sourceHtml,
        patches: action.patches ?? state.patches,
        overlays: action.overlays ?? state.overlays
      });

      if (areSnapshotsEqual(state, nextSnapshot)) {
        return state;
      }

      const shouldCaptureHistory = action.historyGroup ? state.activeGroup !== action.historyGroup : true;

      return {
        ...nextSnapshot,
        past: shouldCaptureHistory ? trimHistory([...state.past, toSnapshot(state)]) : state.past,
        future: [],
        activeGroup: action.historyGroup ?? null
      };
    }

    case "replace":
      return {
        sourceHtml: action.sourceHtml ?? state.sourceHtml,
        patches: action.patches,
        overlays: action.overlays ?? [],
        past: [],
        future: [],
        activeGroup: null
      };

    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) {
        return state;
      }

      return {
        ...previous,
        past: state.past.slice(0, -1),
        future: [toSnapshot(state), ...state.future].slice(0, MAX_HISTORY),
        activeGroup: null
      };
    }

    case "redo": {
      const next = state.future[0];
      if (!next) {
        return state;
      }

      return {
        ...next,
        past: trimHistory([...state.past, toSnapshot(state)]),
        future: state.future.slice(1),
        activeGroup: null
      };
    }

    case "end-group":
      return {
        ...state,
        activeGroup: null
      };

    default:
      return state;
  }
}

function trimHistory(history: EditorSnapshot[]): EditorSnapshot[] {
  return history.slice(Math.max(0, history.length - MAX_HISTORY));
}

function toSnapshot(state: EditorSnapshot): EditorSnapshot {
  return cloneEditorSnapshot({
    sourceHtml: state.sourceHtml,
    patches: state.patches,
    overlays: state.overlays
  });
}

function cloneEditorSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    sourceHtml: snapshot.sourceHtml,
    patches: snapshot.patches.map((patch) => ({ ...patch })),
    overlays: snapshot.overlays.map((overlay) => ({ ...overlay }))
  };
}

function areSnapshotsEqual(left: EditorSnapshot, right: EditorSnapshot): boolean {
  return JSON.stringify(toSnapshot(left)) === JSON.stringify(toSnapshot(right));
}
