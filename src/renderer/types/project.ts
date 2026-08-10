export type SlideDescriptor = {
  id: string;
  label: string;
  selector: string;
  index: number;
  speakerNotes?: string;
  hasDataLabel?: boolean;
  hasSpeakerNotes?: boolean;
  tagName?: string;
  className?: string;
  width?: number;
  height?: number;
};
