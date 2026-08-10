import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, Copy, Plus } from "lucide-react";
import { SlidePreviewFrame } from "./SlidePreviewFrame";
import { useI18n } from "../i18n";
import type { Overlay, Patch } from "../types/patches";
import type { SlideDescriptor } from "../types/project";

type SlideNavigatorProps = {
  slides: SlideDescriptor[];
  currentSlideId: string | null;
  sourceHtml: string;
  sourceBaseHref?: string;
  patches: Patch[];
  overlays: Overlay[];
  structuralEditing: { enabled: boolean; reason?: string };
  onSelectSlide: (slideId: string) => void;
  onAddSlide: () => void;
  onDuplicateSlide: () => void;
  onMoveSlide: (direction: -1 | 1) => void;
};

export function SlideNavigator({
  slides,
  currentSlideId,
  sourceHtml,
  sourceBaseHref,
  patches,
  overlays,
  structuralEditing,
  onSelectSlide,
  onAddSlide,
  onDuplicateSlide,
  onMoveSlide
}: SlideNavigatorProps): JSX.Element {
  const { t } = useI18n();
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentSlideId, slides.length]);

  return (
    <aside className="slide-navigator" aria-label={t("slides")}>
      <div className="slide-navigator__heading">
        <span>{t("slides")}</span>
        <button
          type="button"
          onClick={onAddSlide}
          disabled={!structuralEditing.enabled}
          title={structuralEditing.enabled ? "スライドを追加" : structuralEditing.reason}
          aria-label="スライドを追加"
        ><Plus size={15} /></button>
      </div>
      {!structuralEditing.enabled && structuralEditing.reason ? (
        <p className="slide-navigator__notice" role="note">{structuralEditing.reason}</p>
      ) : null}
      <div className="slide-list">
        {slides.map((slide) => (
          <button
            key={slide.id}
            ref={slide.id === currentSlideId ? activeItemRef : null}
            className={`slide-list__item${slide.id === currentSlideId ? " slide-list__item--active" : ""}`}
            onClick={() => onSelectSlide(slide.id)}
            aria-current={slide.id === currentSlideId ? "page" : undefined}
          >
            <span className="slide-list__index">{slide.index + 1}</span>
            <span className="slide-list__thumb" aria-hidden="true">
              <SlidePreviewFrame
                sourceHtml={sourceHtml}
                sourceBaseHref={sourceBaseHref}
                patches={patches}
                overlays={overlays}
                slideId={slide.id}
                className="slide-preview--thumbnail"
                title={t("thumbnail", { label: slide.label })}
              />
            </span>
            <span className="slide-list__label">{slide.label}</span>
          </button>
        ))}
      </div>
      <div className="slide-navigator__actions" aria-label="スライド操作">
        <button type="button" onClick={onDuplicateSlide} disabled={!structuralEditing.enabled || !currentSlideId} title={structuralEditing.enabled ? "複製" : structuralEditing.reason}><Copy size={15} /><span>複製</span></button>
        <button type="button" onClick={() => onMoveSlide(-1)} disabled={!structuralEditing.enabled || !currentSlideId || slides[0]?.id === currentSlideId} title={structuralEditing.enabled ? "上へ" : structuralEditing.reason}><ArrowUp size={15} /></button>
        <button type="button" onClick={() => onMoveSlide(1)} disabled={!structuralEditing.enabled || !currentSlideId || slides.at(-1)?.id === currentSlideId} title={structuralEditing.enabled ? "下へ" : structuralEditing.reason}><ArrowDown size={15} /></button>
      </div>
    </aside>
  );
}
