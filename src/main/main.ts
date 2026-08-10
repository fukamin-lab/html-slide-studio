import { BrowserWindow, Menu, app } from "electron";
import { join } from "node:path";
import { registerFileSystemIpc } from "./fileSystem";
import { findLaunchHtmlPath, setPendingLaunchHtmlPath } from "./launchFiles";
import { closePresenterWindow, registerPresenterIpc } from "./presenterWindow";
import { configureGlobalSecurity, configureWindowSecurity } from "./security";
import { getEditorWindow, registerEditorWindow } from "./editorWindowRegistry";

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const remoteDebuggingPort = process.env.HSS_REMOTE_DEBUGGING_PORT;
const userDataDir = process.env.HSS_USER_DATA_DIR;

if (userDataDir) {
  app.setPath("userData", userDataDir);
}

if (remoteDebuggingPort) {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
}

const firstLaunchHtmlPath = findLaunchHtmlPath(process.argv);
if (firstLaunchHtmlPath) {
  setPendingLaunchHtmlPath(firstLaunchHtmlPath);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 560,
    title: "HTML Slide Studio",
    autoHideMenuBar: true,
    backgroundColor: "#f5f6f8",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  registerEditorWindow(mainWindow);

  configureWindowSecurity(mainWindow);
  attachRendererDiagnostics(mainWindow, "main");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    closePresenterWindow();
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  configureGlobalSecurity(isDev);
  registerFileSystemIpc();
  registerPresenterIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("second-instance", (_event, argv) => {
  const launchHtmlPath = findLaunchHtmlPath(argv);
  if (launchHtmlPath) {
    setPendingLaunchHtmlPath(launchHtmlPath);
  }

  const mainWindow = getEditorWindow();
  if (!mainWindow) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
  mainWindow.webContents.send("hss:launch-html-file");
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  const launchHtmlPath = findLaunchHtmlPath([filePath]);
  if (launchHtmlPath) {
    setPendingLaunchHtmlPath(launchHtmlPath);
    getEditorWindow()?.webContents.send("hss:launch-html-file");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function attachRendererDiagnostics(window: BrowserWindow, label: string): void {
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[renderer:${label}] load failed`, { errorCode, errorDescription, validatedUrl });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer:${label}] process gone`, details);
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[renderer:${label}] preload failed`, { preloadPath, error });
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer:${label}] ${message}`, { line, sourceId });
    }
  });
}
