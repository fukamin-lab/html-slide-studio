import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "./lib/cdp.mjs";

const repoRoot = process.cwd();
const electronPath = resolve("node_modules/electron/dist/electron.exe");
const mainPath = resolve("out/main/main.js");
const fixturePath = resolve("tests/fixtures/large-1600-slide.html");
const tempRoot = await mkdtemp(join(tmpdir(), "hss-slide-size-e2e-"));
const port = 40500 + Math.floor(Math.random() * 1000);
let child = null;
let cdp = null;

try {
  console.log("launching");
  child = spawn(electronPath, [mainPath, fixturePath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(port),
      HSS_USER_DATA_DIR: join(tempRoot, "profile"),
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[electron] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[electron] ${chunk}`));
  const target = await waitForTarget(
    `http://127.0.0.1:${port}`,
    (item) => item.type === "page" && item.title.includes("HTML Slide Studio"),
    30_000
  );
  console.log("target-ready");
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    return frame?.clientWidth === 1600 && frame?.clientHeight === 900;
  })()`, 30_000);
  console.log("editor-size-ready");

  const editor = await evaluate(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const canvas = document.querySelector('.canvas-frame');
    const marker = frame?.contentDocument?.querySelector('#right-edge-marker');
    if (!(frame instanceof HTMLIFrameElement) || !(canvas instanceof HTMLElement) || !marker) return null;
    const markerRect = marker.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      frameWidth: frame.clientWidth,
      frameHeight: frame.clientHeight,
      markerRight: markerRect.right,
      markerVisibleInSource: markerRect.right <= frame.clientWidth,
      canvasWidth: canvasRect.width,
      iframeDisplayWidth: frame.getBoundingClientRect().width,
      thumbnailSizes: Array.from(document.querySelectorAll('.slide-list__thumb iframe')).map((item) => [item.clientWidth, item.clientHeight])
    };
  })()`);
  assert.equal(editor.frameWidth, 1600);
  assert.equal(editor.frameHeight, 900);
  assert.equal(editor.markerVisibleInSource, true);
  assert.ok(editor.markerRight > 1366, "fixture must exercise content beyond the legacy frame width");
  assert.ok(Math.abs(editor.canvasWidth - editor.iframeDisplayWidth) <= 1, "canvas must contain the complete scaled iframe");
  assert.deepEqual(editor.thumbnailSizes, [[1600, 900]]);
  console.log("editor-assertions-pass");

  await clickButton(cdp, "確認");
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.deck-review-frame');
    return frame?.clientWidth === 1600 && frame?.clientHeight === 900;
  })()`, 30_000);
  console.log("review-size-ready");

  await clickButton(cdp, "発表");
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('.slide-preview--audience iframe');
    return frame?.clientWidth === 1600 && frame?.clientHeight === 900;
  })()`, 30_000);
  console.log("audience-size-ready");

  console.log(JSON.stringify({ pass: true, frame: [1600, 900], editor: true, thumbnail: true, review: true, audience: true }));
} finally {
  try { cdp?.close(); } catch {}
  if (child?.pid) {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); } catch {}
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

async function clickButton(client, label) {
  const clicked = await evaluate(client, `(() => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `button not found: ${label}`);
}
