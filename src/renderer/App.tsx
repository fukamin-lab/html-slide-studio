import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CanvasStage, type CanvasZoomMode } from "./components/CanvasStage";
import { CheckPanel } from "./components/CheckPanel";
import { EditorToolbar } from "./components/EditorToolbar";
import { SimpleInspector } from "./components/SimpleInspector";
import { SlideNavigator } from "./components/SlideNavigator";
import { SlidePreviewFrame } from "./components/SlidePreviewFrame";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { buildEditedHtmlExport } from "./editor/htmlExport";
import { rehydratePersistedOverlays } from "./editor/overlayPersistence";
import { updateOverlay, updateOverlayStyle } from "./editor/overlayMutations";
import { upsertStylePatch, upsertTextPatch } from "./editor/patchMutations";
import { buildReviewResult } from "./editor/reviewQa";
import {
  applyDomMoveStateUpdate,
  areSelectionListsEqual,
  areSelectionsEqual,
  createDomMoveStateUpdates,
  mergeIds,
  mergeSelections,
  replaceSelection,
  toggleId,
  toggleSelection,
  updateSelectedStyle
} from "./editor/selectionState";
import { getSlideMutationAvailability, mutateSlideDocument } from "./editor/slideStructure";
import { estimateSpeakerNotes, formatSpeakerNotesDuration, updateSpeakerNotesInHtml } from "./editor/speakerNotes";
import { formatTranslate, parseTranslate } from "./editor/transform";
import { I18nProvider } from "./i18n";
import { createLaunchOpenGate, type LaunchOpenGate } from "./launchOpenGate";
import {
  applyPresentationDraw,
  clearPresentationInk,
  createEmptyPresentationInk,
  DEFAULT_PRESENTATION_COLOR,
  PRESENTATION_COLOR_OPTIONS
} from "./presentationInk";
import { createEmptyEditorHistory, editorHistoryReducer } from "./state/editorHistory";
import type { EditableStyle, Overlay, OverlayImage, OverlayText, PatchManifest } from "./types/patches";
import type { PresentationColor, PresentationDrawEvent, PresentationTool, PresenterCommand, PresenterSnapshot } from "./types/presenter";
import type { SlideDescriptor } from "./types/project";
import type { ReviewIssue, ReviewSnapshot, ReviewTarget } from "./types/review";
import type {
  DomMoveChange,
  DomResizeChange,
  OverlayMoveChange,
  OverlayResizeChange,
  SelectedElement
} from "./types/selection";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

type OpenDocumentState = {
  filePath: string;
  sourceBaseUrl: string;
  fingerprint: string;
  warnings: string[];
};

type OpenDocumentPayload = {
  html: string;
  filePath: string;
  sourceBaseUrl: string;
  fingerprint: string;
  warnings?: string[];
};

export function App(): JSX.Element {
  const [documentState, setDocumentState] = useState<OpenDocumentState | null>(null);
  const [editorState, dispatchEditor] = useReducer(editorHistoryReducer, createEmptyEditorHistory());
  const [savedSignature, setSavedSignature] = useState("");
  const [slides, setSlides] = useState<SlideDescriptor[]>([]);
  const [currentSlideId, setCurrentSlideId] = useState<string | null>(null);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [selectedElements, setSelectedElements] = useState<SelectedElement[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [selectedOverlayIds, setSelectedOverlayIds] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState("HTMLファイルを開いてください");
  const [runtimeWarnings, setRuntimeWarnings] = useState<string[]>([]);
  const [isCheckOpen, setIsCheckOpen] = useState(false);
  const [reviewRequestId, setReviewRequestId] = useState(0);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewSnapshot | null>(null);
  const [zoomMode, setZoomMode] = useState<CanvasZoomMode>("fit");
  const [fitScale, setFitScale] = useState(1);
  const [manualScale, setManualScale] = useState(1);
  const [isAudienceMode, setIsAudienceMode] = useState(false);
  const [presentationActive, setPresentationActive] = useState(false);
  const [presentationMode, setPresentationMode] = useState<"single" | "dual" | null>(null);
  const [presentationVisualSnapshot, setPresentationVisualSnapshot] = useState<PresenterSnapshot | null>(null);
  const [presentationInk, setPresentationInk] = useState(createEmptyPresentationInk);
  const [audienceTool, setAudienceTool] = useState<PresentationTool>("laser");
  const [audienceColor, setAudienceColor] = useState<PresentationColor>(DEFAULT_PRESENTATION_COLOR);
  const [audienceControlsVisible, setAudienceControlsVisible] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const pendingSlideIndexRef = useRef<number | null>(null);
  const documentOperationRef = useRef<"manual-open" | "launch-open" | "save" | null>(null);
  const documentRevisionRef = useRef(0);
  const currentSignatureRef = useRef("");
  const isDirtyRef = useRef(false);
  const slidesRef = useRef<SlideDescriptor[]>([]);
  const sourceHtmlRef = useRef("");
  const selectionKindRef = useRef<"dom" | "overlay" | null>(null);
  const launchOpenGateRef = useRef<LaunchOpenGate<OpenDocumentPayload> | null>(null);
  const presentationVisualSnapshotRef = useRef<PresenterSnapshot | null>(null);
  const audienceControlsTimerRef = useRef<number | null>(null);

  const patches = editorState.patches;
  const overlays = editorState.overlays;
  const sourceHtml = editorState.sourceHtml;
  slidesRef.current = slides;
  sourceHtmlRef.current = sourceHtml;
  const structuralEditing = useMemo(() => getSlideMutationAvailability(sourceHtml), [sourceHtml]);
  const currentSignature = useMemo(() => documentSignature(sourceHtml, patches, overlays), [overlays, patches, sourceHtml]);
  const isDirty = Boolean(documentState) && currentSignature !== savedSignature;
  currentSignatureRef.current = currentSignature;
  isDirtyRef.current = isDirty;
  const scale = zoomMode === "fit" ? fitScale : manualScale;
  const selectedOverlay = selectedOverlayId ? overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null : null;
  const activeSelectedElement = selectedOverlay ? overlayToSelectedElement(selectedOverlay) : selectedElement;
  const selectionCount = selectedElements.length + selectedOverlayIds.length;

  const manifest = useMemo<PatchManifest>(() => createManifest(documentState, slides, patches, overlays), [documentState, overlays, patches, slides]);
  const reviewResult = useMemo(() => buildReviewResult(reviewSnapshot, manifest), [manifest, reviewSnapshot]);
  const blockingIssueCount = reviewResult.issues.filter((issue) => issue.severity !== "info").length;
  const documentName = documentState ? fileNameFromPath(documentState.filePath) : "HTML Slide Studio";
  const currentSlide = slides.find((slide) => slide.id === currentSlideId) ?? slides[0] ?? null;
  const currentNotes = currentSlide?.speakerNotes ?? "";
  const notesEstimate = useMemo(() => estimateSpeakerNotes(currentNotes), [currentNotes]);
  const warnings = useMemo(
    () => [...new Set([...(documentState?.warnings ?? []), ...runtimeWarnings])],
    [documentState?.warnings, runtimeWarnings]
  );
  const presenterSnapshot = useMemo<PresenterSnapshot>(
    () => ({
      sourceHtml,
      sourceBaseUrl: documentState?.sourceBaseUrl,
      manifest,
      slides,
      currentSlideId,
      deckName: documentName,
      updatedAt: new Date().toISOString()
    }),
    [currentSlideId, documentName, documentState?.sourceBaseUrl, manifest, slides, sourceHtml]
  );

  const clearSelection = useCallback(() => {
    selectionKindRef.current = null;
    setSelectedElement(null);
    setSelectedElements([]);
    setSelectedOverlayId(null);
    setSelectedOverlayIds([]);
  }, []);

  const selectOnlyOverlay = useCallback((overlayId: string): void => {
    selectionKindRef.current = "overlay";
    setSelectedElement(null);
    setSelectedElements([]);
    setSelectedOverlayId(overlayId);
    setSelectedOverlayIds([overlayId]);
  }, []);

  const applyOpenedDocument = useCallback((payload: OpenDocumentPayload): void => {
    documentRevisionRef.current += 1;
    const rehydrated = rehydratePersistedOverlays(payload.html);
    const nextWarnings = [...new Set([...(payload.warnings ?? []), ...rehydrated.warnings])];
    const nextSignature = documentSignature(rehydrated.sourceHtml, [], rehydrated.overlays);
    setDocumentState({
      filePath: payload.filePath,
      sourceBaseUrl: payload.sourceBaseUrl,
      fingerprint: payload.fingerprint,
      warnings: nextWarnings
    });
    dispatchEditor({ type: "replace", sourceHtml: rehydrated.sourceHtml, patches: [], overlays: rehydrated.overlays });
    setSavedSignature(nextSignature);
    setSlides([]);
    setCurrentSlideId(null);
    setRuntimeWarnings([]);
    setReviewSnapshot(null);
    setIsCheckOpen(false);
    clearSelection();
    setStatusMessage(`${fileNameFromPath(payload.filePath)} を開きました`);
  }, [clearSelection]);

  const confirmReplacingDirtyDocument = useCallback((): boolean => {
    if (!isDirtyRef.current) return true;
    return window.confirm("未保存の変更があります。別のHTMLを開くと、この変更は失われます。続けますか？");
  }, []);

  const handleOpen = useCallback(async (): Promise<void> => {
    if (documentOperationRef.current) return;
    if (!confirmReplacingDirtyDocument()) return;
    documentOperationRef.current = "manual-open";
    setIsOpening(true);
    launchOpenGateRef.current?.beginBlockingOperation();
    try {
      const result = await window.hss.openHtmlDocument();
      if (!result.canceled) applyOpenedDocument(result);
    } catch (error) {
      setStatusMessage(`開けませんでした: ${errorMessage(error)}`);
    } finally {
      documentOperationRef.current = null;
      setIsOpening(false);
      void launchOpenGateRef.current?.endBlockingOperation();
    }
  }, [applyOpenedDocument, confirmReplacingDirtyDocument]);

  const handleOpenDemo = useCallback(async (): Promise<void> => {
    if (documentOperationRef.current) return;
    if (!confirmReplacingDirtyDocument()) return;
    documentOperationRef.current = "manual-open";
    setIsOpening(true);
    launchOpenGateRef.current?.beginBlockingOperation();
    try {
      const result = await window.hss.openDemoDocument();
      if (!result.canceled) applyOpenedDocument(result);
    } catch (error) {
      setStatusMessage(`デモを開けませんでした: ${errorMessage(error)}`);
    } finally {
      documentOperationRef.current = null;
      setIsOpening(false);
      void launchOpenGateRef.current?.endBlockingOperation();
    }
  }, [applyOpenedDocument, confirmReplacingDirtyDocument]);

  const handleOpenPath = useCallback(async (filePath: string): Promise<void> => {
    if (documentOperationRef.current) return;
    if (!confirmReplacingDirtyDocument()) return;
    documentOperationRef.current = "manual-open";
    setIsOpening(true);
    launchOpenGateRef.current?.beginBlockingOperation();
    try {
      const result = await window.hss.openHtmlPath(filePath);
      if (!result.canceled) applyOpenedDocument(result);
    } catch (error) {
      setStatusMessage(`開けませんでした: ${errorMessage(error)}`);
    } finally {
      documentOperationRef.current = null;
      setIsOpening(false);
      void launchOpenGateRef.current?.endBlockingOperation();
    }
  }, [applyOpenedDocument, confirmReplacingDirtyDocument]);

  useEffect(() => {
    const gate = createLaunchOpenGate<OpenDocumentPayload>({
      consume: async () => {
        const result = await window.hss.consumeLaunchHtml();
        return result.canceled ? null : result;
      },
      apply: (payload) => {
        if (confirmReplacingDirtyDocument()) {
          applyOpenedDocument(payload);
        } else {
          setStatusMessage("起動ファイルを開きませんでした");
        }
      },
      onConsumeStart: () => {
        documentOperationRef.current = "launch-open";
        setIsOpening(true);
      },
      onConsumeEnd: () => {
        if (documentOperationRef.current === "launch-open") {
          documentOperationRef.current = null;
          setIsOpening(false);
        }
      },
      onError: (error) => {
        setStatusMessage(`起動ファイルを開けませんでした: ${errorMessage(error)}`);
      }
    });
    if (documentOperationRef.current) gate.beginBlockingOperation();
    launchOpenGateRef.current = gate;
    const unsubscribe = window.hss.onLaunchHtmlFile(() => void gate.notify());
    void gate.notify();
    return () => {
      unsubscribe();
      gate.dispose();
      if (documentOperationRef.current === "launch-open") documentOperationRef.current = null;
      if (launchOpenGateRef.current === gate) launchOpenGateRef.current = null;
    };
  }, [applyOpenedDocument, confirmReplacingDirtyDocument]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const preventAccidentalClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalClose);
    return () => window.removeEventListener("beforeunload", preventAccidentalClose);
  }, [isDirty]);

  const handlePrepared = useCallback((preparedSlides: SlideDescriptor[], preparationWarnings: string[]) => {
    setSlides(preparedSlides);
    setRuntimeWarnings((existing) => [...new Set([...preparationWarnings, ...existing.filter((warning) => !warning.startsWith("明示的なスライド構造を判定できません"))])]);
    const requestedIndex = pendingSlideIndexRef.current;
    pendingSlideIndexRef.current = null;
    setCurrentSlideId((current) => {
      if (requestedIndex !== null) return preparedSlides[requestedIndex]?.id ?? preparedSlides.at(-1)?.id ?? null;
      return preparedSlides.some((slide) => slide.id === current) ? current : preparedSlides[0]?.id ?? null;
    });
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!documentState || documentOperationRef.current) return;
    const saveRevision = documentRevisionRef.current;
    const saveStartSignature = currentSignature;
    const saveFilePath = documentState.filePath;
    const saveFingerprint = documentState.fingerprint;
    documentOperationRef.current = "save";
    launchOpenGateRef.current?.beginBlockingOperation();
    setIsSaving(true);
    try {
      setStatusMessage("保存しています…");
      const exported = buildEditedHtmlExport(sourceHtml, manifest);
      if (exported.warnings.length > 0) {
        throw new Error(exported.warnings.join(" / "));
      }
      const result = await window.hss.saveHtmlDocument({
        html: exported.html,
        filePath: saveFilePath,
        expectedFingerprint: saveFingerprint
      });
      if (result.canceled) return;
      if (documentRevisionRef.current !== saveRevision) return;
      const rehydrated = rehydratePersistedOverlays(exported.html);
      const nextWarnings = [...new Set([...result.warnings, ...rehydrated.warnings])];
      const persistedSignature = documentSignature(rehydrated.sourceHtml, [], rehydrated.overlays);
      setDocumentState((current) => current?.filePath === saveFilePath
        ? { ...current, fingerprint: result.fingerprint, warnings: nextWarnings }
        : current);
      setSavedSignature(persistedSignature);
      if (currentSignatureRef.current === saveStartSignature) {
        dispatchEditor({ type: "replace", sourceHtml: rehydrated.sourceHtml, patches: [], overlays: rehydrated.overlays });
        clearSelection();
        setStatusMessage(`上書き保存しました — ${result.bytes.toLocaleString()} bytes`);
      } else {
        setStatusMessage(`上書き保存しました — 保存中の変更は未保存として残っています`);
      }
    } catch (error) {
      setStatusMessage(`保存できませんでした: ${errorMessage(error)}`);
    } finally {
      documentOperationRef.current = null;
      setIsSaving(false);
      void launchOpenGateRef.current?.endBlockingOperation();
    }
  }, [clearSelection, currentSignature, documentState, manifest, sourceHtml]);

  const handleSlideMutation = useCallback((type: "add" | "duplicate" | "move", direction?: -1 | 1): void => {
    if (!documentState || slides.length === 0) return;
    try {
      const currentIndex = Math.max(0, slides.findIndex((slide) => slide.id === currentSlideId));
      const exported = buildEditedHtmlExport(sourceHtml, manifest);
      if (exported.warnings.length > 0) throw new Error(exported.warnings.join(" / "));
      const mutation = type === "move"
        ? { type, index: currentIndex, direction: direction ?? 1 } as const
        : { type, index: currentIndex } as const;
      const result = mutateSlideDocument(exported.html, mutation);
      const rehydrated = rehydratePersistedOverlays(result.html);
      pendingSlideIndexRef.current = result.selectedIndex;
      dispatchEditor({ type: "edit", sourceHtml: rehydrated.sourceHtml, patches: [], overlays: rehydrated.overlays });
      clearSelection();
      setStatusMessage(type === "add" ? "スライドを追加しました" : type === "duplicate" ? "スライドを複製しました" : "スライドを並べ替えました");
    } catch (error) {
      setStatusMessage(`スライド操作を完了できませんでした: ${errorMessage(error)}`);
    }
  }, [clearSelection, currentSlideId, documentState, manifest, slides, sourceHtml]);

  const handleSpeakerNotesForSlide = useCallback((slideId: string, notes: string): void => {
    const slide = slidesRef.current.find((candidate) => candidate.id === slideId);
    if (!slide) return;
    const nextSource = updateSpeakerNotesInHtml(sourceHtmlRef.current, slide.index, notes);
    sourceHtmlRef.current = nextSource;
    dispatchEditor({ type: "edit", sourceHtml: nextSource, historyGroup: `notes-${slide.id}` });
    const nextSlides = slidesRef.current.map((candidate) => candidate.id === slide.id ? { ...candidate, speakerNotes: notes, hasSpeakerNotes: Boolean(notes) } : candidate);
    slidesRef.current = nextSlides;
    setSlides(nextSlides);
  }, []);

  const handleSpeakerNotesChange = useCallback((notes: string): void => {
    if (currentSlide) handleSpeakerNotesForSlide(currentSlide.id, notes);
  }, [currentSlide, handleSpeakerNotesForSlide]);

  const handleAddText = useCallback((): void => {
    const overlay: OverlayText = {
      id: createOverlayId(),
      type: "overlayText",
      slideId: currentSlideId ?? slides[0]?.id ?? null,
      x: 420,
      y: 320,
      width: 420,
      height: 90,
      text: "テキストを入力",
      style: {
        color: "#202124",
        backgroundColor: "transparent",
        fontSize: "32px",
        fontFamily: 'Arial, "Noto Sans JP", sans-serif',
        lineHeight: "1.35"
      },
      updatedAt: new Date().toISOString()
    };
    dispatchEditor({ type: "edit", overlays: [...overlays, overlay] });
    selectOnlyOverlay(overlay.id);
    setStatusMessage("テキストを追加しました");
  }, [currentSlideId, overlays, selectOnlyOverlay, slides]);

  const handleAddImage = useCallback(async (): Promise<void> => {
    if (!documentState) return;
    try {
      const result = await window.hss.importDocumentImage(documentState.filePath);
      if (result.canceled) return;
      const overlay: OverlayImage = {
        id: createOverlayId(),
        type: "overlayImage",
        slideId: currentSlideId ?? slides[0]?.id ?? null,
        x: 410,
        y: 210,
        width: 540,
        height: 340,
        text: fileNameFromPath(result.relativePath),
        src: result.relativePath,
        style: { objectFit: "contain", objectPosition: "center" },
        updatedAt: new Date().toISOString()
      };
      dispatchEditor({ type: "edit", overlays: [...overlays, overlay] });
      selectOnlyOverlay(overlay.id);
      setStatusMessage("画像を追加しました");
    } catch (error) {
      setStatusMessage(`画像を追加できませんでした: ${errorMessage(error)}`);
    }
  }, [currentSlideId, documentState, overlays, selectOnlyOverlay, slides]);

  const handleReplaceImage = useCallback(async (): Promise<void> => {
    if (!documentState || !activeSelectedElement?.imageSource) return;
    try {
      const result = await window.hss.importDocumentImage(documentState.filePath);
      if (result.canceled) return;
      const overlayTargets = new Set(selectedOverlayIds.length > 0 ? selectedOverlayIds : selectedOverlayId ? [selectedOverlayId] : []);
      if (overlayTargets.size > 0) {
        dispatchEditor({
          type: "edit",
          overlays: overlays.map((overlay) => overlayTargets.has(overlay.id) && overlay.type === "overlayImage"
            ? { ...overlay, src: result.relativePath, text: fileNameFromPath(result.relativePath), updatedAt: new Date().toISOString() }
            : overlay)
        });
      } else if (selectedElement?.tagName.toLowerCase() === "img") {
        dispatchEditor({ type: "edit", sourceHtml: replaceDomImageSource(sourceHtml, selectedElement, result.relativePath) });
      }
      setStatusMessage("画像を差し替えました");
    } catch (error) {
      setStatusMessage(`画像を差し替えられませんでした: ${errorMessage(error)}`);
    }
  }, [activeSelectedElement?.imageSource, documentState, overlays, selectedElement, selectedOverlayId, selectedOverlayIds, sourceHtml]);

  const handleSelectDomElement = useCallback((selected: SelectedElement | null, options?: { additive?: boolean }) => {
    if (!selected) {
      if (!options?.additive) clearSelection();
      return;
    }
    if (options?.additive) {
      const next = toggleSelection(selectedElements, selected);
      selectionKindRef.current = next.length > 0 ? "dom" : null;
      setSelectedElements(next);
      setSelectedElement(next.at(-1) ?? null);
      setSelectedOverlayIds([]);
      setSelectedOverlayId(null);
      return;
    }
    selectionKindRef.current = "dom";
    setSelectedElements([selected]);
    setSelectedElement(selected);
    setSelectedOverlayIds([]);
    setSelectedOverlayId(null);
  }, [clearSelection, selectedElements]);

  const handleSelectElements = useCallback((selected: SelectedElement[], overlayIds: string[], options?: { additive?: boolean }) => {
    const selectsOverlays = overlayIds.length > 0;
    const nextElements = selectsOverlays ? [] : options?.additive ? mergeSelections(selectedElements, selected) : selected;
    const nextOverlayIds = selectsOverlays ? options?.additive ? mergeIds(selectedOverlayIds, overlayIds) : overlayIds : [];
    selectionKindRef.current = nextOverlayIds.length > 0 ? "overlay" : nextElements.length > 0 ? "dom" : null;
    setSelectedElements(nextElements);
    setSelectedElement(nextElements.at(-1) ?? null);
    setSelectedOverlayIds(nextOverlayIds);
    setSelectedOverlayId(nextOverlayIds.at(-1) ?? null);
  }, [selectedElements, selectedOverlayIds]);

  const handleRefreshSelectedElements = useCallback((refreshed: SelectedElement[]) => {
    if (selectionKindRef.current !== "dom") return;
    setSelectedElements((current) => areSelectionListsEqual(current, refreshed) ? current : refreshed);
    setSelectedElement((current) => {
      const next = current ? refreshed.find((selection) => selection.hssId === current.hssId) ?? refreshed.at(-1) ?? null : refreshed.at(-1) ?? null;
      return areSelectionsEqual(current, next) ? current : next;
    });
  }, []);

  const handleSelectOverlay = useCallback((overlayId: string, options?: { additive?: boolean }) => {
    if (options?.additive) {
      const next = toggleId(selectedOverlayIds, overlayId);
      selectionKindRef.current = next.length > 0 ? "overlay" : null;
      setSelectedElement(null);
      setSelectedElements([]);
      setSelectedOverlayIds(next);
      setSelectedOverlayId(next.at(-1) ?? null);
      return;
    }
    selectOnlyOverlay(overlayId);
  }, [selectOnlyOverlay, selectedOverlayIds]);

  const handleTextChange = useCallback((text: string): void => {
    if (selectedOverlay?.type === "overlayText" && !selectedOverlay.locked) {
      dispatchEditor({ type: "edit", overlays: updateOverlay(overlays, selectedOverlay.id, { text }) });
      return;
    }
    if (!selectedElement?.canEditTextDirectly || selectedElement.locked) return;
    setSelectedElement((current) => current ? { ...current, textContent: text } : current);
    setSelectedElements((current) => replaceSelection(current, { ...selectedElement, textContent: text }));
    dispatchEditor({ type: "edit", patches: upsertTextPatch(patches, selectedElement, text) });
  }, [overlays, patches, selectedElement, selectedOverlay]);

  const handleInlineTextCommit = useCallback((selected: SelectedElement, text: string): void => {
    if (selected.locked || !selected.canEditTextDirectly) return;
    setSelectedElement({ ...selected, textContent: text });
    setSelectedElements((current) => replaceSelection(current, { ...selected, textContent: text }));
    dispatchEditor({ type: "edit", patches: upsertTextPatch(patches, selected, text) });
    setStatusMessage("テキストを変更しました");
  }, [patches]);

  const handleOverlayTextCommit = useCallback((overlayId: string, text: string): void => {
    const overlay = overlays.find((candidate) => candidate.id === overlayId);
    if (overlay?.type !== "overlayText" || overlay.locked) return;
    dispatchEditor({ type: "edit", overlays: updateOverlay(overlays, overlayId, { text }) });
  }, [overlays]);

  const handleStyleChange = useCallback((style: EditableStyle, options?: { historyGroup?: string; domTargetIds?: string[]; overlayTargetIds?: string[] }): void => {
    const domFilter = options?.domTargetIds ? new Set(options.domTargetIds) : null;
    const overlayFilter = options?.overlayTargetIds ? new Set(options.overlayTargetIds) : null;
    const domTargets = (selectedElements.length > 0 ? selectedElements : selectedElement ? [selectedElement] : [])
      .filter((target) => !target.locked && !isSlideRootSelection(target) && (!domFilter || domFilter.has(target.hssId)));
    const overlayTargets = (selectedOverlayIds.length > 0 ? selectedOverlayIds : selectedOverlay ? [selectedOverlay.id] : [])
      .filter((id) => !overlayFilter || overlayFilter.has(id))
      .filter((id) => !overlays.find((overlay) => overlay.id === id)?.locked);
    if (domTargets.length === 0 && overlayTargets.length === 0) return;

    let nextPatches = patches;
    for (const target of domTargets) nextPatches = upsertStylePatch(nextPatches, target, style);
    let nextOverlays = overlays;
    for (const id of overlayTargets) nextOverlays = updateOverlayStyle(nextOverlays, id, style);
    const domIds = new Set(domTargets.map((target) => target.hssId));
    setSelectedElement((current) => current && domIds.has(current.hssId) ? updateSelectedStyle(current, style) : current);
    setSelectedElements((current) => current.map((target) => domIds.has(target.hssId) ? updateSelectedStyle(target, style) : target));
    dispatchEditor({ type: "edit", patches: nextPatches, overlays: nextOverlays, historyGroup: options?.historyGroup });
  }, [overlays, patches, selectedElement, selectedElements, selectedOverlay, selectedOverlayIds]);

  const handleMoveSelection = useCallback((domMoves: DomMoveChange[], overlayMoves: OverlayMoveChange[], options?: { historyGroup?: string }): void => {
    let nextPatches = patches;
    const allowedDomMoves = domMoves.filter((move) => !move.selection.locked && !isSlideRootSelection(move.selection));
    for (const move of allowedDomMoves) nextPatches = upsertStylePatch(nextPatches, move.selection, { transform: move.transform });
    let nextOverlays = overlays;
    const allowedOverlayMoves = overlayMoves.filter((move) => !overlays.find((overlay) => overlay.id === move.overlayId)?.locked);
    for (const move of allowedOverlayMoves) nextOverlays = updateOverlay(nextOverlays, move.overlayId, { x: move.x, y: move.y });
    if (allowedDomMoves.length > 0) {
      const updates = createDomMoveStateUpdates(allowedDomMoves, patches);
      setSelectedElement((current) => applyDomMoveStateUpdate(current, updates));
      setSelectedElements((current) => current.map((selection) => applyDomMoveStateUpdate(selection, updates)));
    }
    dispatchEditor({ type: "edit", patches: nextPatches, overlays: nextOverlays, historyGroup: options?.historyGroup });
  }, [overlays, patches]);

  const handleResizeSelection = useCallback((domResizes: DomResizeChange[], overlayResizes: OverlayResizeChange[], options?: { historyGroup?: string }): void => {
    let nextPatches = patches;
    for (const resize of domResizes.filter((item) => !item.selection.locked && !isSlideRootSelection(item.selection))) {
      nextPatches = upsertStylePatch(nextPatches, resize.selection, { ...resize.style, transform: resize.transform, width: resize.width, height: resize.height });
    }
    let nextOverlays = overlays;
    for (const resize of overlayResizes.filter((item) => !overlays.find((overlay) => overlay.id === item.overlayId)?.locked)) {
      nextOverlays = updateOverlay(nextOverlays, resize.overlayId, { x: resize.x, y: resize.y, width: resize.width, height: resize.height });
    }
    dispatchEditor({ type: "edit", patches: nextPatches, overlays: nextOverlays, historyGroup: options?.historyGroup });
  }, [overlays, patches]);

  const handleNudge = useCallback((deltaX: number, deltaY: number, options?: { historyGroup?: string }): void => {
    const domMoves = selectedElements.filter((selection) => !selection.locked && !isSlideRootSelection(selection)).map((selection) => {
      const patch = patches.find((candidate) => candidate.type === "style" && candidate.target.hssId === selection.hssId);
      const current = parseTranslate(patch?.type === "style" ? patch.style.transform : selection.computedStyle.transform);
      return { selection, transform: formatTranslate(current.x + deltaX, current.y + deltaY) };
    });
    const overlayMoves = selectedOverlayIds.flatMap((id) => {
      const overlay = overlays.find((candidate) => candidate.id === id);
      return overlay && !overlay.locked ? [{ overlayId: id, x: overlay.x + deltaX, y: overlay.y + deltaY }] : [];
    });
    handleMoveSelection(domMoves, overlayMoves, options);
  }, [handleMoveSelection, overlays, patches, selectedElements, selectedOverlayIds]);

  const handleDeleteSelection = useCallback((): void => {
    let nextPatches = patches;
    const domTargets = selectedElements.filter((selection) => !selection.locked && !isSlideRootSelection(selection));
    for (const selection of domTargets) nextPatches = upsertStylePatch(nextPatches, selection, { display: "none" });
    const overlaySet = new Set(selectedOverlayIds.filter((id) => !overlays.find((overlay) => overlay.id === id)?.locked));
    dispatchEditor({ type: "edit", patches: nextPatches, overlays: overlays.filter((overlay) => !overlaySet.has(overlay.id)) });
    clearSelection();
    setStatusMessage("選択した要素を削除しました");
  }, [clearSelection, overlays, patches, selectedElements, selectedOverlayIds]);

  const handleDuplicateSelection = useCallback((): void => {
    const selectedSet = new Set(selectedOverlayIds);
    const copies = overlays.filter((overlay) => selectedSet.has(overlay.id)).map((overlay) => ({
      ...overlay,
      id: createOverlayId(),
      x: overlay.x + 24,
      y: overlay.y + 24,
      updatedAt: new Date().toISOString()
    }));
    if (copies.length === 0) return;
    dispatchEditor({ type: "edit", overlays: [...overlays, ...copies] });
    setSelectedOverlayIds(copies.map((overlay) => overlay.id));
    setSelectedOverlayId(copies.at(-1)?.id ?? null);
  }, [overlays, selectedOverlayIds]);

  const handleCheck = useCallback((): void => {
    setIsCheckOpen(true);
    setReviewRequestId((current) => current + 1);
    setStatusMessage("現在のスライドを確認しました");
  }, []);

  const handleSelectIssue = useCallback((issue: ReviewIssue): void => {
    const target = reviewSnapshot?.targets.find((candidate) => candidate.id === issue.targetId);
    if (!target) return;
    if (target.slideId) setCurrentSlideId(target.slideId);
    if (target.source === "overlay") {
      handleSelectOverlay(target.id);
    } else {
      handleSelectDomElement(reviewTargetToSelectedElement(target));
    }
  }, [handleSelectDomElement, handleSelectOverlay, reviewSnapshot?.targets]);

  const navigateSlide = useCallback((direction: -1 | 1): boolean => {
    const currentIndex = Math.max(0, slides.findIndex((slide) => slide.id === currentSlideId));
    const next = slides[Math.min(slides.length - 1, Math.max(0, currentIndex + direction))];
    if (!next || next.id === currentSlideId) return false;
    setCurrentSlideId(next.id);
    return true;
  }, [currentSlideId, slides]);

  const endPresentation = useCallback((): void => {
    setIsAudienceMode(false);
    setPresentationActive(false);
    setPresentationMode(null);
    setPresentationVisualSnapshot(null);
    presentationVisualSnapshotRef.current = null;
    setPresentationInk(createEmptyPresentationInk());
    if (audienceControlsTimerRef.current !== null) window.clearTimeout(audienceControlsTimerRef.current);
    void window.hss.endPresenter();
    setStatusMessage("編集画面へ戻りました");
  }, []);

  const handlePresent = useCallback(async (): Promise<void> => {
    if (!documentState || slides.length === 0) return;
    try {
      setPresentationInk(createEmptyPresentationInk());
      setAudienceTool("laser");
      setAudienceColor(DEFAULT_PRESENTATION_COLOR);
      presentationVisualSnapshotRef.current = presenterSnapshot;
      setPresentationVisualSnapshot(presenterSnapshot);
      const result = await window.hss.openPresenter(presenterSnapshot);
      setPresentationMode(result.mode);
      setPresentationActive(true);
      setIsAudienceMode(true);
      setStatusMessage(
        result.mode === "dual"
          ? "発表者画面と投映画面を開きました"
          : result.fallback
            ? "画面配置に失敗したため、1画面の全画面表示を開始しました"
            : "全画面表示を開始しました"
      );
    } catch (error) {
      presentationVisualSnapshotRef.current = null;
      setPresentationVisualSnapshot(null);
      setPresentationMode(null);
      setStatusMessage(`発表を開始できませんでした: ${errorMessage(error)}`);
    }
  }, [documentState, presenterSnapshot, slides.length]);

  useEffect(() => {
    if (!presentationActive) return;
    const visualSnapshot = presentationVisualSnapshotRef.current;
    if (!visualSnapshot) return;
    const latestSlides = slidesRef.current;
    void window.hss.updatePresenter({
      ...visualSnapshot,
      slides: latestSlides,
      manifest: { ...visualSnapshot.manifest, slides: latestSlides },
      currentSlideId,
      updatedAt: new Date().toISOString()
    }).catch(() => undefined);
  }, [currentSlideId, presentationActive]);

  useEffect(() => window.hss.onPresenterCommand((command: PresenterCommand) => {
    if (command.type === "next-slide") navigateSlide(1);
    if (command.type === "previous-slide") navigateSlide(-1);
    if (command.type === "set-slide" && slides.some((slide) => slide.id === command.slideId)) setCurrentSlideId(command.slideId);
    if (command.type === "update-notes" && slides.some((slide) => slide.id === command.slideId)) handleSpeakerNotesForSlide(command.slideId, command.notes);
    if (command.type === "finish-notes" && slides.some((slide) => slide.id === command.slideId)) dispatchEditor({ type: "end-group" });
    if (command.type === "draw" && slides.some((slide) => slide.id === command.event.slideId)) {
      setPresentationInk((current) => applyPresentationDraw(current, command.event));
    }
    if (command.type === "clear-drawing" && slides.some((slide) => slide.id === command.slideId)) {
      setPresentationInk((current) => clearPresentationInk(current, command.slideId));
    }
    if (command.type === "end-presentation") {
      setIsAudienceMode(false);
      setPresentationActive(false);
      setPresentationMode(null);
      setPresentationVisualSnapshot(null);
      presentationVisualSnapshotRef.current = null;
      setPresentationInk(createEmptyPresentationInk());
    }
  }), [handleSpeakerNotesForSlide, navigateSlide, slides]);

  const handleAudienceDraw = useCallback((event: PresentationDrawEvent): void => {
    setPresentationInk((current) => applyPresentationDraw(current, event));
  }, []);

  const revealAudienceControls = useCallback((): void => {
    setAudienceControlsVisible(true);
    if (audienceControlsTimerRef.current !== null) window.clearTimeout(audienceControlsTimerRef.current);
    audienceControlsTimerRef.current = window.setTimeout(() => {
      setAudienceControlsVisible(false);
      audienceControlsTimerRef.current = null;
    }, 1_800);
  }, []);

  useEffect(() => {
    if (!isAudienceMode || presentationMode !== "single") return undefined;
    revealAudienceControls();
    return () => {
      if (audienceControlsTimerRef.current !== null) window.clearTimeout(audienceControlsTimerRef.current);
      audienceControlsTimerRef.current = null;
    };
  }, [isAudienceMode, presentationMode, revealAudienceControls]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isAudienceMode) {
        if (event.key === "Escape") { event.preventDefault(); endPresentation(); }
        else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") { event.preventDefault(); navigateSlide(1); }
        else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); navigateSlide(-1); }
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void handleSave(); }
      if (event.key.toLowerCase() === "o") { event.preventDefault(); void handleOpen(); }
      if (event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); dispatchEditor({ type: "undo" }); }
      if (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey)) { event.preventDefault(); dispatchEditor({ type: "redo" }); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [endPresentation, handleOpen, handleSave, isAudienceMode, navigateSlide]);

  if (!documentState) {
    return (
      <I18nProvider>
        <WelcomeScreen
          onOpen={() => void handleOpen()}
          onOpenDemo={() => void handleOpenDemo()}
          onDropFile={(file) => void handleOpenPath(window.hss.getFilePath(file))}
        />
        <div className="welcome-status" role="status">{statusMessage}</div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <div className="app-shell">
        <EditorToolbar
          documentName={documentName}
          isDirty={isDirty}
          isSaving={isSaving}
          isOpening={isOpening}
          canUndo={editorState.past.length > 0}
          canRedo={editorState.future.length > 0}
          checkIssueCount={blockingIssueCount}
          onOpen={() => void handleOpen()}
          onSave={() => void handleSave()}
          onUndo={() => dispatchEditor({ type: "undo" })}
          onRedo={() => dispatchEditor({ type: "redo" })}
          onAddText={handleAddText}
          onAddImage={() => void handleAddImage()}
          onCheck={handleCheck}
          onPresent={() => void handlePresent()}
        />

        <main className="workspace-grid">
          <SlideNavigator
            slides={slides}
            currentSlideId={currentSlideId}
            sourceHtml={sourceHtml}
            sourceBaseHref={documentState.sourceBaseUrl}
            patches={patches}
            overlays={overlays}
            structuralEditing={structuralEditing}
            onSelectSlide={(slideId) => { setCurrentSlideId(slideId); clearSelection(); }}
            onAddSlide={() => handleSlideMutation("add")}
            onDuplicateSlide={() => handleSlideMutation("duplicate")}
            onMoveSlide={(direction) => handleSlideMutation("move", direction)}
          />

          <CanvasStage
            sourceHtml={sourceHtml}
            sourceBaseHref={documentState.sourceBaseUrl}
            patches={patches}
            overlays={overlays}
            currentSlideId={currentSlideId}
            selectedElement={selectedElement}
            selectedElements={selectedElements}
            selectedOverlayId={selectedOverlayId}
            selectedOverlayIds={selectedOverlayIds}
            snapEnabled
            zoomMode={zoomMode}
            scale={scale}
            onPrepared={handlePrepared}
            onSlideBounds={() => undefined}
            onFitScaleChange={(next) => setFitScale(clampZoom(next))}
            onZoomOut={() => { setManualScale(clampZoom(scale - ZOOM_STEP)); setZoomMode("manual"); }}
            onZoomIn={() => { setManualScale(clampZoom(scale + ZOOM_STEP)); setZoomMode("manual"); }}
            onZoomFit={() => setZoomMode("fit")}
            onZoomActual={() => { setManualScale(1); setZoomMode("manual"); }}
            onNavigateSlideByWheel={navigateSlide}
            onSelectElement={handleSelectDomElement}
            onSelectElements={handleSelectElements}
            onRefreshSelectedElements={handleRefreshSelectedElements}
            onSelectOverlay={handleSelectOverlay}
            onInlineTextCommit={handleInlineTextCommit}
            onOverlayTextCommit={handleOverlayTextCommit}
            onDeleteSelection={handleDeleteSelection}
            onMoveOverlay={(id, x, y) => dispatchEditor({ type: "edit", overlays: updateOverlay(overlays, id, { x, y }) })}
            onMoveSelection={handleMoveSelection}
            onResizeSelection={handleResizeSelection}
            onResizeOverlay={(id, x, y, width, height, options) => dispatchEditor({ type: "edit", overlays: updateOverlay(overlays, id, { x, y, width, height }), historyGroup: options?.historyGroup })}
            onStyleChange={handleStyleChange}
            onEndHistoryGroup={() => dispatchEditor({ type: "end-group" })}
            onUndo={() => dispatchEditor({ type: "undo" })}
            onRedo={() => dispatchEditor({ type: "redo" })}
            onCopy={() => setStatusMessage("要素のコピーは画像・文字の複製を使ってください")}
            onPaste={() => undefined}
            onDuplicate={handleDuplicateSelection}
            onNudge={handleNudge}
            onRuntimeWarnings={(next) => setRuntimeWarnings(next)}
            reviewRequestId={reviewRequestId}
            onReviewSnapshot={setReviewSnapshot}
          />

          {isCheckOpen ? (
            <CheckPanel result={reviewResult} onSelectIssue={handleSelectIssue} onClose={() => setIsCheckOpen(false)} />
          ) : (
            <SimpleInspector
              selectedElement={activeSelectedElement}
              selectedCount={selectionCount}
              onTextChange={handleTextChange}
              onStyleChange={handleStyleChange}
              onReplaceImage={() => void handleReplaceImage()}
              onDelete={handleDeleteSelection}
            />
          )}

          <section className="notes-pane" aria-label="発表者ノート">
            <label htmlFor="speaker-notes-editor">発表者ノート</label>
            <textarea
              id="speaker-notes-editor"
              rows={2}
              value={currentNotes}
              placeholder="このスライドで話すことをメモ"
              onChange={(event) => handleSpeakerNotesChange(event.currentTarget.value)}
              onBlur={() => dispatchEditor({ type: "end-group" })}
            />
            <span>{notesEstimate.characters}文字・目安 {formatSpeakerNotesDuration(notesEstimate.seconds)}</span>
          </section>
        </main>

        <footer className="app-status" role="status">
          <span className={isDirty ? "app-status__dirty" : ""}>{isDirty ? "未保存" : "保存済み"}</span>
          <span className="app-status__message">{statusMessage}</span>
          {warnings.length > 0 ? <span className="app-status__warning" title={warnings.join("\n")}>注意 {warnings.length}</span> : null}
          <span>{Math.round(scale * 100)}%</span>
        </footer>

        {isAudienceMode && currentSlide ? (
          <div
            className="audience-mode"
            role="dialog"
            aria-label="発表モード"
            onPointerMove={presentationMode === "single" ? revealAudienceControls : undefined}
          >
            <SlidePreviewFrame
              className={`slide-preview--audience${presentationMode === "dual" ? " slide-preview--input-blocked" : ""}`}
              sourceHtml={(presentationVisualSnapshot ?? presenterSnapshot).sourceHtml}
              sourceBaseHref={(presentationVisualSnapshot ?? presenterSnapshot).sourceBaseUrl}
              patches={(presentationVisualSnapshot ?? presenterSnapshot).manifest.patches}
              overlays={(presentationVisualSnapshot ?? presenterSnapshot).manifest.overlays}
              slideId={currentSlide.id}
              title={currentSlide.label}
              presentationInk={presentationInk}
              presentationTool={audienceTool}
              presentationColor={audienceColor}
              onPresentationDraw={presentationMode === "single" ? handleAudienceDraw : undefined}
            />
            {presentationMode === "single" ? (
              <div className={`audience-mode__controls${audienceControlsVisible ? " audience-mode__controls--visible" : ""}`}>
                <button type="button" onClick={() => navigateSlide(-1)} disabled={currentSlide.id === slides[0]?.id}>前へ</button>
                <span>{currentSlide.index + 1} / {slides.length}</span>
                <button type="button" onClick={() => navigateSlide(1)} disabled={currentSlide.id === slides.at(-1)?.id}>次へ</button>
                <button type="button" className={audienceTool === "laser" ? "is-active" : ""} onClick={() => setAudienceTool("laser")} aria-pressed={audienceTool === "laser"}>レーザー</button>
                <button type="button" className={audienceTool === "pen" ? "is-active" : ""} onClick={() => setAudienceTool("pen")} aria-pressed={audienceTool === "pen"}>ペン</button>
                <div className="audience-mode__colors" role="group" aria-label="描画色">
                  {PRESENTATION_COLOR_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.color}
                      className={`presentation-color-button${audienceColor === option.color ? " is-active" : ""}`}
                      onClick={() => setAudienceColor(option.color)}
                      aria-label={`${option.label}で描画`}
                      aria-pressed={audienceColor === option.color}
                      title={option.label}
                    >
                      <span style={{ backgroundColor: option.color }} />
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => setPresentationInk((current) => clearPresentationInk(current, currentSlide.id))}>描画を消去</button>
                <button type="button" onClick={endPresentation}>編集へ戻る</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </I18nProvider>
  );
}

function createManifest(
  documentState: OpenDocumentState | null,
  slides: SlideDescriptor[],
  patches: PatchManifest["patches"],
  overlays: Overlay[]
): PatchManifest {
  return {
    version: 1,
    app: "html-slide-studio",
    savedAt: new Date().toISOString(),
    warnings: (documentState?.warnings ?? []).map((message, index) => ({ id: `document-warning-${index}`, severity: "warning", message })),
    slides,
    patches,
    overlays
  };
}

function documentSignature(sourceHtml: string, patches: PatchManifest["patches"], overlays: Overlay[]): string {
  return JSON.stringify({ sourceHtml, patches, overlays });
}

function overlayToSelectedElement(overlay: Overlay): SelectedElement {
  return {
    hssId: overlay.id,
    tagName: overlay.type === "overlayImage" ? "image" : "overlayText",
    selector: `[data-hss-overlay-id="${overlay.id}"]`,
    textContent: overlay.text,
    childElementCount: 0,
    canEditTextDirectly: overlay.type === "overlayText",
    locked: Boolean(overlay.locked),
    imageSource: overlay.type === "overlayImage" ? overlay.src : undefined,
    computedStyle: {
      ...overlay.style,
      transform: formatTranslate(overlay.x, overlay.y),
      width: `${overlay.width}px`,
      height: `${overlay.height}px`,
      display: overlay.hidden ? "none" : overlay.style.display
    },
    bbox: { x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height }
  };
}

function reviewTargetToSelectedElement(target: ReviewTarget): SelectedElement {
  return {
    hssId: target.id,
    tagName: target.tagName ?? target.type,
    selector: `[data-hss-id="${target.id}"]`,
    textContent: target.text ?? target.label,
    childElementCount: 0,
    canEditTextDirectly: target.type === "text",
    locked: target.locked,
    imageSource: target.imageSource,
    computedStyle: {
      color: target.color,
      backgroundColor: target.backgroundColor,
      fontSize: target.fontSize !== undefined ? `${target.fontSize}px` : undefined,
      lineHeight: target.lineHeight !== undefined ? `${target.lineHeight}px` : undefined
    },
    bbox: target.bounds
  };
}

function replaceDomImageSource(sourceHtml: string, selected: SelectedElement, relativePath: string): string {
  const document = new DOMParser().parseFromString(sourceHtml, "text/html");
  let element = document.querySelector(`[data-hss-id="${cssAttributeEscape(selected.hssId)}"]`);
  if (!element) {
    try { element = document.querySelector(selected.selector); } catch { element = null; }
  }
  if (!(element instanceof HTMLImageElement)) throw new Error("選択した画像を元のHTMLで特定できませんでした");
  element.setAttribute("data-hss-id", selected.hssId);
  element.setAttribute("src", relativePath);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function cssAttributeEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function isSlideRootSelection(selection: SelectedElement): boolean {
  return selection.tagName === "section" || selection.tagName === "article" || selection.tagName === "body";
}

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function createOverlayId(): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `overlay-${value.slice(0, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
