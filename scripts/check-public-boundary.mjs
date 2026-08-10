import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_NAMES = new Set([
  "AGENTS.md",
  "PROJECT_ID.json",
  "PROJECT_SEED.md",
  "LOCAL_ENDPOINT.json"
]);
const INTERNAL_METADATA_KEYS = [
  ["allocation", "Id"],
  ["project", "Instance", "Id"],
  ["workspace", "Relative", "Root"]
].map((parts) => parts.join(""));

const FORBIDDEN_TEXT = [
  { label: "internal workspace path", pattern: /C:[\\/]dev[\\/]fukamin(?:[\\/]|\b)/i },
  { label: "internal endpoint metadata", pattern: new RegExp(`\\b(?:${INTERNAL_METADATA_KEYS.join("|")})\\b`) },
  { label: "legacy product name", pattern: new RegExp(["HTML Slide Studio", "Legacy"].join(" "), "i") },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

const BINARY_EXTENSIONS = new Set([".png", ".ico", ".exe", ".zip"]);

export async function checkPublicBoundary(rootPath = process.cwd(), explicitFiles = null, additionalForbiddenText = []) {
  const root = resolve(rootPath);
  await requireCanonicalDirectory(root, "Public source root");
  const files = explicitFiles ?? trackedFiles(root);
  if (files.length === 0) throw new Error("Public boundary check requires at least one tracked file");

  const findings = [];
  for (const relativePath of files) {
    const normalized = relativePath.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (segments.some((segment) => FORBIDDEN_NAMES.has(segment)) || segments.includes(".git")) {
      findings.push(`${normalized}: forbidden path`);
      continue;
    }

    const filePath = resolve(root, relativePath);
    if (relative(root, filePath).startsWith(".." + sep) || relative(root, filePath) === "..") {
      findings.push(`${normalized}: path escaped root`);
      continue;
    }
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
      findings.push(`${normalized}: not a canonical regular file`);
      continue;
    }
    if (BINARY_EXTENSIONS.has(extensionOf(filePath))) continue;

    const text = await readFile(filePath, "utf8");
    for (const rule of [...FORBIDDEN_TEXT, ...additionalForbiddenText]) {
      if (rule.pattern.test(text)) findings.push(`${normalized}: ${rule.label}`);
      rule.pattern.lastIndex = 0;
    }
  }
  if (findings.length > 0) throw new Error(`Public boundary check failed:\n${findings.join("\n")}`);
  return { pass: true, root, files: files.length };
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

async function requireCanonicalDirectory(directoryPath, label) {
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(directoryPath), directoryPath)) {
    throw new Error(`${label} must be a canonical regular directory`);
  }
}

function extensionOf(filePath) {
  const name = basename(filePath);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkPublicBoundary(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify(result, null, 2));
}
