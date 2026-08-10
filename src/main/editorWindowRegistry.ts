import type { BrowserWindow, WebContents } from "electron";

let editorWindow: BrowserWindow | null = null;

export function registerEditorWindow(window: BrowserWindow): void {
  editorWindow = window;
  window.once("closed", () => {
    if (editorWindow === window) editorWindow = null;
  });
}

export function isEditorSender(sender: WebContents): boolean {
  return Boolean(editorWindow && !editorWindow.isDestroyed() && !editorWindow.webContents.isDestroyed() && editorWindow.webContents === sender);
}

export function requireEditorSender(sender: WebContents): BrowserWindow {
  if (!isEditorSender(sender) || !editorWindow) throw new Error("IPC request did not originate from the editor window");
  return editorWindow;
}

export function getEditorWindow(): BrowserWindow | null {
  return editorWindow && !editorWindow.isDestroyed() ? editorWindow : null;
}
