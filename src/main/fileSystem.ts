import { app, dialog, ipcMain } from "electron";
import { join, resolve } from "node:path";
import {
  type CanonicalFileIdentity,
  importImageForDocument,
  openHtmlDocument,
  saveHtmlDocument
} from "./documentFiles";
import { isPathPayload, isSavePayload } from "./filePayloadGuards";
import { takePendingLaunchHtmlPath } from "./launchFiles";
import { requireEditorSender } from "./editorWindowRegistry";
import { withDocumentSaveLock } from "./documentSaveMutex";
import { DEMO_FILE_NAME, ensureDemoWorkingCopy } from "./demoDocument";

type AuthorizedDocument = { fingerprint: string; identity: CanonicalFileIdentity };
const authorizedDocuments = new Map<string, AuthorizedDocument>();

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
    const authorization = authorizedDocuments.get(filePath);
    if (!authorization || authorization.fingerprint !== payload.expectedFingerprint) {
      throw new Error("Save is allowed only for an HTML file opened by this app session");
    }
    return withDocumentSaveLock(filePath, async () => {
      const saved = await saveHtmlDocument({ ...payload, filePath }, undefined, undefined, authorization.identity);
      authorizedDocuments.set(filePath, { fingerprint: saved.fingerprint, identity: saved.documentIdentity });
      const { documentIdentity: _identity, ...publicResult } = saved;
      return { canceled: false, ...publicResult };
    });
  });

  ipcMain.handle("hss:import-document-image", async (event, payload: unknown) => {
    const owner = requireEditorSender(event.sender);
    if (!isPathPayload(payload)) {
      throw new Error("Invalid image import request");
    }
    const htmlPath = resolve(payload.filePath);
    const authorization = authorizedDocuments.get(htmlPath);
    if (!authorization) {
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
      ...(await importImageForDocument(htmlPath, result.filePaths[0], undefined, authorization.identity))
    }));
  });
}

async function authorizeOpenedDocument(filePath: string) {
  const requestedPath = resolve(filePath);
  return withDocumentSaveLock(requestedPath, async () => {
    const document = await openHtmlDocument(requestedPath);
    authorizedDocuments.set(document.filePath, { fingerprint: document.fingerprint, identity: document.documentIdentity });
    const { documentIdentity: _identity, ...publicDocument } = document;
    return { canceled: false, ...publicDocument };
  });
}
