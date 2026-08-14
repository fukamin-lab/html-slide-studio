export type TextOverflowMetrics = {
  overflowX: string;
  overflowY: string;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

export function isClippedTextOverflow(metrics: TextOverflowMetrics, tolerance = 2): boolean {
  const clipsHorizontally = metrics.overflowX !== "visible" && metrics.scrollWidth > metrics.clientWidth + tolerance;
  const clipsVertically = metrics.overflowY !== "visible" && metrics.scrollHeight > metrics.clientHeight + tolerance;
  return clipsHorizontally || clipsVertically;
}
