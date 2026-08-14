import { AlignCenter, AlignLeft, AlignRight, Image, Trash2 } from "lucide-react";
import type { EditableStyle } from "../types/patches";
import type { SelectedElement } from "../types/selection";

type SimpleInspectorProps = {
  selectedElement: SelectedElement | null;
  selectedCount: number;
  onTextChange: (text: string) => void;
  onStyleChange: (style: EditableStyle) => void;
  onReplaceImage: () => void;
  onDelete: () => void;
};

export function SimpleInspector({
  selectedElement,
  selectedCount,
  onTextChange,
  onStyleChange,
  onReplaceImage,
  onDelete
}: SimpleInspectorProps): JSX.Element {
  if (!selectedElement) {
    return (
      <aside className="simple-inspector" aria-label="選択した要素の設定">
        <div className="simple-inspector__heading">書式</div>
        <div className="simple-inspector__empty">
          <strong>要素を選択</strong>
          <p>スライド上の文字や画像をクリックすると、ここで内容と見た目を調整できます。</p>
        </div>
      </aside>
    );
  }

  const style = selectedElement.computedStyle;
  const fontSize = Math.max(1, Number.parseInt(style.fontSize ?? "16", 10) || 16);
  const canEditText = selectedCount === 1 && selectedElement.canEditTextDirectly && !selectedElement.locked;
  const isImage = Boolean(selectedElement.imageSource);

  return (
    <aside className="simple-inspector" aria-label="選択した要素の設定">
      <div className="simple-inspector__heading">
        <span>{selectedCount > 1 ? `${selectedCount}個を選択` : elementLabel(selectedElement)}</span>
        <button type="button" className="simple-inspector__delete" onClick={onDelete} title="削除" aria-label="削除">
          <Trash2 size={15} />
        </button>
      </div>

      {canEditText ? (
        <section className="simple-inspector__section">
          <label htmlFor="inspector-text">テキスト</label>
          <textarea id="inspector-text" rows={5} value={selectedElement.textContent} onChange={(event) => onTextChange(event.currentTarget.value)} />
        </section>
      ) : null}

      <section className="simple-inspector__section">
        <span className="simple-inspector__label">文字</span>
        <div className="simple-inspector__row">
          <select value={style.fontFamily ?? "Arial, sans-serif"} onChange={(event) => onStyleChange({ fontFamily: event.currentTarget.value })} aria-label="フォント">
            <option value='Arial, "Noto Sans JP", sans-serif'>Arial / Noto Sans</option>
            <option value='"Meiryo UI", Meiryo, sans-serif'>Meiryo UI</option>
            <option value='"Yu Gothic", Meiryo, sans-serif'>游ゴシック</option>
            <option value='Georgia, "Times New Roman", serif'>Georgia</option>
            <option value='"Courier New", monospace'>Courier</option>
          </select>
          <input
            type="number"
            min="6"
            max="240"
            value={fontSize}
            aria-label="文字サイズ"
            onChange={(event) => onStyleChange({ fontSize: `${event.currentTarget.valueAsNumber || 16}px` })}
          />
        </div>
        <div className="simple-inspector__row simple-inspector__row--compact">
          <button
            type="button"
            className={style.fontWeight === "700" || style.fontWeight === "bold" ? "is-active" : ""}
            onClick={() => onStyleChange({ fontWeight: style.fontWeight === "700" || style.fontWeight === "bold" ? "400" : "700" })}
            aria-label="太字"
          >
            <strong>B</strong>
          </button>
          <button type="button" className={style.textAlign === "left" ? "is-active" : ""} onClick={() => onStyleChange({ textAlign: "left" })} aria-label="左揃え"><AlignLeft size={16} /></button>
          <button type="button" className={style.textAlign === "center" ? "is-active" : ""} onClick={() => onStyleChange({ textAlign: "center" })} aria-label="中央揃え"><AlignCenter size={16} /></button>
          <button type="button" className={style.textAlign === "right" ? "is-active" : ""} onClick={() => onStyleChange({ textAlign: "right" })} aria-label="右揃え"><AlignRight size={16} /></button>
        </div>
        <div className="simple-inspector__colors">
          <label>文字色<input type="color" value={toColor(style.color, "#202124")} onChange={(event) => onStyleChange({ color: event.currentTarget.value })} /></label>
          <label>背景色<input type="color" value={toColor(style.backgroundColor, "#ffffff")} onChange={(event) => onStyleChange({ backgroundColor: event.currentTarget.value })} /></label>
        </div>
      </section>

      <section className="simple-inspector__section">
        <span className="simple-inspector__label">サイズ</span>
        <div className="simple-inspector__row">
          <label>幅<input type="number" min="8" value={Math.round(selectedElement.bbox.width)} onChange={(event) => onStyleChange({ width: `${event.currentTarget.valueAsNumber || 8}px` })} /></label>
          <label>高さ<input type="number" min="8" value={Math.round(selectedElement.bbox.height)} onChange={(event) => onStyleChange({ height: `${event.currentTarget.valueAsNumber || 8}px` })} /></label>
        </div>
      </section>

      {isImage ? (
        <section className="simple-inspector__section">
          <button type="button" className="simple-inspector__replace" onClick={onReplaceImage}>
            <Image size={16} />画像を差し替える
          </button>
          <select value={style.objectFit ?? "contain"} onChange={(event) => onStyleChange({ objectFit: event.currentTarget.value })} aria-label="画像の表示方法">
            <option value="contain">全体を表示</option>
            <option value="cover">枠に合わせて切り抜く</option>
            <option value="fill">枠いっぱいに伸ばす</option>
          </select>
        </section>
      ) : null}
    </aside>
  );
}

function elementLabel(element: SelectedElement): string {
  if (element.imageSource) return "画像";
  if (element.canEditTextDirectly) return "テキスト";
  return element.tagName.toUpperCase();
}

function toColor(value: string | undefined, fallback: string): string {
  if (value?.match(/^#[0-9a-f]{6}$/i)) return value;
  const rgb = value?.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!rgb) return fallback;
  return `#${[rgb[1], rgb[2], rgb[3]].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
}
