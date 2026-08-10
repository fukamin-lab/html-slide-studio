import { ChevronLeft, ChevronRight, LogOut, MousePointer2, PenLine, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SlidePreviewFrame } from "./components/SlidePreviewFrame";
import { estimateSpeakerNotes, formatSpeakerNotesDuration } from "./editor/speakerNotes";
import {
  applyPresentationDraw,
  clearPresentationInk,
  createEmptyPresentationInk,
  DEFAULT_PRESENTATION_COLOR,
  PRESENTATION_COLOR_OPTIONS
} from "./presentationInk";
import type { PresentationColor, PresentationDrawEvent, PresentationTool, PresenterCommand, PresenterSnapshot } from "./types/presenter";

export function PresenterApp(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PresenterSnapshot | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [tool, setTool] = useState<PresentationTool>("laser");
  const [color, setColor] = useState<PresentationColor>(DEFAULT_PRESENTATION_COLOR);
  const [ink, setInk] = useState(createEmptyPresentationInk);
  const [notesDraft, setNotesDraft] = useState("");
  const locallyOwnedNotesSlideRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.hssPresenter.onPresenterState(setSnapshot);
    window.hssPresenter.presenterReady();
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const sendCommand = useCallback((command: PresenterCommand): void => {
    window.hssPresenter.sendPresenterCommand(command);
  }, []);

  const currentIndex = useMemo(() => {
    if (!snapshot) return 0;
    const index = snapshot.slides.findIndex((slide) => slide.id === snapshot.currentSlideId);
    return Math.max(0, index);
  }, [snapshot]);
  const currentSlide = snapshot?.slides[currentIndex] ?? null;
  const nextSlide = snapshot?.slides[currentIndex + 1] ?? null;
  const noteEstimate = estimateSpeakerNotes(notesDraft);

  useEffect(() => {
    const slideId = currentSlide?.id ?? null;
    if (locallyOwnedNotesSlideRef.current === slideId) return;
    locallyOwnedNotesSlideRef.current = slideId;
    setNotesDraft(currentSlide?.speakerNotes ?? "");
  }, [currentSlide?.id, currentSlide?.speakerNotes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        sendCommand({ type: "end-presentation" });
      } else if (isEditableTarget(event.target)) {
        return;
      } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        sendCommand({ type: "next-slide" });
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        sendCommand({ type: "previous-slide" });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sendCommand]);

  const handleDraw = useCallback((event: PresentationDrawEvent): void => {
    setInk((current) => applyPresentationDraw(current, event));
    sendCommand({ type: "draw", event });
  }, [sendCommand]);

  const handleClearDrawing = useCallback((): void => {
    if (!currentSlide) return;
    setInk((current) => clearPresentationInk(current, currentSlide.id));
    sendCommand({ type: "clear-drawing", slideId: currentSlide.id });
  }, [currentSlide, sendCommand]);

  if (!snapshot || !currentSlide) {
    return <div className="presenter-shell presenter-shell--empty">スライドを準備しています…</div>;
  }

  return (
    <div className="presenter-shell">
      <header className="presenter-topbar">
        <div className="presenter-topbar__deck">
          <strong>{currentSlide.label}</strong>
          <span>{snapshot.deckName ?? "HTMLスライド"}</span>
        </div>
        <div className="presenter-topbar__status">
          <span>{currentIndex + 1} / {snapshot.slides.length}</span>
          <span>{formatElapsed(now - startedAt)}</span>
          <span>{formatClock(new Date(now))}</span>
          <button type="button" className="presenter-end-button" onClick={() => sendCommand({ type: "end-presentation" })}>
            <LogOut size={16} />終了
          </button>
        </div>
      </header>

      <div className="presenter-progress" aria-hidden="true">
        <span style={{ width: `${((currentIndex + 1) / snapshot.slides.length) * 100}%` }} />
      </div>

      <main className="presenter-grid">
        <nav className="presenter-panel presenter-slide-rail" aria-label="スライド一覧">
          <div className="presenter-section-heading"><span>スライド</span></div>
          <div className="presenter-slide-rail__body">
            {snapshot.slides.map((slide, index) => (
              <button
                type="button"
                key={slide.id}
                className={index === currentIndex ? "presenter-slide-thumb presenter-slide-thumb--active" : "presenter-slide-thumb"}
                onClick={() => sendCommand({ type: "set-slide", slideId: slide.id })}
                aria-current={index === currentIndex ? "page" : undefined}
              >
                <span className="presenter-slide-thumb__index">{index + 1}</span>
                <span className="presenter-slide-thumb__preview" aria-hidden="true">
                  <SlidePreviewFrame
                    className="slide-preview--thumbnail"
                    sourceHtml={snapshot.sourceHtml}
                    sourceBaseHref={snapshot.sourceBaseUrl}
                    patches={snapshot.manifest.patches}
                    overlays={snapshot.manifest.overlays}
                    slideId={slide.id}
                    title={slide.label}
                  />
                </span>
                <strong>{slide.label}</strong>
              </button>
            ))}
          </div>
        </nav>

        <section className="presenter-current">
          <div className="presenter-section-heading">
            <span>現在のスライド</span>
            <div className="presenter-current__actions">
              <div className="presenter-tools" aria-label="描画ツール">
                <button type="button" className={tool === "laser" ? "is-active" : ""} onClick={() => setTool("laser")} aria-label="レーザー" aria-pressed={tool === "laser"}><MousePointer2 size={17} /></button>
                <button type="button" className={tool === "pen" ? "is-active" : ""} onClick={() => setTool("pen")} aria-label="ペン" aria-pressed={tool === "pen"}><PenLine size={17} /></button>
                <div className="presenter-colors" role="group" aria-label="描画色">
                  {PRESENTATION_COLOR_OPTIONS.map((option) => (
                    <button
                      type="button"
                      key={option.color}
                      className={`presentation-color-button${color === option.color ? " is-active" : ""}`}
                      onClick={() => setColor(option.color)}
                      aria-label={`${option.label}で描画`}
                      aria-pressed={color === option.color}
                      title={option.label}
                    >
                      <span style={{ backgroundColor: option.color }} />
                    </button>
                  ))}
                </div>
                <button type="button" onClick={handleClearDrawing} aria-label="描画を消去"><Trash2 size={17} /></button>
              </div>
              <div className="presenter-controls">
                <button type="button" onClick={() => sendCommand({ type: "previous-slide" })} disabled={currentIndex === 0} aria-label="前のスライド"><ChevronLeft size={24} /></button>
                <button type="button" onClick={() => sendCommand({ type: "next-slide" })} disabled={currentIndex === snapshot.slides.length - 1} aria-label="次のスライド"><ChevronRight size={24} /></button>
              </div>
            </div>
          </div>
          <SlidePreviewFrame
            sourceHtml={snapshot.sourceHtml}
            sourceBaseHref={snapshot.sourceBaseUrl}
            patches={snapshot.manifest.patches}
            overlays={snapshot.manifest.overlays}
            slideId={currentSlide.id}
            title="現在のスライド"
            presentationInk={ink}
            presentationTool={tool}
            presentationColor={color}
            onPresentationDraw={handleDraw}
          />
        </section>

        <aside className="presenter-side">
          <section className="presenter-panel presenter-next">
            <div className="presenter-section-heading"><span>次のスライド</span></div>
            {nextSlide ? (
              <SlidePreviewFrame
                className="slide-preview--compact"
                sourceHtml={snapshot.sourceHtml}
                sourceBaseHref={snapshot.sourceBaseUrl}
                patches={snapshot.manifest.patches}
                overlays={snapshot.manifest.overlays}
                slideId={nextSlide.id}
                title="次のスライド"
                presentationInk={ink}
              />
            ) : <div className="presenter-empty-panel">最後のスライドです</div>}
          </section>

          <section className="presenter-panel presenter-notes">
            <div className="presenter-section-heading">
              <span>発表者ノート</span>
              <small>{noteEstimate.characters}文字・{formatSpeakerNotesDuration(noteEstimate.seconds)}</small>
            </div>
            <textarea
              className="presenter-notes__editor"
              aria-label="発表者ノート"
              value={notesDraft}
              placeholder="このスライドで話すことをメモ"
              onChange={(event) => {
                const notes = event.currentTarget.value;
                locallyOwnedNotesSlideRef.current = currentSlide.id;
                setNotesDraft(notes);
                sendCommand({ type: "update-notes", slideId: currentSlide.id, notes });
              }}
              onBlur={() => sendCommand({ type: "finish-notes", slideId: currentSlide.id })}
            />
          </section>
        </aside>
      </main>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(date);
}
