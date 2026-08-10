import { FileCode2, FolderOpen, MonitorPlay, MousePointer2, Presentation, Save } from "lucide-react";
import { useState, type DragEvent } from "react";

type WelcomeScreenProps = {
  onOpen: () => void;
  onOpenDemo: () => void;
  onDropFile: (file: File) => void;
};

export function WelcomeScreen({ onOpen, onOpenDemo, onDropFile }: WelcomeScreenProps): JSX.Element {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onDropFile(file);
  };

  return (
    <section
      className={`welcome-screen${isDragging ? " welcome-screen--dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="welcome-screen__content">
        <div className="welcome-screen__eyebrow">HTML Slide Studio</div>
        <h1>AIで作ったスライドを、手元で仕上げる。</h1>
        <p>HTMLを開き、文字や画像を直して、そのまま上書き保存・発表できます。</p>

        <div className="welcome-flow" aria-label="使い方">
          <FlowStep icon={<FileCode2 size={20} />} number="1" label="HTMLを開く" />
          <span aria-hidden="true">→</span>
          <FlowStep icon={<MousePointer2 size={20} />} number="2" label="画面で直す" />
          <span aria-hidden="true">→</span>
          <FlowStep icon={<Save size={20} />} number="3" label="上書き保存" />
          <span aria-hidden="true">→</span>
          <FlowStep icon={<MonitorPlay size={20} />} number="4" label="発表する" />
        </div>

        <div className="welcome-screen__actions">
          <button type="button" className="welcome-screen__open" onClick={onOpen}>
            <FolderOpen size={19} />HTMLファイルを開く
          </button>
          <button type="button" className="welcome-screen__demo" onClick={onOpenDemo}>
            <Presentation size={19} />デモを開く
          </button>
        </div>
        <span className="welcome-screen__drop">または、この画面へ .html / .htm をドロップ</span>
        <small>デモは編集用コピーを開くため、製品に同梱された原本は変更されません。</small>
      </div>
    </section>
  );
}

function FlowStep({ icon, number, label }: { icon: JSX.Element; number: string; label: string }): JSX.Element {
  return <div className="welcome-flow__step">{icon}<span>{number}</span><strong>{label}</strong></div>;
}
