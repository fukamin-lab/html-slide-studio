import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const MAX_HTML_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const ASSET_INDEX_NAME = ".html-slide-studio-assets.json";
const ARTIFACT_PATTERN_PART = "hss-save";
const RECOVERY_ARTIFACT_SUFFIX = ".recovery.bak";
const RECOVERY_INVALID_SUFFIX = ".recovery.invalid";
const TRANSACTION_OWNER = "html-slide-studio-legacy";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const execFileAsync = promisify(execFile);

export type OpenHtmlDocumentResult = {
  html: string;
  filePath: string;
  sourceBaseUrl: string;
  fingerprint: string;
  warnings: string[];
};

export type SaveHtmlDocumentPayload = {
  html: string;
  filePath: string;
  expectedFingerprint: string;
};

export type SaveHtmlDocumentResult = {
  filePath: string;
  fingerprint: string;
  bytes: number;
  warnings: string[];
};

export type ImportedDocumentImage = {
  relativePath: string;
  fileUrl: string;
  bytes: number;
};

export type AssetOperations = {
  copyExclusive: (sourcePath: string, targetPath: string) => Promise<void>;
  writeIndex: (indexPath: string, index: AssetIndex) => Promise<void>;
};

export type SaveOperations = {
  replaceWithBackup: (temporaryPath: string, targetPath: string, backupPath: string) => Promise<void>;
  restoreBackupIfTargetMatches: (
    backupPath: string,
    targetPath: string,
    expectedTargetFingerprint: string
  ) => Promise<"restored" | "changed">;
};

type SaveTransaction = {
  schemaVersion: 1;
  owner: typeof TRANSACTION_OWNER;
  operationId: string;
  targetName: string;
  createdAt: string;
  expectedFingerprint: string;
  intendedFingerprint: string;
};

export const productionSaveOperations: SaveOperations = {
  replaceWithBackup: windowsReplaceWithBackup,
  restoreBackupIfTargetMatches: windowsRestoreBackupIfTargetMatches
};

const defaultAssetOperations: AssetOperations = {
  copyExclusive: async (sourcePath, targetPath) => copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL),
  writeIndex: writeAssetIndex
};

export async function openHtmlDocument(filePath: string): Promise<OpenHtmlDocumentResult> {
  const normalizedPath = requireHtmlPath(filePath);
  await requireCanonicalParentAndSafeTarget(normalizedPath);
  const warnings = await recoverSaveArtifacts(normalizedPath);
  await requireCanonicalRegularPath(normalizedPath);
  const file = await stat(normalizedPath);
  if (!file.isFile()) {
    throw new Error("Selected HTML path is not a file");
  }
  if (file.size > MAX_HTML_BYTES) {
    throw new Error("HTML file is larger than the 64 MB safety limit");
  }

  const html = await readFile(normalizedPath, "utf8");
  validateHtmlOutput(html);
  try {
    await pruneDocumentAssets(normalizedPath, html);
  } catch (error) {
    warnings.push(`Unused image cleanup was skipped: ${errorMessage(error)}`);
  }
  return {
    html,
    filePath: normalizedPath,
    sourceBaseUrl: directoryFileUrl(normalizedPath),
    fingerprint: createContentFingerprint(html),
    warnings
  };
}

export async function saveHtmlDocument(
  payload: SaveHtmlDocumentPayload,
  operations: SaveOperations = productionSaveOperations
): Promise<SaveHtmlDocumentResult> {
  const targetPath = requireHtmlPath(payload.filePath);
  await requireCanonicalRegularPath(targetPath);
  validateHtmlOutput(payload.html);
  validatePortableHtmlOutput(payload.html);
  const outputBytes = Buffer.byteLength(payload.html, "utf8");
  if (outputBytes > MAX_HTML_BYTES) {
    throw new Error("Edited HTML is larger than the 64 MB safety limit");
  }

  const currentHtml = await readFile(targetPath, "utf8");
  const currentFingerprint = createContentFingerprint(currentHtml);
  if (currentFingerprint !== payload.expectedFingerprint) {
    throw new Error("The HTML file changed outside HTML Slide Studio. Reopen it before saving.");
  }

  const operationId = randomUUID();
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.tmp`);
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.bak`);
  const transactionPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.txn.json`);
  const targetStats = await stat(targetPath);
  const intendedFingerprint = createContentFingerprint(payload.html);
  const transaction: SaveTransaction = {
    schemaVersion: 1,
    owner: TRANSACTION_OWNER,
    operationId,
    targetName: basename(targetPath),
    createdAt: new Date().toISOString(),
    expectedFingerprint: payload.expectedFingerprint,
    intendedFingerprint
  };
  const warnings: string[] = [];
  let replaced = false;
  let verified = false;
  let rollbackHandled = false;
  let transactionCreated = false;
  let replaceAttempted = false;
  try {
    await writeSaveTransaction(transactionPath, transaction);
    transactionCreated = true;
    const handle = await open(temporaryPath, "wx", targetStats.mode);
    try {
      await handle.writeFile(payload.html, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, targetStats.mode);
    const written = await readFile(temporaryPath, "utf8");
    if (written !== payload.html) {
      throw new Error("Temporary save verification failed");
    }
    validateHtmlOutput(written);
    validatePortableHtmlOutput(written);

    const immediatelyCurrentHtml = await readFile(targetPath, "utf8");
    if (createContentFingerprint(immediatelyCurrentHtml) !== payload.expectedFingerprint) {
      throw new Error("The HTML file changed while saving. No file was replaced.");
    }

    replaceAttempted = true;
    await operations.replaceWithBackup(temporaryPath, targetPath, backupPath);
    replaced = true;

    const backupHtml = await readFile(backupPath, "utf8");
    const backupFingerprint = createContentFingerprint(backupHtml);
    if (backupFingerprint !== payload.expectedFingerprint) {
      const outcome = await operations.restoreBackupIfTargetMatches(backupPath, targetPath, intendedFingerprint);
      rollbackHandled = true;
      if (outcome === "restored") {
        await requireFingerprint(targetPath, backupFingerprint, "External version restore verification failed");
        await cleanupSuccessfulTransaction(temporaryPath, backupPath, transactionPath);
        throw new Error("The HTML file changed during the final save step. The external version was restored; reopen it before editing.");
      }
      const recoveryPath = await preserveRecoveryBackup(backupPath);
      await cleanupResolvedTransaction(temporaryPath, transactionPath);
      throw new Error(
        `The HTML file changed again after replacement. The latest target was left untouched. Recovery backup: ${recoveryPath}`
      );
    }

    const saved = await readFile(targetPath, "utf8");
    validateHtmlOutput(saved);
    validatePortableHtmlOutput(saved);
    if (saved !== payload.html) {
      throw new Error("Saved HTML verification failed after replace");
    }
    verified = true;
    try {
      await pruneDocumentAssets(targetPath, saved);
    } catch (error) {
      warnings.push(`Unused image cleanup was skipped: ${errorMessage(error)}`);
    }
    await cleanupSuccessfulTransaction(temporaryPath, backupPath, transactionPath);
  } catch (error) {
    if (replaced && !verified && !rollbackHandled) {
      try {
        const outcome = await operations.restoreBackupIfTargetMatches(backupPath, targetPath, intendedFingerprint);
        rollbackHandled = true;
        if (outcome === "restored") {
          await requireFingerprint(targetPath, payload.expectedFingerprint, "Rollback fingerprint verification failed");
          await cleanupSuccessfulTransaction(temporaryPath, backupPath, transactionPath);
        } else {
          const recoveryPath = await preserveRecoveryBackup(backupPath);
          await cleanupResolvedTransaction(temporaryPath, transactionPath);
          throw new Error(
            `Save verification failed, then the target changed externally. The latest target was left untouched. Recovery backup: ${recoveryPath}`,
            { cause: error }
          );
        }
      } catch (rollbackError) {
        throw new Error(`Save failed and recovery could not be verified. Recovery backup: ${backupPath}. ${errorMessage(rollbackError)}`, {
          cause: error
        });
      }
    } else if (!replaced && transactionCreated && !replaceAttempted) {
      await cleanupResolvedTransaction(temporaryPath, transactionPath);
    }
    throw error;
  }

  return {
    filePath: targetPath,
    fingerprint: intendedFingerprint,
    bytes: outputBytes,
    warnings
  };
}

export async function importImageForDocument(
  htmlPath: string,
  imagePath: string,
  operations: AssetOperations = defaultAssetOperations
): Promise<ImportedDocumentImage> {
  const normalizedHtmlPath = requireHtmlPath(htmlPath);
  await requireCanonicalRegularPath(normalizedHtmlPath);
  const normalizedImagePath = resolve(imagePath);
  const extension = extname(normalizedImagePath).toLowerCase();
  if (!isAbsolute(imagePath) || !IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("Select a PNG, JPEG, GIF, WebP, or SVG image");
  }

  const imageStats = await stat(normalizedImagePath);
  if (!imageStats.isFile()) {
    throw new Error("Selected image path is not a file");
  }
  if (imageStats.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is larger than the 32 MB safety limit");
  }

  const content = await readFile(normalizedImagePath);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const deckStem = sanitizeStem(basename(normalizedHtmlPath, extname(normalizedHtmlPath)));
  const imageStem = sanitizeStem(basename(normalizedImagePath, extension));
  const assetDirectoryName = `${deckStem}.assets`;
  const assetDirectory = join(dirname(normalizedHtmlPath), assetDirectoryName);
  const assetName = `${imageStem}-${hash}${extension}`;
  const targetPath = join(assetDirectory, assetName);

  const indexPath = join(assetDirectory, ASSET_INDEX_NAME);
  const index = await openOrCreateAssetIndex(assetDirectory, indexPath);
  const alreadyOwned = index.files.includes(assetName);
  let targetExists = true;
  let existing: Buffer | null = null;
  try {
    existing = await readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    targetExists = false;
  }

  if (targetExists && !alreadyOwned) {
    throw new Error("Generated asset name collides with a file not owned by HTML Slide Studio");
  }
  if (alreadyOwned && (!existing || !existing.equals(content))) {
    throw new Error("An app-owned asset with the same generated name has different content");
  }

  if (!targetExists) {
    let created = false;
    try {
      await operations.copyExclusive(normalizedImagePath, targetPath);
      created = true;
      await operations.writeIndex(indexPath, { ...index, files: [...index.files, assetName] });
    } catch (error) {
      if (created) await rm(targetPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  const relativePath = relative(dirname(normalizedHtmlPath), targetPath).split(sep).join("/");
  if (relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error("Generated asset path escaped the HTML directory");
  }

  return {
    relativePath,
    fileUrl: pathToFileURL(targetPath).toString(),
    bytes: imageStats.size
  };
}

export function createContentFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateHtmlOutput(html: string): void {
  if (!html.trim()) {
    throw new Error("HTML output is empty");
  }
  if (!/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html)) {
    throw new Error("HTML output must contain html and body elements");
  }
}

export function validatePortableHtmlOutput(html: string): void {
  const srcsetPattern = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(srcsetPattern)) {
    const value = decodeReference(match[1] ?? match[2] ?? match[3] ?? "");
    if (/\bdata:/i.test(value)) {
      throw new Error("Saved HTML must not contain data URI values in srcset");
    }
  }
  for (const rawReference of extractPortableReferences(html)) {
    const reference = decodeReference(rawReference);
    if (!reference || reference.startsWith("#") || /^(?:https?:|data:|blob:|mailto:|tel:)/i.test(reference)) continue;
    if (/^file:/i.test(reference) || /\.hslides(?:[\\/]|$)/i.test(reference)) {
      throw new Error("Saved HTML must not contain file: or .hslides references");
    }
    if (
      /^[A-Za-z]:[\\/]/.test(reference) ||
      /^\\\\/.test(reference) ||
      /^\/\//.test(reference) ||
      /^\//.test(reference) ||
      reference.split(/[\\/]+/).includes("..")
    ) {
      throw new Error("Saved HTML must not contain absolute or escaping local asset paths");
    }
  }
}

function extractPortableReferences(html: string): string[] {
  const references: string[] = [];
  const attributePattern = /\b(?:src|href|xlink:href|poster|action|formaction|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(attributePattern)) references.push(match[1] ?? match[2] ?? match[3] ?? "");

  const srcsetPattern = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(srcsetPattern)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    for (const candidate of value.split(",")) references.push(candidate.trim().split(/\s+/)[0] ?? "");
  }

  const cssUrlPattern = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
  for (const match of html.matchAll(cssUrlPattern)) references.push(match[1] ?? match[2] ?? match[3] ?? "");

  const cssImportPattern = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(cssImportPattern)) references.push(match[1] ?? match[2] ?? "");
  return references;
}

function decodeReference(value: string): string {
  let decoded = value
    .trim()
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&bsol;/gi, "\\");
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.trim();
}

function requireHtmlPath(filePath: string): string {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new Error("HTML path must be absolute");
  }
  const normalizedPath = resolve(filePath);
  if (!HTML_EXTENSIONS.has(extname(normalizedPath).toLowerCase())) {
    throw new Error("Only HTML files can be opened or saved");
  }
  return normalizedPath;
}

function directoryFileUrl(filePath: string): string {
  return pathToFileURL(`${dirname(filePath)}${sep}`).toString();
}

function sanitizeStem(value: string): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return safe || "asset";
}

type AssetIndex = {
  schemaVersion: 1;
  owner: "html-slide-studio-legacy";
  files: string[];
};

async function requireCanonicalRegularPath(filePath: string): Promise<void> {
  const resolvedPath = resolve(filePath);
  const canonicalFile = await realpath(resolvedPath);
  const canonicalParent = await realpath(dirname(resolvedPath));
  if (!samePath(canonicalFile, resolvedPath) || !samePath(canonicalParent, dirname(resolvedPath))) {
    throw new Error("HTML paths through symlinks, junctions, or reparse points are not supported");
  }
  const stats = await lstat(resolvedPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("HTML target must be a regular file");
  }
}

async function requireCanonicalParentAndSafeTarget(filePath: string): Promise<void> {
  const resolvedPath = resolve(filePath);
  const parentPath = dirname(resolvedPath);
  const parentStats = await lstat(parentPath);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || !samePath(await realpath(parentPath), parentPath)) {
    throw new Error("HTML paths through symlinks, junctions, or reparse points are not supported");
  }
  try {
    const targetStats = await lstat(resolvedPath);
    if (!targetStats.isFile() || targetStats.isSymbolicLink() || !samePath(await realpath(resolvedPath), resolvedPath)) {
      throw new Error("HTML target must be a canonical regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function openOrCreateAssetIndex(assetDirectory: string, indexPath: string): Promise<AssetIndex> {
  try {
    const directoryStats = await lstat(assetDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error("Adjacent asset path must be a regular directory");
    }
    const canonicalDirectory = await realpath(assetDirectory);
    if (!samePath(canonicalDirectory, assetDirectory)) {
      throw new Error("Adjacent asset directory must not use a reparse point");
    }
    return parseAssetIndex(await readFile(indexPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    try {
      await stat(assetDirectory);
      throw new Error("Existing adjacent asset directory is not owned by HTML Slide Studio");
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw directoryError;
      }
    }
    await mkdir(assetDirectory);
    const index: AssetIndex = { schemaVersion: 1, owner: "html-slide-studio-legacy", files: [] };
    try {
      await writeAssetIndex(indexPath, index);
    } catch (error) {
      await rm(assetDirectory, { recursive: false, force: true }).catch(() => undefined);
      throw error;
    }
    return index;
  }
}

async function pruneDocumentAssets(htmlPath: string, html: string): Promise<void> {
  const deckStem = sanitizeStem(basename(htmlPath, extname(htmlPath)));
  const assetDirectoryName = `${deckStem}.assets`;
  const assetDirectory = join(dirname(htmlPath), assetDirectoryName);
  const indexPath = join(assetDirectory, ASSET_INDEX_NAME);
  let index: AssetIndex;
  try {
    await requireCanonicalOwnedAssetDirectory(assetDirectory, indexPath);
    index = parseAssetIndex(await readFile(indexPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const referenced = new Set<string>();
  for (const reference of extractPortableReferences(html)) {
    const fileName = assetFileNameFromReference(reference, assetDirectoryName);
    if (fileName) referenced.add(assetComparisonName(fileName));
  }

  const kept: string[] = [];
  for (const fileName of index.files) {
    if (!isSafeAssetFileName(fileName)) {
      continue;
    }
    if (referenced.has(assetComparisonName(fileName))) {
      kept.push(fileName);
      continue;
    }
    await rm(join(assetDirectory, fileName), { force: true });
  }
  if (kept.length !== index.files.length) {
    await writeAssetIndex(indexPath, { ...index, files: kept });
  }
}

function assetFileNameFromReference(reference: string, assetDirectoryName: string): string | null {
  let pathValue = decodeReference(reference).replace(/[?#].*$/, "").replace(/\\/g, "/");
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathValue)) pathValue = decodeReference(new URL(pathValue).pathname);
  } catch {
    return null;
  }
  const segments = pathValue.split("/").filter(Boolean);
  const directoryIndex = segments.findIndex((segment) => segment.toLowerCase() === assetDirectoryName.toLowerCase());
  if (directoryIndex < 0 || directoryIndex !== segments.length - 2) return null;
  const fileName = segments[directoryIndex + 1];
  return isSafeAssetFileName(fileName) ? fileName : null;
}

function assetComparisonName(fileName: string): string {
  return process.platform === "win32" ? fileName.toLowerCase() : fileName;
}

async function recoverSaveArtifacts(targetPath: string): Promise<string[]> {
  const directory = dirname(targetPath);
  const targetName = basename(targetPath);
  const transactionPattern = new RegExp(`^\\.${escapeRegExp(targetName)}\\.${ARTIFACT_PATTERN_PART}-(${UUID_PATTERN})\\.txn\\.json$`);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }

  const transactions: Array<{ journal: SaveTransaction; transactionPath: string; createdAt: number }> = [];
  for (const name of names) {
    const match = transactionPattern.exec(name);
    if (!match) continue;
    const transactionPath = join(directory, name);
    try {
      const transactionStats = await lstat(transactionPath);
      if (!transactionStats.isFile() || transactionStats.isSymbolicLink() || !samePath(await realpath(transactionPath), transactionPath)) continue;
      const journal = parseSaveTransaction(await readFile(transactionPath, "utf8"), match[1], targetName);
      transactions.push({ journal, transactionPath, createdAt: Date.parse(journal.createdAt) });
    } catch {
      // A filename alone is not proof of app ownership. Invalid journals are left untouched.
    }
  }
  transactions.sort((left, right) => right.createdAt - left.createdAt);
  if (transactions.length === 0) return [];

  const [latest, ...obsolete] = transactions;
  const warnings = await recoverSaveTransaction(targetPath, latest.journal, latest.transactionPath);
  for (const entry of obsolete) {
    const paths = saveArtifactPaths(targetPath, entry.journal.operationId);
    const backup = await inspectHtmlFile(paths.backupPath);
    if (backup.valid) {
      const recoveryPath = await preserveRecoveryBackup(paths.backupPath);
      await cleanupResolvedTransaction(paths.temporaryPath, entry.transactionPath);
      warnings.push(`An older interrupted save backup was retained instead of being discarded: ${recoveryPath}`);
    } else if (backup.exists) {
      warnings.push(`An older interrupted save has an invalid backup; its recovery metadata was left untouched: ${entry.transactionPath}`);
    } else {
      await cleanupResolvedTransaction(paths.temporaryPath, entry.transactionPath);
    }
  }
  return warnings;
}

async function recoverSaveTransaction(
  targetPath: string,
  transaction: SaveTransaction,
  transactionPath: string
): Promise<string[]> {
  const paths = saveArtifactPaths(targetPath, transaction.operationId);
  const target = await inspectHtmlFile(targetPath);
  const backup = await inspectHtmlFile(paths.backupPath);

  if (!backup.exists) {
    if (target.valid) {
      await cleanupResolvedTransaction(paths.temporaryPath, transactionPath);
      return [];
    }
    throw new Error(`Interrupted save has no valid backup. Recovery metadata was retained: ${transactionPath}`);
  }
  if (!backup.valid || !backup.fingerprint) {
    throw new Error(`Interrupted save backup is invalid. Recovery metadata was retained: ${paths.backupPath}`);
  }

  if (!target.valid || !target.fingerprint) {
    const invalidCapture = await restoreBackupForRecovery(paths.backupPath, targetPath, backup.fingerprint, transaction.operationId, target.exists);
    await cleanupSuccessfulTransaction(paths.temporaryPath, paths.backupPath, transactionPath);
    return [invalidCapture
      ? `An interrupted save was recovered from backup. Invalid interrupted bytes were retained: ${invalidCapture}`
      : "An interrupted save was recovered from its verified backup."];
  }

  if (target.fingerprint === transaction.intendedFingerprint) {
    if (backup.fingerprint === transaction.expectedFingerprint) {
      await cleanupSuccessfulTransaction(paths.temporaryPath, paths.backupPath, transactionPath);
      return [];
    }
    const outcome = await productionSaveOperations.restoreBackupIfTargetMatches(
      paths.backupPath,
      targetPath,
      transaction.intendedFingerprint
    );
    if (outcome === "restored") {
      await requireFingerprint(targetPath, backup.fingerprint, "Interrupted-save rollback verification failed");
      await cleanupSuccessfulTransaction(paths.temporaryPath, paths.backupPath, transactionPath);
      return ["An interrupted save rollback was completed from its verified backup."];
    }
  } else if (target.fingerprint === transaction.expectedFingerprint) {
    await cleanupSuccessfulTransaction(paths.temporaryPath, paths.backupPath, transactionPath);
    return [];
  }

  const recoveryPath = await preserveRecoveryBackup(paths.backupPath);
  await cleanupResolvedTransaction(paths.temporaryPath, transactionPath);
  return [`The HTML changed outside the app during an interrupted save. The current file was left untouched and a recovery backup was retained: ${recoveryPath}`];
}

async function inspectHtmlFile(filePath: string): Promise<{ exists: boolean; valid: boolean; fingerprint: string | null }> {
  try {
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) return { exists: true, valid: false, fingerprint: null };
    const html = await readFile(filePath, "utf8");
    validateHtmlOutput(html);
    return { exists: true, valid: true, fingerprint: createContentFingerprint(html) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, valid: false, fingerprint: null };
    return { exists: true, valid: false, fingerprint: null };
  }
}

async function restoreBackupForRecovery(
  backupPath: string,
  targetPath: string,
  backupFingerprint: string,
  operationId: string,
  targetExists: boolean
): Promise<string | null> {
  let invalidPath: string | null = null;
  if (targetExists) {
    invalidPath = `${backupPath.replace(/\.bak$/i, "")}${RECOVERY_INVALID_SUFFIX}`;
    if (process.platform === "win32") {
      await windowsReplaceWithBackup(backupPath, targetPath, invalidPath);
    } else {
      await rename(targetPath, invalidPath);
      await rename(backupPath, targetPath);
    }
  } else {
    await rename(backupPath, targetPath);
  }
  await requireFingerprint(targetPath, backupFingerprint, `Interrupted save ${operationId} recovery verification failed`);
  return invalidPath;
}

function parseSaveTransaction(content: string, operationId: string, targetName: string): SaveTransaction {
  const value = JSON.parse(content) as Partial<SaveTransaction>;
  const fingerprintPattern = /^[0-9a-f]{64}$/;
  if (
    value.schemaVersion !== 1 ||
    value.owner !== TRANSACTION_OWNER ||
    value.operationId !== operationId ||
    value.targetName !== targetName ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.expectedFingerprint !== "string" ||
    !fingerprintPattern.test(value.expectedFingerprint) ||
    typeof value.intendedFingerprint !== "string" ||
    !fingerprintPattern.test(value.intendedFingerprint)
  ) {
    throw new Error("Save transaction ownership metadata is invalid");
  }
  return value as SaveTransaction;
}

function saveArtifactPaths(targetPath: string, operationId: string): {
  temporaryPath: string;
  backupPath: string;
} {
  const prefix = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}`);
  return { temporaryPath: `${prefix}.tmp`, backupPath: `${prefix}.bak` };
}

function parseAssetIndex(content: string): AssetIndex {
  const value = JSON.parse(content) as Partial<AssetIndex>;
  if (value.schemaVersion !== 1 || value.owner !== "html-slide-studio-legacy" || !Array.isArray(value.files) || !value.files.every(isSafeAssetFileName)) {
    throw new Error("Adjacent asset directory ownership index is invalid");
  }
  return { schemaVersion: 1, owner: "html-slide-studio-legacy", files: [...new Set(value.files)] };
}

async function writeAssetIndex(indexPath: string, index: AssetIndex): Promise<void> {
  const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(index, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, indexPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeSaveTransaction(transactionPath: string, transaction: SaveTransaction): Promise<void> {
  const handle = await open(transactionPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(transaction, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupResolvedTransaction(temporaryPath: string, transactionPath: string): Promise<void> {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
  await rm(transactionPath, { force: true }).catch(() => undefined);
}

async function cleanupSuccessfulTransaction(temporaryPath: string, backupPath: string, transactionPath: string): Promise<void> {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
  await rm(backupPath, { force: true }).catch(() => undefined);
  await rm(transactionPath, { force: true }).catch(() => undefined);
}

function isSafeAssetFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    value !== ASSET_INDEX_NAME &&
    basename(value) === value &&
    /^[\p{L}\p{N}_.-]+$/u.test(value)
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requireCanonicalOwnedAssetDirectory(assetDirectory: string, indexPath: string): Promise<void> {
  const directoryStats = await lstat(assetDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Adjacent asset path must be a regular directory");
  }
  if (!samePath(await realpath(assetDirectory), assetDirectory)) {
    throw new Error("Adjacent asset directory must not use a reparse point");
  }
  const indexStats = await lstat(indexPath);
  if (!indexStats.isFile() || indexStats.isSymbolicLink() || !samePath(await realpath(indexPath), indexPath)) {
    throw new Error("Adjacent asset ownership index must be a regular file");
  }
}

async function requireFingerprint(filePath: string, expected: string, message: string): Promise<void> {
  const actual = createContentFingerprint(await readFile(filePath, "utf8"));
  if (actual !== expected) {
    throw new Error(message);
  }
}

async function preserveRecoveryBackup(backupPath: string): Promise<string> {
  const recoveryPath = backupPath.replace(/\.bak$/i, RECOVERY_ARTIFACT_SUFFIX);
  try {
    await rename(backupPath, recoveryPath);
    return recoveryPath;
  } catch {
    return backupPath;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function windowsReplaceWithBackup(temporaryPath: string, targetPath: string, backupPath: string): Promise<void> {
  requireWindowsFileReplace();
  await runWindowsPowerShell(
    "$ErrorActionPreference='Stop'; [System.IO.File]::Replace($env:HSS_REPLACE_SOURCE, $env:HSS_REPLACE_TARGET, $env:HSS_REPLACE_BACKUP, $true)",
    {
      HSS_REPLACE_SOURCE: temporaryPath,
      HSS_REPLACE_TARGET: targetPath,
      HSS_REPLACE_BACKUP: backupPath
    }
  );
}

async function windowsRestoreBackupIfTargetMatches(
  backupPath: string,
  targetPath: string,
  expectedTargetFingerprint: string
): Promise<"restored" | "changed"> {
  requireWindowsFileReplace();
  const script = [
    "$ErrorActionPreference='Stop'",
    "$target = [System.IO.FileStream]::new($env:HSS_RESTORE_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
    "try {",
    "  $sha = [System.Security.Cryptography.SHA256]::Create()",
    "  try { $actual = ([System.BitConverter]::ToString($sha.ComputeHash($target))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    "  if ($actual -ne $env:HSS_RESTORE_EXPECTED) { [Console]::Out.Write('changed'); return }",
    "  $backup = [System.IO.FileStream]::new($env:HSS_RESTORE_BACKUP, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "  try {",
    "    $target.Position = 0",
    "    $target.SetLength(0)",
    "    $backup.CopyTo($target)",
    "    $target.Flush($true)",
    "  } finally { $backup.Dispose() }",
    "  [Console]::Out.Write('restored')",
    "} finally { $target.Dispose() }"
  ].join("; ");
  const { stdout } = await runWindowsPowerShell(script, {
    HSS_RESTORE_BACKUP: backupPath,
    HSS_RESTORE_TARGET: targetPath,
    HSS_RESTORE_EXPECTED: expectedTargetFingerprint
  });
  const outcome = stdout.trim();
  if (outcome !== "restored" && outcome !== "changed") {
    throw new Error(`Unexpected rollback result: ${outcome || "empty output"}`);
  }
  return outcome;
}

function requireWindowsFileReplace(): void {
  if (process.platform !== "win32") {
    throw new Error("Safe overwrite save currently requires Windows File.Replace");
  }
}

async function runWindowsPowerShell(
  script: string,
  operationEnvironment: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error("SystemRoot is unavailable; safe overwrite cannot run");
  }
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...operationEnvironment }
  });
}
