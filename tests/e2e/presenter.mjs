import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "./lib/cdp.mjs";

const electronPath = resolve("node_modules/electron/dist/electron.exe");
const hostPath = resolve("tests/e2e/presenter-host.mjs");
const snapshotPath = process.argv[2] ? resolve(process.argv[2]) : null;
const suppliedSnapshot = snapshotPath ? JSON.parse(await readFile(snapshotPath, "utf8")) : null;
const expectedNotes = suppliedSnapshot?.slides?.find((slide) => slide.id === suppliedSnapshot.currentSlideId)?.speakerNotes ?? "Presenterに表示されるE2Eメモ";
const expectedDeckName = suppliedSnapshot?.deckName ?? "Presenter E2E";
const tempRoot = await mkdtemp(join(tmpdir(), "hss-presenter-e2e-"));
const port = 40600 + Math.floor(Math.random() * 500);
const child = spawn(electronPath, [hostPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HSS_REMOTE_DEBUGGING_PORT: String(port),
    HSS_USER_DATA_DIR: join(tempRoot, "profile"),
    ...(snapshotPath ? { HSS_PRESENTER_SNAPSHOT_PATH: snapshotPath } : {}),
    ELECTRON_ENABLE_LOGGING: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
const logs = [];
child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

let cdp = null;
try {
  const target = await waitForTarget(
    `http://127.0.0.1:${port}`,
    (item) => item.type === "page" && item.url.includes("view=presenter"),
    30_000
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitForEval(cdp, `document.querySelector('.presenter-notes__editor')?.value.includes(${JSON.stringify(expectedNotes)})`, 30_000);
  const state = await evaluate(cdp, `({
    notes: document.querySelector('.presenter-notes__editor')?.value,
    deck: document.querySelector('.presenter-topbar__deck')?.textContent,
    slideRailPreviews: document.querySelectorAll('.presenter-slide-rail .presenter-slide-thumb__preview').length,
    activeThumbAccessible: document.querySelector('.presenter-slide-thumb--active')?.getAttribute('aria-current'),
    laserDefault: document.querySelector('.presenter-tools button[aria-label="レーザー"]')?.classList.contains('is-active'),
    laserPressed: document.querySelector('.presenter-tools button[aria-label="レーザー"]')?.getAttribute('aria-pressed'),
    notesLabel: document.querySelector('.presenter-notes__editor')?.getAttribute('aria-label'),
    currentNoScroll: (() => {
      const frame = document.querySelector('.presenter-current iframe');
      const root = frame?.contentDocument?.documentElement;
      return Boolean(root && frame?.contentWindow && frame.contentWindow.getComputedStyle(root).overflow === 'hidden');
    })(),
    editorBridgeAbsent: typeof window.hss === 'undefined',
    presenterCapabilities: Object.keys(window.hssPresenter ?? {}).sort()
  })`);
  assert.equal(state.notes?.trim(), expectedNotes);
  assert.match(state.deck ?? "", new RegExp(expectedDeckName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(state.slideRailPreviews, suppliedSnapshot?.slides?.length ?? 2);
  assert.equal(state.activeThumbAccessible, "page");
  assert.equal(state.laserDefault, true);
  assert.equal(state.laserPressed, "true");
  assert.equal(state.notesLabel, "発表者ノート");
  assert.equal(state.currentNoScroll, true);
  assert.equal(state.editorBridgeAbsent, true);
  assert.deepEqual(state.presenterCapabilities, ["onPresenterState", "presenterReady", "sendPresenterCommand"]);

  const clicked = await evaluate(cdp, `(() => {
    const button = document.querySelector('.presenter-controls button[aria-label="次のスライド"]');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true);
  await waitForEval(cdp, "window.__hssPresenterCommands?.some((command) => command.type === 'next-slide')", 10_000);

  const notesChanged = await evaluate(cdp, `(() => {
    const editor = document.querySelector('.presenter-notes__editor');
    if (!(editor instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, '高速入力A');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(editor, '高速入力AB');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(notesChanged, true);
  await waitForEval(cdp, "window.__hssPresenterCommands?.some((command) => command.type === 'update-notes' && command.notes === '高速入力AB')", 10_000);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  assert.equal(await evaluate(cdp, "document.querySelector('.presenter-notes__editor')?.value"), "高速入力AB");

  await evaluate(cdp, "document.querySelector('.presenter-notes__editor')?.focus()");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitForEval(cdp, "window.__hssPresenterCommands?.some((command) => command.type === 'end-presentation')", 10_000);

  const inkRect = await evaluate(cdp, `(() => {
    const element = document.querySelector('.presenter-current .slide-preview__interaction-layer');
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
  assert.ok(inkRect?.width > 100 && inkRect?.height > 50);
  const startX = inkRect.x + inkRect.width * 0.3;
  const startY = inkRect.y + inkRect.height * 0.4;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 80, y: startY + 30, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 80, y: startY + 30, button: 'left', buttons: 0, clickCount: 1 });
  await waitForEval(cdp, "window.__hssPresenterCommands?.some((command) => command.type === 'draw' && command.event?.tool === 'laser' && command.event?.phase === 'end')", 10_000);
  await waitForEval(cdp, "Boolean(document.querySelector('.presentation-ink__stroke--laser'))", 10_000);
  assert.equal(await evaluate(cdp, "document.querySelector('.presentation-ink__stroke--laser')?.getAttribute('fill')"), "none");

  const blueSelected = await evaluate(cdp, `(() => {
    const button = document.querySelector('.presenter-tools button[aria-label="青で描画"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(blueSelected, true);
  await waitForEval(cdp, "document.querySelector('.presenter-tools button[aria-label=\"青で描画\"]')?.getAttribute('aria-pressed') === 'true'", 10_000);

  const penSelected = await evaluate(cdp, `(() => {
    const button = document.querySelector('.presenter-tools button[aria-label="ペン"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(penSelected, true);
  await waitForEval(cdp, "document.querySelector('.presenter-tools button[aria-label=\"ペン\"]')?.getAttribute('aria-pressed') === 'true'", 10_000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX + 20, y: startY + 80, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 100, y: startY + 110, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 100, y: startY + 110, button: 'left', buttons: 0, clickCount: 1 });
  await waitForEval(cdp, "window.__hssPresenterCommands?.some((command) => command.type === 'draw' && command.event?.tool === 'pen' && command.event?.color === '#2563eb' && command.event?.phase === 'end')", 10_000);
  await waitForEval(cdp, "Boolean(document.querySelector('.presentation-ink__stroke--pen'))", 10_000);
  assert.deepEqual(await evaluate(cdp, `(() => {
    const stroke = document.querySelector('.presentation-ink__stroke--pen');
    return { fill: stroke?.getAttribute('fill'), stroke: stroke?.getAttribute('stroke') };
  })()`), { fill: "none", stroke: "#2563eb" });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_900));
  assert.equal(await evaluate(cdp, "Boolean(document.querySelector('.presentation-ink__stroke--pen'))"), true);
  await evaluate(cdp, "document.querySelector('.presenter-tools button[aria-label=\"描画を消去\"]')?.click()");
  await waitForEval(cdp, "!document.querySelector('.presentation-ink__stroke--pen') && window.__hssPresenterCommands?.some((command) => command.type === 'clear-drawing')", 10_000);

  console.log(JSON.stringify({ pass: true, presenterNotes: true, presenterNotesEditable: true, notesEchoRaceSafe: true, thumbnailRail: true, scaleToFit: true, laserDefault: true, laserDraw: true, strokeOnlyInk: true, drawingColor: true, penPersists: true, drawingClear: true, escapeFromNotes: true, reopenedSaveChain: Boolean(snapshotPath), presenterCapabilitySplit: true, presenterCommand: true }, null, 2));
} catch (error) {
  console.error(error?.stack ?? String(error));
  if (logs.length > 0) console.error(logs.join(""));
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch {}
  if (child.pid) {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); } catch {}
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
