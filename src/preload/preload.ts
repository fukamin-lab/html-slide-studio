import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const api = {
  openHtmlDocument: () => ipcRenderer.invoke("hss:open-html-document"),
  openDemoDocument: () => ipcRenderer.invoke("hss:open-demo-document"),
  openHtmlPath: (filePath: string) => ipcRenderer.invoke("hss:open-html-path", { filePath }),
  consumeLaunchHtml: () => ipcRenderer.invoke("hss:consume-launch-html"),
  saveHtmlDocument: (payload: unknown) => ipcRenderer.invoke("hss:save-html-document", payload),
  importDocumentImage: (filePath: string) => ipcRenderer.invoke("hss:import-document-image", { filePath }),
  openPresenter: (state: unknown) => ipcRenderer.invoke("hss:open-presenter", state),
  updatePresenter: (state: unknown) => ipcRenderer.invoke("hss:update-presenter", state),
  endPresenter: () => ipcRenderer.invoke("hss:end-presenter"),
  onPresenterCommand: (callback: (command: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, command: unknown): void => callback(command);
    ipcRenderer.on("hss:presenter-command", listener);
    return () => ipcRenderer.removeListener("hss:presenter-command", listener);
  },
  onLaunchHtmlFile: (callback: () => void) => {
    const listener = (): void => callback();
    ipcRenderer.on("hss:launch-html-file", listener);
    return () => ipcRenderer.removeListener("hss:launch-html-file", listener);
  },
  getFilePath: (file: File) => webUtils.getPathForFile(file)
};

contextBridge.exposeInMainWorld("hss", api);
