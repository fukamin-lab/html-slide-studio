export type ReviewSeverity = "error" | "warning" | "info";

export type ReviewIssueKind =
  | "text-overflow"
  | "off-slide"
  | "small-text"
  | "broken-image"
  | "external-reference"
  | "source-compatibility"
  | "patch-warning";

export type ReviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ReviewTarget = {
  id: string;
  source: "dom" | "overlay";
  type: "text" | "image" | "shape" | "unknown";
  label: string;
  tagName?: string;
  slideId: string | null;
  text?: string;
  bounds: ReviewBounds;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  lineHeight?: number;
  textClipped?: boolean;
  imageSource?: string;
  imageBroken?: boolean;
  locked?: boolean;
  hidden?: boolean;
};

export type ReviewExternalReference = {
  kind: "src" | "href";
  value: string;
  label: string;
};

export type ReviewSnapshot = {
  checkedAt: string;
  slideId: string | null;
  slideLabel: string;
  slides: import("./project").SlideDescriptor[];
  slideBounds: ReviewBounds;
  targets: ReviewTarget[];
  externalReferences: ReviewExternalReference[];
};

export type ReviewIssue = {
  id: string;
  severity: ReviewSeverity;
  kind: ReviewIssueKind;
  title: string;
  detail: string;
  targetId?: string;
  targetLabel?: string;
  recommendation: string;
};

export type ReviewSummary = {
  score: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issueCount: number;
  checkedAt: string;
};

export type ReviewResult = {
  summary: ReviewSummary;
  issues: ReviewIssue[];
};
