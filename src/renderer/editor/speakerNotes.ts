import { detectSlideStructure } from "./slideStructure";

export type SpeakerNotesEstimate = {
  characters: number;
  words: number;
  seconds: number;
};

export function estimateSpeakerNotes(notes: string): SpeakerNotesEstimate {
  const text = normalizeSpeakerNotes(notes).trim();
  if (!text) {
    return { characters: 0, words: 0, seconds: 0 };
  }

  const japaneseCharacters = (text.match(/[\u3040-\u30ff\u3400-\u9fffー々〆〤]/g) ?? []).length;
  const latinText = text.replace(/[\u3040-\u30ff\u3400-\u9fffー々〆〤]/g, " ").trim();
  const words = latinText ? latinText.split(/\s+/).filter(Boolean).length : 0;
  const otherCharacters = text.replace(/\s/g, "").length - japaneseCharacters;

  const japaneseMinutes = japaneseCharacters / 300;
  const latinMinutes = words / 140;
  const fallbackMinutes = words > 0 ? 0 : Math.max(0, otherCharacters) / 550;
  const seconds = Math.max(5, Math.ceil((japaneseMinutes + latinMinutes + fallbackMinutes) * 60));

  return {
    characters: text.replace(/\s/g, "").length,
    words,
    seconds
  };
}

export function formatSpeakerNotesDuration(seconds: number): string {
  if (seconds <= 0) {
    return "0:00";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function updateSpeakerNotesInHtml(sourceHtml: string, slideIndex: number, notes: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sourceHtml, "text/html");
  const slides = findSlideNodes(doc);
  const slide = slides[Math.max(0, slideIndex)] ?? slides[0] ?? doc.body;
  const normalizedNotes = normalizeSpeakerNotes(notes);
  slide.setAttribute("data-speaker-notes", normalizedNotes);
  return serializeHtmlDocument(doc);
}

function normalizeSpeakerNotes(notes: string): string {
  return notes.replace(/\r\n?/g, "\n");
}

function findSlideNodes(doc: Document): Element[] {
  return detectSlideStructure(doc)?.nodes ?? [];
}

function serializeHtmlDocument(doc: Document): string {
  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : "";
  return `${doctype}${doc.documentElement.outerHTML}`;
}
