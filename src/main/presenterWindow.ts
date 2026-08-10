import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import { join } from "node:path";
import { requireEditorSender } from "./editorWindowRegistry";
import { selectPresentationDisplays } from "./presentationDisplays";
import { configureWindowSecurity } from "./security";
import { isPresenterCommand, isPresenterSnapshot } from "../shared/presenterContract";
import type { PresenterSnapshot } from "../renderer/types/presenter";
import { restoreWindowPlacement, type SavedWindowPlacement } from "./windowPlacement";

let presenterWindow: BrowserWindow | null = null;
let latestPresenterState: PresenterSnapshot | null = null;
let activeEditorWindow: BrowserWindow | null = null;
let editorWindowState: SavedWindowPlacement | null = null;
let presentationEnding = false;

export function registerPresenterIpc(): void {
  ipcMain.handle("hss:open-presenter", async (event, state: unknown) => {
    const editorWindow = requireEditorSender(event.sender);
    if (!isPresenterSnapshot(state)) throw new Error("Invalid Presenter state");
    latestPresenterState = state;
    activeEditorWindow = editorWindow;

    if (!editorWindowState) {
      editorWindowState = {
        bounds: editorWindow.getBounds(),
        wasFullScreen: editorWindow.isFullScreen(),
        wasMaximized: editorWindow.isMaximized()
      };
    }

    const displays = screen.getAllDisplays();
    const topology = selectPresentationDisplays(displays, screen.getPrimaryDisplay().id);
    if (!topology.audience) {
      presentationEnding = true;
      closePresenterOnly();
      presentationEnding = false;
      prepareSingleDisplayAudience(editorWindow, editorWindowState.bounds);
      return { opened: true, displayCount: displays.length, mode: "single" as const };
    }

    try {
      editorWindow.setFullScreen(false);
      editorWindow.unmaximize();
      editorWindow.setBounds(topology.audience.bounds, false);
      editorWindow.setFullScreen(true);
      editorWindow.show();

      const window = await ensurePresenterWindow(topology.presenter.workArea);
      sendPresenterState(window);
      window.show();
      window.focus();
      return {
        opened: true,
        displayCount: displays.length,
        mode: "dual" as const,
        audienceDisplayId: topology.audience.id,
        presenterDisplayId: topology.presenter.id
      };
    } catch (error) {
      console.error("[presenter] dual-display placement failed; using audience-only mode", error);
      presentationEnding = true;
      closePresenterOnly();
      presentationEnding = false;
      prepareSingleDisplayAudience(editorWindow, editorWindowState.bounds);
      return { opened: true, displayCount: displays.length, mode: "single" as const, fallback: true };
    }
  });

  ipcMain.handle("hss:update-presenter", async (event, state: unknown) => {
    requireEditorSender(event.sender);
    if (!isPresenterSnapshot(state)) throw new Error("Invalid Presenter state");
    latestPresenterState = state;
    sendPresenterState(presenterWindow);
    return { updated: true };
  });

  ipcMain.handle("hss:end-presenter", async (event) => {
    requireEditorSender(event.sender);
    endPresentation();
    return { ended: true };
  });

  ipcMain.on("hss:presenter-ready", (event) => {
    if (!isPresenterSender(event.sender.id)) return;
    event.sender.send("hss:presenter-state", latestPresenterState);
  });

  ipcMain.on("hss:presenter-command", (event, command: unknown) => {
    if (!isPresenterSender(event.sender.id) || !isPresenterCommand(command)) return;
    if (activeEditorWindow && !activeEditorWindow.isDestroyed()) {
      activeEditorWindow.webContents.send("hss:presenter-command", command);
    }
    if (command.type === "end-presentation") endPresentation();
  });
}

export function closePresenterWindow(): void {
  presentationEnding = true;
  closePresenterOnly();
  presentationEnding = false;
  latestPresenterState = null;
  activeEditorWindow = null;
  editorWindowState = null;
}

async function ensurePresenterWindow(bounds: Rectangle): Promise<BrowserWindow> {
  if (presenterWindow && !presenterWindow.isDestroyed()) {
    presenterWindow.setBounds(bounds, false);
    return presenterWindow;
  }

  presenterWindow = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 560,
    title: "HTML Slide Studio — 発表者画面",
    backgroundColor: "#171717",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/presenter.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  presenterWindow.setMenu(null);
  configureWindowSecurity(presenterWindow);
  attachPresenterDiagnostics(presenterWindow);
  presenterWindow.on("closed", () => {
    presenterWindow = null;
    if (!presentationEnding) {
      if (activeEditorWindow && !activeEditorWindow.isDestroyed()) {
        activeEditorWindow.webContents.send("hss:presenter-command", { type: "end-presentation" });
      }
      restoreEditorWindow();
      latestPresenterState = null;
      activeEditorWindow = null;
      editorWindowState = null;
    }
  });
  await loadPresenterRoute(presenterWindow);
  return presenterWindow;
}

function endPresentation(): void {
  presentationEnding = true;
  closePresenterOnly();
  restoreEditorWindow();
  presentationEnding = false;
  latestPresenterState = null;
  activeEditorWindow = null;
  editorWindowState = null;
}

function restoreEditorWindow(): void {
  const window = activeEditorWindow;
  if (!window || window.isDestroyed() || !editorWindowState) return;
  try {
    restoreWindowPlacement(window, editorWindowState);
  } catch (error) {
    console.error("[presenter] editor window restoration encountered an error", error);
  }
}

function closePresenterOnly(): void {
  if (presenterWindow && !presenterWindow.isDestroyed()) presenterWindow.close();
  presenterWindow = null;
}

async function loadPresenterRoute(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    await window.loadURL(`${devServerUrl}?view=presenter`);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"), { query: { view: "presenter" } });
  }
}

function prepareSingleDisplayAudience(window: BrowserWindow, originalBounds: Rectangle): void {
  window.setFullScreen(false);
  window.unmaximize();
  window.setBounds(originalBounds, false);
  window.setFullScreen(true);
  window.show();
  window.focus();
}

function isPresenterSender(webContentsId: number): boolean {
  return Boolean(presenterWindow && !presenterWindow.isDestroyed() && !presenterWindow.webContents.isDestroyed() && presenterWindow.webContents.id === webContentsId);
}

function sendPresenterState(window: BrowserWindow | null): void {
  if (window && !window.isDestroyed()) window.webContents.send("hss:presenter-state", latestPresenterState);
}

function attachPresenterDiagnostics(window: BrowserWindow): void {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error("[renderer:presenter] load failed", { errorCode, errorDescription, validatedUrl });
  });
  window.webContents.on("render-process-gone", (_event, details) => console.error("[renderer:presenter] process gone", details));
  window.webContents.on("preload-error", (_event, preloadPath, error) => console.error("[renderer:presenter] preload failed", { preloadPath, error }));
}
