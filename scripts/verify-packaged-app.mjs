import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "../tests/e2e/lib/cdp.mjs";
import { resolveLocalEndpoint } from "./lib/local-endpoint.mjs";

const projectRoot = process.cwd();
const { version } = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const portablePath = resolve("release/HTML Slide Studio.exe");
const payloadPath = resolve("release/win-arm64-unpacked/HTML Slide Studio.exe");
const zipPath = resolve(`release/HTML Slide Studio-${version}-arm64-win.zip`);
const endpoint = resolveLocalEndpoint(projectRoot);
assert.equal(await readPeMachine(payloadPath), 0xaa64, "Packaged Electron payload must be native Windows ARM64");
assert.deepEqual(
  await readFile(resolve("release/win-arm64-unpacked/resources/LICENSE")),
  await readFile(resolve("LICENSE")),
  "Packaged app must include the project MIT license"
);
assert.deepEqual(
  await readFile(resolve("release/win-arm64-unpacked/resources/THIRD_PARTY_NOTICES.md")),
  await readFile(resolve("THIRD_PARTY_NOTICES.md")),
  "Packaged app must include third-party notices"
);
const zipEntries = execFileSync("tar", ["-tf", zipPath], { encoding: "utf8" }).split(/\r?\n/);
assert.equal(zipEntries.includes("resources/LICENSE"), true, "ZIP must include the project MIT license");
assert.equal(zipEntries.includes("resources/THIRD_PARTY_NOTICES.md"), true, "ZIP must include third-party notices");
assert.equal(zipEntries.includes("LICENSE.electron.txt"), true, "ZIP must include the Electron license");
assert.equal(zipEntries.includes("LICENSES.chromium.html"), true, "ZIP must include Chromium licenses");
const electronLicense = await readFile(resolve("release/win-arm64-unpacked/LICENSE.electron.txt"));
const chromiumLicenses = await readFile(resolve("release/win-arm64-unpacked/LICENSES.chromium.html"));
assert.equal(electronLicense.length > 100, true, "Electron license must be nonempty");
assert.equal(chromiumLicenses.length > 100, true, "Chromium licenses must be nonempty");
assert.deepEqual(readZipEntry(zipPath, "LICENSE.electron.txt"), electronLicense, "ZIP Electron license must match unpacked payload");
assert.deepEqual(readZipEntry(zipPath, "LICENSES.chromium.html"), chromiumLicenses, "ZIP Chromium licenses must match unpacked payload");
assert.deepEqual(
  readZipEntry(zipPath, "resources/LICENSE"),
  await readFile(resolve("LICENSE")),
  "ZIP project license must match the source license"
);
assert.deepEqual(
  readZipEntry(zipPath, "resources/THIRD_PARTY_NOTICES.md"),
  await readFile(resolve("THIRD_PARTY_NOTICES.md")),
  "ZIP third-party notices must match the source notices"
);

function readZipEntry(archivePath, entryName) {
  return execFileSync("tar", ["-xOf", archivePath, entryName], {
    maxBuffer: 64 * 1024 * 1024
  });
}

const asarPath = resolve("release/win-arm64-unpacked/resources/app.asar");
const asarList = execFileSync(process.execPath, [resolve("node_modules/@electron/asar/bin/asar.js"), "list", asarPath], { encoding: "utf8" });
assert.equal(/(?:^|[\\/])node_modules(?:[\\/]|$)/m.test(asarList), false, "Packaged app.asar must not contain node_modules");
const asarBytes = await readFile(asarPath);
for (const forbidden of ["C:\\dev\\fukamin", ["HTML Slide Studio", "Legacy"].join(" "), "PROJECT_ID.json", "LOCAL_ENDPOINT.json"]) {
  assert.equal(asarBytes.includes(Buffer.from(forbidden, "utf8")), false, `Packaged app.asar contains internal reference: ${forbidden}`);
}
await assertPortAvailable(endpoint.host, endpoint.port);

const verificationRoot = await mkdtemp(join(tmpdir(), "hss-package-"));
assert.equal(resolve(verificationRoot).startsWith(resolve(tmpdir())), true, "verification directory must remain under the system temp directory");
assert.match(basename(verificationRoot), /^hss-package-/, "verification directory must use the owned prefix");
const profilePath = join(verificationRoot, "profile");

const logs = [];
let child = null;
let cdp = null;
let verificationResult = null;
try {
  child = spawn(portablePath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(endpoint.port),
      HSS_USER_DATA_DIR: profilePath,
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const target = await waitForTarget(
    `http://${endpoint.host}:${endpoint.port}`,
    (candidate) => candidate.type === "page" && candidate.title.includes("HTML Slide Studio"),
    120_000
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await waitForEval(cdp, "Boolean(document.querySelector('.welcome-screen'))", 30_000);
  const clickedDemo = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.welcome-screen__actions button'))
      .find((candidate) => candidate.textContent?.trim() === 'デモを開く');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clickedDemo, true, "Packaged Welcome screen must expose the demo action");
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 8", 30_000);
  const state = await evaluate(cdp, `({
    title: document.title,
    shell: Boolean(document.querySelector(".app-shell")),
    slides: document.querySelectorAll(".slide-list__item").length,
    documentName: document.querySelector(".editor-toolbar__document strong")?.textContent,
    bridge: ["openHtmlDocument", "openDemoDocument", "saveHtmlDocument", "importDocumentImage", "openPresenter"]
      .every((name) => typeof window.hss?.[name] === "function")
  })`);
  assert.deepEqual(state, {
    title: "HTML Slide Studio",
    shell: true,
    slides: 8,
    documentName: "html-slide-studio-demo.html",
    bridge: true
  });
  const addedOverlay = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.editor-toolbar button'))
      .find((candidate) => candidate.textContent?.trim() === 'テキスト');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(addedOverlay, true, "Packaged app must allow adding an inline text object before close verification");
  await waitForEval(cdp, "Boolean(document.querySelector('.overlay-text--selected .overlay-text__content'))", 10_000);
  const overlayPoint = await evaluate(cdp, `(() => {
    const element = document.querySelector('.overlay-text--selected .overlay-text__content');
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(overlayPoint, "Packaged inline text object must have a clickable surface");
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: overlayPoint.x, y: overlayPoint.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: overlayPoint.x, y: overlayPoint.y, button: "left", buttons: 0, clickCount: 1 });
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') === 'true'", 10_000);
  const dirtyEditApplied = await evaluate(cdp, `(() => {
    const editor = document.querySelector('.overlay-text__content');
    if (!(editor instanceof HTMLElement)) return false;
    editor.textContent = '終了確認テスト';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '終了確認テスト' }));
    return true;
  })()`);
  assert.equal(dirtyEditApplied, true, "Packaged app must apply an active inline text edit before close verification");
  await waitForEval(cdp, "document.querySelector('#inspector-text')?.value === '終了確認テスト' && document.querySelector('.app-status')?.textContent.includes('未保存')", 10_000);
  verificationResult = { pass: true, executable: portablePath, payloadMachine: "0xAA64", endpoint, packagedDemoOpenedFromWelcome: true, state };
} catch (error) {
  console.error(logs.join(""));
  throw error;
} finally {
  let terminationError = null;
  let dialogConfirmer = null;
  const cancelDialogLogs = [];
  const discardDialogLogs = [];
  try {
    if (cdp) {
      assert.equal(isChildRunning(child), true, "Portable launcher exited before native window-close verification");
      dialogConfirmer = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", resolve("scripts/confirm-unsaved-close.ps1"),
        "-RootProcessId", String(child.pid),
        "-Action", "Cancel",
        "-TimeoutMs", "20000"
      ], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      dialogConfirmer.stdout.on("data", (chunk) => cancelDialogLogs.push(chunk.toString()));
      dialogConfirmer.stderr.on("data", (chunk) => cancelDialogLogs.push(chunk.toString()));
      const cancelExit = await waitForProcessExit(dialogConfirmer, 25_000, "Unsaved-close cancel confirmer");
      const cancelLog = cancelDialogLogs.join("");
      assert.equal(cancelExit.code, 0, `Owned unsaved-close cancel action was not confirmed:\n${cancelLog}`);
      const cancelPayloadPid = assertDialogProcessIds(cancelLog, "Cancel");
      assert.equal(isChildRunning(child), true, "Packaged app must remain running after canceling the unsaved-close dialog");
      assert.equal(isProcessRunning(cancelPayloadPid), true, "Packaged payload window process must remain running after canceling close");
      await waitForEval(cdp, "document.querySelector('.app-status')?.textContent.includes('未保存')", 10_000);

      dialogConfirmer = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", resolve("scripts/confirm-unsaved-close.ps1"),
        "-RootProcessId", String(child.pid),
        "-Action", "Discard",
        "-TimeoutMs", "20000"
      ], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      dialogConfirmer.stdout.on("data", (chunk) => discardDialogLogs.push(chunk.toString()));
      dialogConfirmer.stderr.on("data", (chunk) => discardDialogLogs.push(chunk.toString()));
      const discardExit = await waitForProcessExit(dialogConfirmer, 25_000, "Unsaved-close discard confirmer");
      const discardLog = discardDialogLogs.join("");
      assert.equal(discardExit.code, 0, `Owned unsaved-close discard action was not confirmed:\n${discardLog}`);
      const discardPayloadPid = assertDialogProcessIds(discardLog, "Discard");
      await waitForProcessExit(child, 30_000, "Packaged app");
      assert.equal(isProcessRunning(discardPayloadPid), false, "Packaged payload window process must exit after discarding changes");
      if (verificationResult) {
        verificationResult.nativeDirtyWindowClose = true;
        verificationResult.nativeUnsavedDialogCancelVerified = true;
        verificationResult.nativeUnsavedDialogConfirmed = true;
      }
    }
  } catch (error) {
    terminationError = error;
  } finally {
    try { cdp?.close(); } catch {}
    if (dialogConfirmer?.pid && isChildRunning(dialogConfirmer)) {
      try {
        execFileSync("taskkill", ["/pid", String(dialogConfirmer.pid), "/t", "/f"], { stdio: "ignore" });
        await waitForProcessExit(dialogConfirmer, 10_000, "Dialog confirmer cleanup");
      } catch (error) {
        terminationError ??= error;
      }
    }
    if (child?.pid && isChildRunning(child)) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        await waitForProcessExit(child, 30_000, "Packaged app cleanup");
      } catch (error) {
        terminationError ??= error;
      }
    }
    if (isChildRunning(child)) {
      terminationError ??= new Error("Packaged app process did not terminate");
    }
  }
  await rm(verificationRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (terminationError) throw terminationError;
}

console.log(JSON.stringify(verificationResult, null, 2));

async function assertPortAvailable(host, port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host, port, exclusive: true }, resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
}

async function waitForProcessExit(childProcess, timeoutMs, label = "Process") {
  if (!isChildRunning(childProcess)) return { code: childProcess.exitCode, signal: childProcess.signalCode };
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      childProcess.off("exit", onExit);
      rejectExit(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    };
    childProcess.once("exit", onExit);
  });
}

function isChildRunning(childProcess) {
  return Boolean(childProcess && childProcess.exitCode === null && childProcess.signalCode === null);
}

function assertDialogProcessIds(log, action) {
  const closeMatch = log.match(/close-requested:(\d+)/);
  const confirmMatch = log.match(new RegExp(`confirmed:${action}:(\\d+)`));
  assert.ok(closeMatch, "Dialog verifier must request a native close on the owned payload window");
  assert.ok(confirmMatch, `Dialog verifier must confirm the ${action} action on the owned payload window`);
  assert.equal(confirmMatch[1], closeMatch[1], "Dialog action must target the same payload process that received WM_CLOSE");
  return Number(closeMatch[1]);
}

function isProcessRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    throw error;
  }
}

async function readPeMachine(filePath) {
  const handle = await open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await handle.read(dosHeader, 0, dosHeader.length, 0);
    assert.equal(dosRead.bytesRead, dosHeader.length, "PE DOS header is truncated");
    assert.equal(dosHeader.toString("ascii", 0, 2), "MZ", "Payload is not a Windows PE executable");
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    const peRead = await handle.read(peHeader, 0, peHeader.length, peOffset);
    assert.equal(peRead.bytesRead, peHeader.length, "PE header is truncated");
    assert.deepEqual(peHeader.subarray(0, 4), Buffer.from([0x50, 0x45, 0x00, 0x00]), "PE signature is invalid");
    return peHeader.readUInt16LE(4);
  } finally {
    await handle.close();
  }
}
