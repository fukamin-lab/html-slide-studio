import type { PatchManifest } from "../types/patches";
import type { ReviewIssue, ReviewResult, ReviewSnapshot, ReviewTarget } from "../types/review";

const MIN_PRESENTATION_TEXT_SIZE = 12;

export function buildReviewResult(snapshots: ReviewSnapshot[] | null, manifest: PatchManifest): ReviewResult {
  const issues = snapshots ? inspectSnapshots(snapshots, manifest) : [notReadyIssue()];
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;
  return {
    summary: {
      score: Math.max(0, 100 - errorCount * 25 - warningCount * 8),
      errorCount,
      warningCount,
      infoCount,
      issueCount: issues.length,
      checkedSlideCount: snapshots?.filter((snapshot) => Boolean(snapshot.slideId)).length ?? 0,
      checkedAt: snapshots?.[0]?.checkedAt ?? new Date().toISOString()
    },
    issues
  };
}

function inspectSnapshots(snapshots: ReviewSnapshot[], manifest: PatchManifest): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const snapshot of snapshots) {
    for (const target of snapshot.targets.filter((candidate) => !candidate.hidden)) {
      if (target.textClipped) issues.push(textClippedIssue(target, snapshot));
      if (outsideSlide(target, snapshot)) issues.push(outsideSlideIssue(target, snapshot));
      if (target.type === "image" && target.imageBroken) issues.push(brokenImageIssue(target, snapshot));
      if ((target.fontSize ?? 0) > 0 && (target.fontSize ?? 0) < MIN_PRESENTATION_TEXT_SIZE && Boolean(target.text?.trim())) {
        issues.push(smallTextIssue(target, snapshot));
      }
    }

    for (const reference of snapshot.externalReferences) {
      issues.push({
        id: issueId("external", `${reference.slideId ?? "document"}-${reference.targetId ?? "global"}-${reference.value}`),
        severity: "warning",
        kind: "external-reference",
        title: "External reference",
        detail: `${reference.label}${reference.attributeName ? ` の ${reference.attributeName}` : ""} は ${reference.value} に依存しています。`,
        slideId: reference.slideId,
        slideLabel: reference.slideId ? snapshot.slideLabel : undefined,
        slideIndex: reference.slideId ? snapshot.slides.findIndex((slide) => slide.id === reference.slideId) : undefined,
        targetId: reference.targetId,
        targetLabel: reference.targetLabel,
        targetSource: reference.targetSource,
        recommendation: "オフラインでも発表できるよう、必要なファイルをHTMLと一緒に保持してください。"
      });
    }
  }

  if (snapshots.length === 0 || snapshots[0]?.slides.length === 0) {
    issues.push({
      id: "source-no-slides",
      severity: "error",
      kind: "source-compatibility",
      title: "No slide structure",
      detail: "対応する最上位のスライド構造を見つけられませんでした。",
      recommendation: "section.slideの兄弟要素またはRevealの.slides直下のsectionを使用してください。"
    });
  }

  for (const warning of manifest.warnings) {
    issues.push({
      id: issueId("document-warning", warning.id),
      severity: warning.severity,
      kind: "patch-warning",
      title: "Document warning",
      detail: warning.message,
      recommendation: "Review the warning before presenting."
    });
  }
  return dedupe(issues);
}

function textClippedIssue(target: ReviewTarget, snapshot: ReviewSnapshot): ReviewIssue {
  return {
    id: issueId("text-clipped", `${snapshot.slideId}-${target.id}`),
    severity: "error",
    kind: "text-overflow",
    title: "Text may be clipped",
    detail: `${target.label} が指定枠より大きく表示されています。`,
    ...issueTarget(target, snapshot),
    recommendation: "枠を広げる、文字を小さくする、または文章を短くしてください。"
  };
}

function outsideSlideIssue(target: ReviewTarget, snapshot: ReviewSnapshot): ReviewIssue {
  return {
    id: issueId("outside", `${snapshot.slideId}-${target.id}`),
    severity: "error",
    kind: "off-slide",
    title: "Object is outside the slide",
    detail: `${target.label} が表示範囲の外にはみ出しています。`,
    ...issueTarget(target, snapshot),
    recommendation: "要素を移動または縮小し、スライド内へ収めてください。"
  };
}

function brokenImageIssue(target: ReviewTarget, snapshot: ReviewSnapshot): ReviewIssue {
  return {
    id: issueId("broken-image", `${snapshot.slideId}-${target.id}`),
    severity: "error",
    kind: "broken-image",
    title: "Image did not load",
    detail: `${target.label} の画像を読み込めませんでした。`,
    ...issueTarget(target, snapshot),
    recommendation: "画像を差し替えるか、不足しているファイルを元の場所へ戻してください。"
  };
}

function smallTextIssue(target: ReviewTarget, snapshot: ReviewSnapshot): ReviewIssue {
  return {
    id: issueId("small-text", `${snapshot.slideId}-${target.id}`),
    severity: "warning",
    kind: "small-text",
    title: "Text may be too small",
    detail: `${target.label} の文字サイズは ${Math.round(target.fontSize ?? 0)}pxです。`,
    ...issueTarget(target, snapshot),
    recommendation: "発表時に読めるよう、文字を大きくしてください。"
  };
}

function issueTarget(target: ReviewTarget, snapshot: ReviewSnapshot): Pick<ReviewIssue, "slideId" | "slideLabel" | "slideIndex" | "targetId" | "targetLabel" | "targetSource"> {
  const slideIndex = snapshot.slides.findIndex((slide) => slide.id === snapshot.slideId);
  return {
    slideId: snapshot.slideId ?? undefined,
    slideLabel: snapshot.slideLabel,
    slideIndex: slideIndex >= 0 ? slideIndex : undefined,
    targetId: target.id,
    targetLabel: target.label,
    targetSource: target.source
  };
}

function outsideSlide(target: ReviewTarget, snapshot: ReviewSnapshot): boolean {
  const bounds = target.bounds;
  const slide = snapshot.slideBounds;
  return bounds.x < slide.x - 1 || bounds.y < slide.y - 1 || bounds.x + bounds.width > slide.x + slide.width + 1 || bounds.y + bounds.height > slide.y + slide.height + 1;
}

function notReadyIssue(): ReviewIssue {
  return {
    id: "check-not-ready",
    severity: "info",
    kind: "source-compatibility",
    title: "Canvas is preparing",
    detail: "スライドをまだ測定していません。",
    recommendation: "少し待ってから、もう一度確認してください。"
  };
}

function issueId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80)}`;
}

function dedupe(issues: ReviewIssue[]): ReviewIssue[] {
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()];
}
