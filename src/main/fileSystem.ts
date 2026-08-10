import { app, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import {
  importImageForDocument,
  openHtmlDocument,
  saveHtmlDocument,
  type SaveHtmlDocumentPayload
} from "./documentFiles";
import { takePendingLaunchHtmlPath } from "./launchFiles";
import { requireEditorSender } from "./editorWindowRegistry";
import { withDocumentSaveLock } from "./documentSaveMutex";
import { DEMO_FILE_NAME, ensureDemoWorkingCopy } from "./demoDocument";

const authorizedDocuments = new Set<string>();

export function registerFileSystemIpc(): void {
  ipcMain.handle("hss:open-html-document", async (event) => {
    const owner = requireEditorSender(event.sender);
    const options = {
      title: "HTMLスライドを開く",
      properties: ["openFile"],
      filters: [
        { name: "HTML", extensions: ["html", "htm"] },
        { name: "すべてのファイル", extensions: ["*"] }
      ]
    } satisfies Electron.OpenDialogOptions;
    const result = await dialog.showOpenDialog(owner, options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return authorizeOpenedDocument(result.filePaths[0]);
  });

  ipcMain.handle("hss:open-html-path", async (event, payload: unknown) => {
    requireEditorSender(event.sender);
    if (!isPathPayload(payload)) {
      throw new Error("Invalid HTML open request");
    }
    return authorizeOpenedDocument(payload.filePath);
  });

  ipcMain.handle("hss:open-demo-document", async (event) => {
    requireEditorSender(event.sender);
    const templatePath = join(__dirname, "../../demo", DEMO_FILE_NAME);
    const workingPath = await ensureDemoWorkingCopy(templatePath, app.getPath("userData"));
    return authorizeOpenedDocument(workingPath);
  });

  ipcMain.handle("hss:consume-launch-html", async (event) => {
    requireEditorSender(event.sender);
    const filePath = takePendingLaunchHtmlPath();
    return filePath ? authorizeOpenedDocument(filePath) : { canceled: true };
  });

  ipcMain.handle("hss:save-html-document", async (event, payload: unknown) => {
    requireEditorSender(event.sender);
    if (!isSavePayload(payload)) {
      throw new Error("Invalid HTML save request");
    }
    const filePath = resolve(payload.filePath);
    if (!authorizedDocuments.has(filePath)) {
      throw new Error("Save is allowed only for an HTML file opened by this app session");
    }
    return withDocumentSaveLock(filePath, async () => ({ canceled: false, ...(await saveHtmlDocument({ ...payload, filePath })) }));
  });

  ipcMain.handle("hss:import-document-image", async (event, payload: unknown) => {
    const owner = requireEditorSender(event.sender);
    if (!isPathPayload(payload)) {
      throw new Error("Invalid image import request");
    }
    const htmlPath = resolve(payload.filePath);
    if (!authorizedDocuments.has(htmlPath)) {
      throw new Error("Images can be added only to an HTML file opened by this app session");
    }

    const options = {
      title: "画像を追加",
      properties: ["openFile"],
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }]
    } satisfies Electron.OpenDialogOptions;
    const result = await dialog.showOpenDialog(owner, options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return withDocumentSaveLock(htmlPath, async () => ({
      canceled: false,
      ...(await importImageForDocument(htmlPath, result.filePaths[0]))
    }));
  });
}

async function authorizeOpenedDocument(filePath: string) {
  const requestedPath = resolve(filePath);
  return withDocumentSaveLock(requestedPath, async () => {
    const document = await openHtmlDocument(requestedPath);
    authorizedDocuments.add(document.filePath);
    return { canceled: false, ...document };
  });
}

function isPathPayload(value: unknown): value is { filePath: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { filePath?: unknown }).filePath === "string";
}

function isSavePayload(value: unknown): value is SaveHtmlDocumentPayload {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { filePath?: unknown }).filePath === "string" &&
    typeof (value as { html?: unknown }).html === "string" &&
    typeof (value as { expectedFingerprint?: unknown }).expectedFingerprint === "string";
}
