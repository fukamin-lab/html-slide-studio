import type { PatchManifest } from "../types/patches";
import type { ReviewIssue, ReviewResult, ReviewSnapshot, ReviewTarget } from "../types/review";

const MIN_PRESENTATION_TEXT_SIZE = 12;

export function buildReviewResult(snapshot: ReviewSnapshot | null, manifest: PatchManifest): ReviewResult {
  const issues = snapshot ? inspectSnapshot(snapshot, manifest) : [notReadyIssue()];
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
      checkedAt: snapshot?.checkedAt ?? new Date().toISOString()
    },
    issues
  };
}

function inspectSnapshot(snapshot: ReviewSnapshot, manifest: PatchManifest): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const target of snapshot.targets.filter((candidate) => !candidate.hidden)) {
    if (target.textClipped) issues.push(textClippedIssue(target));
    if (outsideSlide(target, snapshot)) issues.push(outsideSlideIssue(target));
    if (target.type === "image" && target.imageBroken) issues.push(brokenImageIssue(target));
    if ((target.fontSize ?? 0) > 0 && (target.fontSize ?? 0) < MIN_PRESENTATION_TEXT_SIZE && Boolean(target.text?.trim())) {
      issues.push(smallTextIssue(target));
    }
  }

  for (const reference of snapshot.externalReferences) {
    issues.push({
      id: issueId("external", reference.value),
      severity: "warning",
      kind: "external-reference",
      title: "External reference",
      detail: `${reference.label} depends on ${reference.value}.`,
      recommendation: "Keep required files beside the HTML so the presentation also works offline."
    });
  }

  if (snapshot.slides.length === 0) {
    issues.push({
      id: "source-no-slides",
      severity: "error",
      kind: "source-compatibility",
      title: "No slide structure",
      detail: "No supported top-level slide sections were found.",
      recommendation: "Use sibling section.slide elements or direct Reveal .slides children."
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

function textClippedIssue(target: ReviewTarget): ReviewIssue {
  return {
    id: issueId("text-clipped", target.id),
    severity: "error",
    kind: "text-overflow",
    title: "Text may be clipped",
    detail: `${target.label} appears larger than its box.`,
    targetId: target.id,
    targetLabel: target.label,
    recommendation: "Increase the box size, reduce the font size, or shorten the text."
  };
}

function outsideSlideIssue(target: ReviewTarget): ReviewIssue {
  return {
    id: issueId("outside", target.id),
    severity: "error",
    kind: "off-slide",
    title: "Object is outside the slide",
    detail: `${target.label} extends beyond the visible slide.`,
    targetId: target.id,
    targetLabel: target.label,
    recommendation: "Move or resize the object so it stays inside the slide."
  };
}

function brokenImageIssue(target: ReviewTarget): ReviewIssue {
  return {
    id: issueId("broken-image", target.id),
    severity: "error",
    kind: "broken-image",
    title: "Image did not load",
    detail: `${target.label} points to a missing or unreadable image.`,
    targetId: target.id,
    targetLabel: target.label,
    recommendation: "Replace the image or restore the missing file."
  };
}

function smallTextIssue(target: ReviewTarget): ReviewIssue {
  return {
    id: issueId("small-text", target.id),
    severity: "warning",
    kind: "small-text",
    title: "Text may be too small",
    detail: `${target.label} uses ${Math.round(target.fontSize ?? 0)}px text.`,
    targetId: target.id,
    targetLabel: target.label,
    recommendation: "Use a larger font size for presentation readability."
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
    detail: "The current slide has not been measured yet.",
    recommendation: "Wait a moment and run the check again."
  };
}

function issueId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80)}`;
}

function dedupe(issues: ReviewIssue[]): ReviewIssue[] {
  return [...new Map(issues.map((issue) => [issue.id, issue])).values()];
}
