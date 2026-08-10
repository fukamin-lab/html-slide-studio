import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpClient, evaluate, waitForEval, waitForTarget } from "./lib/cdp.mjs";

const electronPath = resolve("node_modules/electron/dist/electron.exe");
const mainPath = resolve("out/main/main.js");
const templatePath = resolve("demo/html-slide-studio-demo.html");
const templateBytes = await readFile(templatePath);
const tempRoot = await mkdtemp(join(tmpdir(), "hss-demo-e2e-"));
const profilePath = join(tempRoot, "profile");
const port = 40500 + Math.floor(Math.random() * 800);
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
  await waitForEval(cdp, "Boolean(document.querySelector('.welcome-screen'))", 30_000);
  const actions = await evaluate(cdp, "Array.from(document.querySelectorAll('.welcome-screen__actions button')).map((button) => button.textContent.trim())");
  assert.deepEqual(actions, ["HTMLファイルを開く", "デモを開く"]);
  const clicked = await evaluate(cdp, `(() => {
    const button = Array.from(document.querySelectorAll('.welcome-screen__actions button'))
      .find((candidate) => candidate.textContent?.trim() === 'デモを開く');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true);
  await waitForEval(cdp, "document.querySelectorAll('.slide-list__item').length === 8", 30_000);
  assert.deepEqual(await evaluate(cdp, `({
    documentName: document.querySelector('.editor-toolbar__document strong')?.textContent,
    slides: document.querySelectorAll('.slide-list__item').length,
    demoBridge: typeof window.hss?.openDemoDocument === 'function'
  })`), { documentName: "html-slide-studio-demo.html", slides: 8, demoBridge: true });

  const workingBytes = await readFile(join(profilePath, "demo", "html-slide-studio-demo.html"));
  assert.deepEqual(workingBytes, templateBytes);
  assert.deepEqual(await readFile(templatePath), templateBytes, "bundled demo source must remain unchanged");
  console.log(JSON.stringify({ pass: true, welcomeAction: true, slides: 8, workingCopy: true, sourceUnchanged: true }, null, 2));
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
