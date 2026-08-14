import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, evaluate, waitForAnimationFrames, waitForEval, waitForTarget } from "./lib/cdp.mjs";

const electronPath = resolve("node_modules/electron/dist/electron.exe");
const mainPath = resolve("out/main/main.js");
const tempRoot = await mkdtemp(join(tmpdir(), "hss-demo-check-e2e-"));
const profilePath = join(tempRoot, "profile");
const port = 41300 + Math.floor(Math.random() * 600);
const evidenceDirectory = process.env.HSS_DEMO_CHECK_EVIDENCE_DIR
  ? resolve(process.env.HSS_DEMO_CHECK_EVIDENCE_DIR)
  : null;
const logs = [];
let child = null;
let cdp = null;

try {
  child = spawn(electronPath, [mainPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(port),
      HSS_USER_DATA_DIR: profilePath,
      ELECTRON_ENABLE_LOGGING: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const target = await waitForTarget(
    `http://127.0.0.1:${port}`,
    (candidate) => candidate.type === "page" && candidate.title.includes("HTML Slide Studio"),
    30_000
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitForEval(cdp, "Boolean(document.querySelector('.welcome-screen'))", 30_000);
  assert.equal(await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.welcome-screen__actions button'))
      .find((candidate) => candidate.textContent?.trim() === 'デモを開く');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`), true);
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 8", 30_000);

  const activeSlideBefore = await evaluate(cdp, "document.querySelector('.slide-list__item--active')?.textContent?.trim() ?? null");
  assert.equal(await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.editor-toolbar button'))
      .find((candidate) => candidate.textContent?.trim() === '確認');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`), true);
  await waitForEval(cdp, `document.querySelector('.app-status__message')?.textContent?.trim() === '全8枚のスライドを確認しました'`, 10_000);

  const report = await evaluate(cdp, `({
    activeSlideBefore: ${JSON.stringify(activeSlideBefore)},
    activeSlideAfter: document.querySelector('.slide-list__item--active')?.textContent?.trim() ?? null,
    issues: Array.from(document.querySelectorAll('.check-issue')).map((issue) => issue.textContent.trim())
  })`);

  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(evidenceDirectory, "check-results.png"), Buffer.from(screenshot.data, "base64"));
    for (let index = 0; index < report.issues.length; index += 1) {
      await evaluate(cdp, `document.querySelectorAll('.check-issue')[${index}]?.click()`);
      await waitForAnimationFrames(cdp, 2);
      const issueScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(
        join(evidenceDirectory, `issue-${String(index + 1).padStart(2, "0")}.png`),
        Buffer.from(issueScreenshot.data, "base64")
      );
    }
  }

  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.activeSlideAfter, report.activeSlideBefore, "running Check must not change the visible slide");
  assert.deepEqual(report.issues, [], "the bundled demo must not report false positive issues");
} catch (error) {
  console.error(logs.join(""));
  throw error;
} finally {
  try { cdp?.close(); } catch {}
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
