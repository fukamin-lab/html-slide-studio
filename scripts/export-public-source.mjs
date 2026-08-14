import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { checkPublicBoundary } from "./check-public-boundary.mjs";

const EXPECTED_REMOTE = "https://github.com/fukamin-lab/html-slide-studio.git";
const EXPECTED_REPOSITORY_ID = 1329961337;
const ALLOWED_FILES = new Set([
  ".gitattributes",
  ".gitignore",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "build/icon-source.png",
  "config/public-endpoint.json",
  "docs/PRODUCT_CONTRACT.md",
  "docs/RELEASE.md",
  "electron-builder.yml",
  "electron.vite.config.ts",
  "package-lock.json",
  "package.json",
  "scripts/build-user-guide.mjs",
  "scripts/capture-user-guide.mjs",
  "scripts/check-public-boundary.mjs",
  "scripts/confirm-unsaved-close.ps1",
  "scripts/verify-packaged-ui.ps1",
  "scripts/ensure-electron-binary.mjs",
  "scripts/export-public-source.mjs",
  "scripts/lib/local-endpoint.d.mts",
  "scripts/lib/local-endpoint.mjs",
  "scripts/package-windows-arm64.mjs",
  "scripts/prepare-app-icon.mjs",
  "scripts/verify-packaged-app.mjs",
  "scripts/write-release-checksums.mjs",
  "tsconfig.json"
]);
const ALLOWED_PREFIXES = [".github/", "demo/", "docs/user-guide/", "src/", "tests/"];

const sourceRoot = resolve(process.cwd());
const markerState = await Promise.all(["AGENTS.md", "PROJECT_ID.json", "LOCAL_ENDPOINT.json"].map((name) => pathExists(resolve(sourceRoot, name))));
if (markerState.some(Boolean) && !markerState.every(Boolean)) {
  throw new Error("Internal source identity markers are incomplete");
}
if (markerState.every(Boolean)) {
  await exportInternalCandidate(sourceRoot);
} else {
  await verifyPublicClone(sourceRoot);
}

async function verifyPublicClone(root) {
  await requireCanonicalDirectory(root, "Public source root");
  const origin = git(root, ["remote", "get-url", "origin"]);
  assert.equal(normalizeRemote(origin), normalizeRemote(EXPECTED_REMOTE), "Public clone origin mismatch");
  assert.equal(git(root, ["status", "--porcelain"]), "", "Public source worktree must be clean");
  assert.equal(git(root, ["clean", "-ndx"]), "", "Public source must not contain ignored or untracked files");
  const tracked = gitNullList(root, ["ls-files", "-z"]);
  const boundary = await checkPublicBoundary(root, tracked);
  console.log(JSON.stringify({ pass: true, mode: "public-clean-source", head: git(root, ["rev-parse", "HEAD"]), boundary }, null, 2));
}

async function exportInternalCandidate(root) {
  await requireInternalCanonicalSource(root);
  const dirty = git(root, ["status", "--porcelain"]);
  const allowDirtyCandidate = process.argv.includes("--allow-dirty-candidate");
  if (!allowDirtyCandidate) assert.equal(dirty, "", "Internal source worktree must be clean");

  const repository = JSON.parse(execFileSync("gh", ["api", "repos/fukamin-lab/html-slide-studio"], { encoding: "utf8" }));
  assert.equal(repository.id, EXPECTED_REPOSITORY_ID, "GitHub repository identity mismatch");
  assert.equal(repository.html_url, "https://github.com/fukamin-lab/html-slide-studio", "GitHub repository URL mismatch");
  assert.equal(repository.visibility, "public", "GitHub repository must be public");

  const exportRoot = await mkdtemp(join(tmpdir(), "hss-public-export-"));
  const targetRoot = resolve(exportRoot, "html-slide-studio");
  try {
    execFileSync("git", ["clone", "--no-tags", EXPECTED_REMOTE, targetRoot], { stdio: "pipe" });
    await requireOwnedClone(exportRoot, targetRoot);
    assert.equal(normalizeRemote(git(targetRoot, ["remote", "get-url", "origin"])), normalizeRemote(EXPECTED_REMOTE), "Public clone origin mismatch");
    assert.equal(git(targetRoot, ["status", "--porcelain"]), "", "Fresh public clone must be clean");
    assert.equal(git(targetRoot, ["clean", "-ndx"]), "", "Fresh public clone must not contain ignored or untracked files");

    if (repository.size > 0) {
      const head = git(targetRoot, ["rev-parse", "HEAD"]);
      const originHead = git(targetRoot, ["rev-parse", "origin/main"]);
      assert.equal(head, originHead, "Fresh public clone HEAD must equal origin/main");
    }

    for (const entry of await readdir(targetRoot)) {
      if (entry === ".git") continue;
      const target = resolve(targetRoot, entry);
      assert.equal(dirname(target), targetRoot, "Cleanup target escaped the owned public clone");
      await requireNoLinks(targetRoot, target);
      await rm(target, { recursive: true, force: true });
    }

    const sourceFiles = allowDirtyCandidate
      ? gitNullList(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
      : gitNullList(root, ["ls-files", "-z"]);
    const publicFiles = sourceFiles.filter(isAllowedPublicPath);
    assert.equal(publicFiles.length > 0, true, "Public allowlist selected no source files");
    for (const required of ALLOWED_FILES) {
      assert.equal(publicFiles.includes(required), true, `Required public file is missing from the candidate: ${required}`);
    }

    for (const relativePath of publicFiles) {
      const source = resolve(root, relativePath);
      await requireCanonicalRegularFile(source, `Public source ${relativePath}`);
      const target = resolve(targetRoot, relativePath);
      assert.equal(isInside(targetRoot, target), true, `Public target escaped clone: ${relativePath}`);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { force: false, errorOnExist: true });
    }

    const internalEndpoint = JSON.parse(await readFile(resolve(root, "LOCAL_ENDPOINT.json"), "utf8"));
    const internalProject = JSON.parse(await readFile(resolve(root, "PROJECT_ID.json"), "utf8"));
    const allocationKey = ["allocation", "Id"].join("");
    const instanceKey = ["project", "Instance", "Id"].join("");
    const projectKey = ["project", "Id"].join("");
    const internalIds = [internalEndpoint[allocationKey], internalEndpoint[instanceKey], internalProject[projectKey]];
    const additionalForbiddenText = internalIds.map((value) => ({ label: "internal identifier", pattern: exactPattern(value) }));
    const boundary = await checkPublicBoundary(targetRoot, publicFiles, additionalForbiddenText);
    const internalBoundary = await checkInternalBoundaryIndependently(targetRoot, publicFiles, internalIds);
    console.log(JSON.stringify({
      pass: true,
      mode: allowDirtyCandidate ? "internal-dirty-candidate" : "internal-clean-export",
      releaseable: !allowDirtyCandidate,
      sourceHead: git(root, ["rev-parse", "HEAD"]),
      targetRoot,
      boundary,
      internalBoundary
    }, null, 2));
  } catch (error) {
    await rm(exportRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    throw error;
  }
}

function isAllowedPublicPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return ALLOWED_FILES.has(normalized) || ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

async function checkInternalBoundaryIndependently(root, files, internalIds) {
  const forbiddenNames = new Set(["AGENTS.md", "PROJECT_ID.json", "PROJECT_SEED.md", "LOCAL_ENDPOINT.json"]);
  const forbiddenText = [
    ...internalIds.map((value) => {
      if (typeof value !== "string" || value.length < 4) throw new Error("Internal identifier is missing");
      return { label: "internal identifier", value: value.toLowerCase() };
    }),
    { label: "internal Windows workspace path", value: ["c:", "dev", "fukamin"].join("\\") },
    { label: "internal slash workspace path", value: ["c:", "dev", "fukamin"].join("/") }
  ];

  const findings = [];
  for (const relativePath of files) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.split("/").some((segment) => forbiddenNames.has(segment))) {
      findings.push(`${normalized}: forbidden internal path`);
      continue;
    }
    const lowerBytes = (await readFile(resolve(root, relativePath))).toString("latin1").toLowerCase();
    for (const forbidden of forbiddenText) {
      if (lowerBytes.includes(forbidden.value)) findings.push(`${normalized}: ${forbidden.label}`);
    }
  }
  if (findings.length > 0) throw new Error(`Independent internal boundary check failed:\n${findings.join("\n")}`);
  return { pass: true, files: files.length, binaryFilesScanned: true };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function gitNullList(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).split("\0").filter(Boolean);
}

async function requireInternalCanonicalSource(root) {
  await requireCanonicalDirectory(root, "Internal source");
  for (const marker of ["AGENTS.md", "PROJECT_ID.json", "LOCAL_ENDPOINT.json"]) {
    await requireCanonicalRegularFile(resolve(root, marker), `Internal marker ${marker}`);
  }
}

async function requireOwnedClone(exportRoot, cloneRoot) {
  await requireCanonicalDirectory(exportRoot, "Owned export root");
  await requireCanonicalDirectory(cloneRoot, "Owned public clone");
  await requireCanonicalDirectory(resolve(cloneRoot, ".git"), "Owned public clone .git");
  assert.equal(isInside(exportRoot, cloneRoot), true, "Public clone escaped the owned temporary root");
}

async function requireNoLinks(root, entryPath) {
  const stats = await lstat(entryPath);
  if (stats.isSymbolicLink()) throw new Error(`Owned clone must not contain links: ${relative(root, entryPath)}`);
  if (!stats.isDirectory()) return;
  for (const child of await readdir(entryPath)) await requireNoLinks(root, resolve(entryPath, child));
}

async function requireCanonicalDirectory(directoryPath, label) {
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(directoryPath), directoryPath)) {
    throw new Error(`${label} must be a canonical regular directory`);
  }
}

async function requireCanonicalRegularFile(filePath, label) {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
    throw new Error(`${label} must be a canonical regular file`);
  }
}

function exactPattern(value) {
  if (typeof value !== "string" || value.length < 4) throw new Error("Internal identifier is missing");
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isInside(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(".." + sep);
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeRemote(value) {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}
