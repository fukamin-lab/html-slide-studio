import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "./lib/cdp.mjs";

const repoRoot = process.cwd();
const electronPath = resolve("node_modules/electron/dist/electron.exe");
const mainPath = resolve("out/main/main.js");
const fixturePath = resolve("tests/fixtures/workflow-slide.html");
const revealFixturePath = resolve("tests/fixtures/reveal-nested.html");
const unsupportedFixturePath = resolve("tests/fixtures/unsupported-body-sections.html");

const tempRoot = await mkdtemp(join(tmpdir(), "hss-legacy-e2e-"));
const htmlPath = join(tempRoot, "workflow.html");
const revealPath = join(tempRoot, "reveal-nested.html");
const unsupportedPath = join(tempRoot, "unsupported-body-sections.html");
const artifactsPath = join(tempRoot, "artifacts");
const reopenedPresenterSnapshotPath = join(tempRoot, "reopened-presenter-snapshot.json");
await mkdir(artifactsPath);
await copyFile(fixturePath, htmlPath);
await copyFile(revealFixturePath, revealPath);
await copyFile(unsupportedFixturePath, unsupportedPath);

let session = null;
let presenterNotesRoundTrip = false;
let presenterDrawingSynced = false;
let expectedSavedNotes = "E2E発表メモ";
try {
  session = await launch("first", htmlPath);
  const { cdp } = session;
  await waitForEval(cdp, "Boolean(document.querySelector('.app-shell') && document.querySelector('iframe.slide-frame'))", 30_000);

  const startup = await evaluate(cdp, `({
    buttons: Array.from(document.querySelectorAll('.editor-toolbar button')).map((button) => button.textContent.trim()).filter(Boolean),
    slides: document.querySelectorAll('.slide-list__item').length,
    oldUi: ['.ribbon','.version-history-panel','.asset-manager-dialog','.review-panel'].some((selector) => document.querySelector(selector)),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    canvasFitNoScroll: (() => {
      const viewport = document.querySelector('.canvas-viewport--fit');
      const frame = document.querySelector('iframe.slide-frame');
      const root = frame?.contentDocument?.documentElement;
      const viewportStyle = viewport ? getComputedStyle(viewport) : null;
      const rootStyle = root && frame?.contentWindow ? frame.contentWindow.getComputedStyle(root) : null;
      return Boolean(viewportStyle && rootStyle && viewportStyle.overflow === 'hidden' && rootStyle.overflow === 'hidden');
    })(),
    bridge: ['openHtmlDocument','openDemoDocument','saveHtmlDocument','importDocumentImage','openPresenter'].every((name) => typeof window.hss?.[name] === 'function')
  })`);
  assert.deepEqual(startup.buttons, ["開く", "保存", "テキスト", "画像", "確認", "発表"]);
  assert.equal(startup.slides, 2);
  assert.equal(startup.oldUi, false);
  assert.equal(startup.overflowX, false);
  assert.equal(startup.canvasFitNoScroll, true);
  assert.equal(startup.bridge, true);

  await clickAtSelector(cdp, '.slide-list__item:nth-child(2) .slide-list__thumb');
  await waitForEval(cdp, "document.querySelector('.slide-list__item:nth-child(2)')?.classList.contains('slide-list__item--active')");
  await clickAtSelector(cdp, '.slide-list__item:nth-child(1) .slide-list__thumb');
  await waitForEval(cdp, "document.querySelector('.slide-list__item:nth-child(1)')?.classList.contains('slide-list__item--active')");

  await click(cdp, ".slide-navigator__heading button");
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 3");
  await click(cdp, '.slide-navigator__actions button[title="複製"]');
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 4");
  await click(cdp, '.slide-navigator__actions button[title="上へ"]');
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 4");

  await setInputValue(cdp, "#speaker-notes-editor", "E2E発表メモ");
  await clickButtonByText(cdp, ".editor-toolbar button", "テキスト");
  await waitForEval(cdp, "document.querySelectorAll('[data-hss-overlay-id]').length === 1 && Boolean(document.querySelector('#inspector-text'))");
  const headingPoint = await evaluate(cdp, `(() => {
    const canvas = document.querySelector('.canvas-frame');
    if (!(canvas instanceof HTMLElement)) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvasRect.width / 1366;
    return { x: canvasRect.left + 120 * scale, y: canvasRect.top + 130 * scale };
  })()`);
  assert.ok(headingPoint);
  const headingSelected = await evaluate(cdp, `(() => {
    const layer = document.querySelector('.canvas-input-layer');
    if (!(layer instanceof HTMLElement)) return false;
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${headingPoint.x}, clientY: ${headingPoint.y} }));
    return true;
  })()`);
  assert.equal(headingSelected, true);
  await waitForEval(cdp, "document.querySelectorAll('.selection-outline').length === 1 && document.querySelectorAll('.overlay-text--selected').length === 0");
  await clickAtSelector(cdp, '.overlay-text__content', 2);
  await waitForEval(cdp, "document.querySelectorAll('.selection-outline').length === 0 && document.querySelectorAll('.overlay-text--selected').length === 1");
  await clickAtSelector(cdp, '.overlay-text__content');
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') === 'true'");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') !== 'true'");
  await doubleClickAtSelector(cdp, '.overlay-text__content');
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') === 'true'");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  const wholeOverlayTextSelected = await evaluate(cdp, `(() => {
    const element = document.querySelector('.overlay-text__content');
    const selection = window.getSelection();
    return Boolean(element && selection && selection.toString() === element.textContent && selection.rangeCount === 1);
  })()`);
  assert.equal(wholeOverlayTextSelected, true);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') !== 'true'");
  await setInputValue(cdp, "#inspector-text", "E2Eで追加したテキスト");
  await waitForEval(cdp, "document.querySelector('.app-status')?.textContent.includes('未保存')");

  await clickButtonByText(cdp, ".editor-toolbar button", "保存");
  await waitForEval(cdp, "document.querySelector('.app-status')?.textContent.includes('上書き保存しました')", 20_000);
  const savedHtml = await readFile(htmlPath, "utf8");
  assert.match(savedHtml, /E2Eで追加したテキスト/);
  assert.match(savedHtml, /data-speaker-notes="E2E発表メモ"/);
  assert.equal((savedHtml.match(/<section\b/g) ?? []).length, 4);
  assert.equal((savedHtml.match(/data-hss-export-layer="true"/g) ?? []).length, 1);
  assert.doesNotMatch(savedHtml, /\bfile:/i);
  assert.doesNotMatch(savedHtml, /\.hslides/i);
  assert.ok(Buffer.byteLength(savedHtml, "utf8") < 512 * 1024);
  const ids = [...savedHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicated slide IDs must be unique");

  await clickButtonByText(cdp, ".editor-toolbar button", "確認");
  await waitForEval(cdp, "Boolean(document.querySelector('.check-panel'))");
  await clickButtonByText(cdp, ".editor-toolbar button", "発表");
  await waitForEval(cdp, "Boolean(document.querySelector('.audience-mode'))", 20_000);
  const dualModeExpected = await evaluate(cdp, "document.querySelector('.app-status__message')?.textContent.includes('発表者画面と投映画面を開きました')");
  if (dualModeExpected) {
    assert.equal(await evaluate(cdp, "Boolean(document.querySelector('.audience-mode__controls'))"), false, "dual-display audience surface must not expose controls");
  }
  await evaluate(cdp, `(() => {
    const frame = document.querySelector('.audience-mode iframe');
    if (!(frame instanceof HTMLIFrameElement)) return false;
    window.__hssAudienceFrameWindow = frame.contentWindow;
    window.__hssAudienceFrameLoads = 0;
    frame.addEventListener('load', () => { window.__hssAudienceFrameLoads += 1; });
    return true;
  })()`);
  let livePresenterCdp = null;
  if (dualModeExpected) {
    const presenterTarget = await waitForTarget(
      `http://127.0.0.1:${session.port}`,
      (item) => item.type === "page" && item.url.includes("view=presenter"),
      20_000
    );
    livePresenterCdp = await CdpClient.connect(presenterTarget.webSocketDebuggerUrl);
    await livePresenterCdp.send("Runtime.enable");
    await waitForEval(livePresenterCdp, "Boolean(document.querySelector('.presenter-notes__editor'))", 10_000);
    await evaluate(livePresenterCdp, `(() => {
      const frame = document.querySelector('.presenter-current iframe');
      if (!(frame instanceof HTMLIFrameElement)) return false;
      window.__hssPresenterFrameWindow = frame.contentWindow;
      window.__hssPresenterFrameLoads = 0;
      frame.addEventListener('load', () => { window.__hssPresenterFrameLoads += 1; });
      return true;
    })()`);
    expectedSavedNotes = "発表中E2EメモAB";
    const notesSent = await evaluate(livePresenterCdp, `(() => {
      const editor = document.querySelector('.presenter-notes__editor');
      if (!(editor instanceof HTMLTextAreaElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      editor.focus();
      setter.call(editor, '発表中E2EメモA');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(editor, ${JSON.stringify("発表中E2EメモAB")});
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.blur();
      return true;
    })()`);
    assert.equal(notesSent, true);
    await waitForEval(cdp, `document.querySelector('#speaker-notes-editor')?.value === ${JSON.stringify("発表中E2EメモAB")} && document.querySelector('.app-status')?.textContent.includes('未保存')`, 10_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.equal(await evaluate(livePresenterCdp, "document.querySelector('.presenter-notes__editor')?.value"), expectedSavedNotes);
    assert.equal(await evaluate(livePresenterCdp, `(() => {
      const frame = document.querySelector('.presenter-current iframe');
      return frame?.contentWindow === window.__hssPresenterFrameWindow && window.__hssPresenterFrameLoads === 0;
    })()`), true, "Presenter note edits must not reload the current slide frame");
    assert.equal(await evaluate(cdp, `(() => {
      const frame = document.querySelector('.audience-mode iframe');
      return frame?.contentWindow === window.__hssAudienceFrameWindow && window.__hssAudienceFrameLoads === 0;
    })()`), true, "Presenter note edits must not reload the audience slide frame");
    const drawRect = await evaluate(livePresenterCdp, `(() => {
      const layer = document.querySelector('.presenter-current .slide-preview__interaction-layer');
      if (!(layer instanceof HTMLElement)) return null;
      const rect = layer.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`);
    assert.ok(drawRect?.width > 100 && drawRect?.height > 50);
    const drawX = drawRect.x + drawRect.width * 0.35;
    const drawY = drawRect.y + drawRect.height * 0.45;
    await livePresenterCdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: drawX, y: drawY, button: "left", buttons: 1, clickCount: 1 });
    await livePresenterCdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drawX + 90, y: drawY + 30, button: "left", buttons: 1 });
    await livePresenterCdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: drawX + 90, y: drawY + 30, button: "left", buttons: 0, clickCount: 1 });
    await waitForEval(cdp, "Boolean(document.querySelector('.audience-mode .presentation-ink__stroke--laser'))", 10_000);
    assert.deepEqual(await evaluate(cdp, `(() => {
      const stroke = document.querySelector('.audience-mode .presentation-ink__stroke--laser');
      return { fill: stroke?.getAttribute('fill'), stroke: stroke?.getAttribute('stroke') };
    })()`), { fill: "none", stroke: "#ef4444" });
    presenterDrawingSynced = true;
    presenterNotesRoundTrip = true;
  }
  if (dualModeExpected) assert.equal(presenterNotesRoundTrip, true, "dual-display mode must complete the live Presenter notes round trip");
  if (dualModeExpected) assert.equal(presenterDrawingSynced, true, "dual-display mode must mirror Presenter drawing to the audience surface");
  if (dualModeExpected && livePresenterCdp) {
    await evaluate(livePresenterCdp, "document.querySelector('.presenter-end-button')?.click()");
  } else {
    await evaluate(cdp, "document.querySelector('.audience-mode')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))");
    await waitForEval(cdp, "document.querySelector('.audience-mode__controls')?.classList.contains('audience-mode__controls--visible')", 5_000);
    await clickButtonByText(cdp, ".audience-mode__controls button", "編集へ戻る");
  }
  await waitForEval(cdp, "!document.querySelector('.audience-mode')", 20_000);
  livePresenterCdp?.close();
  if (presenterNotesRoundTrip) {
    await clickButtonByText(cdp, ".editor-toolbar button", "保存");
    await waitForEval(cdp, "document.querySelector('.app-status')?.textContent.includes('上書き保存しました')", 20_000);
    assert.match(await readFile(htmlPath, "utf8"), new RegExp(`data-speaker-notes="${expectedSavedNotes}"`));
  }

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(join(artifactsPath, "editor.png"), Buffer.from(screenshot.data, "base64"));

  await shutdown(session);
  session = await launch("reopen", htmlPath);
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 4", 30_000);
  await clickButtonContainingText(session.cdp, ".slide-list__item", "新しいスライド（複製）");
  await waitForEval(session.cdp, "document.querySelectorAll('[data-hss-overlay-id]').length === 1");
  const reopened = await evaluate(session.cdp, `({
    overlays: document.querySelectorAll('[data-hss-overlay-id]').length,
    notes: document.querySelector('#speaker-notes-editor')?.value,
    text: document.body.innerText.includes('E2Eで追加したテキスト')
  })`);
  assert.equal(reopened.overlays, 1);
  assert.equal(reopened.notes, expectedSavedNotes);
  assert.equal(reopened.text, true);
  const reopenedPresenterSnapshot = await evaluate(session.cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const frameDocument = frame?.contentDocument;
    if (!frameDocument) return null;
    const notes = document.querySelector('#speaker-notes-editor')?.value ?? '';
    const slideNodes = Array.from(frameDocument.querySelectorAll('[data-hss-slide-id]'));
    const slides = slideNodes.map((node, index) => ({
      id: node.getAttribute('data-hss-slide-id'),
      label: node.getAttribute('data-label') || node.querySelector('h1,h2,h3')?.textContent?.trim() || ('Slide ' + (index + 1)),
      selector: '[data-hss-slide-id="' + node.getAttribute('data-hss-slide-id') + '"]',
      index,
      ...(node.hasAttribute('data-speaker-notes') ? { speakerNotes: node.getAttribute('data-speaker-notes') ?? '', hasSpeakerNotes: Boolean(node.getAttribute('data-speaker-notes')) } : {}),
      tagName: node.tagName.toLowerCase(),
      ...(node.getAttribute('class') ? { className: node.getAttribute('class') } : {})
    }));
    const currentSlide = slides.find((slide) => slide.speakerNotes === notes) ?? slides[0];
    const now = new Date().toISOString();
    return {
      sourceHtml: '<!doctype html>\\n' + frameDocument.documentElement.outerHTML,
      sourceBaseUrl: frameDocument.querySelector('base[data-hss-base="true"]')?.getAttribute('href'),
      manifest: { version: 1, app: 'html-slide-studio', savedAt: now, warnings: [], slides, patches: [], overlays: [] },
      slides,
      currentSlideId: currentSlide?.id ?? null,
      deckName: '保存・再読込したE2E資料',
      updatedAt: now
    };
  })()`);
  assert.ok(reopenedPresenterSnapshot);
  assert.equal(reopenedPresenterSnapshot.slides.find((slide) => slide.id === reopenedPresenterSnapshot.currentSlideId)?.speakerNotes, expectedSavedNotes);
  await writeFile(reopenedPresenterSnapshotPath, `${JSON.stringify(reopenedPresenterSnapshot, null, 2)}\n`, "utf8");

  await shutdown(session);
  session = await launch("nested", revealPath);
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 2", 30_000);
  await click(session.cdp, '.slide-navigator__actions button[title="複製"]');
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 3");
  await clickButtonByText(session.cdp, ".editor-toolbar button", "保存");
  await waitForEval(session.cdp, "document.querySelector('.app-status')?.textContent.includes('上書き保存しました')", 20_000);
  const revealHtml = await readFile(revealPath, "utf8");
  assert.equal((revealHtml.match(/class="slide"/g) ?? []).length, 3);
  assert.equal((revealHtml.match(/data-nested-fragment="true"/g) ?? []).length, 2);
  const revealIds = [...revealHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(revealIds).size, revealIds.length, "nested duplicate IDs must be regenerated");

  await shutdown(session);
  session = await launch("unsupported", unsupportedPath);
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 2", 30_000);
  const unsupported = await evaluate(session.cdp, `({
    addDisabled: document.querySelector('.slide-navigator__heading button')?.disabled,
    duplicateDisabled: document.querySelector('.slide-navigator__actions button')?.disabled,
    reason: document.querySelector('.slide-navigator__notice')?.textContent
  })`);
  assert.equal(unsupported.addDisabled, true);
  assert.equal(unsupported.duplicateDisabled, true);
  assert.match(unsupported.reason ?? "", /区別できない/);

  await shutdown(session);
  session = null;
  const presenterEvidence = execFileSync(process.execPath, [resolve("tests/e2e/presenter.mjs"), reopenedPresenterSnapshotPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 90_000
  });
  assert.match(presenterEvidence, /"reopenedSaveChain": true/);

  console.log(JSON.stringify({ pass: true, slides: 4, overwrite: true, reopen: true, presenterNotesRoundTrip, presenterDrawingSynced, reopenedNotesInPresenter: true, nestedReveal: true, unsupportedMutationDisabled: true, screenshotCaptured: true }, null, 2));
} catch (error) {
  if (session?.cdp) {
    try {
      const screenshot = await session.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await writeFile(join(artifactsPath, "failure.png"), Buffer.from(screenshot.data, "base64"));
    } catch {}
  }
  console.error(error?.stack ?? String(error));
  console.error(`Artifacts retained at ${artifactsPath}`);
  process.exitCode = 1;
} finally {
  await shutdown(session);
  if (!process.exitCode) await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

async function launch(name, filePath) {
  const port = 39000 + Math.floor(Math.random() * 1500);
  const profile = join(tempRoot, `profile-${name}`);
  const logs = [];
  const child = spawn(electronPath, [mainPath, filePath], {
    cwd: repoRoot,
    env: { ...process.env, HSS_REMOTE_DEBUGGING_PORT: String(port), HSS_USER_DATA_DIR: profile, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  const target = await waitForTarget(`http://127.0.0.1:${port}`, (item) => item.type === "page" && item.title.includes("HTML Slide Studio"), 30_000);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  return { child, cdp, logs, profile, port };
}

async function shutdown(current) {
  if (!current) return;
  try { current.cdp?.close(); } catch {}
  if (current.child?.pid) {
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
}

async function click(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  assert.equal(clicked, true, `click target not found: ${selector}`);
}

async function clickAtSelector(cdp, selector, modifiers = 0) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `click target not found: ${selector}`);
  await clickAtPoint(cdp, point.x, point.y, modifiers);
}

async function clickAtPoint(cdp, x, y, modifiers = 0, clickCount = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount, modifiers });
}

async function doubleClickAtSelector(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `double-click target not found: ${selector}`);
  await clickAtPoint(cdp, point.x, point.y, 0, 1);
  await clickAtPoint(cdp, point.x, point.y, 0, 2);
}

async function clickButtonByText(cdp, selector, label) {
  const clicked = await evaluate(cdp, `(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  assert.equal(clicked, true, `button not found: ${label}`);
}

async function clickButtonContainingText(cdp, selector, label) {
  const clicked = await evaluate(cdp, `(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate) => candidate.textContent?.includes(${JSON.stringify(label)})); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
  assert.equal(clicked, true, `button containing text not found: ${label}`);
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
  assert.equal(changed, true, `input not found: ${selector}`);
}
