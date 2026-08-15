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
const mixedFixturePath = resolve("tests/fixtures/mixed-data-slide.html");
const securityFixturePath = resolve("tests/fixtures/security-boundaries.html");

const tempRoot = await mkdtemp(join(tmpdir(), "hss-legacy-e2e-"));
const htmlPath = join(tempRoot, "workflow.html");
const revealPath = join(tempRoot, "reveal-nested.html");
const unsupportedPath = join(tempRoot, "unsupported-body-sections.html");
const mixedPath = join(tempRoot, "mixed-data-slide.html");
const securityPath = join(tempRoot, "security-boundaries.html");
const artifactsPath = join(tempRoot, "artifacts");
const reopenedPresenterSnapshotPath = join(tempRoot, "reopened-presenter-snapshot.json");
await mkdir(artifactsPath);
await copyFile(fixturePath, htmlPath);
await copyFile(revealFixturePath, revealPath);
await copyFile(unsupportedFixturePath, unsupportedPath);
await copyFile(mixedFixturePath, mixedPath);
await copyFile(securityFixturePath, securityPath);

let session = null;
let presenterNotesRoundTrip = false;
let presenterDrawingSynced = false;
let expectedSavedNotes = "E2E発表メモ";
try {
  session = await launch("first", htmlPath);
  const { cdp } = session;
  await waitForEval(cdp, "Boolean(document.querySelector('.app-shell') && document.querySelector('iframe.slide-frame'))", 30_000);
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 2", 30_000);
  await waitForEval(cdp, `(() => {
    const viewport = document.querySelector('.canvas-viewport--fit');
    const frame = document.querySelector('iframe.slide-frame');
    const root = frame?.contentDocument?.documentElement;
    if (!(viewport instanceof HTMLElement) || !root || !frame?.contentWindow) return false;
    return getComputedStyle(viewport).overflow === 'hidden' && frame.contentWindow.getComputedStyle(root).overflow === 'hidden';
  })()`, 30_000);

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

  await clickAtSelector(cdp, '.editor-toolbar button[aria-label="確認"]');
  await waitForEval(cdp, `(() => {
    const panel = document.querySelector('.check-panel');
    return panel?.textContent.includes('全2枚で') && panel?.textContent.includes('まとめ /') && panel?.textContent.includes('文字が小さすぎる可能性があります');
  })()`, 30_000);
  const deckReview = await evaluate(cdp, `(() => ({
    summary: document.querySelector('.check-panel__heading span')?.textContent,
    issues: Array.from(document.querySelectorAll('.check-issue')).map((issue) => issue.textContent.trim()),
    currentSlide: document.querySelector('.slide-list__item[aria-current="page"] .slide-list__label')?.textContent
  }))()`);
  assert.match(deckReview.summary ?? "", /全2枚で\d+件/);
  assert.ok(deckReview.issues.some((issue) => issue.includes('2. まとめ') && issue.includes('小さい注釈')));
  assert.ok(deckReview.issues.some((issue) => issue.includes('2. まとめ') && issue.includes('flex配置を保って測定する確認文') && issue.includes('枠からはみ出している')));
  assert.ok(!deckReview.issues.some((issue) => issue.includes('可視グリフの正常な行高')), "visible glyph ink outside the line box is not clipping");
  assert.ok(!deckReview.issues.some((issue) => issue.includes('正常に折り返す確認文')), "healthy wrapping is not clipping");
  assert.ok(deckReview.issues.some((issue) => issue.includes('2. まとめ') && issue.includes('外部参照の確認') && issue.includes('外部ファイルに依存しています')));
  assert.ok(deckReview.issues.some((issue) => issue.includes('2. まとめ') && issue.includes('review-source.png') && issue.includes('外部ファイルに依存しています')));
  assert.equal(deckReview.currentSlide, "はじめに", "deck-wide review must not visibly page through the slides");

  await clickAtSelector(cdp, '.check-issue--warning');
  await waitForEval(cdp, `(() => {
    const active = document.querySelector('.slide-list__item[aria-current="page"] .slide-list__label')?.textContent;
    return active === 'まとめ' && document.querySelectorAll('.selection-outline').length === 1;
  })()`);
  await clickAtSelector(cdp, '.slide-list__item:nth-child(1) .slide-list__thumb');
  await clickButtonContainingText(cdp, '.check-issue', '外部ファイルに依存しています');
  await waitForEval(cdp, `(() => {
    const active = document.querySelector('.slide-list__item[aria-current="page"] .slide-list__label')?.textContent;
    const frame = document.querySelector('iframe.slide-frame');
    const selected = frame?.contentDocument?.querySelector('#fixture-external-link');
    return active === 'まとめ' && selected?.getAttribute('data-hss-id') && document.querySelectorAll('.selection-outline').length === 1;
  })()`);
  await clickAtSelector(cdp, '.slide-list__item:nth-child(1) .slide-list__thumb');
  await clickButtonContainingText(cdp, '.check-issue', 'review-source.png');
  await waitForEval(cdp, `(() => {
    const active = document.querySelector('.slide-list__item[aria-current="page"] .slide-list__label')?.textContent;
    return active === 'まとめ' && document.querySelectorAll('.selection-outline').length === 1;
  })()`);
  await clickAtSelector(cdp, '.check-panel__heading button[aria-label="閉じる"]');
  await clickAtSelector(cdp, '.slide-list__item:nth-child(1) .slide-list__thumb');
  await waitForEval(cdp, `document.querySelector('.slide-list__item[aria-current="page"] .slide-list__label')?.textContent === 'はじめに'`);

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 560, deviceScaleFactor: 1, mobile: false });
  await waitForEval(cdp, "window.innerWidth === 760 && window.innerHeight === 560");
  const narrowLayout = await evaluate(cdp, `(() => {
    const buttons = Array.from(document.querySelectorAll('.editor-toolbar button'));
    const toolbar = document.querySelector('.editor-toolbar');
    const workspace = document.querySelector('.workspace-grid');
    const viewport = document.querySelector('.canvas-viewport--fit');
    return {
      viewportWidth: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      toolbarOverflow: toolbar ? toolbar.scrollWidth > toolbar.clientWidth : true,
      workspaceOverflow: workspace ? workspace.scrollWidth > workspace.clientWidth : true,
      actionsReachable: buttons.length === 8 && buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }),
      canvasFitNoScroll: viewport ? getComputedStyle(viewport).overflow === 'hidden' : false
    };
  })()`);
  assert.deepEqual(narrowLayout, {
    viewportWidth: 760,
    overflowX: false,
    toolbarOverflow: false,
    workspaceOverflow: false,
    actionsReachable: true,
    canvasFitNoScroll: true
  });
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await waitForEval(cdp, "window.innerWidth > 760");

  let sourceHeadingPoint = await sourceTextCaretPoint(cdp, "#fixture-title", 2);
  await clickAtPoint(cdp, sourceHeadingPoint.x, sourceHeadingPoint.y);
  await waitForEval(cdp, "document.querySelectorAll('.selection-outline').length === 1 && document.querySelectorAll('.selection-move-edge').length === 4");

  const sourceBoxBeforeMove = await sourceElementBox(cdp, "#fixture-title");
  await dragSelector(cdp, ".selection-move-edge--top", 24, 12);
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const heading = frame?.contentDocument?.querySelector('#fixture-title');
    const box = heading?.getBoundingClientRect();
    return Boolean(box && (Math.abs(box.left - ${sourceBoxBeforeMove.left}) > 3 || Math.abs(box.top - ${sourceBoxBeforeMove.top}) > 3));
  })()`);
  await clickAtSelector(cdp, '.editor-toolbar button[aria-label="元に戻す"]');
  await waitForSourceBox(cdp, "#fixture-title", sourceBoxBeforeMove);

  const sourceBoxBeforeResize = await sourceElementBox(cdp, "#fixture-title");
  await dragSelector(cdp, ".selection-handle--se", 32, 18);
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const heading = frame?.contentDocument?.querySelector('#fixture-title');
    return (heading?.getBoundingClientRect().width ?? 0) > ${sourceBoxBeforeResize.width + 3};
  })()`);
  await clickAtSelector(cdp, '.editor-toolbar button[aria-label="元に戻す"]');
  await waitForSourceBox(cdp, "#fixture-title", sourceBoxBeforeResize);

  sourceHeadingPoint = await sourceTextCaretPoint(cdp, "#fixture-title", 2);
  const sourceBoxBeforeEdit = await sourceElementBox(cdp, "#fixture-title");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
  await clickAtPoint(cdp, sourceHeadingPoint.x, sourceHeadingPoint.y);
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const heading = frame?.contentDocument?.querySelector('#fixture-title');
    const selection = frame?.contentWindow?.getSelection();
    return heading?.getAttribute('contenteditable') === 'true' && frame?.contentDocument?.activeElement === heading && Boolean(selection?.isCollapsed) && selection?.anchorOffset === 2;
  })()`);
  assert.deepEqual(await sourceElementBox(cdp, "#fixture-title"), sourceBoxBeforeEdit, "an interior click must enter text editing without moving the source element");
  const sourceCompositionGuarded = await evaluate(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const heading = frame?.contentDocument?.querySelector('#fixture-title');
    if (!(heading instanceof frame.contentWindow.HTMLElement)) return false;
    heading.dispatchEvent(new frame.contentWindow.CompositionEvent('compositionstart', { bubbles: true, data: 'を' }));
    const escape = new frame.contentWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
    heading.dispatchEvent(escape);
    const guarded = !escape.defaultPrevented && heading.getAttribute('contenteditable') === 'true';
    heading.dispatchEvent(new frame.contentWindow.CompositionEvent('compositionend', { bubbles: true, data: 'を' }));
    return guarded;
  })()`);
  assert.equal(sourceCompositionGuarded, true, "source text editing must not handle Escape while IME composition is active");
  await cdp.send('Input.insertText', { text: 'を' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await waitForEval(cdp, `document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title')?.textContent === 'AI講義のはじめに'`);
  await waitForEval(cdp, `document.querySelector('.editor-toolbar__document span:last-child')?.textContent === '保存済み'`);
  assert.equal(await evaluate(cdp, "document.querySelector('.editor-toolbar button[aria-label=\"元に戻す\"]')?.disabled"), true, "typing back to the session original must remove the no-op history entry");

  await cdp.send('Input.insertText', { text: 'を' });
  await waitForEval(cdp, `document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title')?.textContent === 'AIを講義のはじめに'`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
  await waitForEval(cdp, `(() => {
    const heading = document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title');
    return heading?.textContent === 'AI講義のはじめに' && heading?.getAttribute('contenteditable') !== 'true';
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2 });
  await waitForEval(cdp, `document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title')?.textContent === 'AIを講義のはじめに'`);
  assert.equal(await evaluate(cdp, "document.querySelector('.editor-toolbar button[aria-label=\"元に戻す\"]')?.disabled"), false, "source text input must enable toolbar Undo immediately");
  await clickAtSelector(cdp, '.editor-toolbar button[aria-label="元に戻す"]');
  await waitForEval(cdp, `document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title')?.textContent === 'AI講義のはじめに'`);

  const paragraphPoint = await sourceTextCaretPoint(cdp, "p[aria-labelledby='fixture-title']", 2);
  await clickAtPoint(cdp, paragraphPoint.x, paragraphPoint.y);
  sourceHeadingPoint = await sourceTextCaretPoint(cdp, "#fixture-title", 2);
  await clickAtPoint(cdp, sourceHeadingPoint.x, sourceHeadingPoint.y);
  await waitForEval(cdp, "document.querySelectorAll('.selection-outline').length === 1");
  await clickAtPoint(cdp, sourceHeadingPoint.x, sourceHeadingPoint.y);
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const heading = frame?.contentDocument?.querySelector('#fixture-title');
    return heading?.getAttribute('contenteditable') === 'true' && frame?.contentWindow?.getSelection()?.toString() === heading?.textContent;
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await waitForEval(cdp, `document.querySelector('iframe.slide-frame')?.contentDocument?.querySelector('#fixture-title')?.getAttribute('contenteditable') !== 'true'`);

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
  const fontChoices = await evaluate(cdp, "Array.from(document.querySelectorAll('select[aria-label=\"フォント\"] option')).map((option) => option.textContent?.trim())");
  assert.ok(fontChoices.includes("Meiryo UI"), "the text formatting menu must offer Meiryo UI");
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
  assert.equal(await evaluate(cdp, `(() => {
    const element = document.querySelector('.overlay-text__content');
    return element?.getAttribute('contenteditable') === 'true' && document.activeElement === element;
  })()`), true, "a single click on selected overlay text must immediately enter caret editing");
  const overlayCompositionGuarded = await evaluate(cdp, `(() => {
    const element = document.querySelector('.overlay-text__content');
    if (!(element instanceof HTMLElement)) return false;
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '字' }));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
    element.dispatchEvent(escape);
    const guarded = !escape.defaultPrevented && element.getAttribute('contenteditable') === 'true';
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '字' }));
    return guarded;
  })()`);
  assert.equal(overlayCompositionGuarded, true, "overlay text editing must not handle Escape while IME composition is active");
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
  await cdp.send('Input.insertText', { text: 'ショートカットUndo対象' });
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.textContent === 'ショートカットUndo対象'");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2 });
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.textContent === 'テキストを入力'");
  await doubleClickAtSelector(cdp, '.overlay-text__content');
  await cdp.send('Input.insertText', { text: '新しいUndo対象' });
  await waitForEval(cdp, "document.querySelector('#inspector-text')?.value === '新しいUndo対象' && document.querySelector('.app-status')?.textContent.includes('未保存')");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2 });
  assert.equal(await evaluate(cdp, "document.querySelector('.overlay-text__content')?.textContent"), "新しいUndo対象", "new input after Undo must invalidate the stale Redo value");
  assert.equal(await evaluate(cdp, "document.querySelector('.editor-toolbar button[aria-label=\"元に戻す\"]')?.disabled"), false, "inline text input must immediately enable toolbar Undo");
  await clickAtSelector(cdp, '.editor-toolbar button[aria-label="元に戻す"]');
  await waitForEval(cdp, "document.querySelector('.overlay-text__content')?.getAttribute('contenteditable') !== 'true'");
  await waitForEval(cdp, "document.querySelector('#inspector-text')?.value === 'テキストを入力' && document.querySelector('.overlay-text__content')?.textContent === 'テキストを入力'");
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

  await clickAtSelector(cdp, '.editor-toolbar button[aria-label^="確認"]');
  await waitForEval(cdp, "Boolean(document.querySelector('.check-panel'))");
  await clickButtonByText(cdp, ".editor-toolbar button", "発表");
  await waitForEval(cdp, "Boolean(document.querySelector('.audience-mode'))", 20_000);
  const presentationMode = await waitForEval(cdp, `(() => {
    const audience = document.querySelector('.audience-mode');
    if (!audience) return '';
    return audience.querySelector('.audience-mode__controls') ? 'single' : 'dual';
  })()`, 20_000);
  const dualModeExpected = presentationMode === "dual";
  if (dualModeExpected) {
    await waitForEval(cdp, "!document.querySelector('.audience-mode__controls')", 10_000);
  }
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('.audience-mode iframe');
    return frame instanceof HTMLIFrameElement && frame.contentDocument?.readyState === 'complete';
  })()`, 10_000);
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('.audience-mode iframe');
    if (!(frame instanceof HTMLIFrameElement)) return false;
    window.__hssAudienceFrameWindow = frame.contentWindow;
    window.__hssAudienceFrameLoads = 0;
    frame.addEventListener('load', () => { window.__hssAudienceFrameLoads += 1; });
    return true;
  })()`, 10_000);
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
    await waitForEval(livePresenterCdp, `(() => {
      const frame = document.querySelector('.presenter-current iframe');
      return frame instanceof HTMLIFrameElement && frame.contentDocument?.readyState === 'complete';
    })()`, 10_000);
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
    try {
      await evaluate(livePresenterCdp, "document.querySelector('.presenter-end-button')?.click()");
    } catch (error) {
      if (!(error instanceof Error) || !/CDP command timed out|WebSocket|closed/i.test(error.message)) throw error;
    }
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
  const duplicateReferences = await evaluate(session.cdp, `(() => {
    const root = document.querySelector('iframe.slide-frame')?.contentDocument;
    if (!root) return { pass: false, reason: 'missing frame' };
    const copiedHeading = root.querySelector('[id^="parent-heading-copy"]');
    const slide = copiedHeading?.closest('section.slide');
    if (!slide) return { pass: false, reason: 'missing current duplicate slide' };
    const ids = new Set(Array.from(slide.querySelectorAll('[id]'), (element) => element.id));
    const references = [];
    for (const [selector, attribute] of [
      ['label[for]', 'for'],
      ['input[list]', 'list'],
      ['input[form]', 'form'],
      ['td[headers]', 'headers'],
      ['[aria-activedescendant]', 'aria-activedescendant'],
      ['[aria-controls]', 'aria-controls'],
      ['[aria-describedby]', 'aria-describedby'],
      ['[aria-details]', 'aria-details'],
      ['[aria-errormessage]', 'aria-errormessage'],
      ['[aria-flowto]', 'aria-flowto'],
      ['[aria-labelledby]', 'aria-labelledby'],
      ['[aria-owns]', 'aria-owns']
    ]) {
      const element = slide.querySelector(selector);
      if (!element) return { pass: false, reason: 'missing ' + selector };
      references.push(...(element.getAttribute(attribute) ?? '').split(/\\s+/).filter(Boolean));
    }
    for (const element of slide.querySelectorAll('[href], use')) {
      for (const attribute of ['href', 'xlink:href']) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith('#')) references.push(value.slice(1));
      }
    }
    for (const element of slide.querySelectorAll('[style], style')) {
      const text = element instanceof HTMLStyleElement ? element.textContent ?? '' : element.getAttribute('style') ?? '';
      for (const match of text.matchAll(/url\\(\\s*["']?#([^)"']+)["']?\\s*\\)/g)) references.push(match[1]);
    }
    return {
      pass: references.length >= 16 && references.every((id) => ids.has(id) && id.includes('-copy')),
      references
    };
  })()`);
  assert.equal(duplicateReferences.pass, true, duplicateReferences.reason ?? "duplicated ID references must stay internal");
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
  session = await launch("mixed", mixedPath);
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 1", 30_000);
  const mixed = await evaluate(session.cdp, `({
    addDisabled: document.querySelector('.slide-navigator__heading button')?.disabled,
    duplicateDisabled: document.querySelector('.slide-navigator__actions button')?.disabled,
    reason: document.querySelector('.slide-navigator__notice')?.textContent
  })`);
  assert.equal(mixed.addDisabled, true);
  assert.equal(mixed.duplicateDisabled, true);
  assert.match(mixed.reason ?? "", /安全に判定できない/);

  await shutdown(session);
  session = await launch("security", securityPath);
  await waitForEval(session.cdp, "document.querySelectorAll('.slide-list__item').length === 1", 30_000);
  const securityBoundaries = await evaluate(session.cdp, `(() => {
    const root = document.querySelector('iframe.slide-frame')?.contentDocument;
    if (!root) return null;
    return {
      headingText: root.querySelector('#security-title')?.textContent,
      injectedNode: Boolean(root.querySelector('#attribute-injection')),
      javascriptHref: root.querySelector('#javascript-link')?.hasAttribute('href'),
      dataSource: root.querySelector('#data-image')?.hasAttribute('src'),
      embeddedHtml: root.querySelector('#embedded-html')?.hasAttribute('srcdoc')
    };
  })()`);
  assert.deepEqual(securityBoundaries, {
    headingText: "安全な見出し",
    injectedNode: false,
    javascriptHref: false,
    dataSource: false,
    embeddedHtml: false
  });

  await shutdown(session);
  session = null;
  const presenterEvidence = execFileSync(process.execPath, [resolve("tests/e2e/presenter.mjs"), reopenedPresenterSnapshotPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 90_000
  });
  assert.match(presenterEvidence, /"reopenedSaveChain": true/);

  console.log(JSON.stringify({ pass: true, slides: 4, deckWideReview: true, overwrite: true, reopen: true, presenterNotesRoundTrip, presenterDrawingSynced, reopenedNotesInPresenter: true, nestedReveal: true, duplicateReferencesRemapped: true, unsupportedMutationDisabled: true, mixedTagMutationDisabled: true, maliciousRuntimeMarkerIgnored: true, unsafeUrlsRemoved: true, screenshotCaptured: true }, null, 2));
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

async function sourceTextCaretPoint(cdp, selector, offset) {
  const point = await evaluate(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const element = frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    const textNode = element?.firstChild;
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow || !(element instanceof frame.contentWindow.HTMLElement) || !(textNode instanceof frame.contentWindow.Text)) return null;
    const range = frame.contentDocument.createRange();
    range.setStart(textNode, Math.max(0, ${offset} - 1));
    range.setEnd(textNode, ${offset});
    const caretRect = range.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const scale = frameRect.width / 1366;
    return {
      x: frameRect.left + (caretRect.right - 1) * scale,
      y: frameRect.top + (caretRect.top + caretRect.height / 2) * scale
    };
  })()`);
  assert.ok(point, `source text caret target not found: ${selector}`);
  return point;
}

async function sourceElementBox(cdp, selector) {
  const box = await evaluate(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const element = frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow || !(element instanceof frame.contentWindow.HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  })()`);
  assert.ok(box, `source element not found: ${selector}`);
  return box;
}

async function waitForSourceBox(cdp, selector, expected) {
  await waitForEval(cdp, `(() => {
    const frame = document.querySelector('iframe.slide-frame');
    const element = frame?.contentDocument?.querySelector(${JSON.stringify(selector)});
    const rect = element?.getBoundingClientRect();
    return Boolean(rect
      && Math.abs(rect.left - ${expected.left}) <= 1
      && Math.abs(rect.top - ${expected.top}) <= 1
      && Math.abs(rect.width - ${expected.width}) <= 1
      && Math.abs(rect.height - ${expected.height}) <= 1);
  })()`);
}

async function dragSelector(cdp, selector, deltaX, deltaY) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `drag target not found: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + deltaX, y: point.y + deltaY, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + deltaX, y: point.y + deltaY, button: 'left', buttons: 0, clickCount: 1 });
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
