import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { Baseline, Bold, PaintBucket, Trash2 } from "lucide-react";
import { applyPatchesToDocument, applySlideVisibility, rememberOriginalTextForPatch } from "../editor/patchEngine";
import {
  findElementByHssTarget,
  readSelectedElement,
  selectElementAtPoint,
  selectElementFromMouseEvent,
  selectElementsInRect
} from "../editor/selection";
import { documentAssetUrl } from "../editor/assetUrl";
import {
  extractExternalReferenceValues,
  REVIEW_CSS_URL_ATTRIBUTES,
  REVIEW_URL_ATTRIBUTES,
  type ReviewReferenceSource
} from "../editor/reviewReferences";
import { prepareSlideDocument } from "../editor/slideDetection";
import { isClippedTextOverflow } from "../editor/textOverflow";
import { formatTranslate, parseTranslate } from "../editor/transform";
import { useI18n } from "../i18n";
import type { EditableStyle, Overlay, Patch } from "../types/patches";
import type { SlideDescriptor } from "../types/project";
import type { ReviewExternalReference, ReviewSnapshot, ReviewTarget } from "../types/review";
import type { DomMoveChange, DomResizeChange, OverlayMoveChange, OverlayResizeChange, SelectedElement } from "../types/selection";

const FRAME_WIDTH = 1366;
const FRAME_HEIGHT = 768;
const RESIZE_HANDLES: ResizeHandle[] = ["nw", "ne", "sw", "se"];
const TEXT_MOVE_EDGES = ["top", "right", "bottom", "left"] as const;
const SNAP_THRESHOLD = 6;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1.6;
const QUICK_TEXT_COLORS = ["#20242a", "#b8553f", "#1f77b4"];
const QUICK_FILL_COLORS = ["", "#ffffff", "#fff2cc", "#d9eaf7"];

export type CanvasZoomMode = "fit" | "manual";

type CanvasStageProps = {
  sourceHtml: string;
  reviewHtml: string | null;
  sourceBaseHref?: string;
  patches: Patch[];
  overlays: Overlay[];
  currentSlideId: string | null;
  selectedElement: SelectedElement | null;
  selectedElements: SelectedElement[];
  selectedOverlayId: string | null;
  selectedOverlayIds: string[];
  snapEnabled: boolean;
  zoomMode: CanvasZoomMode;
  scale: number;
  onPrepared: (slides: SlideDescriptor[], warnings: string[]) => void;
  onSlideBounds: (bounds: SlideBounds) => void;
  onFitScaleChange: (scale: number) => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onZoomFit: () => void;
  onZoomActual: () => void;
  onNavigateSlideByWheel: (direction: -1 | 1) => boolean;
  onSelectElement: (selected: SelectedElement | null, options?: SelectionOptions) => void;
  onSelectElements: (selected: SelectedElement[], overlayIds: string[], options?: SelectionOptions) => void;
  onRefreshSelectedElements: (selected: SelectedElement[]) => void;
  onSelectOverlay: (overlayId: string, options?: SelectionOptions) => void;
  onInlineTextCommit: (selected: SelectedElement, text: string, options?: { historyGroup?: string }) => void;
  onOverlayTextCommit: (overlayId: string, text: string, options?: { historyGroup?: string }) => void;
  onDirectTextDraftChange: (dirty: boolean) => void;
  onDeleteSelection: () => void;
  onMoveOverlay: (overlayId: string, x: number, y: number) => void;
  onMoveSelection: (domMoves: DomMoveChange[], overlayMoves: OverlayMoveChange[], options?: { historyGroup?: string }) => void;
  onResizeSelection: (domResizes: DomResizeChange[], overlayResizes: OverlayResizeChange[], options?: { historyGroup?: string }) => void;
  onResizeOverlay: (overlayId: string, x: number, y: number, width: number, height: number, options?: { historyGroup?: string }) => void;
  onStyleChange: (style: EditableStyle, options?: StyleChangeOptions) => void;
  onEndHistoryGroup: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onNudge: (deltaX: number, deltaY: number, options?: { historyGroup?: string }) => void;
  onRuntimeWarnings: (warnings: string[]) => void;
  reviewRequestId: number;
  onReviewSnapshots: (requestId: number, snapshots: ReviewSnapshot[]) => void;
};

export function CanvasStage({
  sourceHtml,
  reviewHtml,
  sourceBaseHref,
  patches,
  overlays,
  currentSlideId,
  selectedElement,
  selectedElements,
  selectedOverlayId,
  selectedOverlayIds,
  snapEnabled,
  zoomMode,
  scale,
  onPrepared,
  onSlideBounds,
  onFitScaleChange,
  onZoomOut,
  onZoomIn,
  onZoomFit,
  onZoomActual,
  onNavigateSlideByWheel,
  onSelectElement,
  onSelectElements,
  onRefreshSelectedElements,
  onSelectOverlay,
  onInlineTextCommit,
  onOverlayTextCommit,
  onDirectTextDraftChange,
  onDeleteSelection,
  onMoveOverlay: _onMoveOverlay,
  onMoveSelection,
  onResizeSelection,
  onResizeOverlay,
  onStyleChange,
  onEndHistoryGroup,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  onDuplicate,
  onNudge,
  onRuntimeWarnings,
  reviewRequestId,
  onReviewSnapshots
}: CanvasStageProps): JSX.Element {
  const { t } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const selectedElementsRef = useRef<SelectedElement[]>([]);
  const suppressInputClickRef = useRef(false);
  const lastCanvasTextClickRef = useRef<TextClick | null>(null);
  const wheelDeltaRef = useRef(0);
  const lastWheelNavigationRef = useRef(0);
  const [interaction, setInteraction] = useState<CanvasInteraction | null>(null);
  const [overlayInteraction, setOverlayInteraction] = useState<OverlayInteraction | null>(null);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [pointerSelection, setPointerSelection] = useState<PointerSelection | null>(null);
  const [isInlineEditing, setIsInlineEditing] = useState(false);
  const [editingOverlay, setEditingOverlay] = useState<{ id: string; originalText: string } | null>(null);
  const inlineEditingRef = useRef(false);
  const setInlineEditing = useCallback((value: boolean): void => {
    inlineEditingRef.current = value;
    setIsInlineEditing(value);
  }, []);

  const prepared = useMemo(() => prepareSlideDocument(sourceHtml, sourceBaseHref), [sourceBaseHref, sourceHtml]);
  const reviewPrepared = useMemo(
    () => reviewHtml ? prepareSlideDocument(reviewHtml, sourceBaseHref) : null,
    [reviewHtml, sourceBaseHref]
  );
  const visibleOverlays = useMemo(
    () => overlays.filter((overlay) => !overlay.hidden && (!currentSlideId || !overlay.slideId || overlay.slideId === currentSlideId)),
    [currentSlideId, overlays]
  );
  const activeOverlay = useMemo(
    () => selectedOverlayId ? visibleOverlays.find((overlay) => overlay.id === selectedOverlayId) ?? null : null,
    [selectedOverlayId, visibleOverlays]
  );
  const miniPaletteBox = useMemo(() => {
    if (isInlineEditing || interaction || overlayInteraction) {
      return null;
    }

    const boxes = [
      ...selectedElements.map(selectedBox),
      ...selectedOverlayIds
        .map((overlayId) => visibleOverlays.find((overlay) => overlay.id === overlayId))
        .filter((overlay): overlay is Overlay => Boolean(overlay))
        .map(overlayBox)
    ];

    return boxes.length > 0 ? unionBoxes(boxes) : null;
  }, [interaction, isInlineEditing, overlayInteraction, selectedElements, selectedOverlayIds, visibleOverlays]);
  const canUseMiniPalette = useMemo(
    () =>
      selectedElements.some((selection) => !selection.locked && !isDomLocked(patches, selection.hssId) && !isSlideRootLikeSelection(selection)) ||
      selectedOverlayIds.some((overlayId) => {
        const overlay = visibleOverlays.find((candidate) => candidate.id === overlayId);
        return Boolean(overlay && !overlay.locked);
      }),
    [patches, selectedElements, selectedOverlayIds, visibleOverlays]
  );
  const miniPaletteStyle = useMemo(
    () => miniPaletteBox ? toMiniPaletteStyle(miniPaletteBox, scale) : undefined,
    [miniPaletteBox, scale]
  );
  const miniPaletteActiveStyle = selectedElement?.computedStyle ?? activeOverlay?.style;

  useEffect(() => {
    selectedElementsRef.current = selectedElements;
  }, [selectedElements]);

  useEffect(() => {
    onPrepared(prepared.slides, prepared.warnings);
  }, [onPrepared, prepared]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateScale = (): void => {
      const rect = viewport.getBoundingClientRect();
      const style = window.getComputedStyle(viewport);
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availableWidth = Math.max(1, rect.width - horizontalPadding);
      const availableHeight = Math.max(1, rect.height - verticalPadding);
      onFitScaleChange(clampZoom(Math.min(availableWidth / FRAME_WIDTH, availableHeight / FRAME_HEIGHT)));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [onFitScaleChange]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (isEditableKeyTarget(event.target) || !(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        onZoomIn();
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        onZoomOut();
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        onZoomFit();
        return;
      }

      if (event.key === "1") {
        event.preventDefault();
        onZoomActual();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [onZoomActual, onZoomFit, onZoomIn, onZoomOut]);

  const applyRuntimeState = useCallback(() => {
    if (inlineEditingRef.current) {
      return;
    }

    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    const warnings = applyPatchesToDocument(document, patches);
    applySlideVisibility(document, currentSlideId, prepared.slides);
    onSlideBounds(readCurrentSlideBounds(document, currentSlideId, prepared.slides));
    onRuntimeWarnings(warnings);

    const refreshedSelections = selectedElementsRef.current
      .flatMap((currentSelection): SelectedElement[] => {
        const selected = findElementByHssTarget(document, currentSelection.hssId, currentSelection.selector);
        return selected
          ? [{
              ...readSelectedElement(selected, currentSelection.selector, currentSelection.hssId),
              locked: currentSelection.locked || isDomLocked(patches, currentSelection.hssId)
            }]
          : [];
      });

    if (refreshedSelections.length > 0) {
      onRefreshSelectedElements(refreshedSelections);
    }
  }, [currentSlideId, onRefreshSelectedElements, onRuntimeWarnings, onSlideBounds, patches, prepared.slides]);

  useEffect(() => {
    if (!isInlineEditing) {
      applyRuntimeState();
    }
  }, [applyRuntimeState, isInlineEditing, selectedElements]);

  const attachEditorListeners = useCallback(() => {
    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    const handleClick = (event: MouseEvent): void => {
      if (isEditableKeyTarget(event.target)) {
        if (event.detail >= 2) {
          const editable = findContentEditableElement(event.target);
          if (editable) {
            event.preventDefault();
            event.stopPropagation();
            selectElementContents(editable);
          }
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const selected = selectElementFromMouseEvent(event);
      onSelectElement(selected && !isDomLocked(patches, selected.hssId) ? selected : null, { additive: event.ctrlKey || event.metaKey });
    };

    const handleDoubleClick = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const selected = selectElementFromMouseEvent(event);
      if (!selected || isDomLocked(patches, selected.hssId)) {
        return;
      }

      const element = findElementByHssTarget(document, selected.hssId, selected.selector);
      if (selected.canEditTextDirectly && isHtmlElement(element) && canInlineEdit(element)) {
        beginInlineEditBySelection(
          document,
          selected,
          onSelectElement,
          onInlineTextCommit,
          onDirectTextDraftChange,
          onUndo,
          onRedo,
          onEndHistoryGroup,
          setInlineEditing,
          { selectAll: true }
        );
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isEditableKeyTarget(event.target)) {
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        onDeleteSelection();
        return;
      }

      const nudge = getArrowNudge(event);
      if (nudge) {
        event.preventDefault();
        event.stopPropagation();
        onNudge(nudge.x, nudge.y, { historyGroup: "keyboard-nudge" });
        return;
      }

      const isModifierPressed = event.ctrlKey || event.metaKey;
      if (!isModifierPressed) {
        return;
      }

      if (event.key.toLowerCase() === "z" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onRedo();
        return;
      }

      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopPropagation();
        onUndo();
        return;
      }

      if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        event.stopPropagation();
        onRedo();
        return;
      }

      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        onCopy();
        return;
      }

      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        event.stopPropagation();
        onPaste();
        return;
      }

      if (event.key.toLowerCase() === "d") {
        event.preventDefault();
        event.stopPropagation();
        onDuplicate();
      }
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key.startsWith("Arrow")) {
        onEndHistoryGroup();
      }
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("dblclick", handleDoubleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("keyup", handleKeyUp, true);
    applyRuntimeState();

    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("dblclick", handleDoubleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [
    applyRuntimeState,
    onDeleteSelection,
    onDirectTextDraftChange,
    onEndHistoryGroup,
    onInlineTextCommit,
    onCopy,
    onNudge,
    onPaste,
    patches,
    onRedo,
    onSelectElement,
    onSelectElements,
    onUndo,
    onDuplicate,
    visibleOverlays
  ]);

  const handleReviewFrameLoad = useCallback((requestId: number): void => {
    const frame = reviewIframeRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document || !reviewPrepared) {
      return;
    }

    const snapshots = reviewPrepared.slides.length > 0
      ? captureDeckReviewSnapshots(document, frame, reviewPrepared.slides, sourceBaseHref)
      : [buildReviewSnapshot(document, frame, null, [], [], 1, sourceBaseHref, true)];

    onReviewSnapshots(requestId, snapshots);
  }, [onReviewSnapshots, reviewPrepared, sourceBaseHref]);

  const handleInputPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInlineEditing) {
      return;
    }

    event.currentTarget.focus();
    const document = iframeRef.current?.contentDocument;
    const point = toFramePoint(event, scale);
    const rawSelected = document ? selectElementAtPoint(document, point.x, point.y) : null;
    if (rawSelected && isDomLocked(patches, rawSelected.hssId)) {
      suppressInputClickRef.current = true;
      return;
    }

    const selected = rawSelected && !isDomLocked(patches, rawSelected.hssId) ? rawSelected : null;

    const selectedAlreadyActive = Boolean(selected && selectedElements.some((selection) => selection.hssId === selected.hssId));
    if (selected && canStartCanvasDomMove(selected) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      suppressInputClickRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);

      if (!selectedAlreadyActive) {
        onSelectElement(selected);
      }

      const movingSelections = selectedAlreadyActive
        ? selectedElements.filter((selection) => !selection.locked && !isDomLocked(patches, selection.hssId))
        : [selected];
      const movingOverlays = selectedAlreadyActive
        ? selectedOverlayIds
            .map((overlayId) => overlays.find((overlay) => overlay.id === overlayId))
            .filter((overlay): overlay is Overlay => Boolean(overlay))
            .filter((overlay) => !overlay.locked)
        : [];
      const primaryTranslate = readCurrentTranslate(patches, selected);

      setInteraction({
        mode: "move",
        pointerId: event.pointerId,
        historyGroup: `canvas-move-${event.pointerId}`,
        resizeHandle: "se",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: selected.bbox.x,
        startY: selected.bbox.y,
        startTranslateX: primaryTranslate.x,
        startTranslateY: primaryTranslate.y,
        primaryHssId: selected.hssId,
        startDomMoves: movingSelections.map((selection) => {
          const translate = readCurrentTranslate(patches, selection);
          return {
            selection,
            startTranslateX: translate.x,
            startTranslateY: translate.y
          };
        }),
        startOverlayMoves: movingOverlays.map((overlay) => ({
          overlayId: overlay.id,
          startX: overlay.x,
          startY: overlay.y
        })),
        startDomResizes: [],
        startOverlayResizes: [],
        startWidth: selected.bbox.width,
        startHeight: selected.bbox.height,
        textClickCandidate: selected.canEditTextDirectly ? { hssId: selected.hssId, point } : undefined
      });
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setPointerSelection({
      pointerId: event.pointerId,
      additive: event.ctrlKey || event.metaKey,
      start: point,
      current: point,
      active: false,
      suppressClick: false
    });
  }, [isInlineEditing, onDirectTextDraftChange, onInlineTextCommit, onSelectElement, overlays, patches, scale, selectedElements, selectedOverlayIds]);

  const handleInputPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!pointerSelection || event.pointerId !== pointerSelection.pointerId) {
      return;
    }

    const current = toFramePoint(event, scale);
    const distance = Math.hypot(current.x - pointerSelection.start.x, current.y - pointerSelection.start.y);
    const active = pointerSelection.active || distance >= 6;

    setPointerSelection({
      ...pointerSelection,
      current,
      active
    });
    setMarquee(active ? toMarqueeRect(pointerSelection.start, current) : null);
  }, [pointerSelection, scale]);

  const handleInputPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!pointerSelection || event.pointerId !== pointerSelection.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    const current = toFramePoint(event, scale);

    if (pointerSelection.active) {
      const document = iframeRef.current?.contentDocument;
      if (document) {
        const rect = toMarqueeRect(pointerSelection.start, current);
        const selected = selectElementsInRect(document, rect).filter((selection) => !isDomLocked(patches, selection.hssId));
        const overlayIds = getOverlaysInRect(visibleOverlays.filter((overlay) => !overlay.locked), rect);
        onSelectElements(selected, overlayIds, { additive: pointerSelection.additive });
      }
      suppressInputClickRef.current = true;
    }

    setPointerSelection(null);
    setMarquee(null);
  }, [onSelectElements, patches, pointerSelection, scale, visibleOverlays]);

  const handleInputClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isInlineEditing) {
      return;
    }

    if (suppressInputClickRef.current) {
      suppressInputClickRef.current = false;
      return;
    }

    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    const point = toFramePoint(event, scale);
    const rawSelected = selectElementAtPoint(document, point.x, point.y);
    if (rawSelected && isDomLocked(patches, rawSelected.hssId)) {
      return;
    }

    const selected = rawSelected && !isDomLocked(patches, rawSelected.hssId) ? rawSelected : null;
    lastCanvasTextClickRef.current = selected?.canEditTextDirectly && !event.ctrlKey && !event.metaKey
      ? { hssId: selected.hssId, point, timestamp: performance.now() }
      : null;
    onSelectElement(selected, { additive: event.ctrlKey || event.metaKey });
    setPointerSelection(null);
  }, [isInlineEditing, onSelectElement, patches, scale]);

  const handleInputDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    const point = toFramePoint(event, scale);
    const selected = selectElementAtPoint(document, point.x, point.y);
    if (!selected || isDomLocked(patches, selected.hssId)) {
      return;
    }

    beginInlineEditBySelection(
      document,
      selected,
      onSelectElement,
      onInlineTextCommit,
      onDirectTextDraftChange,
      onUndo,
      onRedo,
      onEndHistoryGroup,
      setInlineEditing,
      { selectAll: true }
    );
  }, [onDirectTextDraftChange, onEndHistoryGroup, onInlineTextCommit, onRedo, onSelectElement, onUndo, patches, scale]);

  const handleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDeleteSelection();
      return;
    }

    const nudge = getArrowNudge(event.nativeEvent);
    if (nudge) {
      event.preventDefault();
      onNudge(nudge.x, nudge.y, { historyGroup: "keyboard-nudge" });
      return;
    }

    const isModifierPressed = event.ctrlKey || event.metaKey;
    if (!isModifierPressed) {
      return;
    }

    if (event.key.toLowerCase() === "z" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onRedo();
      return;
    }

    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.stopPropagation();
      onUndo();
      return;
    }

    if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      event.stopPropagation();
      onRedo();
      return;
    }

    if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      event.stopPropagation();
      onCopy();
      return;
    }

    if (event.key.toLowerCase() === "v") {
      event.preventDefault();
      event.stopPropagation();
      onPaste();
      return;
    }

    if (event.key.toLowerCase() === "d") {
      event.preventDefault();
      event.stopPropagation();
      onDuplicate();
    }
  }, [onCopy, onDeleteSelection, onDuplicate, onNudge, onPaste, onRedo, onUndo]);

  const measureLiveSelection = useCallback((selection: SelectedElement): SelectedElement => {
    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return selection;
    }

    const element = findElementByHssTarget(document, selection.hssId, selection.selector);
    return element
      ? { ...readSelectedElement(element, selection.selector, selection.hssId), locked: selection.locked }
      : selection;
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>, targetSelection = selectedElement) => {
      if (!targetSelection || targetSelection.locked || !canStartCanvasDomMove(targetSelection) || isDomLocked(patches, targetSelection.hssId)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const measuredTarget = measureLiveSelection(targetSelection);
      const handle = (event.target as HTMLElement).dataset.handle;
      const resizeHandle = readResizeHandle(handle);
      const mode = resizeHandle ? "resize" : "move";
      const movingSelections = (mode === "move"
        ? selectedElements.filter((selection) => !selection.locked && !isDomLocked(patches, selection.hssId))
        : [targetSelection]).map(measureLiveSelection);
      const movingOverlays = mode === "move"
        ? selectedOverlayIds
            .map((overlayId) => overlays.find((overlay) => overlay.id === overlayId))
            .filter((overlay): overlay is Overlay => Boolean(overlay))
            .filter((overlay) => !overlay.locked)
        : [];
      const resizingSelections = (mode === "resize"
        ? selectedElements.filter((selection) => !selection.locked && !isDomLocked(patches, selection.hssId) && canStartCanvasDomMove(selection))
        : []).map(measureLiveSelection);
      const resizingOverlays = mode === "resize"
        ? selectedOverlayIds
            .map((overlayId) => overlays.find((overlay) => overlay.id === overlayId))
            .filter((overlay): overlay is Overlay => Boolean(overlay))
            .filter((overlay) => !overlay.locked)
        : [];
      const primaryTranslate = readCurrentTranslate(patches, measuredTarget);

      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({
        mode,
        pointerId: event.pointerId,
        historyGroup: `canvas-${mode}-${event.pointerId}`,
        resizeHandle: resizeHandle ?? "se",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: measuredTarget.bbox.x,
        startY: measuredTarget.bbox.y,
        startTranslateX: primaryTranslate.x,
        startTranslateY: primaryTranslate.y,
        primaryHssId: measuredTarget.hssId,
        startDomMoves: movingSelections.map((selection) => {
          const translate = readCurrentTranslate(patches, selection);
          return {
            selection,
            startTranslateX: translate.x,
            startTranslateY: translate.y
          };
        }),
        startOverlayMoves: movingOverlays.map((overlay) => ({
          overlayId: overlay.id,
          startX: overlay.x,
          startY: overlay.y
        })),
        startDomResizes: resizingSelections.map((selection) => {
          const translate = readCurrentTranslate(patches, selection);
          return {
            selection,
            startTranslateX: translate.x,
            startTranslateY: translate.y,
            anchorStyle: createDomResizeAnchorStyle(selection, translate),
            startX: selection.bbox.x,
            startY: selection.bbox.y,
            startWidth: selection.bbox.width,
            startHeight: selection.bbox.height
          };
        }),
        startOverlayResizes: resizingOverlays.map((overlay) => ({
          overlayId: overlay.id,
          startX: overlay.x,
          startY: overlay.y,
          startWidth: overlay.width,
          startHeight: overlay.height
        })),
        startWidth: measuredTarget.bbox.width,
        startHeight: measuredTarget.bbox.height
      });
    },
    [measureLiveSelection, overlays, patches, selectedElement, selectedElements, selectedOverlayIds]
  );

  const applyCanvasInteraction = useCallback(
    (clientX: number, clientY: number, bypassSnap = false) => {
      if (!interaction) {
        return;
      }

      const document = iframeRef.current?.contentDocument;
      const rawDeltaX = (clientX - interaction.startClientX) / scale;
      const rawDeltaY = (clientY - interaction.startClientY) / scale;
      const snap = document && snapEnabled && !bypassSnap
        ? snapCanvasInteraction(interaction, rawDeltaX, rawDeltaY, document, currentSlideId, prepared.slides, patches, visibleOverlays)
        : { deltaX: rawDeltaX, deltaY: rawDeltaY, guides: [] };
      const deltaX = snap.deltaX;
      const deltaY = snap.deltaY;
      setSnapGuides(snap.guides);

      if (interaction.mode === "move") {
        onMoveSelection(
          interaction.startDomMoves.map((move) => ({
            selection: move.selection,
            transform: formatTranslate(move.startTranslateX + deltaX, move.startTranslateY + deltaY)
          })),
          interaction.startOverlayMoves.map((move) => ({
            overlayId: move.overlayId,
            x: Math.round(move.startX + deltaX),
            y: Math.round(move.startY + deltaY)
          })),
          { historyGroup: interaction.historyGroup }
        );
        return;
      }

      onResizeSelection(
        interaction.startDomResizes.map((resize) => {
          const nextBox = resizeBoxFromHandle(
            interaction.resizeHandle,
            resize.startX,
            resize.startY,
            resize.startWidth,
            resize.startHeight,
            deltaX,
            deltaY
          );

          return {
            selection: resize.selection,
            style: resize.anchorStyle,
            transform: formatTranslate(
              resize.startTranslateX + nextBox.x - resize.startX,
              resize.startTranslateY + nextBox.y - resize.startY
            ),
            width: `${nextBox.width}px`,
            height: `${nextBox.height}px`
          };
        }),
        interaction.startOverlayResizes.map((resize) => {
          const nextBox = resizeBoxFromHandle(
            interaction.resizeHandle,
            resize.startX,
            resize.startY,
            resize.startWidth,
            resize.startHeight,
            deltaX,
            deltaY
          );

          return {
            overlayId: resize.overlayId,
            x: nextBox.x,
            y: nextBox.y,
            width: nextBox.width,
            height: nextBox.height
          };
        }),
        { historyGroup: interaction.historyGroup }
      );
    },
    [currentSlideId, interaction, onMoveSelection, onResizeSelection, patches, prepared.slides, scale, snapEnabled, visibleOverlays]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();
      applyCanvasInteraction(event.clientX, event.clientY, event.altKey);
    },
    [applyCanvasInteraction, interaction]
  );

  useEffect(() => {
    if (!interaction) {
      return;
    }

    const handleWindowPointerMove = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== interaction.pointerId) {
        return;
      }

      event.preventDefault();
      applyCanvasInteraction(event.clientX, event.clientY, event.altKey);
    };
    const handleWindowMouseMove = (event: MouseEvent): void => {
      event.preventDefault();
      applyCanvasInteraction(event.clientX, event.clientY, event.altKey);
    };
    let finished = false;
    const finish = (clientX?: number, clientY?: number): void => {
      if (finished) return;
      finished = true;
      if (interaction.textClickCandidate && clientX !== undefined && clientY !== undefined) {
        const moved = Math.hypot(clientX - interaction.startClientX, clientY - interaction.startClientY);
        lastCanvasTextClickRef.current = moved < 6
          ? { ...interaction.textClickCandidate, timestamp: performance.now() }
          : null;
      }
      setInteraction(null);
      setSnapGuides([]);
      onEndHistoryGroup();
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent): void => {
      if (event.pointerId === interaction.pointerId) {
        finish(event.clientX, event.clientY);
      }
    };
    const handleWindowMouseUp = (event: MouseEvent): void => finish(event.clientX, event.clientY);

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [applyCanvasInteraction, interaction, onEndHistoryGroup]);

  const finishInteraction = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
      }

      event.currentTarget.releasePointerCapture(event.pointerId);
      setInteraction(null);
      setSnapGuides([]);
      onEndHistoryGroup();
    },
    [interaction, onEndHistoryGroup]
  );

  const handleOverlayPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>, overlay: Overlay) => {
      if (isInlineEditing || isEditableKeyTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (overlay.locked) {
        onSelectOverlay(overlay.id, { additive: event.ctrlKey || event.metaKey });
        return;
      }

      const resizeHandle = readResizeHandle((event.target as HTMLElement).dataset.overlayHandle);
      const mode = resizeHandle ? "resize" : "move";
      const point = { x: event.clientX, y: event.clientY };
      const additive = event.ctrlKey || event.metaKey;
      const overlayAlreadySelected = selectedOverlayIds.includes(overlay.id);
      const clickedText = Boolean((event.target as HTMLElement).closest(".overlay-text__content"));
      if (mode === "move" && overlay.type === "overlayText" && overlayAlreadySelected && !additive && clickedText) {
        const content = event.currentTarget.querySelector<HTMLElement>(".overlay-text__content");
        if (content) {
          setInlineEditing(true);
          setEditingOverlay({ id: overlay.id, originalText: overlay.text });
          onSelectOverlay(overlay.id);
          beginOverlayTextEdit(
            content,
            overlay.id,
            onOverlayTextCommit,
            onUndo,
            onRedo,
            () => {
              setInlineEditing(false);
              setEditingOverlay(null);
              onEndHistoryGroup();
            },
            { caretPoint: point }
          );
          return;
        }
      }
      const movingOverlayIds = mode === "move"
        ? overlayAlreadySelected
          ? selectedOverlayIds.filter((overlayId) => !visibleOverlays.find((candidate) => candidate.id === overlayId)?.locked)
          : additive
            ? Array.from(new Set([...selectedOverlayIds, overlay.id]))
            : [overlay.id]
        : [overlay.id];
      const movingDomSelections: SelectedElement[] = [];
      const resizingOverlayIds = mode === "resize" && overlayAlreadySelected
        ? selectedOverlayIds.filter((overlayId) => !visibleOverlays.find((candidate) => candidate.id === overlayId)?.locked)
        : [overlay.id];
      const resizingDomSelections: SelectedElement[] = [];

      onSelectOverlay(overlay.id, { additive });
      event.currentTarget.setPointerCapture(event.pointerId);
      setOverlayInteraction({
        mode,
        pointerId: event.pointerId,
        overlayId: overlay.id,
        historyGroup: `overlay-${mode}-${event.pointerId}`,
        resizeHandle: resizeHandle ?? "se",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: overlay.x,
        startY: overlay.y,
        startWidth: overlay.width,
        startHeight: overlay.height,
        startDomMoves: movingDomSelections.map((selection) => {
          const translate = readCurrentTranslate(patches, selection);
          return {
            selection,
            startTranslateX: translate.x,
            startTranslateY: translate.y
          };
        }),
        startOverlayMoves: movingOverlayIds
          .map((overlayId) => visibleOverlays.find((candidate) => candidate.id === overlayId))
          .filter((candidate): candidate is Overlay => Boolean(candidate))
          .map((candidate) => ({
            overlayId: candidate.id,
            startX: candidate.x,
            startY: candidate.y
          })),
        startDomResizes: resizingDomSelections.map((selection) => {
          const translate = readCurrentTranslate(patches, selection);
          return {
            selection,
            startTranslateX: translate.x,
            startTranslateY: translate.y,
            anchorStyle: createDomResizeAnchorStyle(selection, translate),
            startX: selection.bbox.x,
            startY: selection.bbox.y,
            startWidth: selection.bbox.width,
            startHeight: selection.bbox.height
          };
        }),
        startOverlayResizes: resizingOverlayIds
          .map((overlayId) => visibleOverlays.find((candidate) => candidate.id === overlayId))
          .filter((candidate): candidate is Overlay => Boolean(candidate))
          .map((candidate) => ({
            overlayId: candidate.id,
            startX: candidate.x,
            startY: candidate.y,
            startWidth: candidate.width,
            startHeight: candidate.height
          }))
      });
    },
    [isInlineEditing, measureLiveSelection, onEndHistoryGroup, onOverlayTextCommit, onRedo, onSelectOverlay, onUndo, patches, selectedElements, selectedOverlayIds, visibleOverlays]
  );

  const handleOverlayDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, overlay: Overlay) => {
      event.preventDefault();
      event.stopPropagation();

      if (overlay.locked || overlay.type !== "overlayText") {
        return;
      }

      const content = event.currentTarget.querySelector<HTMLElement>(".overlay-text__content");
      if (!content) {
        return;
      }

      setInlineEditing(true);
      setEditingOverlay({ id: overlay.id, originalText: overlay.text });
      onSelectOverlay(overlay.id);
      beginOverlayTextEdit(
        content,
        overlay.id,
        onOverlayTextCommit,
        onUndo,
        onRedo,
        () => {
          setInlineEditing(false);
          setEditingOverlay(null);
          onEndHistoryGroup();
        },
        { selectAll: true }
      );
    },
    [onEndHistoryGroup, onOverlayTextCommit, onRedo, onSelectOverlay, onUndo]
  );

  const applyOverlayInteraction = useCallback(
    (clientX: number, clientY: number, bypassSnap = false) => {
      if (!overlayInteraction) {
        return;
      }

      const document = iframeRef.current?.contentDocument;
      const rawDeltaX = (clientX - overlayInteraction.startClientX) / scale;
      const rawDeltaY = (clientY - overlayInteraction.startClientY) / scale;
      const snap = document && snapEnabled && !bypassSnap
        ? snapOverlayInteraction(overlayInteraction, rawDeltaX, rawDeltaY, document, currentSlideId, prepared.slides, patches, visibleOverlays)
        : { deltaX: rawDeltaX, deltaY: rawDeltaY, guides: [] };
      const deltaX = snap.deltaX;
      const deltaY = snap.deltaY;
      setSnapGuides(snap.guides);

      if (overlayInteraction.mode === "resize") {
        onResizeSelection(
          overlayInteraction.startDomResizes.map((resize) => {
            const nextBox = resizeBoxFromHandle(
              overlayInteraction.resizeHandle,
              resize.startX,
              resize.startY,
              resize.startWidth,
              resize.startHeight,
              deltaX,
              deltaY
            );

            return {
              selection: resize.selection,
              style: resize.anchorStyle,
              transform: formatTranslate(
                resize.startTranslateX + nextBox.x - resize.startX,
                resize.startTranslateY + nextBox.y - resize.startY
              ),
              width: `${nextBox.width}px`,
              height: `${nextBox.height}px`
            };
          }),
          overlayInteraction.startOverlayResizes.map((resize) => {
            const nextBox = resizeBoxFromHandle(
              overlayInteraction.resizeHandle,
              resize.startX,
              resize.startY,
              resize.startWidth,
              resize.startHeight,
              deltaX,
              deltaY
            );

            return {
              overlayId: resize.overlayId,
              x: nextBox.x,
              y: nextBox.y,
              width: nextBox.width,
              height: nextBox.height
            };
          }),
          { historyGroup: overlayInteraction.historyGroup }
        );
        return;
      }

      onMoveSelection(
        overlayInteraction.startDomMoves.map((move) => ({
          selection: move.selection,
          transform: formatTranslate(move.startTranslateX + deltaX, move.startTranslateY + deltaY)
        })),
        overlayInteraction.startOverlayMoves.map((move) => ({
          overlayId: move.overlayId,
          x: Math.round(move.startX + deltaX),
          y: Math.round(move.startY + deltaY)
        })),
        { historyGroup: overlayInteraction.historyGroup }
      );
    },
    [currentSlideId, onMoveSelection, onResizeSelection, overlayInteraction, patches, prepared.slides, scale, snapEnabled, visibleOverlays]
  );

  const handleOverlayPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!overlayInteraction || event.pointerId !== overlayInteraction.pointerId) {
        return;
      }

      event.preventDefault();
      applyOverlayInteraction(event.clientX, event.clientY, event.altKey);
    },
    [applyOverlayInteraction, overlayInteraction]
  );

  useEffect(() => {
    if (!overlayInteraction) {
      return;
    }

    const handleWindowPointerMove = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== overlayInteraction.pointerId) {
        return;
      }

      event.preventDefault();
      applyOverlayInteraction(event.clientX, event.clientY, event.altKey);
    };
    const handleWindowMouseMove = (event: MouseEvent): void => {
      event.preventDefault();
      applyOverlayInteraction(event.clientX, event.clientY, event.altKey);
    };
    const finish = (): void => {
      setOverlayInteraction(null);
      setSnapGuides([]);
      onEndHistoryGroup();
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent): void => {
      if (event.pointerId === overlayInteraction.pointerId) {
        finish();
      }
    };

    window.addEventListener("pointermove", handleWindowPointerMove);
    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerUp);
    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", finish);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerUp);
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", finish);
    };
  }, [applyOverlayInteraction, onEndHistoryGroup, overlayInteraction]);

  const finishOverlayInteraction = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!overlayInteraction || event.pointerId !== overlayInteraction.pointerId) {
        return;
      }

      event.currentTarget.releasePointerCapture(event.pointerId);
      setOverlayInteraction(null);
      setSnapGuides([]);
      onEndHistoryGroup();
    },
    [onEndHistoryGroup, overlayInteraction]
  );

  const handleCanvasWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (
        isInlineEditing ||
        interaction ||
        overlayInteraction ||
        pointerSelection ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        isEditableKeyTarget(event.target) ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return;
      }

      wheelDeltaRef.current += event.deltaY;
      const threshold = event.deltaMode === 1 ? 2 : 72;
      if (Math.abs(wheelDeltaRef.current) < threshold) {
        return;
      }

      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelNavigationRef.current < 280) {
        return;
      }

      const direction = wheelDeltaRef.current > 0 ? 1 : -1;
      wheelDeltaRef.current = 0;
      const changed = onNavigateSlideByWheel(direction);
      if (changed) {
        lastWheelNavigationRef.current = now;
      }
    },
    [interaction, isInlineEditing, onNavigateSlideByWheel, overlayInteraction, pointerSelection]
  );

  return (
    <main className="canvas-shell">
      <div className={`canvas-viewport canvas-viewport--${zoomMode}`} ref={viewportRef}>
        <div
          ref={frameRef}
          className="canvas-frame"
          onWheel={handleCanvasWheel}
          style={{
            width: FRAME_WIDTH * scale,
            height: FRAME_HEIGHT * scale
          }}
        >
          <iframe
            ref={iframeRef}
            className="slide-frame"
            title="HTML slide canvas"
            sandbox="allow-same-origin"
            srcDoc={prepared.html}
            onLoad={attachEditorListeners}
            style={{
              width: FRAME_WIDTH,
              height: FRAME_HEIGHT,
              transform: `scale(${scale})`
            }}
          />
          <div
            className={`canvas-input-layer${isInlineEditing ? " canvas-input-layer--disabled" : ""}`}
            tabIndex={0}
            aria-label="Slide object selection layer"
            onPointerDown={handleInputPointerDown}
            onPointerMove={handleInputPointerMove}
            onPointerUp={handleInputPointerUp}
            onPointerCancel={() => {
              setPointerSelection(null);
              setMarquee(null);
            }}
            onClick={handleInputClick}
            onDoubleClick={handleInputDoubleClick}
            onKeyDown={handleInputKeyDown}
          />
          {visibleOverlays.map((overlay) => {
            const isSelectedOverlay = selectedOverlayIds.includes(overlay.id);

            return (
              <div
                key={overlay.id}
                className={`overlay-text${overlay.type === "overlayImage" ? " overlay-image" : ""}${isSelectedOverlay ? " overlay-text--selected" : ""}${overlay.locked ? " overlay-text--locked" : ""}`}
                data-hss-overlay-id={overlay.id}
                style={toOverlayStyle(overlay, scale)}
                onPointerDown={(event) => handleOverlayPointerDown(event, overlay)}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={finishOverlayInteraction}
                onPointerCancel={finishOverlayInteraction}
                onDoubleClick={(event) => handleOverlayDoubleClick(event, overlay)}
                title={overlay.type === "overlayImage" ? "画像" : "テキスト"}
              >
                {overlay.type === "overlayText" ? (
                  <span className="overlay-text__content" data-overlay-content-id={overlay.id}>
                    {editingOverlay?.id === overlay.id ? editingOverlay.originalText : overlay.text}
                  </span>
                ) : overlay.type === "overlayImage" ? (
                  <img
                    className="overlay-image__content"
                    src={documentAssetUrl(sourceBaseHref, overlay.src)}
                    alt={overlay.text}
                    draggable={false}
                    style={{ objectFit: (overlay.style.objectFit ?? "contain") as CSSProperties["objectFit"], objectPosition: overlay.style.objectPosition ?? "center" }}
                  />
                ) : null}
                {isSelectedOverlay && !overlay.locked ? RESIZE_HANDLES.map((handle) => (
                  <span
                    key={handle}
                    className={`overlay-resize-handle overlay-resize-handle--${handle}`}
                    data-overlay-handle={`resize-${handle}`}
                    aria-hidden="true"
                    title="Resize"
                  />
                )) : null}
              </div>
            );
          })}
          {!isInlineEditing ? selectedElements.map((selection) => {
            const isPrimary = selection.hssId === selectedElement?.hssId;
            const isLocked = Boolean(selection.locked || isDomLocked(patches, selection.hssId));
            const outlineStyle = toOutlineStyle(selection, scale);

            return (
              <div
                key={selection.hssId}
                className={`selection-outline${interaction && isPrimary ? " selection-outline--active" : ""}${!isPrimary ? " selection-outline--secondary" : ""}${isLocked ? " selection-outline--locked" : ""}`}
                style={outlineStyle}
                onPointerDown={(event) => {
                  if (event.button !== 0 || isInlineEditing) {
                    return;
                  }

                  if ((event.target as HTMLElement).dataset.handle) {
                    lastCanvasTextClickRef.current = null;
                    return;
                  }

                  if (!isLocked && selection.canEditTextDirectly) {
                    const document = iframeRef.current?.contentDocument;
                    const caretPoint = toFrameClientPoint(frameRef.current, event.clientX, event.clientY, scale);
                    const selectAll = Boolean(caretPoint && isQuickTextClick(lastCanvasTextClickRef.current, selection, caretPoint));
                    lastCanvasTextClickRef.current = null;
                    if (document && beginInlineEditBySelection(
                      document,
                      selection,
                      onSelectElement,
                      onInlineTextCommit,
                      onDirectTextDraftChange,
                      onUndo,
                      onRedo,
                      onEndHistoryGroup,
                      setInlineEditing,
                      selectAll ? { selectAll: true } : caretPoint ? { caretPoint } : undefined
                    )) {
                      event.preventDefault();
                      event.stopPropagation();
                      return;
                    }
                  }

                  if (!isLocked) {
                    handlePointerDown(event, selection);
                  }
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={finishInteraction}
                onPointerCancel={finishInteraction}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const document = iframeRef.current?.contentDocument;
                  if (!document) {
                    return;
                  }

                  beginInlineEditBySelection(
                    document,
                    selection,
                    onSelectElement,
                    onInlineTextCommit,
                    onDirectTextDraftChange,
                    onUndo,
                    onRedo,
                    onEndHistoryGroup,
                    setInlineEditing,
                    { selectAll: true }
                  );
                }}
              >
                {!isLocked && canStartCanvasDomMove(selection) ? (
                  <>
                    {selection.canEditTextDirectly ? TEXT_MOVE_EDGES.map((edge) => (
                      <span
                        key={`move-${edge}`}
                        className={`selection-move-edge selection-move-edge--${edge}`}
                        data-handle="move"
                        aria-hidden="true"
                        title="Move"
                        onPointerDown={(event) => handlePointerDown(event, selection)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishInteraction}
                        onPointerCancel={finishInteraction}
                      />
                    )) : (
                      <span
                        className="selection-move-handle"
                        data-handle="move"
                        aria-hidden="true"
                        title="Move"
                        onPointerDown={(event) => handlePointerDown(event, selection)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishInteraction}
                        onPointerCancel={finishInteraction}
                      />
                    )}
                    {RESIZE_HANDLES.map((handle) => (
                      <span
                        key={handle}
                        className={`selection-handle selection-handle--${handle}`}
                        data-handle={`resize-${handle}`}
                        aria-hidden="true"
                        title="Resize"
                        onPointerDown={(event) => handlePointerDown(event, selection)}
                        onPointerMove={handlePointerMove}
                        onPointerUp={finishInteraction}
                        onPointerCancel={finishInteraction}
                      />
                    ))}
                  </>
                ) : null}
              </div>
            );
          }) : null}
          {miniPaletteBox && canUseMiniPalette && miniPaletteStyle ? (
            <SelectionMiniPalette
              style={miniPaletteStyle}
              activeStyle={miniPaletteActiveStyle}
              labels={{
                bold: t("palette.bold"),
                textBlack: t("palette.textBlack"),
                textRed: t("palette.textRed"),
                textBlue: t("palette.textBlue"),
                fillNone: t("palette.fillNone"),
                fillWhite: t("palette.fillWhite"),
                fillYellow: t("palette.fillYellow"),
                fillBlue: t("palette.fillBlue"),
                delete: t("palette.delete"),
                label: t("palette.label")
              }}
              onStyleChange={onStyleChange}
              onDeleteSelection={onDeleteSelection}
            />
          ) : null}
          {snapGuides.map((guide, index) => (
            <div
              key={`${guide.orientation}-${guide.position}-${index}`}
              className={`snap-guide snap-guide--${guide.orientation}`}
              style={toSnapGuideStyle(guide, scale)}
              aria-hidden="true"
            />
          ))}
          {marquee ? <div className="marquee-selection" style={toMarqueeStyle(marquee, scale)} /> : null}
        </div>
      </div>
      {reviewPrepared && reviewRequestId > 0 ? (
        <iframe
          key={reviewRequestId}
          ref={reviewIframeRef}
          className="deck-review-frame"
          title="全スライド確認"
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-same-origin"
          srcDoc={reviewPrepared.html}
          onLoad={() => handleReviewFrameLoad(reviewRequestId)}
        />
      ) : null}
    </main>
  );
}

type MiniPaletteLabels = {
  label: string;
  bold: string;
  textBlack: string;
  textRed: string;
  textBlue: string;
  fillNone: string;
  fillWhite: string;
  fillYellow: string;
  fillBlue: string;
  delete: string;
};

function SelectionMiniPalette({
  style,
  activeStyle,
  labels,
  onStyleChange,
  onDeleteSelection
}: {
  style: CSSProperties;
  activeStyle?: EditableStyle;
  labels: MiniPaletteLabels;
  onStyleChange: (style: EditableStyle, options?: StyleChangeOptions) => void;
  onDeleteSelection: () => void;
}): JSX.Element {
  const isBold = activeStyle?.fontWeight === "700" ||
    activeStyle?.fontWeight === "bold" ||
    Number.parseInt(activeStyle?.fontWeight ?? "", 10) >= 600;
  const textLabels = [labels.textBlack, labels.textRed, labels.textBlue];
  const fillLabels = [labels.fillNone, labels.fillWhite, labels.fillYellow, labels.fillBlue];

  return (
    <div
      className="selection-mini-palette"
      style={style}
      role="toolbar"
      aria-label={labels.label}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className={`selection-mini-palette__button${isBold ? " selection-mini-palette__button--active" : ""}`}
        type="button"
        onClick={() => onStyleChange({ fontWeight: isBold ? "400" : "700" })}
        title={labels.bold}
        aria-label={labels.bold}
      >
        <Bold size={14} aria-hidden="true" />
      </button>
      <span className="selection-mini-palette__divider" aria-hidden="true" />
      <span className="selection-mini-palette__icon" aria-hidden="true">
        <Baseline size={14} />
      </span>
      {QUICK_TEXT_COLORS.map((color, index) => (
        <button
          key={color}
          className="selection-mini-palette__swatch-button"
          type="button"
          onClick={() => onStyleChange({ color })}
          title={textLabels[index]}
          aria-label={textLabels[index]}
        >
          <span className="selection-mini-palette__swatch" style={{ backgroundColor: color }} aria-hidden="true" />
        </button>
      ))}
      <span className="selection-mini-palette__divider" aria-hidden="true" />
      <span className="selection-mini-palette__icon" aria-hidden="true">
        <PaintBucket size={14} />
      </span>
      {QUICK_FILL_COLORS.map((color, index) => (
        <button
          key={color || "none"}
          className="selection-mini-palette__swatch-button"
          type="button"
          onClick={() => onStyleChange({ backgroundColor: color })}
          title={fillLabels[index]}
          aria-label={fillLabels[index]}
        >
          <span
            className={`selection-mini-palette__swatch${color ? "" : " selection-mini-palette__swatch--none"}`}
            style={color ? { backgroundColor: color } : undefined}
            aria-hidden="true"
          />
        </button>
      ))}
      <span className="selection-mini-palette__divider" aria-hidden="true" />
      <button
        className="selection-mini-palette__button selection-mini-palette__button--danger"
        type="button"
        onClick={onDeleteSelection}
        title={labels.delete}
        aria-label={labels.delete}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

type SelectionOptions = {
  additive?: boolean;
};

type CanvasInteraction = {
  mode: "move" | "resize";
  pointerId: number;
  historyGroup: string;
  resizeHandle: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startTranslateX: number;
  startTranslateY: number;
  primaryHssId: string;
  startDomMoves: DomMoveStart[];
  startOverlayMoves: OverlayMoveStart[];
  startDomResizes: DomResizeStart[];
  startOverlayResizes: OverlayResizeStart[];
  startWidth: number;
  startHeight: number;
  textClickCandidate?: Pick<TextClick, "hssId" | "point">;
};

type OverlayInteraction = {
  mode: "move" | "resize";
  pointerId: number;
  overlayId: string;
  historyGroup: string;
  resizeHandle: ResizeHandle;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  startDomMoves: DomMoveStart[];
  startOverlayMoves: OverlayMoveStart[];
  startDomResizes: DomResizeStart[];
  startOverlayResizes: OverlayResizeStart[];
};

type DomMoveStart = {
  selection: SelectedElement;
  startTranslateX: number;
  startTranslateY: number;
};

type DomResizeStart = DomMoveStart & {
  anchorStyle?: EditableStyle;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
};

type OverlayMoveStart = {
  overlayId: string;
  startX: number;
  startY: number;
};

type OverlayResizeStart = OverlayMoveStart & {
  startWidth: number;
  startHeight: number;
};

type ResizeHandle = "nw" | "ne" | "sw" | "se";

type StyleChangeOptions = {
  historyGroup?: string;
  domTargetIds?: string[];
  overlayTargetIds?: string[];
};

type FramePoint = {
  x: number;
  y: number;
};

type MarqueeRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SlideBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SnapBox = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type SnapGuide = {
  orientation: "vertical" | "horizontal";
  position: number;
  start: number;
  end: number;
};

type SnapResult = {
  deltaX: number;
  deltaY: number;
  guides: SnapGuide[];
};

type PointerSelection = {
  pointerId: number;
  additive: boolean;
  start: FramePoint;
  current: FramePoint;
  active: boolean;
  suppressClick: boolean;
};

type TextClick = {
  hssId: string;
  point: FramePoint;
  timestamp: number;
};

function getPatchedStyle(patches: Patch[], hssId: string): EditableStyle {
  const patch = patches.find((candidate) => candidate.type === "style" && candidate.target.hssId === hssId);
  return patch?.type === "style" ? patch.style : {};
}

function isDomLocked(patches: Patch[], hssId: string): boolean {
  const patch = patches.find((candidate) => candidate.type === "style" && candidate.target.hssId === hssId);
  return patch?.type === "style" ? Boolean(patch.locked) : false;
}

function readCurrentTranslate(patches: Patch[], selection: SelectedElement): { x: number; y: number } {
  const patchedStyle = getPatchedStyle(patches, selection.hssId);
  return parseTranslate(patchedStyle.transform ?? selection.computedStyle.transform);
}

function createDomResizeAnchorStyle(selection: SelectedElement, translate: { x: number; y: number }): EditableStyle | undefined {
  const position = selection.computedStyle.position;
  if (position !== "absolute" && position !== "fixed") {
    return undefined;
  }

  return {
    position,
    left: `${Math.round(selection.bbox.x - translate.x)}px`,
    top: `${Math.round(selection.bbox.y - translate.y)}px`,
    right: "auto",
    bottom: "auto",
    margin: "0",
    boxSizing: "border-box"
  };
}

function readCurrentSlideBounds(document: Document, currentSlideId: string | null, slides: SlideDescriptor[]): SlideBounds {
  const slide = slides.find((candidate) => candidate.id === currentSlideId) ?? slides[0] ?? null;
  const root = slide ? document.querySelector(slide.selector) : document.body;
  const target = root ?? document.body ?? document.documentElement;

  if (!target) {
    return defaultFrameBounds();
  }

  const rect = target.getBoundingClientRect();

  if (rect.width >= 1 && rect.height >= 1) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  return defaultFrameBounds();
}

function buildReviewSnapshot(
  document: Document,
  frame: HTMLElement,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  visibleOverlays: Overlay[],
  scale: number,
  sourceBaseUrl?: string,
  includeDocumentWideReferences = false
): ReviewSnapshot {
  const slide = slides.find((candidate) => candidate.id === currentSlideId) ?? slides[0] ?? null;
  const slideBounds = readCurrentSlideBounds(document, currentSlideId, slides);
  const slideRoot = slide ? document.querySelector(slide.selector) : document.body;

  const targets = [
    ...collectReviewDomTargets(document, slideRoot ?? document.body, slide?.id ?? null),
    ...collectReviewOverlayTargets(frame, visibleOverlays, slide?.id ?? null, scale, sourceBaseUrl)
  ];

  return {
    checkedAt: new Date().toISOString(),
    slideId: slide?.id ?? null,
    slideLabel: slide?.label ?? "Current slide",
    slides,
    slideBounds: {
      x: slideBounds.left,
      y: slideBounds.top,
      width: slideBounds.width,
      height: slideBounds.height
    },
    targets,
    externalReferences: collectExternalReferences(document, slideRoot, targets, slide?.id ?? null, includeDocumentWideReferences)
  };
}

function captureDeckReviewSnapshots(
  document: Document,
  frame: HTMLElement,
  slides: SlideDescriptor[],
  sourceBaseUrl?: string
): ReviewSnapshot[] {
  const displayStates = new Map<HTMLElement, { value: string; priority: string }>();
  for (const slide of slides) {
    const node = document.querySelector(slide.selector);
    if (node && node !== document.body && "style" in node) {
      const element = node as HTMLElement;
      displayStates.set(element, {
        value: element.style.getPropertyValue("display"),
        priority: element.style.getPropertyPriority("display")
      });
    }
  }

  try {
    return slides.map((slide, index) => {
      for (const candidate of slides) {
        const node = document.querySelector(candidate.selector);
        if (!node || node === document.body || !("style" in node)) continue;
        const element = node as HTMLElement;
        if (candidate.id === slide.id) restoreInlineDisplay(element, displayStates.get(element));
        else element.style.setProperty("display", "none", "important");
      }
      return buildReviewSnapshot(document, frame, slide.id, slides, [], 1, sourceBaseUrl, index === 0);
    });
  } finally {
    for (const [element, state] of displayStates) restoreInlineDisplay(element, state);
  }
}

function restoreInlineDisplay(element: HTMLElement, state?: { value: string; priority: string }): void {
  if (state?.value) element.style.setProperty("display", state.value, state.priority);
  else element.style.removeProperty("display");
}

function collectReviewDomTargets(document: Document, root: Element | null, slideId: string | null): ReviewTarget[] {
  if (!root) {
    return [];
  }

  const candidates = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,span,a,img,svg,table,td,th,div"))
    .filter(isReviewHtmlOrSvgElement)
    .filter((element) => isReviewElementVisible(element))
    .filter((element) => isMeaningfulReviewElement(element));

  const withoutContainers = candidates.filter((element) => {
    if (isReviewImageElement(element) || element.tagName === "SVG") {
      return true;
    }

    const hasMeaningfulChild = candidates.some((candidate) => candidate !== element && element.contains(candidate));
    return !hasMeaningfulChild || hasVisibleBackground(element);
  });

  return withoutContainers.map((element) => {
    const selected = readSelectedElement(element);
    const overlayRoot = element.closest<HTMLElement>("[data-hss-overlay-id]");
    const overlayId = overlayRoot?.dataset.hssOverlayId;
    const computed = document.defaultView?.getComputedStyle(element);
    const image = isReviewImageElement(element) ? element : null;
    const text = selected.textContent.trim();

    return {
      id: overlayId ?? selected.hssId,
      source: overlayId ? "overlay" : "dom",
      type: image ? "image" : text ? "text" : hasVisibleBackground(element) ? "shape" : "unknown",
      label: labelReviewElement(element, text),
      tagName: selected.tagName,
      selector: selected.selector,
      slideId,
      text,
      bounds: {
        x: selected.bbox.x,
        y: selected.bbox.y,
        width: selected.bbox.width,
        height: selected.bbox.height
      },
      color: computed?.color,
      backgroundColor: resolveEffectiveBackground(element),
      fontSize: readCssPx(computed?.fontSize),
      lineHeight: readCssPx(computed?.lineHeight),
      textClipped: text ? isTextClipped(element) : false,
      imageSource: image?.currentSrc || image?.getAttribute("src") || undefined,
      imageBroken: image ? image.complete && image.naturalWidth === 0 : undefined
    };
  });
}

function collectReviewOverlayTargets(
  frame: HTMLElement,
  visibleOverlays: Overlay[],
  slideId: string | null,
  scale: number,
  sourceBaseUrl?: string
): ReviewTarget[] {
  return visibleOverlays.map((overlay) => {
    const element = frame.querySelector<HTMLElement>(`[data-hss-overlay-id="${overlay.id}"]`);
    const content = element?.querySelector<HTMLElement>(".overlay-text__content");
    const image = element?.querySelector<HTMLImageElement>("img") ?? null;
    const text = overlay.text.trim();

    return {
      id: overlay.id,
      source: "overlay",
      type: overlay.type === "overlayImage" ? "image" : "text",
      label: overlay.type === "overlayImage" ? text || overlay.src : text || "テキスト",
      slideId: overlay.slideId ?? slideId,
      text,
      bounds: {
        x: overlay.x,
        y: overlay.y,
        width: overlay.width,
        height: overlay.height
      },
      color: overlay.style.color,
      backgroundColor: overlay.style.backgroundColor,
      fontSize: readCssPx(overlay.style.fontSize),
      lineHeight: readCssPx(overlay.style.lineHeight),
      textClipped: content ? isTextClipped(content) : false,
      imageSource: overlay.type === "overlayImage" ? documentAssetUrl(sourceBaseUrl, overlay.src) : undefined,
      imageBroken: image ? image.complete && image.naturalWidth === 0 : undefined,
      locked: overlay.locked,
      hidden: overlay.hidden
    };
  });
}

function collectExternalReferences(
  document: Document,
  root: Element | null,
  targets: ReviewTarget[],
  slideId: string | null,
  includeDocumentWide: boolean
): ReviewExternalReference[] {
  const references: ReviewExternalReference[] = [];

  const roots = [root, includeDocumentWide ? document.head : null].filter((candidate): candidate is Element => Boolean(candidate));
  for (const scanRoot of roots) {
    const elements = [scanRoot, ...Array.from(scanRoot.querySelectorAll("*"))];
    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const source: ReviewReferenceSource | null = REVIEW_URL_ATTRIBUTES.has(name)
          ? "attribute"
          : name === "srcset" || name === "imagesrcset"
            ? "srcset"
            : REVIEW_CSS_URL_ATTRIBUTES.has(name)
              ? "css"
              : null;
        if (!source) continue;
        for (const value of extractExternalReferenceValues(source, attribute.value)) {
          references.push(reviewExternalReference(element, targets, slideId, source, value, name, scanRoot === root ? root : null));
        }
      }
      if (element.tagName.toLowerCase() === "style") {
        for (const value of extractExternalReferenceValues("css", element.textContent ?? "")) {
          references.push(reviewExternalReference(element, targets, slideId, "css", value, undefined, scanRoot === root ? root : null));
        }
      }
    }
  }

  return references;
}

function reviewExternalReference(
  element: Element,
  targets: ReviewTarget[],
  slideId: string | null,
  kind: ReviewReferenceSource,
  value: string,
  attributeName: string | undefined,
  slideRoot: Element | null
): ReviewExternalReference {
  const sourceElement = slideRoot ? findReferenceTargetElement(element, slideRoot) : null;
  const ancestorTargetId = sourceElement?.parentElement?.closest("[data-hss-id]")?.getAttribute("data-hss-id") ?? null;
  const selected = sourceElement ? readSelectedElement(sourceElement) : null;
  let target = selected
    ? targets.find((candidate) =>
        candidate.id === selected.hssId ||
        candidate.selector === selected.selector ||
        candidate.id === ancestorTargetId
      )
    : null;
  if (!target && sourceElement && selected) {
    target = buildReferenceReviewTarget(sourceElement, selected, slideId);
    targets.push(target);
  }
  return {
    kind,
    value,
    label: element.tagName.toLowerCase(),
    attributeName,
    slideId: target ? slideId ?? undefined : undefined,
    targetId: target?.id,
    targetLabel: target?.label,
    targetSource: target?.source
  };
}

function findReferenceTargetElement(element: Element, slideRoot: Element): Element {
  let candidate: Element | null = element;
  while (candidate && slideRoot.contains(candidate)) {
    if (isReviewElementVisible(candidate)) return candidate;
    if (candidate === slideRoot) break;
    candidate = candidate.parentElement;
  }
  return slideRoot;
}

function buildReferenceReviewTarget(element: Element, selected: SelectedElement, slideId: string | null): ReviewTarget {
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  const image = isReviewImageElement(element) ? element : null;
  const text = selected.textContent.trim();
  const overlayRoot = element.closest<HTMLElement>("[data-hss-overlay-id]");
  const overlayId = overlayRoot?.dataset.hssOverlayId;
  return {
    id: overlayId ?? selected.hssId,
    source: overlayId ? "overlay" : "dom",
    type: image ? "image" : text ? "text" : hasVisibleBackground(element) ? "shape" : "unknown",
    label: labelReviewElement(element, text) || element.tagName.toLowerCase(),
    tagName: selected.tagName,
    selector: selected.selector,
    slideId,
    text,
    bounds: {
      x: selected.bbox.x,
      y: selected.bbox.y,
      width: selected.bbox.width,
      height: selected.bbox.height
    },
    color: computed?.color,
    backgroundColor: resolveEffectiveBackground(element),
    fontSize: readCssPx(computed?.fontSize),
    lineHeight: readCssPx(computed?.lineHeight),
    textClipped: text ? isTextClipped(element) : false,
    imageSource: image?.currentSrc || image?.getAttribute("src") || undefined,
    imageBroken: image ? image.complete && image.naturalWidth === 0 : undefined
  };
}

function isReviewElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(element);

  return rect.width > 1 &&
    rect.height > 1 &&
    computed?.display !== "none" &&
    computed?.visibility !== "hidden" &&
    computed?.opacity !== "0";
}

function isMeaningfulReviewElement(element: Element): boolean {
  if (isReviewImageElement(element) || element.tagName === "SVG") {
    return true;
  }

  const text = element.textContent?.trim() ?? "";
  return text.length > 0 || hasVisibleBackground(element);
}

function hasVisibleBackground(element: Element): boolean {
  const color = element.ownerDocument.defaultView?.getComputedStyle(element).backgroundColor;
  return Boolean(color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)" && !color.endsWith(", 0)"));
}

function resolveEffectiveBackground(element: Element): string | undefined {
  let current: Element | null = element;

  while (current) {
    const color = current.ownerDocument.defaultView?.getComputedStyle(current).backgroundColor;
    if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      return color;
    }

    current = current.parentElement;
  }

  return "rgb(255, 255, 255)";
}

function labelReviewElement(element: Element, text: string): string {
  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute("aria-label") || element.getAttribute("title") || text;
  return name ? `${tag}: ${truncateText(name, 48)}` : tag;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function readCssPx(value: string | undefined): number | undefined {
  if (!value || value === "normal") {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTextClipped(element: Element): boolean {
  if (!isReviewHtmlElement(element)) {
    return false;
  }

  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!computed) {
    return false;
  }

  return isClippedTextOverflow({
    overflowX: computed.overflowX,
    overflowY: computed.overflowY,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight
  });
}

function isReviewHtmlOrSvgElement(element: Element): element is HTMLElement | SVGElement {
  const view = element.ownerDocument.defaultView;
  return Boolean(view && (element instanceof view.HTMLElement || element instanceof view.SVGElement));
}

function isReviewHtmlElement(element: Element): element is HTMLElement {
  const view = element.ownerDocument.defaultView;
  return Boolean(view && element instanceof view.HTMLElement);
}

function isReviewImageElement(element: Element): element is HTMLImageElement {
  const view = element.ownerDocument.defaultView;
  return Boolean(view && element instanceof view.HTMLImageElement);
}

function snapCanvasInteraction(
  interaction: CanvasInteraction,
  deltaX: number,
  deltaY: number,
  document: Document,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  patches: Patch[],
  visibleOverlays: Overlay[]
): SnapResult {
  if (interaction.mode === "move") {
    return snapMove(
      [
        ...interaction.startDomMoves.map((move) => selectedBox(move.selection)),
        ...interaction.startOverlayMoves.flatMap((move) => {
          const overlay = visibleOverlays.find((candidate) => candidate.id === move.overlayId);
          return overlay ? [overlayBox({ ...overlay, x: move.startX, y: move.startY })] : [];
        })
      ],
      deltaX,
      deltaY,
      collectSnapReferences(document, currentSlideId, slides, patches, visibleOverlays, excludeIds(interaction))
    );
  }

  const primary = findResizePrimary(interaction.primaryHssId, interaction.startDomResizes, interaction.startOverlayResizes, visibleOverlays);
  if (!primary) {
    return { deltaX, deltaY, guides: [] };
  }

  return snapResize(
    interaction.resizeHandle,
    primary,
    deltaX,
    deltaY,
    collectSnapReferences(document, currentSlideId, slides, patches, visibleOverlays, excludeIds(interaction))
  );
}

function snapOverlayInteraction(
  interaction: OverlayInteraction,
  deltaX: number,
  deltaY: number,
  document: Document,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  patches: Patch[],
  visibleOverlays: Overlay[]
): SnapResult {
  if (interaction.mode === "move") {
    return snapMove(
      [
        ...interaction.startDomMoves.map((move) => selectedBox(move.selection)),
        ...interaction.startOverlayMoves.flatMap((move) => {
          const overlay = visibleOverlays.find((candidate) => candidate.id === move.overlayId);
          return overlay ? [overlayBox({ ...overlay, x: move.startX, y: move.startY })] : [];
        })
      ],
      deltaX,
      deltaY,
      collectSnapReferences(document, currentSlideId, slides, patches, visibleOverlays, excludeIds(interaction))
    );
  }

  const primary = findResizePrimary(interaction.overlayId, interaction.startDomResizes, interaction.startOverlayResizes, visibleOverlays);
  if (!primary) {
    return { deltaX, deltaY, guides: [] };
  }

  return snapResize(
    interaction.resizeHandle,
    primary,
    deltaX,
    deltaY,
    collectSnapReferences(document, currentSlideId, slides, patches, visibleOverlays, excludeIds(interaction))
  );
}

function snapMove(boxes: SnapBox[], deltaX: number, deltaY: number, references: SnapReferenceSet): SnapResult {
  if (boxes.length === 0) {
    return { deltaX, deltaY, guides: [] };
  }

  const movedBox = shiftBox(unionBoxes(boxes), deltaX, deltaY);
  const vertical = findBestSnap(
    [
      { position: movedBox.left, kind: "start" },
      { position: movedBox.left + movedBox.width / 2, kind: "center" },
      { position: movedBox.right, kind: "end" }
    ],
    references.vertical,
    "vertical"
  );
  const horizontal = findBestSnap(
    [
      { position: movedBox.top, kind: "start" },
      { position: movedBox.top + movedBox.height / 2, kind: "center" },
      { position: movedBox.bottom, kind: "end" }
    ],
    references.horizontal,
    "horizontal"
  );

  return {
    deltaX: deltaX + (vertical?.offset ?? 0),
    deltaY: deltaY + (horizontal?.offset ?? 0),
    guides: [
      ...(vertical ? [vertical.guide] : []),
      ...(horizontal ? [horizontal.guide] : [])
    ]
  };
}

function snapResize(handle: ResizeHandle, primary: SnapBox, deltaX: number, deltaY: number, references: SnapReferenceSet): SnapResult {
  const box = resizeBoxFromHandle(handle, primary.left, primary.top, primary.width, primary.height, deltaX, deltaY);
  const verticalProbe = handle.includes("w")
    ? [{ position: box.x, kind: "start" as const }]
    : [{ position: box.x + box.width, kind: "end" as const }];
  const horizontalProbe = handle.includes("n")
    ? [{ position: box.y, kind: "start" as const }]
    : [{ position: box.y + box.height, kind: "end" as const }];
  const vertical = findBestSnap(verticalProbe, references.vertical, "vertical");
  const horizontal = findBestSnap(horizontalProbe, references.horizontal, "horizontal");

  return {
    deltaX: deltaX + (vertical?.offset ?? 0),
    deltaY: deltaY + (horizontal?.offset ?? 0),
    guides: [
      ...(vertical ? [vertical.guide] : []),
      ...(horizontal ? [horizontal.guide] : [])
    ]
  };
}

type SnapReferenceSet = {
  vertical: SnapReference[];
  horizontal: SnapReference[];
};

type SnapReference = {
  position: number;
  start: number;
  end: number;
};

type SnapProbe = {
  position: number;
  kind: "start" | "center" | "end";
};

function collectSnapReferences(
  document: Document,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  patches: Patch[],
  visibleOverlays: Overlay[],
  excludedIds: Set<string>
): SnapReferenceSet {
  const slideBounds = readCurrentSlideBounds(document, currentSlideId, slides);
  const boxes = [
    slideBox(slideBounds),
    ...visibleOverlays
      .filter((overlay) => !excludedIds.has(overlay.id))
      .map((overlay) => overlayBox(overlay)),
    ...readDomSnapBoxes(document, currentSlideId, slides, patches, excludedIds)
  ];

  return {
    vertical: boxes.flatMap((box) => [
      { position: box.left, start: box.top, end: box.bottom },
      { position: box.left + box.width / 2, start: box.top, end: box.bottom },
      { position: box.right, start: box.top, end: box.bottom }
    ]),
    horizontal: boxes.flatMap((box) => [
      { position: box.top, start: box.left, end: box.right },
      { position: box.top + box.height / 2, start: box.left, end: box.right },
      { position: box.bottom, start: box.left, end: box.right }
    ])
  };
}

function readDomSnapBoxes(
  document: Document,
  currentSlideId: string | null,
  slides: SlideDescriptor[],
  patches: Patch[],
  excludedIds: Set<string>
): SnapBox[] {
  const slide = slides.find((candidate) => candidate.id === currentSlideId) ?? slides[0] ?? null;
  const root = slide ? document.querySelector(slide.selector) : document.body;
  const layerRoot = root ?? document.body;
  const selectors = "h1,h2,h3,h4,h5,h6,p,span,div,li,img,svg,table,td,th,a";

  return Array.from(layerRoot.querySelectorAll(selectors))
    .flatMap((element) => {
      const selected = readSelectedElement(element);
      if (
        excludedIds.has(selected.hssId) ||
        selected.computedStyle.display === "none" ||
        isDomLocked(patches, selected.hssId) ||
        selected.bbox.width < 1 ||
        selected.bbox.height < 1
      ) {
        return [];
      }

      return [selectedBox(selected)];
    });
}

function findBestSnap(
  probes: SnapProbe[],
  references: SnapReference[],
  orientation: SnapGuide["orientation"]
): { offset: number; guide: SnapGuide } | null {
  let best: { distance: number; offset: number; guide: SnapGuide } | null = null;

  for (const probe of probes) {
    for (const reference of references) {
      const offset = reference.position - probe.position;
      const distance = Math.abs(offset);
      if (distance > SNAP_THRESHOLD) {
        continue;
      }

      if (!best || distance < best.distance) {
        best = {
          distance,
          offset,
          guide: {
            orientation,
            position: reference.position,
            start: reference.start,
            end: reference.end
          }
        };
      }
    }
  }

  return best ? { offset: best.offset, guide: best.guide } : null;
}

function excludeIds(interaction: CanvasInteraction | OverlayInteraction): Set<string> {
  return new Set([
    ...interaction.startDomMoves.map((move) => move.selection.hssId),
    ...interaction.startDomResizes.map((resize) => resize.selection.hssId),
    ...interaction.startOverlayMoves.map((move) => move.overlayId),
    ...interaction.startOverlayResizes.map((resize) => resize.overlayId)
  ]);
}

function findResizePrimary(
  primaryId: string,
  domResizes: DomResizeStart[],
  overlayResizes: OverlayResizeStart[],
  visibleOverlays: Overlay[]
): SnapBox | null {
  const dom = domResizes.find((resize) => resize.selection.hssId === primaryId);
  if (dom) {
    return {
      id: dom.selection.hssId,
      left: dom.startX,
      top: dom.startY,
      right: dom.startX + dom.startWidth,
      bottom: dom.startY + dom.startHeight,
      width: dom.startWidth,
      height: dom.startHeight
    };
  }

  const overlayResize = overlayResizes.find((resize) => resize.overlayId === primaryId);
  const overlay = visibleOverlays.find((candidate) => candidate.id === primaryId);
  if (!overlayResize || !overlay) {
    return null;
  }

  return {
    id: overlayResize.overlayId,
    left: overlayResize.startX,
    top: overlayResize.startY,
    right: overlayResize.startX + overlayResize.startWidth,
    bottom: overlayResize.startY + overlayResize.startHeight,
    width: overlayResize.startWidth,
    height: overlayResize.startHeight
  };
}

function selectedBox(selection: SelectedElement): SnapBox {
  return {
    id: selection.hssId,
    left: selection.bbox.x,
    top: selection.bbox.y,
    right: selection.bbox.x + selection.bbox.width,
    bottom: selection.bbox.y + selection.bbox.height,
    width: selection.bbox.width,
    height: selection.bbox.height
  };
}

function overlayBox(overlay: Overlay): SnapBox {
  return {
    id: overlay.id,
    left: overlay.x,
    top: overlay.y,
    right: overlay.x + overlay.width,
    bottom: overlay.y + overlay.height,
    width: overlay.width,
    height: overlay.height
  };
}

function slideBox(bounds: SlideBounds): SnapBox {
  return {
    id: "slide",
    left: bounds.left,
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    width: bounds.width,
    height: bounds.height
  };
}

function shiftBox(box: SnapBox, deltaX: number, deltaY: number): SnapBox {
  return {
    ...box,
    left: box.left + deltaX,
    top: box.top + deltaY,
    right: box.right + deltaX,
    bottom: box.bottom + deltaY
  };
}

function unionBoxes(boxes: SnapBox[]): SnapBox {
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.right));
  const bottom = Math.max(...boxes.map((box) => box.bottom));

  return {
    id: "selection",
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function toMiniPaletteStyle(box: SnapBox, scale: number): CSSProperties {
  const paletteWidth = 286;
  const paletteHeight = 36;
  const frameWidth = FRAME_WIDTH * scale;
  const frameHeight = FRAME_HEIGHT * scale;
  const rightSideLeft = box.right * scale + 8;
  const leftSideLeft = box.left * scale - paletteWidth - 8;
  const centeredLeft = (box.left + box.width / 2) * scale - paletteWidth / 2;
  const sideTop = (box.top + box.height / 2) * scale - paletteHeight / 2;
  const aboveTop = box.top * scale - paletteHeight - 8;
  const belowTop = box.bottom * scale + 8;

  if (rightSideLeft + paletteWidth <= frameWidth - 6) {
    return {
      left: rightSideLeft,
      top: clamp(sideTop, 6, Math.max(6, frameHeight - paletteHeight - 6))
    };
  }

  if (leftSideLeft >= 6) {
    return {
      left: leftSideLeft,
      top: clamp(sideTop, 6, Math.max(6, frameHeight - paletteHeight - 6))
    };
  }

  return {
    left: clamp(centeredLeft, 6, Math.max(6, frameWidth - paletteWidth - 6)),
    top: clamp(aboveTop >= 6 ? aboveTop : belowTop, 6, Math.max(6, frameHeight - paletteHeight - 6))
  };
}

function defaultFrameBounds(): SlideBounds {
  return {
    left: 0,
    top: 0,
    right: FRAME_WIDTH,
    bottom: FRAME_HEIGHT,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT
  };
}

function toOverlayStyle(overlay: Overlay, scale: number): CSSProperties {
  const fontSize = Number.parseFloat(overlay.style.fontSize ?? "32");

  return {
    left: overlay.x * scale,
    top: overlay.y * scale,
    width: overlay.width * scale,
    height: overlay.height * scale,
    color: overlay.style.color,
    backgroundColor: overlay.style.backgroundColor,
    fontFamily: overlay.style.fontFamily,
    fontSize: `${Number.isFinite(fontSize) ? fontSize * scale : 32 * scale}px`,
    fontWeight: overlay.style.fontWeight,
    fontStyle: overlay.style.fontStyle,
    textDecoration: overlay.style.textDecoration,
    lineHeight: scaleCssLength(overlay.style.lineHeight, scale),
    textAlign: overlay.style.textAlign as CSSProperties["textAlign"],
    display: overlay.style.display,
    alignItems: overlay.style.alignItems,
    justifyContent: overlay.style.justifyContent,
    borderRadius: scaleCssLength(overlay.style.borderRadius, scale),
    borderColor: overlay.style.borderColor,
    borderStyle: overlay.style.borderStyle,
    borderWidth: scaleCssLength(overlay.style.borderWidth, scale)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.round(clamp(value, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

function scaleCssLength(value: string | undefined, scale: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && value.trim().endsWith("px") ? `${parsed * scale}px` : value;
}

function toOutlineStyle(selection: SelectedElement, scale: number): CSSProperties {
  return {
    left: selection.bbox.x * scale,
    top: selection.bbox.y * scale,
    width: selection.bbox.width * scale,
    height: selection.bbox.height * scale
  };
}

function toMarqueeRect(start: FramePoint, current: FramePoint): MarqueeRect {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const right = Math.max(start.x, current.x);
  const bottom = Math.max(start.y, current.y);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

function toFramePoint(event: { clientX: number; clientY: number; currentTarget: EventTarget | null }, scale: number): FramePoint {
  const target = event.currentTarget instanceof Element ? event.currentTarget : null;
  const rect = target?.getBoundingClientRect();
  if (!rect) {
    return { x: 0, y: 0 };
  }

  return {
    x: (event.clientX - rect.left) / scale,
    y: (event.clientY - rect.top) / scale
  };
}

function toFrameClientPoint(frame: HTMLElement | null, clientX: number, clientY: number, scale: number): FramePoint | null {
  const rect = frame?.getBoundingClientRect();
  if (!rect || scale <= 0) {
    return null;
  }

  return {
    x: (clientX - rect.left) / scale,
    y: (clientY - rect.top) / scale
  };
}

function isQuickTextClick(lastClick: TextClick | null, selected: SelectedElement, point: FramePoint): boolean {
  if (!lastClick || lastClick.hssId !== selected.hssId) {
    return false;
  }

  return performance.now() - lastClick.timestamp <= 650
    && Math.hypot(point.x - lastClick.point.x, point.y - lastClick.point.y) <= 12;
}

function beginInlineEditBySelection(
  document: Document,
  selected: SelectedElement,
  onSelectElement: (selected: SelectedElement | null, options?: SelectionOptions) => void,
  onInlineTextCommit: (selected: SelectedElement, text: string, options?: { historyGroup?: string }) => void,
  onDirectTextDraftChange: (dirty: boolean) => void,
  onUndo: () => void,
  onRedo: () => void,
  onEndHistoryGroup: () => void,
  setIsInlineEditing: (value: boolean) => void,
  options?: { selectAll?: boolean; caretPoint?: FramePoint }
): boolean {
  const element = findElementByHssTarget(document, selected.hssId, selected.selector);
  if (!selected.canEditTextDirectly || !isHtmlElement(element) || !canInlineEdit(element)) {
    return false;
  }

  setIsInlineEditing(true);
  onSelectElement(selected);
  beginInlineTextEdit(
    element,
    selected,
    onInlineTextCommit,
    onDirectTextDraftChange,
    (refreshed) => onSelectElement(refreshed),
    onUndo,
    onRedo,
    () => {
      setIsInlineEditing(false);
      onEndHistoryGroup();
    },
    options
  );
  return true;
}

function toMarqueeStyle(rect: MarqueeRect, scale: number): CSSProperties {
  return {
    left: rect.left * scale,
    top: rect.top * scale,
    width: rect.width * scale,
    height: rect.height * scale
  };
}

function toSnapGuideStyle(guide: SnapGuide, scale: number): CSSProperties {
  if (guide.orientation === "vertical") {
    return {
      left: guide.position * scale,
      top: guide.start * scale,
      height: Math.max(1, (guide.end - guide.start) * scale)
    };
  }

  return {
    top: guide.position * scale,
    left: guide.start * scale,
    width: Math.max(1, (guide.end - guide.start) * scale)
  };
}

function getOverlaysInRect(overlays: Overlay[], rect: MarqueeRect): string[] {
  return overlays
    .filter((overlay) =>
      intersectsRect(
        { left: overlay.x, top: overlay.y, right: overlay.x + overlay.width, bottom: overlay.y + overlay.height },
        rect
      )
    )
    .map((overlay) => overlay.id);
}

function intersectsRect(left: { left: number; top: number; right: number; bottom: number }, right: { left: number; top: number; right: number; bottom: number }): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function canInlineEdit(element: HTMLElement): boolean {
  if (element.tagName === "SECTION" || element.tagName === "ARTICLE") {
    return false;
  }

  if ((element.tagName === "DIV" || element.tagName === "LI" || element.tagName === "SPAN") && element.childElementCount > 0) {
    return false;
  }

  return !["IMG", "SVG", "TABLE", "VIDEO", "AUDIO", "CANVAS"].includes(element.tagName);
}

function canStartCanvasDomMove(selection: SelectedElement): boolean {
  return !["section", "article"].includes(selection.tagName);
}

function isSlideRootLikeSelection(selection: SelectedElement): boolean {
  return ["section", "article"].includes(selection.tagName);
}

function readResizeHandle(value: string | undefined): ResizeHandle | null {
  if (!value?.startsWith("resize-")) {
    return null;
  }

  const handle = value.replace("resize-", "");
  return isResizeHandle(handle) ? handle : null;
}

function isResizeHandle(value: string): value is ResizeHandle {
  return value === "nw" || value === "ne" || value === "sw" || value === "se";
}

function resizeBoxFromHandle(
  handle: ResizeHandle,
  startX: number,
  startY: number,
  startWidth: number,
  startHeight: number,
  deltaX: number,
  deltaY: number
): { x: number; y: number; width: number; height: number } {
  const minSize = 8;
  let left = startX;
  let top = startY;
  let right = startX + startWidth;
  let bottom = startY + startHeight;

  if (handle.includes("w")) {
    left += deltaX;
  } else {
    right += deltaX;
  }

  if (handle.includes("n")) {
    top += deltaY;
  } else {
    bottom += deltaY;
  }

  if (right - left < minSize) {
    if (handle.includes("w")) {
      left = right - minSize;
    } else {
      right = left + minSize;
    }
  }

  if (bottom - top < minSize) {
    if (handle.includes("n")) {
      top = bottom - minSize;
    } else {
      bottom = top + minSize;
    }
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  if (!element) {
    return false;
  }

  const view = element.ownerDocument.defaultView;
  return Boolean(view?.HTMLElement && element instanceof view.HTMLElement);
}

function beginInlineTextEdit(
  element: HTMLElement,
  selected: SelectedElement,
  onCommit: (selected: SelectedElement, text: string, options?: { historyGroup?: string }) => void,
  onDraftChange: (dirty: boolean) => void,
  onSelectionRefresh: (selected: SelectedElement) => void,
  onUndo: () => void,
  onRedo: () => void,
  onFinish?: () => void,
  options?: { selectAll?: boolean; caretPoint?: FramePoint }
): void {
  if (element.isContentEditable) {
    focusInlineTextEditor(element, options);
    return;
  }

  const originalText = element.textContent ?? "";
  let canceled = false;
  let lastCommittedText = originalText;
  let hasActiveTransaction = false;
  const historyGroup = createInlineTextHistoryGroup("dom", selected.hssId);
  const repeatClick = options?.caretPoint
    ? { point: options.caretPoint, timestamp: performance.now() }
    : null;

  rememberOriginalTextForPatch(element);
  element.setAttribute("contenteditable", "true");
  element.setAttribute("spellcheck", "false");
  element.style.outline = "2px solid #236f73";
  element.style.outlineOffset = "3px";
  let cancelPendingSelection = focusInlineTextEditor(element, options);

  const cleanup = (): void => {
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
    element.style.removeProperty("outline");
    element.style.removeProperty("outline-offset");
    element.removeEventListener("blur", handleBlur);
    element.removeEventListener("input", handleInput);
    element.removeEventListener("keydown", handleKeyDown);
    element.removeEventListener("pointerdown", handlePointerDown, true);
    cancelPendingSelection();
    onDraftChange(false);
    onFinish?.();
  };

  const commit = (): void => {
    const nextText = element.textContent ?? "";
    if (canceled) {
      element.textContent = originalText;
      cleanup();
      return;
    }

    if (nextText !== lastCommittedText) recordText(nextText);
    cleanup();
  };

  function handleBlur(): void {
    commit();
  }

  function handleInput(): void {
    cancelPendingSelection();
    const nextText = element.textContent ?? "";
    recordText(nextText);
  }

  function recordText(nextText: string): void {
    lastCommittedText = nextText;
    const refreshed = readSelectedElement(element, selected.selector, selected.hssId);

    if (nextText === originalText) {
      if (hasActiveTransaction) {
        hasActiveTransaction = false;
        onUndo();
      }
      onSelectionRefresh(refreshed);
      onDraftChange(false);
      return;
    }

    onCommit(refreshed, nextText, { historyGroup });
    hasActiveTransaction = true;
    onDraftChange(true);
  }

  function handlePointerDown(event: globalThis.PointerEvent): void {
    if (!repeatClick || event.button !== 0) {
      return;
    }

    const isDoubleClick = performance.now() - repeatClick.timestamp <= 650
      && Math.hypot(event.clientX - repeatClick.point.x, event.clientY - repeatClick.point.y) <= 12;
    if (!isDoubleClick) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    cancelPendingSelection();
    cancelPendingSelection = focusInlineTextEditor(element, { selectAll: true });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) {
      return;
    }

    const key = event.key.toLowerCase();
    const isModifierPressed = event.ctrlKey || event.metaKey;
    if (isModifierPressed && key === "z" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      element.textContent = originalText;
      lastCommittedText = originalText;
      canceled = true;
      element.blur();
      onUndo();
      return;
    }

    if (isModifierPressed && (key === "y" || (key === "z" && event.shiftKey))) {
      event.preventDefault();
      event.stopPropagation();
      element.blur();
      onRedo();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (hasActiveTransaction) {
        element.textContent = originalText;
        lastCommittedText = originalText;
        onUndo();
      }
      canceled = true;
      element.blur();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      element.blur();
    }
  }

  element.addEventListener("blur", handleBlur);
  element.addEventListener("input", handleInput);
  element.addEventListener("keydown", handleKeyDown);
  element.addEventListener("pointerdown", handlePointerDown, true);
}

function beginOverlayTextEdit(
  element: HTMLElement,
  overlayId: string,
  onCommit: (overlayId: string, text: string, options?: { historyGroup?: string }) => void,
  onUndo: () => void,
  onRedo: () => void,
  onFinish?: () => void,
  options?: { selectAll?: boolean; caretPoint?: { x: number; y: number } }
): void {
  if (element.isContentEditable) {
    focusInlineTextEditor(element, options);
    return;
  }

  const originalText = element.textContent ?? "";
  let canceled = false;
  let redoText: string | null = null;
  let lastCommittedText = originalText;
  const historyGroup = createInlineTextHistoryGroup("overlay", overlayId);

  element.setAttribute("contenteditable", "true");
  element.setAttribute("spellcheck", "false");
  element.style.outline = "2px solid #236f73";
  element.style.outlineOffset = "3px";
  const cancelPendingSelection = focusInlineTextEditor(element, options);

  const cleanup = (): void => {
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
    element.style.removeProperty("outline");
    element.style.removeProperty("outline-offset");
    element.removeEventListener("blur", handleBlur);
    element.removeEventListener("input", handleInput);
    element.removeEventListener("keydown", handleKeyDown);
    cancelPendingSelection();
    onFinish?.();
  };

  const commit = (): void => {
    const nextText = element.textContent ?? "";
    cleanup();
    if (canceled) {
      element.textContent = originalText;
      return;
    }

    if (nextText !== lastCommittedText) {
      onCommit(overlayId, nextText, { historyGroup });
    }
  };

  function handleBlur(): void {
    commit();
  }

  function handleInput(): void {
    cancelPendingSelection();
    const nextText = element.textContent ?? "";
    redoText = null;
    lastCommittedText = nextText;
    onCommit(overlayId, nextText, { historyGroup });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.isComposing) {
      return;
    }

    const key = event.key.toLowerCase();
    const isModifierPressed = event.ctrlKey || event.metaKey;
    if (isModifierPressed && key === "z" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const currentText = element.textContent ?? "";
      if (currentText !== originalText) {
        redoText = currentText;
        element.textContent = originalText;
        placeCaretAtEnd(element);
        lastCommittedText = originalText;
        onUndo();
      }
      return;
    }

    if (isModifierPressed && (key === "y" || (key === "z" && event.shiftKey))) {
      event.preventDefault();
      event.stopPropagation();
      if (redoText !== null) {
        const nextText = redoText;
        redoText = null;
        element.textContent = nextText;
        placeCaretAtEnd(element);
        lastCommittedText = nextText;
        onRedo();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (lastCommittedText !== originalText) {
        lastCommittedText = originalText;
        onUndo();
      }
      canceled = true;
      element.blur();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      element.blur();
    }
  }

  element.addEventListener("blur", handleBlur);
  element.addEventListener("input", handleInput);
  element.addEventListener("keydown", handleKeyDown);
}

function createInlineTextHistoryGroup(kind: "dom" | "overlay", targetId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-text-${targetId}-${suffix}`;
}

function focusInlineTextEditor(
  element: HTMLElement,
  options?: { selectAll?: boolean; caretPoint?: { x: number; y: number } }
): () => void {
  const applySelection = (): void => {
    if (!element.isContentEditable) {
      return;
    }

    element.focus();
    if (options?.selectAll) selectElementContents(element);
    else if (options?.caretPoint) placeCaretAtPoint(element, options.caretPoint);
    else placeCaretAtEnd(element);
  };

  applySelection();
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return () => undefined;
  }

  let firstFrame = view.requestAnimationFrame(applySelection);
  let secondFrame: number | null = null;
  if (options?.selectAll) {
    secondFrame = view.requestAnimationFrame(() => {
      secondFrame = view.requestAnimationFrame(applySelection);
    });
  }

  return () => {
    view.cancelAnimationFrame(firstFrame);
    firstFrame = 0;
    if (secondFrame !== null) view.cancelAnimationFrame(secondFrame);
    secondFrame = null;
  };
}

function placeCaretAtPoint(element: HTMLElement, point: { x: number; y: number }): void {
  const document = element.ownerDocument;
  const range = document.caretRangeFromPoint?.(point.x, point.y);
  if (!range || !element.contains(range.startContainer)) {
    const fallback = document.createRange();
    fallback.selectNodeContents(element);
    fallback.collapse(false);
    const fallbackSelection = document.getSelection();
    fallbackSelection?.removeAllRanges();
    fallbackSelection?.addRange(fallback);
    return;
  }

  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectElementContents(element: HTMLElement): void {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return;
  }

  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = element.ownerDocument.defaultView?.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object" || !("nodeType" in target)) {
    return false;
  }

  const node = target as Node;
  if (node.nodeType !== 1) {
    return false;
  }

  const element = node as Element;
  const tagName = element.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || (element as HTMLElement).isContentEditable;
}

function findContentEditableElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof target !== "object" || !("nodeType" in target)) {
    return null;
  }

  const node = target as Node;
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  if (!element) {
    return null;
  }

  return element.isContentEditable ? element : element.closest<HTMLElement>('[contenteditable="true"]');
}

function getArrowNudge(event: KeyboardEvent): { x: number; y: number } | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  const step = event.shiftKey ? 10 : 1;

  switch (event.key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}
