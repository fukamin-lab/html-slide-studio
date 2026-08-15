import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "../tests/e2e/lib/cdp.mjs";

const repoRoot = process.cwd();
const electronPath = resolve("node_modules/electron/dist/electron.exe");
const mainPath = resolve("out/main/main.js");
const fixturePath = resolve("tests/fixtures/workflow-slide.html");
const outputDir = resolve("docs/user-guide/assets");
const debugPort = 31_229;
const tempRoot = await mkdtemp(join(tmpdir(), "hss-guide-"));
const captureDir = join(tempRoot, "captures");
const documentPath = join(tempRoot, "guide-deck.html");
await mkdir(captureDir);
await copyFile(fixturePath, documentPath);

const capturedFiles = [];
let session = null;
let presenterCdp = null;
let presenterHostSession = null;
let displayMode = "single-display";
let presenterCapture = "not-captured";

try {
  session = await launch("welcome");
  await waitForEval(session.cdp, "Boolean(document.querySelector('.welcome-screen'))", 30_000);
  await capture(session.cdp, "01-start.png");
  await shutdown(session);

  session = await launch("editor", documentPath);
  const { cdp } = session;
  await waitForEval(cdp, "Boolean(document.querySelector('.app-shell') && document.querySelector('iframe.slide-frame'))", 30_000);
  await capture(cdp, "02-editor.png");

  await click(cdp, ".slide-navigator__heading button");
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 3");
  await click(cdp, '.slide-navigator__actions button[title="複製"]');
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 4");
  await capture(cdp, "03-slide-operations.png");

  await setInputValue(cdp, "#speaker-notes-editor", "この画面で話す要点を短くメモします");
  await clickButtonByText(cdp, ".editor-toolbar button", "テキスト");
  await waitForEval(cdp, "Boolean(document.querySelector('#inspector-text'))");
  await setInputValue(cdp, "#inspector-text", "発表で強調するポイント");
  await setInputValue(cdp, 'input[aria-label="文字サイズ"]', "40");
  await capture(cdp, "04-text-edit.png");

  await clickButtonContainingText(cdp, ".editor-toolbar button", "確認");
  await waitForEval(cdp, `(() => {
    const panel = document.querySelector('.check-panel');
    return panel?.textContent.includes('全4枚で') && panel?.textContent.includes('小さい注釈');
  })()`, 30_000);
  await capture(cdp, "05-check.png");
  await click(cdp, '.check-panel button[aria-label="閉じる"]');

  await clickButtonByText(cdp, ".editor-toolbar button", "保存");
  await waitForEval(cdp, "document.querySelector('.app-status')?.textContent.includes('上書き保存しました')", 20_000);
  await capture(cdp, "06-save-complete.png");

  await clickButtonByText(cdp, ".editor-toolbar button", "発表");
  await waitForEval(cdp, "Boolean(document.querySelector('.audience-mode'))", 20_000);
  const controls = await evaluate(cdp, `(() => { const rect = document.querySelector('.audience-mode__controls')?.getBoundingClientRect(); return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null; })()`);
  if (controls) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: controls.x, y: controls.y });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  await capture(cdp, "07-audience-mode.png");

  try {
    const target = await waitForTarget(
      `http://127.0.0.1:${debugPort}`,
      (candidate) => candidate.type === "page" && candidate.url.includes("view=presenter"),
      8_000
    );
    presenterCdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await presenterCdp.send("Runtime.enable");
    await presenterCdp.send("Page.enable");
    await waitForEval(presenterCdp, "Boolean(document.querySelector('.presenter-shell'))", 20_000);
    await drawPresenterLaser(presenterCdp);
    await capture(presenterCdp, "08-presenter-window.png");
    displayMode = "multi-display";
    presenterCapture = "physical-multi-display";
  } catch {
    displayMode = "single-display";
    await shutdown(session);
    session = null;
    presenterHostSession = await launchPresenterHost();
    await waitForEval(
      presenterHostSession.cdp,
      "document.querySelector('.presenter-notes__editor')?.value.includes('Presenterに表示されるE2Eメモ')",
      20_000
    );
    await drawPresenterLaser(presenterHostSession.cdp);
    await capture(presenterHostSession.cdp, "08-presenter-window.png");
    presenterCapture = "production-ui-test-host";
  }

  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const electronPackage = JSON.parse(await readFile(resolve("node_modules/electron/package.json"), "utf8"));
  const sha256 = {};
  for (const fileName of capturedFiles) {
    sha256[fileName] = createHash("sha256").update(await readFile(join(captureDir, fileName))).digest("hex");
  }
  const manifest = {
    schemaVersion: 3,
    capturedAt: new Date().toISOString(),
    displayMode,
    presenterCapture,
    source: {
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
      gitDirty: execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0,
      appVersion: packageJson.version,
      electronVersion: electronPackage.version,
      command: "npm run build && node scripts/capture-user-guide.mjs",
      platform: process.platform,
      arch: process.arch
    },
    files: capturedFiles,
    sha256
  };
  await publishCaptures(manifest);
  console.log(JSON.stringify({ captured: capturedFiles, displayMode, presenterCapture }, null, 2));
} finally {
  presenterCdp?.close();
  await shutdown(presenterHostSession);
  await shutdown(session);
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

async function launchPresenterHost() {
  const profile = join(tempRoot, "profile-presenter-host");
  const child = spawn(electronPath, [resolve("tests/e2e/presenter-host.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(debugPort),
      HSS_USER_DATA_DIR: profile,
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    const target = await waitForTarget(
      `http://127.0.0.1:${debugPort}`,
      (candidate) => candidate.type === "page" && candidate.url.includes("view=presenter"),
      30_000
    );
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return { child, cdp, logs };
  } catch (error) {
    await shutdown({ child });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`);
  }
}

async function launch(name, filePath) {
  const profile = join(tempRoot, `profile-${name}`);
  const args = filePath ? [mainPath, filePath] : [mainPath];
  const child = spawn(electronPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(debugPort),
      HSS_USER_DATA_DIR: profile,
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  try {
    const target = await waitForTarget(
      `http://127.0.0.1:${debugPort}`,
      (candidate) => candidate.type === "page" && candidate.title.includes("HTML Slide Studio"),
      30_000
    );
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    return { child, cdp, logs };
  } catch (error) {
    await shutdown({ child });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join("")}`);
  }
}

async function shutdown(current) {
  if (!current) return;
  try { current.cdp?.close(); } catch {}
  if (!current.child?.pid) return;
  try { execFileSync("taskkill", ["/pid", String(current.child.pid), "/t", "/f"], { stdio: "ignore" }); } catch {}
  if (current.child.exitCode === null) {
    await new Promise((resolveExit) => {
      const timeout = setTimeout(resolveExit, 3_000);
      current.child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
  }
}

async function capture(cdp, fileName) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(join(captureDir, fileName), Buffer.from(screenshot.data, "base64"));
  capturedFiles.push(fileName);
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Click target was not found: ${selector}`);
}

async function clickButtonByText(cdp, selector, label) {
  const clicked = await evaluate(cdp, `(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Button was not found: ${label}`);
}

async function clickButtonContainingText(cdp, selector, label) {
  const clicked = await evaluate(cdp, `(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)})); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Button containing text was not found: ${label}`);
}

async function setInputValue(cdp, selector, value) {
  const changed = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Input was not found: ${selector}`);
}

async function drawPresenterLaser(cdp) {
  await evaluate(cdp, `(() => {
    const button = document.querySelector('.presenter-tools button[aria-label="青で描画"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  await waitForEval(cdp, "document.querySelector('.presenter-tools button[aria-label=\"青で描画\"]')?.getAttribute('aria-pressed') === 'true'", 1_000);
  const rect = await evaluate(cdp, `(() => {
    const element = document.querySelector('.presenter-current .slide-preview__interaction-layer');
    if (!(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
  })()`);
  if (!rect || rect.width < 100 || rect.height < 50) throw new Error("Presenter drawing surface was not ready");
  const startX = rect.x + rect.width * 0.37;
  const startY = rect.y + rect.height * 0.45;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: startX + 100, y: startY + 45, button: "left", buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: startX + 100, y: startY + 45, button: "left", buttons: 0, clickCount: 1 });
  await waitForEval(cdp, "Boolean(document.querySelector('.presentation-ink__stroke--laser'))", 1_000);
}

async function publishCaptures(manifest) {
  await mkdir(outputDir, { recursive: true });
  const manifestPath = join(outputDir, "capture-manifest.json");
  let previousManifest = null;
  try { previousManifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch {}
  const previousFiles = Array.isArray(previousManifest?.files)
    ? previousManifest.files.filter((name) => typeof name === "string" && basename(name) === name && name.endsWith(".png"))
    : [];
  const managedFiles = [...new Set([...previousFiles, ...capturedFiles])];
  const backups = new Map();
  for (const fileName of managedFiles) {
    try { backups.set(fileName, await readFile(join(outputDir, fileName))); } catch { backups.set(fileName, null); }
  }
  let manifestBackup = null;
  try { manifestBackup = await readFile(manifestPath); } catch {}

  try {
    for (const fileName of capturedFiles) await copyFile(join(captureDir, fileName), join(outputDir, fileName));
    for (const staleFile of previousFiles.filter((fileName) => !capturedFiles.includes(fileName))) {
      await rm(join(outputDir, staleFile), { force: true });
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (error) {
    for (const [fileName, contents] of backups) {
      const target = join(outputDir, fileName);
      if (contents === null) await rm(target, { force: true });
      else await writeFile(target, contents);
    }
    if (manifestBackup === null) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, manifestBackup);
    throw error;
  }
}
