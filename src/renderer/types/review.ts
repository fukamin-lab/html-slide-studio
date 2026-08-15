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
  selector?: string;
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
  kind: "attribute" | "srcset" | "css";
  value: string;
  label: string;
  attributeName?: string;
  slideId?: string;
  targetId?: string;
  targetLabel?: string;
  targetSource?: ReviewTarget["source"];
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
  slideId?: string;
  slideLabel?: string;
  slideIndex?: number;
  targetId?: string;
  targetLabel?: string;
  targetSource?: ReviewTarget["source"];
  recommendation: string;
};

export type ReviewSummary = {
  score: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issueCount: number;
  checkedSlideCount: number;
  checkedAt: string;
};

export type ReviewResult = {
  summary: ReviewSummary;
  issues: ReviewIssue[];
};
