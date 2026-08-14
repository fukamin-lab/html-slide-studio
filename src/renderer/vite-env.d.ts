/// <reference types="vite/client" />

import type { PresenterCommand, PresenterSnapshot } from "./types/presenter";

type OpenHtmlDocumentResult =
  | { canceled: true }
  | {
      canceled: false;
      html: string;
      filePath: string;
      sourceBaseUrl: string;
      fingerprint: string;
      warnings: string[];
    };

type SaveHtmlDocumentResult =
  | { canceled: true }
  | {
      canceled: false;
      filePath: string;
      fingerprint: string;
      bytes: number;
      warnings: string[];
    };

type ImportDocumentImageResult =
  | { canceled: true }
  | {
      canceled: false;
      relativePath: string;
      fileUrl: string;
      bytes: number;
    };

type PresenterOpenResult = { opened: true; displayCount: number; mode: "single" | "dual"; fallback?: boolean };
type PresenterUpdateResult = { updated: true };
type Unsubscribe = () => void;

declare global {
  interface Window {
    hss: {
      openHtmlDocument: () => Promise<OpenHtmlDocumentResult>;
      openDemoDocument: () => Promise<OpenHtmlDocumentResult>;
      openHtmlPath: (filePath: string) => Promise<OpenHtmlDocumentResult>;
      consumeLaunchHtml: () => Promise<OpenHtmlDocumentResult>;
      saveHtmlDocument: (payload: { html: string; filePath: string; expectedFingerprint: string; expectedSlideCount: number }) => Promise<SaveHtmlDocumentResult>;
      importDocumentImage: (filePath: string) => Promise<ImportDocumentImageResult>;
      openPresenter: (state: PresenterSnapshot) => Promise<PresenterOpenResult>;
      updatePresenter: (state: PresenterSnapshot) => Promise<PresenterUpdateResult>;
      endPresenter: () => Promise<{ ended: true }>;
      onPresenterCommand: (callback: (command: PresenterCommand) => void) => Unsubscribe;
      onLaunchHtmlFile: (callback: () => void) => Unsubscribe;
      getFilePath: (file: File) => string;
    };
    hssPresenter: {
      presenterReady: () => void;
      sendPresenterCommand: (command: PresenterCommand) => void;
      onPresenterState: (callback: (state: PresenterSnapshot | null) => void) => Unsubscribe;
    };
  }
}
