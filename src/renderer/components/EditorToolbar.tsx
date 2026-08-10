import { FilePlus2, ImagePlus, MonitorPlay, Redo2, Save, ScanSearch, Type, Undo2 } from "lucide-react";

type EditorToolbarProps = {
  documentName: string;
  isDirty: boolean;
  isSaving: boolean;
  isOpening: boolean;
  canUndo: boolean;
  canRedo: boolean;
  checkIssueCount: number;
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddText: () => void;
  onAddImage: () => void;
  onCheck: () => void;
  onPresent: () => void;
};

export function EditorToolbar({
  documentName,
  isDirty,
  isSaving,
  isOpening,
  canUndo,
  canRedo,
  checkIssueCount,
  onOpen,
  onSave,
  onUndo,
  onRedo,
  onAddText,
  onAddImage,
  onCheck,
  onPresent
}: EditorToolbarProps): JSX.Element {
  return (
    <header className="editor-toolbar">
      <div className="editor-toolbar__document" title={documentName}>
        <span className="editor-toolbar__mark" aria-hidden="true">H</span>
        <div>
          <strong>{documentName}</strong>
          <span>{isSaving ? "保存しています…" : isOpening ? "開いています…" : isDirty ? "未保存の変更" : "保存済み"}</span>
        </div>
      </div>

      <div className="editor-toolbar__group" aria-label="ファイル">
        <ToolbarButton icon={<FilePlus2 size={17} />} label="開く" onClick={onOpen} disabled={isSaving || isOpening} />
        <ToolbarButton icon={<Save size={17} />} label={isSaving ? "保存中" : "保存"} onClick={onSave} primary disabled={!isDirty || isSaving || isOpening} />
      </div>

      <div className="editor-toolbar__group" aria-label="編集履歴">
        <ToolbarButton icon={<Undo2 size={17} />} label="元に戻す" onClick={onUndo} compact disabled={!canUndo} />
        <ToolbarButton icon={<Redo2 size={17} />} label="やり直す" onClick={onRedo} compact disabled={!canRedo} />
      </div>

      <div className="editor-toolbar__group" aria-label="追加">
        <ToolbarButton icon={<Type size={17} />} label="テキスト" onClick={onAddText} />
        <ToolbarButton icon={<ImagePlus size={17} />} label="画像" onClick={onAddImage} />
      </div>

      <div className="editor-toolbar__spacer" />

      <div className="editor-toolbar__group" aria-label="確認と発表">
        <ToolbarButton
          icon={<ScanSearch size={17} />}
          label={checkIssueCount > 0 ? `確認 ${checkIssueCount}` : "確認"}
          onClick={onCheck}
        />
        <ToolbarButton icon={<MonitorPlay size={17} />} label="発表" onClick={onPresent} primary />
      </div>
    </header>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  compact = false,
  primary = false,
  disabled = false
}: {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  compact?: boolean;
  primary?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`editor-toolbar__button${compact ? " editor-toolbar__button--compact" : ""}${primary ? " editor-toolbar__button--primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {icon}
      {compact ? null : <span>{label}</span>}
    </button>
  );
}
