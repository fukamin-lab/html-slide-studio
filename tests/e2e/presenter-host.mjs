import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const remoteDebuggingPort = process.env.HSS_REMOTE_DEBUGGING_PORT;
const userDataDir = process.env.HSS_USER_DATA_DIR;
if (userDataDir) app.setPath("userData", userDataDir);
if (remoteDebuggingPort) app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);

const slide = {
  id: "slide-001",
  label: "Presenter確認",
  selector: '[data-hss-slide-id="slide-001"]',
  index: 0,
  speakerNotes: "Presenterに表示されるE2Eメモ",
  hasSpeakerNotes: true,
  tagName: "section",
  className: "slide",
  width: 1366,
  height: 768
};
const nextSlide = {
  ...slide,
  id: "slide-002",
  label: "次のスライド",
  selector: '[data-hss-slide-id="slide-002"]',
  index: 1,
  speakerNotes: "次のメモ"
};
const defaultSnapshot = {
  sourceHtml: '<!doctype html><html><head><style>html,body{margin:0;background:#ececea}.slide{position:relative;width:1366px;height:768px;overflow:hidden;padding:88px 100px;background:#fff;color:#202124;font-family:Arial,"Noto Sans JP",sans-serif;box-sizing:border-box}h1{margin:0 0 28px;font-size:64px}p{font-size:30px;line-height:1.55}</style></head><body><section class="slide" data-hss-slide-id="slide-001"><h1>Presenter表示確認</h1><p>現在のスライドを確認しながら話します。</p></section><section class="slide" data-hss-slide-id="slide-002"><h1>次のスライド</h1><p>次に話す内容を先に確認できます。</p></section></body></html>',
  sourceBaseUrl: new URL("../../fixtures/", import.meta.url).href,
  manifest: {
    version: 1,
    app: "html-slide-studio",
    savedAt: "2026-08-10T00:00:00.000Z",
    warnings: [],
    slides: [slide, nextSlide],
    patches: [],
    overlays: []
  },
  slides: [slide, nextSlide],
  currentSlideId: slide.id,
  deckName: "Presenter E2E",
  updatedAt: "2026-08-10T00:00:01.000Z"
};
const snapshot = process.env.HSS_PRESENTER_SNAPSHOT_PATH
  ? JSON.parse(readFileSync(process.env.HSS_PRESENTER_SNAPSHOT_PATH, "utf8"))
  : defaultSnapshot;

ipcMain.on("hss:presenter-ready", (event) => event.sender.send("hss:presenter-state", snapshot));
ipcMain.on("hss:presenter-command", (event, command) => {
  void event.sender.executeJavaScript(`window.__hssPresenterCommands = [...(window.__hssPresenterCommands ?? []), ${JSON.stringify(command)}]`);
  if (command?.type === "update-notes") {
    const echoedSnapshot = structuredClone(snapshot);
    const slide = echoedSnapshot.slides.find((candidate) => candidate.id === command.slideId);
    if (slide) slide.speakerNotes = command.notes;
    const manifestSlide = echoedSnapshot.manifest.slides.find((candidate) => candidate.id === command.slideId);
    if (manifestSlide) manifestSlide.speakerNotes = command.notes;
    echoedSnapshot.updatedAt = new Date().toISOString();
    const delay = command.notes === "高速入力A" ? 80 : 10;
    setTimeout(() => {
      if (!event.sender.isDestroyed()) event.sender.send("hss:presenter-state", echoedSnapshot);
    }, delay);
  }
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      preload: resolve("out/preload/presenter.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  await window.loadFile(resolve("out/renderer/index.html"), { query: { view: "presenter" } });
});

app.on("window-all-closed", () => app.quit());
