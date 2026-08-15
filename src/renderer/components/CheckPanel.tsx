import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { ReviewIssue, ReviewResult } from "../types/review";

type CheckPanelProps = {
  result: ReviewResult;
  isReviewing: boolean;
  onSelectIssue: (issue: ReviewIssue) => void;
  onClose: () => void;
};

export function CheckPanel({ result, isReviewing, onSelectIssue, onClose }: CheckPanelProps): JSX.Element {
  const blockingIssues = result.issues.filter((issue) => issue.severity !== "info");
  return (
    <aside className="check-panel" aria-label="発表前の確認">
      <div className="check-panel__heading">
        <div>
          <strong>発表前の確認</strong>
          <span>{isReviewing
            ? "全スライドを確認しています…"
            : blockingIssues.length === 0
              ? `全${result.summary.checkedSlideCount}枚に大きな問題は見つかりませんでした`
              : `全${result.summary.checkedSlideCount}枚で${blockingIssues.length}件を確認してください`}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="閉じる"><X size={16} /></button>
      </div>
      <div className="check-panel__body">
        {isReviewing ? (
          <div className="check-panel__empty" role="status"><Info size={22} /><span>各スライドの文字・画像・配置を確認しています。</span></div>
        ) : result.issues.length === 0 ? (
          <div className="check-panel__empty"><CheckCircle2 size={22} /><span>全スライドを発表できる状態です。</span></div>
        ) : result.issues.map((issue) => (
          <button
            type="button"
            key={issue.id}
            className={`check-issue check-issue--${issue.severity}`}
            onClick={() => onSelectIssue(issue)}
            disabled={!issue.targetId}
          >
            <IssueIcon severity={issue.severity} />
            <span><strong>{translateTitle(issue)}</strong><small>{translateDetail(issue)}</small></span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function IssueIcon({ severity }: { severity: ReviewIssue["severity"] }): JSX.Element {
  if (severity === "error") return <AlertCircle size={17} />;
  if (severity === "warning") return <AlertTriangle size={17} />;
  return <Info size={17} />;
}

function translateTitle(issue: ReviewIssue): string {
  const titles: Partial<Record<ReviewIssue["kind"], string>> = {
    "text-overflow": "文字が枠からはみ出している可能性があります",
    "off-slide": "要素がスライドの外にはみ出しています",
    "small-text": "文字が小さすぎる可能性があります",
    "broken-image": "画像を読み込めません",
    "external-reference": "外部ファイルに依存しています",
    "source-compatibility": "スライド構造を確認してください",
    "patch-warning": "編集内容を確認してください"
  };
  return titles[issue.kind] ?? issue.title;
}

function translateDetail(issue: ReviewIssue): string {
  const slide = issue.slideLabel
    ? `${typeof issue.slideIndex === "number" ? `${issue.slideIndex + 1}. ` : ""}${issue.slideLabel}`
    : null;
  const target = issue.targetLabel ? `${issue.targetLabel} — ${issue.detail}` : issue.detail;
  return slide ? `${slide} / ${target}` : target;
}
