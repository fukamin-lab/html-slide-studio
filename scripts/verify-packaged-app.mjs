import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveLocalEndpoint } from "./lib/local-endpoint.mjs";

const projectRoot = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const portablePath = resolve("release/HTML Slide Studio.exe");
const payloadPath = resolve("release/win-arm64-unpacked/HTML Slide Studio.exe");
const zipPath = resolve("release/HTML Slide Studio-" + packageJson.version + "-arm64-win.zip");
const endpoint = resolveLocalEndpoint(projectRoot);

assert.equal(await readPeMachine(payloadPath), 0xaa64, "Packaged Electron payload must be native Windows ARM64");
assertElectronFuses(payloadPath);
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
for (const entry of [
  "resources/LICENSE",
  "resources/THIRD_PARTY_NOTICES.md",
  "LICENSE.electron.txt",
  "LICENSES.chromium.html"
]) {
  assert.equal(zipEntries.includes(entry), true, "ZIP must include " + entry);
}
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

const asarPath = resolve("release/win-arm64-unpacked/resources/app.asar");
const asarList = execFileSync(
  process.execPath,
  [resolve("node_modules/@electron/asar/bin/asar.js"), "list", asarPath],
  { encoding: "utf8" }
);
assert.equal(/(?:^|[\\/])node_modules(?:[\\/]|$)/m.test(asarList), false, "Packaged app.asar must not contain node_modules");
assert.match(asarList, /out[\\/]preload[\\/]preload\.cjs/, "Packaged app.asar must include the editor preload");
assert.match(asarList, /out[\\/]preload[\\/]presenter\.cjs/, "Packaged app.asar must include the presenter preload");
const asarBytes = await readFile(asarPath);
for (const forbidden of [
  "C:\\dev\\fukamin",
  ["HTML Slide Studio", "Legacy"].join(" "),
  "PROJECT_ID.json",
  "LOCAL_ENDPOINT.json"
]) {
  assert.equal(
    asarBytes.includes(Buffer.from(forbidden, "utf8")),
    false,
    "Packaged app.asar contains internal reference: " + forbidden
  );
}

await assertPortAvailable(endpoint.host, endpoint.port);
const verificationRoot = await mkdtemp(join(tmpdir(), "hss-package-"));
assert.equal(resolve(verificationRoot).startsWith(resolve(tmpdir())), true, "verification directory must remain under system temp");
assert.match(basename(verificationRoot), /^hss-package-/, "verification directory must use the owned prefix");
const profilePath = join(verificationRoot, "profile");

const logs = [];
let child = null;
let helper = null;
let verificationResult = null;
try {
  await verifySecuritySensitiveSwitchRejected(portablePath, endpoint, join(verificationRoot, "rejected-profile"));

  const ignoredEnvironmentPort = endpoint.port + 1;
  await assertPortAvailable(endpoint.host, ignoredEnvironmentPort);
  child = spawn(portablePath, ["--user-data-dir=" + profilePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HSS_REMOTE_DEBUGGING_PORT: String(ignoredEnvironmentPort),
      HSS_USER_DATA_DIR: join(verificationRoot, "ignored-environment-profile"),
      ELECTRON_RENDERER_URL: "https://renderer-environment-must-be-ignored.invalid",
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect=127.0.0.1:" + ignoredEnvironmentPort
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const uiLogs = [];
  helper = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve("scripts/verify-packaged-ui.ps1"),
    "-RootProcessId", String(child.pid),
    "-TimeoutMs", "120000"
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  helper.stdout.on("data", (chunk) => uiLogs.push(chunk.toString()));
  helper.stderr.on("data", (chunk) => uiLogs.push(chunk.toString()));
  const uiExit = await waitForProcessExit(helper, 130_000, "Packaged UI verifier");
  const uiLog = uiLogs.join("");
  assert.equal(uiExit.code, 0, "Packaged Windows accessibility verification failed:\n" + uiLog);
  const uiState = parseLastJsonLine(uiLog);
  assert.deepEqual(
    {
      pass: uiState.pass,
      packagedDemoOpenedFromWelcome: uiState.packagedDemoOpenedFromWelcome,
      documentName: uiState.documentName,
      slideCount: uiState.slideCount,
      dirtyTextAdded: uiState.dirtyTextAdded
    },
    {
      pass: true,
      packagedDemoOpenedFromWelcome: true,
      documentName: "html-slide-studio-demo.html",
      slideCount: 8,
      dirtyTextAdded: true
    }
  );
  await assertPortAvailable(endpoint.host, ignoredEnvironmentPort);

  verificationResult = {
    pass: true,
    executable: portablePath,
    payloadMachine: "0xAA64",
    packagedDebuggingSwitchRejected: true,
    packagedEnvironmentInjectionIgnored: true,
    packagedDemoOpenedFromWelcome: true,
    state: uiState
  };

  assert.equal(isChildRunning(child), true, "Portable launcher exited before native window-close verification");
  const cancelLog = await confirmUnsavedClose(child, "Cancel");
  const cancelPayloadPid = assertDialogProcessIds(cancelLog, "Cancel");
  assert.equal(isChildRunning(child), true, "Packaged app must remain running after canceling the unsaved-close dialog");
  assert.equal(isProcessRunning(cancelPayloadPid), true, "Packaged payload process must remain running after canceling close");

  const discardLog = await confirmUnsavedClose(child, "Discard");
  const discardPayloadPid = assertDialogProcessIds(discardLog, "Discard");
  await waitForProcessExit(child, 30_000, "Packaged app");
  assert.equal(isProcessRunning(discardPayloadPid), false, "Packaged payload process must exit after discarding changes");
  verificationResult.nativeDirtyWindowClose = true;
  verificationResult.nativeUnsavedDialogCancelVerified = true;
  verificationResult.nativeUnsavedDialogConfirmed = true;
} catch (error) {
  console.error(logs.join(""));
  throw error;
} finally {
  let terminationError = null;
  for (const item of [[helper, "Packaged UI verifier"], [child, "Packaged app"]]) {
    const processToStop = item[0];
    const label = item[1];
    if (processToStop?.pid && isChildRunning(processToStop)) {
      try {
        execFileSync("taskkill", ["/pid", String(processToStop.pid), "/t", "/f"], { stdio: "ignore" });
        await waitForProcessExit(processToStop, 30_000, label + " cleanup");
      } catch (error) {
        terminationError ??= error;
      }
    }
  }
  await rm(verificationRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (terminationError) throw terminationError;
}

console.log(JSON.stringify(verificationResult, null, 2));

function readZipEntry(archivePath, entryName) {
  return execFileSync("tar", ["-xOf", archivePath, entryName], { maxBuffer: 64 * 1024 * 1024 });
}

function assertElectronFuses(executablePath) {
  const report = execFileSync(
    process.execPath,
    [resolve("node_modules/@electron/fuses/dist/bin.js"), "read", "--app", executablePath],
    { encoding: "utf8" }
  );
  const expected = {
    RunAsNode: "Disabled",
    EnableCookieEncryption: "Enabled",
    EnableNodeOptionsEnvironmentVariable: "Disabled",
    EnableNodeCliInspectArguments: "Disabled",
    EnableEmbeddedAsarIntegrityValidation: "Enabled",
    OnlyLoadAppFromAsar: "Enabled",
    LoadBrowserProcessSpecificV8Snapshot: "Disabled",
    GrantFileProtocolExtraPrivileges: "Enabled"
  };
  for (const [name, state] of Object.entries(expected)) {
    assert.match(report, new RegExp("\\b" + name + " is " + state + "\\b"), "Unexpected Electron fuse: " + name + "\\n" + report);
  }
}

async function verifySecuritySensitiveSwitchRejected(executablePath, localEndpoint, rejectedProfilePath) {
  for (const [label, securitySwitch] of [
    ["remote debugging", "--remote-debugging-port=" + localEndpoint.port],
    ["slash no-sandbox", "/no-sandbox"],
    ["single-dash no-sandbox", "-no-sandbox"]
  ]) {
    const profilePath = `${rejectedProfilePath}-${label.replaceAll(" ", "-")}`;
    const rejectedLogs = [];
    const rejected = spawn(executablePath, [securitySwitch, "--user-data-dir=" + profilePath], {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    rejected.stdout.on("data", (chunk) => rejectedLogs.push(chunk.toString()));
    rejected.stderr.on("data", (chunk) => rejectedLogs.push(chunk.toString()));
    try {
      const rejectedExit = await waitForProcessExit(rejected, 30_000, `Packaged ${label} rejection`);
      assert.notEqual(rejectedExit.code, 0, `Packaged app must fail closed when ${label} is requested.`);
      assert.deepEqual(processesUsingProfile(profilePath), [], `Rejected ${label} startup must not leave a payload process.`);
    } catch (error) {
      if (rejected.pid && isChildRunning(rejected)) {
        execFileSync("taskkill", ["/pid", String(rejected.pid), "/t", "/f"], { stdio: "ignore" });
        await waitForProcessExit(rejected, 10_000, "Rejected packaged app cleanup");
      }
      throw new Error(`Packaged app did not reject ${label} startup.\n${rejectedLogs.join("")}`, { cause: error });
    }
  }
  await assertPortAvailable(localEndpoint.host, localEndpoint.port);
}

function processesUsingProfile(profilePath) {
  const escaped = profilePath.replaceAll("'", "''");
  const output = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$needle='${escaped}'; @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $needle + '*') } | ForEach-Object { $_.ProcessId }) -join ','`
  ], { encoding: "utf8", windowsHide: true }).trim();
  return output ? output.split(",").map((value) => Number(value)) : [];
}

async function confirmUnsavedClose(rootProcess, action) {
  const confirmationLogs = [];
  const confirmer = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve("scripts/confirm-unsaved-close.ps1"),
    "-RootProcessId", String(rootProcess.pid),
    "-Action", action,
    "-TimeoutMs", "20000"
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  confirmer.stdout.on("data", (chunk) => confirmationLogs.push(chunk.toString()));
  confirmer.stderr.on("data", (chunk) => confirmationLogs.push(chunk.toString()));
  const exit = await waitForProcessExit(confirmer, 25_000, "Unsaved-close " + action + " confirmer");
  const log = confirmationLogs.join("");
  assert.equal(exit.code, 0, "Owned unsaved-close " + action + " action was not confirmed:\n" + log);
  return log;
}

function parseLastJsonLine(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error("Packaged UI verifier did not return JSON:\n" + output);
}

async function assertPortAvailable(host, port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host, port, exclusive: true }, resolveListen);
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function waitForProcessExit(childProcess, timeoutMs, label = "Process") {
  if (!isChildRunning(childProcess)) return { code: childProcess.exitCode, signal: childProcess.signalCode };
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      childProcess.off("exit", onExit);
      rejectExit(new Error(label + " did not exit within " + timeoutMs + "ms"));
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
  const confirmMatch = log.match(new RegExp("confirmed:" + action + ":(\\d+)"));
  assert.ok(closeMatch, "Dialog verifier must request a native close on the owned payload window");
  assert.ok(confirmMatch, "Dialog verifier must confirm " + action + " on the owned payload window");
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
