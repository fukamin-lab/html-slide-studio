import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { documentAssetUrl } from "../editor/assetUrl";
import { applyPatchesToDocument, applySlideVisibility } from "../editor/patchEngine";
import { prepareSlideDocument } from "../editor/slideDetection";
import {
  DEFAULT_SLIDE_FRAME_SIZE,
  readSlideFrameSize,
  sameSlideFrameSize,
  type SlideFrameSize
} from "../editor/slideFrame";
import {
  DEFAULT_PRESENTATION_COLOR,
  laserOpacity,
  visiblePresentationStrokes,
  type PresentationInkState,
  type PresentationInkStroke
} from "../presentationInk";
import type { Overlay, Patch } from "../types/patches";
import type { PresentationColor, PresentationDrawEvent, PresentationTool } from "../types/presenter";

type SlidePreviewFrameProps = {
  sourceHtml: string;
  sourceBaseHref?: string;
  patches: Patch[];
  overlays: Overlay[];
  slideId: string | null;
  className?: string;
  title: string;
  interactionLayer?: ReactNode;
  onInteractionPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onInteractionPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onInteractionPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  presentationInk?: PresentationInkState;
  presentationTool?: PresentationTool;
  presentationColor?: PresentationColor;
  onPresentationDraw?: (event: PresentationDrawEvent) => void;
};

export function SlidePreviewFrame({
  sourceHtml,
  sourceBaseHref,
  patches,
  overlays,
  slideId,
  className,
  title,
  interactionLayer,
  onInteractionPointerDown,
  onInteractionPointerMove,
  onInteractionPointerUp,
  presentationInk,
  presentationTool = "laser",
  presentationColor = DEFAULT_PRESENTATION_COLOR,
  onPresentationDraw
}: SlidePreviewFrameProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [frameSize, setFrameSize] = useState<SlideFrameSize>(() => ({ ...DEFAULT_SLIDE_FRAME_SIZE }));
  const [inkNow, setInkNow] = useState(() => Date.now());
  const activeStrokeRef = useRef<{
    pointerId: number;
    strokeId: string;
    slideId: string;
    tool: PresentationTool;
    color: PresentationColor;
    x: number;
    y: number;
  } | null>(null);
  const prepared = useMemo(() => prepareSlideDocument(sourceHtml, sourceBaseHref), [sourceBaseHref, sourceHtml]);
  const effectiveSlideId = slideId ?? prepared.slides[0]?.id ?? null;
  const visibleOverlays = useMemo(
    () => overlays.filter((overlay) => !overlay.hidden && (!effectiveSlideId || !overlay.slideId || overlay.slideId === effectiveSlideId)),
    [effectiveSlideId, overlays]
  );
  const visibleInk = useMemo(
    () => effectiveSlideId && presentationInk ? visiblePresentationStrokes(presentationInk, effectiveSlideId, inkNow) : [],
    [effectiveSlideId, inkNow, presentationInk]
  );

  useEffect(() => {
    if (!visibleInk.some((stroke) => stroke.tool === "laser")) return undefined;
    const timer = window.setInterval(() => setInkNow(Date.now()), 80);
    return () => window.clearInterval(timer);
  }, [visibleInk]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateScale = (): void => {
      const rect = viewport.getBoundingClientRect();
      setScale(Math.min(rect.width / frameSize.width, rect.height / frameSize.height));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [frameSize.height, frameSize.width]);

  const applyRuntimeState = useCallback(() => {
    const document = iframeRef.current?.contentDocument;
    if (!document) {
      return;
    }

    applyPatchesToDocument(document, patches);
    applySlideVisibility(document, effectiveSlideId, prepared.slides);
    const nextFrameSize = readSlideFrameSize(document, effectiveSlideId, prepared.slides);
    setFrameSize((current) => sameSlideFrameSize(current, nextFrameSize) ? current : nextFrameSize);
  }, [effectiveSlideId, patches, prepared.slides]);

  const emitPresentationDraw = useCallback((event: ReactPointerEvent<HTMLDivElement>, phase: PresentationDrawEvent["phase"]): void => {
    if (!onPresentationDraw || !effectiveSlideId) return;
    const active = activeStrokeRef.current;
    if (phase !== "start" && (!active || active.pointerId !== event.pointerId)) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / Math.max(1, rect.width)) * frameSize.width, 0, frameSize.width);
    const y = clamp(((event.clientY - rect.top) / Math.max(1, rect.height)) * frameSize.height, 0, frameSize.height);
    const strokeId = phase === "start" ? createStrokeId() : active?.strokeId;
    if (!strokeId) return;

    if (phase === "start") {
      activeStrokeRef.current = {
        pointerId: event.pointerId,
        strokeId,
        slideId: effectiveSlideId,
        tool: presentationTool,
        color: presentationColor,
        x,
        y
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (active) {
      active.x = x;
      active.y = y;
    }

    const stroke = activeStrokeRef.current;
    onPresentationDraw({
      slideId: stroke?.slideId ?? effectiveSlideId,
      tool: stroke?.tool ?? presentationTool,
      color: stroke?.color ?? presentationColor,
      phase,
      strokeId,
      x,
      y
    });
    setInkNow(Date.now());

    if (phase === "end") {
      activeStrokeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [effectiveSlideId, frameSize.height, frameSize.width, onPresentationDraw, presentationColor, presentationTool]);

  const finishInterruptedDraw = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = activeStrokeRef.current;
    if (!active || active.pointerId !== event.pointerId || !onPresentationDraw) return;
    activeStrokeRef.current = null;
    onPresentationDraw({
      slideId: active.slideId,
      tool: active.tool,
      color: active.color,
      phase: "end",
      strokeId: active.strokeId,
      x: active.x,
      y: active.y
    });
    setInkNow(Date.now());
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, [onPresentationDraw]);

  useEffect(() => {
    applyRuntimeState();
  }, [applyRuntimeState]);

  return (
    <div className={`slide-preview${className ? ` ${className}` : ""}`} aria-label={title}>
      <div className="slide-preview__viewport" ref={viewportRef}>
        <div
          className="slide-preview__frame"
          style={{
            width: frameSize.width * scale,
            height: frameSize.height * scale
          }}
        >
          <iframe
            ref={iframeRef}
            className="slide-preview__iframe"
            title={title}
            sandbox="allow-same-origin"
            srcDoc={prepared.html}
            onLoad={applyRuntimeState}
            style={{
              width: frameSize.width,
              height: frameSize.height,
              transform: `scale(${scale})`
            }}
          />
          {visibleOverlays.map((overlay) => (
            <div key={overlay.id} className={`slide-preview__overlay${overlay.type === "overlayImage" ? " slide-preview__overlay--image" : ""}`} style={toOverlayStyle(overlay, scale)}>
              {overlay.type === "overlayImage" ? (
                <img
                  className="slide-preview__overlay-image-content"
                  src={documentAssetUrl(sourceBaseHref, overlay.src)}
                  alt={overlay.text}
                  draggable={false}
                  style={{ objectFit: (overlay.style.objectFit ?? "contain") as CSSProperties["objectFit"], objectPosition: overlay.style.objectPosition ?? "center" }}
                />
              ) : overlay.text}
            </div>
          ))}
          {interactionLayer || presentationInk || onInteractionPointerDown || onPresentationDraw ? (
            <div
              className={`slide-preview__interaction-layer${onInteractionPointerDown || onPresentationDraw ? "" : " slide-preview__interaction-layer--passive"}`}
              onPointerDown={(event) => {
                onInteractionPointerDown?.(event);
                if (event.button === 0) emitPresentationDraw(event, "start");
              }}
              onPointerMove={(event) => {
                onInteractionPointerMove?.(event);
                if (activeStrokeRef.current?.pointerId === event.pointerId) emitPresentationDraw(event, "move");
              }}
              onPointerUp={(event) => {
                onInteractionPointerUp?.(event);
                emitPresentationDraw(event, "end");
              }}
              onPointerCancel={(event) => {
                onInteractionPointerUp?.(event);
                finishInterruptedDraw(event);
              }}
              onLostPointerCapture={finishInterruptedDraw}
            >
              {visibleInk.length > 0 ? <PresentationInkSvg strokes={visibleInk} now={inkNow} frameSize={frameSize} /> : null}
              {interactionLayer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
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

function PresentationInkSvg({
  strokes,
  now,
  frameSize
}: {
  strokes: PresentationInkStroke[];
  now: number;
  frameSize: SlideFrameSize;
}): JSX.Element {
  return (
    <svg className="presentation-ink" viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} aria-hidden="true">
      {strokes.map((stroke) => {
        const opacity = laserOpacity(stroke, now);
        const className = `presentation-ink__stroke presentation-ink__stroke--${stroke.tool}`;
        if (stroke.points.length < 2) {
          const point = stroke.points[0];
          return point ? (
            <circle
              key={stroke.id}
              className={className}
              cx={point.x}
              cy={point.y}
              r={stroke.tool === "laser" ? 8 : 4}
              style={{ fill: stroke.color }}
              opacity={opacity}
            />
          ) : null;
        }
        return <path key={stroke.id} className={className} d={strokePath(stroke)} fill="none" stroke={stroke.color} opacity={opacity} />;
      })}
    </svg>
  );
}

function strokePath(stroke: PresentationInkStroke): string {
  return stroke.points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function createStrokeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function scaleCssLength(value: string | undefined, scale: number): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && value.trim().endsWith("px") ? `${parsed * scale}px` : value;
}
