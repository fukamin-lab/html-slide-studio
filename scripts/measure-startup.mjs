import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  getWindowsArtifactNames,
  parseWindowsArchitectures
} from "./lib/windows-package.mjs";

assert.equal(process.platform, "win32", "Startup measurement requires Windows");

const iterationsArgument = process.argv.find((argument) => argument.startsWith("--iterations="));
const iterations = Number(iterationsArgument?.split("=", 2)[1] ?? "3");
assert.equal(Number.isInteger(iterations) && iterations > 0 && iterations <= 10, true, "--iterations must be an integer from 1 to 10");

const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const [architectureName] = parseWindowsArchitectures(process.argv.slice(2), { allowAll: false });
const artifactNames = getWindowsArtifactNames(packageJson.version, architectureName);
const candidates = [
  {
    kind: "installed-payload",
    executable: resolve("release", artifactNames.unpackedDirectory, "HTML Slide Studio.exe")
  },
  {
    kind: "portable",
    executable: resolve("release", artifactNames.portable)
  }
];
await Promise.all(candidates.map((candidate) => access(candidate.executable)));

const measurements = [];
for (const candidate of candidates) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    measurements.push(await measureVisibleStartup(candidate, iteration));
  }
}

const summaries = Object.fromEntries(candidates.map((candidate) => {
  const values = measurements
    .filter((measurement) => measurement.kind === candidate.kind)
    .map((measurement) => measurement.visibleMs)
    .sort((left, right) => left - right);
  return [candidate.kind, {
    samplesMs: values,
    medianMs: median(values),
    minMs: values[0],
    maxMs: values.at(-1)
  }];
}));

const installedMedian = summaries["installed-payload"].medianMs;
const portableMedian = summaries.portable.medianMs;
console.log(JSON.stringify({
  pass: true,
  version: packageJson.version,
  architecture: architectureName,
  iterations,
  measurement: "process start to visible main window",
  measurements,
  summaries,
  installedPayloadSavedMs: portableMedian - installedMedian,
  installedPayloadReductionPercent: Math.round((portableMedian - installedMedian) / portableMedian * 1000) / 10,
  note: `The installed payload is measured from release/${artifactNames.unpackedDirectory}; an installed shortcut starts the same payload without portable self-extraction.`
}, null, 2));

async function measureVisibleStartup(candidate, iteration) {
  const profilePath = await mkdtemp(join(tmpdir(), "hss-startup-"));
  assert.match(basename(profilePath), /^hss-startup-/, "Owned startup profile prefix is required");
  const startedAtUnixMs = Date.now();
  let app = null;
  let probe = null;
  const appLogs = [];
  try {
    app = spawn(candidate.executable, [`--user-data-dir=${profilePath}`], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    app.stdout.on("data", (chunk) => appLogs.push(chunk.toString()));
    app.stderr.on("data", (chunk) => appLogs.push(chunk.toString()));
    await waitForSpawn(app, candidate.kind);

    const probeLogs = [];
    probe = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", resolve("scripts/verify-packaged-ui.ps1"),
      "-RootProcessId", String(app.pid),
      "-TimeoutMs", "60000",
      "-ProbeOnly",
      "-CloseAfterProbe"
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    probe.stdout.on("data", (chunk) => probeLogs.push(chunk.toString()));
    probe.stderr.on("data", (chunk) => probeLogs.push(chunk.toString()));
    await waitForSpawn(probe, "Startup visibility probe");
    const probeExit = await waitForExit(probe, 65_000, "Startup visibility probe");
    assert.equal(probeExit.code, 0, `Startup probe failed for ${candidate.kind}:\n${probeLogs.join("")}\n${appLogs.join("")}`);
    const probeResult = parseLastJsonLine(probeLogs.join(""));
    assert.deepEqual({ pass: probeResult.pass, ready: probeResult.ready, closed: probeResult.closed }, {
      pass: true,
      ready: true,
      closed: true
    });
    assert.equal(Number.isInteger(probeResult.visibleAtUnixMs), true, "Startup probe must report its window-detection timestamp");
    const visibleMs = probeResult.visibleAtUnixMs - startedAtUnixMs;
    assert.equal(visibleMs >= 0 && visibleMs <= 65_000, true, "Startup visibility timestamp is outside the measurement interval");
    await waitForExit(app, 30_000, `${candidate.kind} clean close`);
    return {
      kind: candidate.kind,
      iteration,
      visibleMs,
      executable: candidate.executable,
      windowProcessId: probeResult.processId
    };
  } finally {
    const cleanupErrors = [];
    for (const [child, label] of [[probe, "Startup visibility probe"], [app, candidate.kind]]) {
      try {
        await stopChildProcessTree(child, label);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    let profileProcessesGone = false;
    try {
      await terminateProfileProcesses(profilePath);
      profileProcessesGone = true;
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (profileProcessesGone) {
      try {
        await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `Startup measurement cleanup failed for ${candidate.kind}`);
    }
  }
}

function median(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
}

function parseLastJsonLine(output) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error(`Startup probe did not return JSON:\n${output}`);
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      child.off("error", onError);
      rejectExit(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      child.off("error", onError);
      resolveExit({ code, signal });
    };
    const onError = (error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      rejectExit(new Error(`${label} process error`, { cause: error }));
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForSpawn(child, label) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolveSpawn();
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      rejectSpawn(new Error(`${label} failed to spawn`, { cause: error }));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function killProcessTree(processId) {
  try {
    execFileSync("taskkill", ["/pid", String(processId), "/t", "/f"], { stdio: "ignore" });
  } catch {
    // A clean exit between the running check and taskkill needs no further action.
  }
}

async function stopChildProcessTree(child, label) {
  if (!child?.pid || !isChildRunning(child)) return;
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } catch (error) {
    if (isChildRunning(child)) {
      throw new Error(`${label} cleanup failed`, { cause: error });
    }
  }
  await waitForExit(child, 10_000, `${label} cleanup`);
}

function processesUsingProfile(profilePath) {
  const command = [
    "$needle=$env:HSS_OWNED_PROFILE",
    "@((Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $needle + '*') }).ProcessId) -join ','"
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, HSS_OWNED_PROFILE: profilePath }
  }).trim();
  return output ? output.split(",").map((value) => Number(value)).filter(Number.isInteger) : [];
}

async function terminateProfileProcesses(profilePath) {
  for (const processId of processesUsingProfile(profilePath)) {
    killProcessTree(processId);
  }
  const deadline = Date.now() + 10_000;
  let remaining = processesUsingProfile(profilePath);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    remaining = processesUsingProfile(profilePath);
  }
  if (remaining.length > 0) {
    throw new Error(`Startup measurement left owned profile processes running: ${remaining.join(",")}`);
  }
}

function isChildRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}
