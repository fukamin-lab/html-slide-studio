import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const presenterApi = {
  presenterReady: () => ipcRenderer.send("hss:presenter-ready"),
  sendPresenterCommand: (command: unknown) => ipcRenderer.send("hss:presenter-command", command),
  onPresenterState: (callback: (state: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, state: unknown): void => callback(state);
    ipcRenderer.on("hss:presenter-state", listener);
    return () => ipcRenderer.removeListener("hss:presenter-state", listener);
  }
};

contextBridge.exposeInMainWorld("hssPresenter", presenterApi);
