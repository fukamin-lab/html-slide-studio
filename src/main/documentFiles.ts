import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  decodeHtmlReference,
  extractHtmlReferences,
  htmlReferenceCandidates,
  validateHtmlSemanticOutput,
  type HtmlReference
} from "./htmlValidation.ts";

export const MAX_HTML_BYTES = 64 * 1024 * 1024;
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
  documentIdentity: CanonicalFileIdentity;
  warnings: string[];
};

export type SaveHtmlDocumentPayload = {
  html: string;
  filePath: string;
  expectedFingerprint: string;
  expectedSlideCount: number;
};

export type SaveHtmlDocumentResult = {
  filePath: string;
  fingerprint: string;
  documentIdentity: CanonicalFileIdentity;
  bytes: number;
  warnings: string[];
};

export type ImportedDocumentImage = {
  relativePath: string;
  fileUrl: string;
  bytes: number;
};

export type AssetOperations = {
  copyExclusive: (sourcePath: string, targetPath: string, content: Buffer) => Promise<CanonicalFileIdentity | void>;
  writeIndex: (
    indexPath: string,
    index: AssetIndex,
    expectedFingerprint?: string,
    beforeInstall?: (indexPath: string) => Promise<void>
  ) => Promise<string | void>;
  beforeIndexInstall?: (indexPath: string) => Promise<void>;
};

export type CanonicalFileIdentity = {
  parent: string;
  file: string;
};

export type SaveOperations = {
  replaceWithBackup: (temporaryPath: string, targetPath: string, backupPath: string) => Promise<void>;
  restoreBackupIfTargetMatches: (
    backupPath: string,
    targetPath: string,
    expectedTargetFingerprint: string,
    expectedBackupFingerprint: string
  ) => Promise<"restored" | "changed" | "backup-changed">;
  beforeRestore?: (backupPath: string, targetPath: string) => Promise<void> | void;
  beforeRemoveArtifact?: (filePath: string) => Promise<void> | void;
  removeArtifact?: (filePath: string) => Promise<void>;
};

export type AssetGcOperations = {
  beforeRemove?: (htmlPath: string, assetPath: string) => Promise<void>;
  removeOwnedAsset?: (assetPath: string, expected: OwnedFileExpectation) => Promise<void>;
};

export type RecoveryOperations = {
  beforeRestoreInvalid?: (targetPath: string, backupPath: string) => Promise<void>;
  beforeRestoreQuarantine?: (quarantinePath: string, targetPath: string) => Promise<void>;
};

type OwnedFileExpectation = {
  identity: CanonicalFileIdentity;
  fingerprint: string;
  bytes: number;
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

export const productionAssetOperations: AssetOperations = {
  copyExclusive: async (_sourcePath, targetPath, content) => {
    const parentIdentity = await fileSystemIdentity(dirname(targetPath));
    const target = await open(targetPath, "wx");
    try {
      await target.writeFile(content);
      await target.sync();
      const stats = await target.stat({ bigint: true });
      return { parent: parentIdentity, file: `${stats.dev}:${stats.ino}` };
    } finally {
      await target.close();
    }
  },
  writeIndex: writeAssetIndex
};

export const productionAssetGcOperations: AssetGcOperations = {
  removeOwnedAsset: quarantineAndRemoveOwnedFile
};

export async function openHtmlDocument(
  filePath: string,
  gcOperations: AssetGcOperations = productionAssetGcOperations,
  recoveryOperations: RecoveryOperations = {}
): Promise<OpenHtmlDocumentResult> {
  const normalizedPath = requireHtmlPath(filePath);
  await requireCanonicalParentAndSafeTarget(normalizedPath);
  const openParentIdentity = await fileSystemIdentity(dirname(normalizedPath));
  const warnings = await recoverSaveArtifacts(normalizedPath, recoveryOperations);
  await requireCanonicalDirectoryIdentity(
    dirname(normalizedPath),
    openParentIdentity,
    "The HTML parent directory identity changed during recovery"
  );
  const openedIdentity = await captureCanonicalFileIdentity(normalizedPath);
  const file = await stat(normalizedPath);
  if (!file.isFile()) {
    throw new Error("Selected HTML path is not a file");
  }
  if (file.size > MAX_HTML_BYTES) {
    throw new Error("HTML file is larger than the 64 MB safety limit");
  }

  const { bytes, html } = await readUtf8HtmlFile(normalizedPath);
  if (bytes.length > MAX_HTML_BYTES) {
    throw new Error("HTML file is larger than the 64 MB safety limit");
  }
  validateHtmlOutput(html);
  const fingerprint = createContentFingerprint(bytes);
  try {
    await pruneDocumentAssets(normalizedPath, html, fingerprint, gcOperations);
  } catch (error) {
    warnings.push(`Unused image cleanup was skipped: ${errorMessage(error)}`);
  }
  await requireFingerprint(normalizedPath, fingerprint, "The HTML changed while it was being opened. Open it again.");
  await requireCanonicalFileIdentity(normalizedPath, openedIdentity, "The HTML path identity changed while it was being opened. Open it again.");
  return {
    html,
    filePath: normalizedPath,
    sourceBaseUrl: directoryFileUrl(normalizedPath),
    fingerprint,
    documentIdentity: openedIdentity,
    warnings
  };
}

export async function saveHtmlDocument(
  payload: SaveHtmlDocumentPayload,
  operations: SaveOperations = productionSaveOperations,
  gcOperations: AssetGcOperations = productionAssetGcOperations,
  expectedDocumentIdentity?: CanonicalFileIdentity
): Promise<SaveHtmlDocumentResult> {
  const targetPath = requireHtmlPath(payload.filePath);
  const targetIdentity = await captureCanonicalFileIdentity(targetPath);
  if (expectedDocumentIdentity && !sameCanonicalFileIdentity(targetIdentity, expectedDocumentIdentity)) {
    throw new Error("The HTML path identity changed after it was opened. Reopen it before saving.");
  }
  const intendedBytes = Buffer.from(payload.html, "utf8");
  const outputBytes = intendedBytes.length;
  if (intendedBytes.length > MAX_HTML_BYTES) {
    throw new Error("Edited HTML is larger than the 64 MB safety limit");
  }
  validateHtmlOutput(payload.html);
  validatePortableHtmlOutput(payload.html);
  validateHtmlSemanticOutput(payload.html, payload.expectedSlideCount);

  const currentFile = await readUtf8HtmlFile(targetPath);
  const currentFingerprint = createContentFingerprint(currentFile.bytes);
  if (currentFingerprint !== payload.expectedFingerprint) {
    throw new Error("The HTML file changed outside HTML Slide Studio. Reopen it before saving.");
  }

  const operationId = randomUUID();
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.tmp`);
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.bak`);
  const transactionPath = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}.txn.json`);
  const targetStats = await stat(targetPath);
  const intendedFingerprint = createContentFingerprint(intendedBytes);
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
  let verifiedBackupFingerprint: string | null = null;
  let finalDocumentIdentity: CanonicalFileIdentity | null = null;
  let transactionCreated = false;
  let replaceAttempted = false;
  try {
    await requireCanonicalFileIdentity(targetPath, targetIdentity, "The HTML path identity changed before save preparation");
    await writeSaveTransaction(transactionPath, transaction);
    transactionCreated = true;
    await requireCanonicalFileIdentity(targetPath, targetIdentity, "The HTML path identity changed while the save journal was created");
    const handle = await open(temporaryPath, "wx", targetStats.mode);
    try {
      await handle.writeFile(intendedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, targetStats.mode);
    const writtenFile = await readUtf8HtmlFile(temporaryPath);
    const written = writtenFile.html;
    if (!writtenFile.bytes.equals(intendedBytes)) {
      throw new Error("Temporary save verification failed");
    }
    validateHtmlOutput(written);
    validatePortableHtmlOutput(written);
    validateHtmlSemanticOutput(written, payload.expectedSlideCount);

    const immediatelyCurrent = await readFile(targetPath);
    if (createContentFingerprint(immediatelyCurrent) !== payload.expectedFingerprint) {
      throw new Error("The HTML file changed while saving. No file was replaced.");
    }
    await requireCanonicalFileIdentity(targetPath, targetIdentity, "The HTML path identity changed immediately before replacement");

    replaceAttempted = true;
    await operations.replaceWithBackup(temporaryPath, targetPath, backupPath);
    replaced = true;

    await requireCanonicalDirectoryIdentity(
      dirname(targetPath),
      targetIdentity.parent,
      "The HTML parent directory identity changed during replacement"
    );
    await requireCanonicalRegularPath(targetPath);
    await requireCanonicalRegularPath(backupPath);
    const backupFingerprint = createContentFingerprint(await readFile(backupPath));
    verifiedBackupFingerprint = backupFingerprint;
    const backupIdentityMatches = (await fileSystemIdentity(backupPath)) === targetIdentity.file;
    if (backupFingerprint !== payload.expectedFingerprint || !backupIdentityMatches) {
      rollbackHandled = true;
      const recoveryPath = await preserveRecoveryBackup(backupPath);
      await cleanupResolvedTransaction(temporaryPath, transactionPath, operations);
      throw new Error(
        `The HTML changed outside the app immediately before replacement. The current target was left as the verified saved version; the untrusted backup was retained for recovery: ${recoveryPath}`
      );
    }

    const savedFile = await readUtf8HtmlFile(targetPath);
    const saved = savedFile.html;
    validateHtmlOutput(saved);
    validatePortableHtmlOutput(saved);
    validateHtmlSemanticOutput(saved, payload.expectedSlideCount);
    if (!savedFile.bytes.equals(intendedBytes) || createContentFingerprint(savedFile.bytes) !== intendedFingerprint) {
      throw new Error("Saved HTML verification failed after replace");
    }
    const savedIdentity = await captureCanonicalFileIdentity(targetPath);
    finalDocumentIdentity = savedIdentity;
    verified = true;
    try {
      await pruneDocumentAssets(targetPath, saved, intendedFingerprint, gcOperations);
    } catch (error) {
      warnings.push(`Unused image cleanup was skipped: ${errorMessage(error)}`);
    }
    if (createContentFingerprint(await readFile(targetPath)) !== intendedFingerprint) {
      const recoveryPath = await preserveRecoveryBackup(backupPath);
      rollbackHandled = true;
      await cleanupResolvedTransaction(temporaryPath, transactionPath, operations);
      throw new Error(
        `The HTML changed externally during post-save image cleanup. The latest target was left untouched. Recovery backup: ${recoveryPath}`
      );
    }
    await requireCanonicalFileIdentity(
      targetPath,
      savedIdentity,
      "The HTML path identity changed externally during post-save image cleanup"
    );
    try {
      await cleanupSuccessfulTransaction(temporaryPath, backupPath, transactionPath, operations);
    } catch (cleanupError) {
      warnings.push(`Save completed, but recovery cleanup is pending and will be retried on the next open: ${errorMessage(cleanupError)}`);
    }
  } catch (error) {
    if (replaced && !verified && !rollbackHandled) {
      try {
        await requireCanonicalDirectoryIdentity(
          dirname(targetPath),
          targetIdentity.parent,
          "The HTML parent directory identity changed before rollback"
        );
        await operations.beforeRestore?.(backupPath, targetPath);
        const outcome = await operations.restoreBackupIfTargetMatches(
          backupPath,
          targetPath,
          intendedFingerprint,
          verifiedBackupFingerprint ?? payload.expectedFingerprint
        );
        rollbackHandled = true;
        if (outcome === "restored") {
          await requireFingerprint(targetPath, payload.expectedFingerprint, "Rollback fingerprint verification failed");
          await cleanupSuccessfulTransaction(temporaryPath, backupPath, transactionPath, operations);
        } else {
          const recoveryPath = await preserveRecoveryBackup(backupPath);
          await cleanupResolvedTransaction(temporaryPath, transactionPath, operations);
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
      await cleanupResolvedTransaction(temporaryPath, transactionPath, operations);
    }
    throw error;
  }

  if (!finalDocumentIdentity) throw new Error("Saved HTML identity verification did not complete");
  return {
    filePath: targetPath,
    fingerprint: intendedFingerprint,
    documentIdentity: finalDocumentIdentity,
    bytes: outputBytes,
    warnings
  };
}

export async function importImageForDocument(
  htmlPath: string,
  imagePath: string,
  operations: AssetOperations = productionAssetOperations,
  expectedDocumentIdentity?: CanonicalFileIdentity
): Promise<ImportedDocumentImage> {
  const normalizedHtmlPath = requireHtmlPath(htmlPath);
  const documentIdentity = await captureCanonicalFileIdentity(normalizedHtmlPath);
  if (expectedDocumentIdentity && !sameCanonicalFileIdentity(documentIdentity, expectedDocumentIdentity)) {
    throw new Error("The HTML path identity changed after it was opened. Reopen it before adding images.");
  }
  const normalizedImagePath = resolve(imagePath);
  const extension = extname(normalizedImagePath).toLowerCase();
  if (!isAbsolute(imagePath) || !IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("Select a PNG, JPEG, GIF, WebP, or SVG image");
  }
  const imageIdentity = await captureCanonicalFileIdentity(normalizedImagePath);

  const imageStats = await stat(normalizedImagePath);
  if (!imageStats.isFile()) {
    throw new Error("Selected image path is not a file");
  }
  if (imageStats.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is larger than the 32 MB safety limit");
  }

  const content = await readFile(normalizedImagePath);
  await requireCanonicalFileIdentity(normalizedImagePath, imageIdentity, "The selected image path identity changed while it was read");
  if (content.length > MAX_IMAGE_BYTES) {
    throw new Error("Image is larger than the 32 MB safety limit");
  }
  const contentHash = createContentFingerprint(content);
  const hash = contentHash.slice(0, 12);
  const documentName = basename(normalizedHtmlPath);
  const deckStem = sanitizeStem(basename(normalizedHtmlPath, extname(normalizedHtmlPath)));
  const imageStem = sanitizeStem(basename(normalizedImagePath, extension));
  const assetDirectoryName = `${deckStem}.assets`;
  const assetDirectory = join(dirname(normalizedHtmlPath), assetDirectoryName);
  const assetName = `${imageStem}-${hash}${extension}`;
  const targetPath = join(assetDirectory, assetName);

  const indexPath = join(assetDirectory, ASSET_INDEX_NAME);
  await requireCanonicalFileIdentity(normalizedHtmlPath, documentIdentity, "The HTML path identity changed before copying an image");
  const loadedIndex = await openOrCreateAssetIndex(normalizedHtmlPath, assetDirectory, indexPath, documentName);
  await requireCanonicalFileIdentity(normalizedHtmlPath, documentIdentity, "The HTML path identity changed while image ownership was prepared");
  const index = loadedIndex.index;
  const ownedEntry = index.files.find((entry) => assetComparisonName(entry.name) === assetComparisonName(assetName));
  let targetExists = true;
  let existing: Buffer | null = null;
  try {
    await requireCanonicalOwnedAssetFile(assetDirectory, targetPath);
    existing = await readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    targetExists = false;
  }

  if (targetExists && !ownedEntry) {
    throw new Error("Generated asset name collides with a file not owned by HTML Slide Studio");
  }
  if (
    ownedEntry &&
    (!existing ||
      !existing.equals(content) ||
      ownedEntry.bytes !== content.length ||
      ownedEntry.sha256 !== contentHash)
  ) {
    throw new Error("An app-owned asset with the same generated name has different content");
  }

  if (!targetExists) {
    let created = false;
    let createdIdentity: CanonicalFileIdentity | null = null;
    try {
      await requireCanonicalFileIdentity(normalizedHtmlPath, documentIdentity, "The HTML path identity changed before the image copy");
      // Copy the exact immutable bytes that were hashed. Re-reading the source
      // path here would let an external replacement create an unindexed asset.
      createdIdentity = (await operations.copyExclusive(normalizedImagePath, targetPath, content)) ?? await captureCanonicalFileIdentity(targetPath);
      created = true;
      await requireCanonicalFileIdentity(normalizedHtmlPath, documentIdentity, "The HTML path identity changed while the image was copied");
      await requireFingerprint(indexPath, loadedIndex.fingerprint, "The asset ownership index changed while importing the image");
      await operations.writeIndex(indexPath, {
        ...index,
        files: [...index.files, { name: assetName, sha256: contentHash, bytes: content.length }]
      }, loadedIndex.fingerprint, operations.beforeIndexInstall);
    } catch (error) {
      if (created && createdIdentity) {
        try {
          await quarantineAndRemoveOwnedFile(targetPath, { identity: createdIdentity, fingerprint: contentHash, bytes: content.length });
        } catch (cleanupError) {
          throw new Error(`Image import failed and the copied asset could not be safely cleaned up: ${errorMessage(cleanupError)}`, { cause: error });
        }
      }
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
    bytes: content.length
  };
}

export function createContentFingerprint(content: string | Uint8Array): string {
  return createHash("sha256").update(typeof content === "string" ? Buffer.from(content, "utf8") : content).digest("hex");
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
  for (const extracted of extractHtmlReferences(html)) {
    for (const reference of htmlReferenceCandidates(extracted)) {
      if (!reference || reference.startsWith("#")) continue;
      const compactScheme = reference.replace(/[\u0000-\u0020]+/g, "");
      if (/^(?:data|blob):/i.test(compactScheme)) {
        throw new Error("Saved HTML must not contain embedded or session-only data/blob references");
      }
      if (/^(?:https?|mailto|tel):/i.test(compactScheme)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(compactScheme)) {
        throw new Error("Saved HTML must not contain unsupported absolute URL schemes");
      }
      if (/\.hslides(?:[\\/]|$)/i.test(reference)) {
        throw new Error("Saved HTML must not contain .hslides references");
      }
      if (
        /^[A-Za-z]:/.test(reference) ||
        /^\\\\/.test(reference) ||
        /^\/\//.test(reference) ||
        /^\//.test(reference) ||
        reference.split(/[\\/]+/).includes("..")
      ) {
        throw new Error("Saved HTML must not contain absolute or escaping local asset paths");
      }
    }
  }
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
  schemaVersion: 3;
  owner: "html-slide-studio-legacy";
  documentName: string;
  files: AssetIndexEntry[];
};

type AssetIndexEntry = {
  name: string;
  sha256: string;
  bytes: number;
};

type LegacyAssetIndex = {
  schemaVersion: 1;
  owner: "html-slide-studio-legacy";
  files: string[];
};

type LoadedAssetIndex = {
  index: AssetIndex;
  fingerprint: string;
};

async function captureCanonicalFileIdentity(filePath: string): Promise<CanonicalFileIdentity> {
  await requireCanonicalRegularPath(filePath);
  return {
    parent: await fileSystemIdentity(dirname(filePath)),
    file: await fileSystemIdentity(filePath)
  };
}

function sameCanonicalFileIdentity(left: CanonicalFileIdentity, right: CanonicalFileIdentity): boolean {
  return left.parent === right.parent && left.file === right.file;
}

async function quarantineAndRemoveOwnedFile(filePath: string, expected: OwnedFileExpectation): Promise<void> {
  const quarantinePath = join(dirname(filePath), `.${basename(filePath)}.hss-remove-${randomUUID()}.quarantine`);
  await rename(filePath, quarantinePath);
  try {
    const identity = await captureCanonicalFileIdentity(quarantinePath);
    const bytes = await readFile(quarantinePath);
    if (
      !sameCanonicalFileIdentity(identity, expected.identity) ||
      bytes.length !== expected.bytes ||
      createContentFingerprint(bytes) !== expected.fingerprint
    ) {
      throw new Error(`Owned file identity or content changed before removal: ${basename(filePath)}`);
    }
    await rm(quarantinePath);
  } catch (error) {
    try {
      await moveFileExclusive(quarantinePath, filePath);
    } catch (restoreError) {
      throw new Error(`A changed file was retained at ${quarantinePath} because its original path could not be restored`, {
        cause: restoreError
      });
    }
    throw error;
  }
}

async function requireCanonicalFileIdentity(
  filePath: string,
  expected: CanonicalFileIdentity,
  message: string
): Promise<void> {
  const actual = await captureCanonicalFileIdentity(filePath);
  if (actual.parent !== expected.parent || actual.file !== expected.file) {
    throw new Error(message);
  }
}

async function requireCanonicalDirectoryIdentity(directoryPath: string, expected: string, message: string): Promise<void> {
  const resolvedPath = resolve(directoryPath);
  const stats = await lstat(resolvedPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(resolvedPath), resolvedPath)) {
    throw new Error(message);
  }
  if (`${stats.dev}:${stats.ino}` !== expected) throw new Error(message);
}

async function fileSystemIdentity(filePath: string): Promise<string> {
  const stats = await lstat(filePath, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

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

async function openOrCreateAssetIndex(
  htmlPath: string,
  assetDirectory: string,
  indexPath: string,
  documentName: string
): Promise<LoadedAssetIndex> {
  const documentIdentity = await captureCanonicalFileIdentity(htmlPath);
  try {
    return await loadExistingAssetIndex(htmlPath, assetDirectory, indexPath, documentName);
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
    await requireCanonicalFileIdentity(htmlPath, documentIdentity, "The HTML path identity changed before the asset directory was created");
    await mkdir(assetDirectory);
    const index: AssetIndex = { schemaVersion: 3, owner: "html-slide-studio-legacy", documentName, files: [] };
    try {
      await requireCanonicalFileIdentity(htmlPath, documentIdentity, "The HTML path identity changed before the asset ownership index was created");
      await writeAssetIndex(indexPath, index);
    } catch (error) {
      await rm(assetDirectory, { recursive: false, force: true }).catch(() => undefined);
      throw error;
    }
    const content = await readFile(indexPath);
    return { index, fingerprint: createContentFingerprint(content) };
  }
}

async function loadExistingAssetIndex(
  htmlPath: string,
  assetDirectory: string,
  indexPath: string,
  documentName: string
): Promise<LoadedAssetIndex> {
  await requireCanonicalOwnedAssetDirectory(assetDirectory, indexPath);
  const content = await readFile(indexPath);
  const parsed = parseAssetIndex(content.toString("utf8"), documentName);
  if (parsed.schemaVersion === 3) {
    return { index: parsed, fingerprint: createContentFingerprint(content) };
  }
  return migrateLegacyAssetIndex(htmlPath, assetDirectory, indexPath, documentName, parsed, content);
}

async function pruneDocumentAssets(
  htmlPath: string,
  html: string,
  expectedHtmlFingerprint: string,
  operations: AssetGcOperations
): Promise<void> {
  const htmlIdentity = await captureCanonicalFileIdentity(htmlPath);
  const documentName = basename(htmlPath);
  const deckStem = sanitizeStem(basename(htmlPath, extname(htmlPath)));
  const assetDirectoryName = `${deckStem}.assets`;
  const assetDirectory = join(dirname(htmlPath), assetDirectoryName);
  const indexPath = join(assetDirectory, ASSET_INDEX_NAME);
  let loadedIndex: LoadedAssetIndex;
  try {
    loadedIndex = await loadExistingAssetIndex(htmlPath, assetDirectory, indexPath, documentName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const index = loadedIndex.index;

  const referenced = new Set<string>();
  for (const reference of extractHtmlReferences(html)) {
    const fileName = assetFileNameFromReference(reference, assetDirectoryName);
    if (fileName) referenced.add(assetComparisonName(fileName));
  }

  const kept = index.files.filter((entry) => referenced.has(assetComparisonName(entry.name)));
  const unused = index.files.filter((entry) => !referenced.has(assetComparisonName(entry.name)));
  if (unused.length === 0) return;

  const removed: Array<{ path: string; bytes: Buffer }> = [];
  let indexChanged = false;
  let updatedIndexFingerprint: string | null = null;
  try {
    for (const entry of unused) {
      const assetPath = join(assetDirectory, entry.name);
      await requireCanonicalOwnedAssetFile(assetDirectory, assetPath);
      const assetIdentity = await captureCanonicalFileIdentity(assetPath);
      await operations.beforeRemove?.(htmlPath, assetPath);
      await requireFingerprint(htmlPath, expectedHtmlFingerprint, "The HTML changed while unused images were being checked");
      await requireCanonicalFileIdentity(htmlPath, htmlIdentity, "The HTML path identity changed while unused images were being checked");
      await requireFingerprint(indexPath, loadedIndex.fingerprint, "The asset ownership index changed while unused images were being checked");
      const bytes = await readFile(assetPath);
      if (bytes.length !== entry.bytes || createContentFingerprint(bytes) !== entry.sha256) {
        throw new Error(`Indexed image changed outside HTML Slide Studio and was preserved: ${entry.name}`);
      }
      await requireCanonicalFileIdentity(assetPath, assetIdentity, `Indexed image path identity changed and was preserved: ${entry.name}`);
      await (operations.removeOwnedAsset ?? productionAssetGcOperations.removeOwnedAsset!)(assetPath, {
        identity: assetIdentity,
        fingerprint: entry.sha256,
        bytes: entry.bytes
      });
      removed.push({ path: assetPath, bytes });
    }
    await requireFingerprint(htmlPath, expectedHtmlFingerprint, "The HTML changed while unused images were being removed");
    await requireCanonicalFileIdentity(htmlPath, htmlIdentity, "The HTML path identity changed while unused images were being removed");
    await requireFingerprint(indexPath, loadedIndex.fingerprint, "The asset ownership index changed while unused images were being removed");
    updatedIndexFingerprint = await writeAssetIndex(indexPath, { ...index, files: kept }, loadedIndex.fingerprint);
    indexChanged = true;
    await requireFingerprint(htmlPath, expectedHtmlFingerprint, "The HTML changed while unused image ownership was being updated");
  } catch (error) {
    let restorationError: unknown = null;
    for (const removedAsset of removed.reverse()) {
      try {
        const handle = await open(removedAsset.path, "wx");
        try {
          await handle.writeFile(removedAsset.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (restoreError) {
        restorationError ??= restoreError;
      }
    }
    if (indexChanged && updatedIndexFingerprint) {
      try {
        await writeAssetIndex(indexPath, index, updatedIndexFingerprint);
      } catch (restoreError) {
        restorationError ??= restoreError;
      }
    }
    if (restorationError) {
      throw new Error(`Unused image cleanup stopped and rollback could not be verified: ${errorMessage(restorationError)}`, { cause: error });
    }
    throw error;
  }
}

function assetFileNameFromReference(reference: HtmlReference, assetDirectoryName: string): string | null {
  let pathValue = decodeHtmlReference(reference).replace(/[?#].*$/, "").replace(/\\/g, "/");
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathValue)) pathValue = decodeURIComponent(new URL(pathValue).pathname);
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

async function recoverSaveArtifacts(targetPath: string, operations: RecoveryOperations): Promise<string[]> {
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
  const warnings = await recoverSaveTransaction(targetPath, latest.journal, latest.transactionPath, operations);
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
  transactionPath: string,
  operations: RecoveryOperations
): Promise<string[]> {
  const paths = saveArtifactPaths(targetPath, transaction.operationId);
  const target = await inspectHtmlFile(targetPath);
  const backup = await inspectHtmlFile(paths.backupPath);

  if (!backup.exists) {
    if (target.valid) {
      if (
        target.fingerprint === transaction.expectedFingerprint ||
        target.fingerprint === transaction.intendedFingerprint
      ) {
        await cleanupResolvedTransaction(paths.temporaryPath, transactionPath);
        return [];
      }
      await cleanupResolvedTransaction(paths.temporaryPath, transactionPath);
      return ["The HTML changed outside the app after an interrupted pre-replace save. The current file was left untouched."];
    }
    throw new Error(`Interrupted save has no valid backup. Recovery metadata was retained: ${transactionPath}`);
  }
  if (!backup.valid || !backup.fingerprint) {
    throw new Error(`Interrupted save backup is invalid. Recovery metadata was retained: ${paths.backupPath}`);
  }
  if (backup.fingerprint !== transaction.expectedFingerprint) {
    const recoveryPath = await preserveRecoveryBackup(paths.backupPath);
    await cleanupResolvedTransaction(paths.temporaryPath, transactionPath);
    return [`Interrupted save backup did not match the pre-save HTML. The current file was left untouched and the backup was retained: ${recoveryPath}`];
  }

  if (!target.valid || !target.fingerprint) {
    const invalidCapture = await restoreBackupForRecovery(
      paths.backupPath,
      targetPath,
      backup,
      transaction.operationId,
      target,
      operations
    );
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
      transaction.intendedFingerprint,
      transaction.expectedFingerprint
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

type InspectedHtmlFile = {
  exists: boolean;
  valid: boolean;
  fingerprint: string | null;
  identity: CanonicalFileIdentity | null;
  bytes: number | null;
};

async function inspectHtmlFile(filePath: string): Promise<InspectedHtmlFile> {
  try {
    const fileStats = await lstat(filePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
      return { exists: true, valid: false, fingerprint: null, identity: null, bytes: null };
    }
    const identity = await captureCanonicalFileIdentity(filePath);
    const bytes = await readFile(filePath);
    const fingerprint = createContentFingerprint(bytes);
    await requireCanonicalFileIdentity(filePath, identity, "HTML path identity changed while recovery state was inspected");
    await requireFingerprint(filePath, fingerprint, "HTML bytes changed while recovery state was inspected");
    try {
      const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateHtmlOutput(html);
      return { exists: true, valid: true, fingerprint, identity, bytes: bytes.length };
    } catch {
      return { exists: true, valid: false, fingerprint, identity, bytes: bytes.length };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, valid: false, fingerprint: null, identity: null, bytes: null };
    }
    return { exists: true, valid: false, fingerprint: null, identity: null, bytes: null };
  }
}

async function restoreBackupForRecovery(
  backupPath: string,
  targetPath: string,
  backup: InspectedHtmlFile,
  operationId: string,
  target: InspectedHtmlFile,
  operations: RecoveryOperations
): Promise<string | null> {
  if (!backup.fingerprint || !backup.identity || backup.bytes === null) {
    throw new Error(`Interrupted save ${operationId} backup identity is unavailable; the current target was left untouched`);
  }
  let invalidPath: string | null = null;
  await operations.beforeRestoreInvalid?.(targetPath, backupPath);
  if (target.exists) {
    if (!target.fingerprint || !target.identity || target.bytes === null) {
      throw new Error(`Interrupted save ${operationId} target identity is unavailable; recovery metadata was retained`);
    }
    invalidPath = await moveToUniqueRecoveryPath(
      targetPath,
      backupPath.replace(/\.bak$/i, ""),
      RECOVERY_INVALID_SUFFIX
    );
    const movedIdentity = await captureCanonicalFileIdentity(invalidPath);
    const movedBytes = await readFile(invalidPath);
    if (
      !sameCanonicalFileIdentity(movedIdentity, target.identity) ||
      movedBytes.length !== target.bytes ||
      createContentFingerprint(movedBytes) !== target.fingerprint
    ) {
      await restoreQuarantinedFile(invalidPath, targetPath, operations.beforeRestoreQuarantine);
      throw new Error(`Interrupted save ${operationId} target changed before recovery; the latest target was left untouched`);
    }
  }

  try {
    const backupBytes = await readFile(backupPath);
    await requireCanonicalFileIdentity(backupPath, backup.identity, `Interrupted save ${operationId} backup identity changed before recovery`);
    if (backupBytes.length !== backup.bytes || createContentFingerprint(backupBytes) !== backup.fingerprint) {
      throw new Error(`Interrupted save ${operationId} backup changed before recovery`);
    }
    const handle = await open(targetPath, "wx");
    try {
      await handle.writeFile(backupBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await requireFingerprint(targetPath, backup.fingerprint, `Interrupted save ${operationId} recovery verification failed`);
  } catch (error) {
    if (invalidPath && !(await pathExists(targetPath))) {
      await restoreQuarantinedFile(invalidPath, targetPath, operations.beforeRestoreQuarantine);
      invalidPath = null;
    }
    throw new Error(`Interrupted save ${operationId} recovery stopped without overwriting a newer target`, { cause: error });
  }
  return invalidPath;
}

async function restoreQuarantinedFile(
  quarantinePath: string,
  targetPath: string,
  beforeRestore?: (quarantinePath: string, targetPath: string) => Promise<void>
): Promise<void> {
  await beforeRestore?.(quarantinePath, targetPath);
  try {
    await moveFileExclusive(quarantinePath, targetPath);
  } catch (error) {
    throw new Error(`The quarantined file was retained at ${quarantinePath} because its original path is occupied`, {
      cause: error
    });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
  transactionPath: string;
} {
  const prefix = join(dirname(targetPath), `.${basename(targetPath)}.${ARTIFACT_PATTERN_PART}-${operationId}`);
  return { temporaryPath: `${prefix}.tmp`, backupPath: `${prefix}.bak`, transactionPath: `${prefix}.txn.json` };
}

function parseAssetIndex(content: string, expectedDocumentName: string): AssetIndex | LegacyAssetIndex {
  const value = JSON.parse(content) as {
    schemaVersion?: unknown;
    owner?: unknown;
    documentName?: unknown;
    files?: unknown;
  };
  if (value.owner !== TRANSACTION_OWNER || !Array.isArray(value.files)) {
    throw new Error("Adjacent asset directory ownership index is invalid");
  }
  if (value.schemaVersion === 1) {
    if (!value.files.every(isSafeAssetFileName) || hasDuplicateAssetNames(value.files)) {
      throw new Error("Legacy adjacent asset ownership index is invalid");
    }
    return { schemaVersion: 1, owner: TRANSACTION_OWNER, files: [...value.files] };
  }
  if (
    value.schemaVersion !== 3 ||
    typeof value.documentName !== "string" ||
    !isSafeDocumentName(value.documentName) ||
    !sameDocumentName(value.documentName, expectedDocumentName) ||
    !value.files.every(isAssetIndexEntry) ||
    hasDuplicateAssetNames(value.files.map((entry) => entry.name))
  ) {
    throw new Error("Adjacent asset directory ownership index is invalid");
  }
  return {
    schemaVersion: 3,
    owner: TRANSACTION_OWNER,
    documentName: value.documentName,
    files: value.files.map((entry) => ({ ...entry }))
  };
}

async function migrateLegacyAssetIndex(
  htmlPath: string,
  assetDirectory: string,
  indexPath: string,
  documentName: string,
  legacy: LegacyAssetIndex,
  originalContent: Buffer
): Promise<LoadedAssetIndex> {
  const documentIdentity = await captureCanonicalFileIdentity(htmlPath);
  await requireUnambiguousLegacyAssetOwner(htmlPath);
  const files: AssetIndexEntry[] = [];
  for (const name of legacy.files) {
    const assetPath = join(assetDirectory, name);
    await requireCanonicalOwnedAssetFile(assetDirectory, assetPath);
    const bytes = await readFile(assetPath);
    const sha256 = createContentFingerprint(bytes);
    const entry = { name, sha256, bytes: bytes.length };
    if (!isAssetIndexEntry(entry)) {
      throw new Error(`Legacy indexed image could not be verified and was preserved: ${name}`);
    }
    files.push(entry);
  }

  await requireCanonicalFileIdentity(htmlPath, documentIdentity, "The HTML path identity changed during legacy asset migration");
  await requireUnambiguousLegacyAssetOwner(htmlPath);
  await requireFingerprint(indexPath, createContentFingerprint(originalContent), "The legacy asset ownership index changed during migration");
  const index: AssetIndex = { schemaVersion: 3, owner: TRANSACTION_OWNER, documentName, files };
  await writeAssetIndex(indexPath, index, createContentFingerprint(originalContent));
  const migratedContent = await readFile(indexPath);
  const migrated = parseAssetIndex(migratedContent.toString("utf8"), documentName);
  if (migrated.schemaVersion !== 3) {
    throw new Error("Legacy asset ownership migration verification failed");
  }
  return { index: migrated, fingerprint: createContentFingerprint(migratedContent) };
}

async function requireUnambiguousLegacyAssetOwner(htmlPath: string): Promise<void> {
  const documentName = basename(htmlPath);
  const expectedStem = sanitizeStem(basename(htmlPath, extname(htmlPath)));
  const siblingCandidates = (await readdir(dirname(htmlPath))).filter((name) => {
    if (!HTML_EXTENSIONS.has(extname(name).toLowerCase())) return false;
    return assetComparisonName(sanitizeStem(basename(name, extname(name)))) === assetComparisonName(expectedStem);
  });
  if (siblingCandidates.length !== 1 || !sameDocumentName(siblingCandidates[0], documentName)) {
    throw new Error("Legacy image assets were preserved because the owning HTML file could not be identified unambiguously");
  }
}

async function writeAssetIndex(
  indexPath: string,
  index: AssetIndex,
  expectedFingerprint?: string,
  beforeInstall?: (indexPath: string) => Promise<void>
): Promise<string> {
  const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(index, null, 2)}\n`;
  const nextFingerprint = createContentFingerprint(content);
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let previousPath: string | null = null;
  try {
    if (expectedFingerprint) {
      const expectedIdentity = await captureCanonicalFileIdentity(indexPath);
      previousPath = join(dirname(indexPath), `.${basename(indexPath)}.hss-index-${randomUUID()}.quarantine`);
      await moveFileExclusive(indexPath, previousPath);
      const movedIdentity = await captureCanonicalFileIdentity(previousPath);
      const movedBytes = await readFile(previousPath);
      if (
        !sameCanonicalFileIdentity(movedIdentity, expectedIdentity) ||
        createContentFingerprint(movedBytes) !== expectedFingerprint
      ) {
        await restoreQuarantinedFile(previousPath, indexPath);
        previousPath = null;
        throw new Error("The asset ownership index changed before it could be replaced");
      }
    }
    await beforeInstall?.(indexPath);
    try {
      await moveFileExclusive(temporaryPath, indexPath);
    } catch (error) {
      if (previousPath) {
        try {
          await restoreQuarantinedFile(previousPath, indexPath);
          previousPath = null;
        } catch (restoreError) {
          throw new Error(`The asset ownership index replacement stopped and the previous index was retained at ${previousPath}`, {
            cause: restoreError
          });
        }
      }
      throw error;
    }
    if (previousPath) {
      await rm(previousPath).catch(() => undefined);
      previousPath = null;
    }
    return nextFingerprint;
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

async function cleanupResolvedTransaction(
  temporaryPath: string,
  transactionPath: string,
  operations: SaveOperations = productionSaveOperations
): Promise<void> {
  const expected = await artifactCleanupExpectations(transactionPath, temporaryPath);
  await removeOwnedArtifact(temporaryPath, expected.temporaryFingerprint, operations);
  await removeOwnedArtifact(transactionPath, expected.transactionFingerprint, operations);
}

async function cleanupSuccessfulTransaction(
  temporaryPath: string,
  backupPath: string,
  transactionPath: string,
  operations: SaveOperations = productionSaveOperations
): Promise<void> {
  const expected = await artifactCleanupExpectations(transactionPath, temporaryPath, backupPath);
  await removeOwnedArtifact(temporaryPath, expected.temporaryFingerprint, operations);
  await removeOwnedArtifact(backupPath, expected.backupFingerprint, operations);
  await removeOwnedArtifact(transactionPath, expected.transactionFingerprint, operations);
}

async function artifactCleanupExpectations(
  transactionPath: string,
  temporaryPath: string,
  backupPath?: string
): Promise<{ transactionFingerprint: string; temporaryFingerprint: string; backupFingerprint: string }> {
  const transactionBytes = await readFile(transactionPath);
  const transaction = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(transactionBytes)) as Partial<SaveTransaction>;
  if (
    transaction.schemaVersion !== 1 ||
    transaction.owner !== TRANSACTION_OWNER ||
    typeof transaction.operationId !== "string" ||
    !new RegExp(`^${UUID_PATTERN}$`).test(transaction.operationId) ||
    typeof transaction.targetName !== "string" ||
    basename(transaction.targetName) !== transaction.targetName ||
    typeof transaction.expectedFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(transaction.expectedFingerprint) ||
    typeof transaction.intendedFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(transaction.intendedFingerprint)
  ) {
    throw new Error("Save cleanup refused an invalid owner journal");
  }
  const paths = saveArtifactPaths(join(dirname(transactionPath), transaction.targetName), transaction.operationId);
  if (
    !samePath(paths.transactionPath, transactionPath) ||
    !samePath(paths.temporaryPath, temporaryPath) ||
    (backupPath && !samePath(paths.backupPath, backupPath))
  ) {
    throw new Error("Save cleanup paths did not match the owner journal");
  }
  return {
    transactionFingerprint: createContentFingerprint(transactionBytes),
    temporaryFingerprint: transaction.intendedFingerprint,
    backupFingerprint: transaction.expectedFingerprint
  };
}

async function removeOwnedArtifact(filePath: string, expectedFingerprint: string, operations: SaveOperations): Promise<void> {
  if (operations.removeArtifact) {
    await operations.removeArtifact(filePath);
    return;
  }
  let identity: CanonicalFileIdentity;
  let bytes: Buffer;
  try {
    identity = await captureCanonicalFileIdentity(filePath);
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (createContentFingerprint(bytes) !== expectedFingerprint) {
    throw new Error(`Save cleanup preserved an artifact whose content no longer matched its owner journal: ${filePath}`);
  }
  await operations.beforeRemoveArtifact?.(filePath);
  await quarantineAndRemoveOwnedFile(filePath, { identity, fingerprint: expectedFingerprint, bytes: bytes.length });
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

function isAssetIndexEntry(value: unknown): value is AssetIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<AssetIndexEntry>;
  if (
    !isSafeAssetFileName(entry.name) ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry.bytes) ||
    (entry.bytes ?? -1) < 0 ||
    (entry.bytes ?? 0) > MAX_IMAGE_BYTES
  ) {
    return false;
  }
  const extension = extname(entry.name).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) && entry.name.toLowerCase().endsWith(`-${entry.sha256.slice(0, 12)}${extension}`);
}

function hasDuplicateAssetNames(names: string[]): boolean {
  const compared = names.map(assetComparisonName);
  return new Set(compared).size !== compared.length;
}

function isSafeDocumentName(value: string): boolean {
  return value.length > 0 && value.length <= 255 && basename(value) === value && HTML_EXTENSIONS.has(extname(value).toLowerCase());
}

function sameDocumentName(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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
  if (!indexStats.isFile() || indexStats.isSymbolicLink() || indexStats.nlink !== 1 || !samePath(await realpath(indexPath), indexPath)) {
    throw new Error("Adjacent asset ownership index must be a regular file");
  }
}

async function requireCanonicalOwnedAssetFile(assetDirectory: string, assetPath: string): Promise<void> {
  const resolvedDirectory = resolve(assetDirectory);
  const resolvedAsset = resolve(assetPath);
  if (dirname(resolvedAsset) !== resolvedDirectory) {
    throw new Error("Indexed asset path escaped its owned directory");
  }
  const assetStats = await lstat(resolvedAsset);
  if (!assetStats.isFile() || assetStats.isSymbolicLink() || assetStats.nlink !== 1 || !samePath(await realpath(resolvedAsset), resolvedAsset)) {
    throw new Error("Indexed asset must be a canonical regular file");
  }
}

async function requireFingerprint(filePath: string, expected: string, message: string): Promise<void> {
  const actual = createContentFingerprint(await readFile(filePath));
  if (actual !== expected) {
    throw new Error(message);
  }
}

async function readUtf8HtmlFile(filePath: string): Promise<{ bytes: Buffer; html: string }> {
  const bytes = await readFile(filePath);
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("HTML files must use valid UTF-8 encoding", { cause: error });
  }
  return { bytes, html };
}

async function preserveRecoveryBackup(backupPath: string): Promise<string> {
  try {
    return await moveToUniqueRecoveryPath(
      backupPath,
      backupPath.replace(/\.bak$/i, ""),
      RECOVERY_ARTIFACT_SUFFIX
    );
  } catch {
    return backupPath;
  }
}

async function moveToUniqueRecoveryPath(sourcePath: string, prefix: string, suffix: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const recoveryPath = `${prefix}.${randomUUID()}${suffix}`;
    try {
      await moveFileExclusive(sourcePath, recoveryPath);
      return recoveryPath;
    } catch (error) {
      if (await pathExists(recoveryPath)) continue;
      throw error;
    }
  }
  throw new Error(`Could not allocate an exclusive recovery path for ${basename(sourcePath)}`);
}

async function moveFileExclusive(sourcePath: string, targetPath: string): Promise<void> {
  if (process.platform === "win32") {
    await runWindowsPowerShell(
      "move-exclusive",
      { HSS_MOVE_SOURCE: sourcePath, HSS_MOVE_TARGET: targetPath }
    );
    return;
  }
  await link(sourcePath, targetPath);
  await rm(sourcePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function windowsReplaceWithBackup(temporaryPath: string, targetPath: string, backupPath: string): Promise<void> {
  requireWindowsFileReplace();
  await runWindowsPowerShell(
    "replace-with-backup",
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
  expectedTargetFingerprint: string,
  expectedBackupFingerprint: string
): Promise<"restored" | "changed" | "backup-changed"> {
  requireWindowsFileReplace();
  const { stdout } = await runWindowsPowerShell("restore-if-unchanged", {
    HSS_RESTORE_BACKUP: backupPath,
    HSS_RESTORE_TARGET: targetPath,
    HSS_RESTORE_EXPECTED: expectedTargetFingerprint,
    HSS_RESTORE_BACKUP_EXPECTED: expectedBackupFingerprint
  });
  const outcome = stdout.trim();
  if (outcome !== "restored" && outcome !== "changed" && outcome !== "backup-changed") {
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
  operation: keyof typeof windowsPowerShellScripts,
  operationEnvironment: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) {
    throw new Error("SystemRoot is unavailable; safe overwrite cannot run");
  }
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const options = {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...operationEnvironment }
  } as const;

  switch (operation) {
    case "move-exclusive":
      return execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellScripts["move-exclusive"]], options);
    case "replace-with-backup":
      return execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellScripts["replace-with-backup"]], options);
    case "restore-if-unchanged":
      return execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPowerShellScripts["restore-if-unchanged"]], options);
  }
}

const windowsPowerShellScripts = {
  "move-exclusive": "$ErrorActionPreference='Stop'; [System.IO.File]::Move($env:HSS_MOVE_SOURCE, $env:HSS_MOVE_TARGET)",
  "replace-with-backup": "$ErrorActionPreference='Stop'; [System.IO.File]::Replace($env:HSS_REPLACE_SOURCE, $env:HSS_REPLACE_TARGET, $env:HSS_REPLACE_BACKUP, $true)",
  "restore-if-unchanged": [
    "$ErrorActionPreference='Stop'",
    "$target = [System.IO.FileStream]::new($env:HSS_RESTORE_TARGET, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)",
    "try {",
    "  $sha = [System.Security.Cryptography.SHA256]::Create()",
    "  try { $actual = ([System.BitConverter]::ToString($sha.ComputeHash($target))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }",
    "  if ($actual -ne $env:HSS_RESTORE_EXPECTED) { [Console]::Out.Write('changed'); return }",
    "  $backup = [System.IO.FileStream]::new($env:HSS_RESTORE_BACKUP, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "  try {",
    "    $backupSha = [System.Security.Cryptography.SHA256]::Create()",
    "    try { $backupActual = ([System.BitConverter]::ToString($backupSha.ComputeHash($backup))).Replace('-', '').ToLowerInvariant() } finally { $backupSha.Dispose() }",
    "    if ($backupActual -ne $env:HSS_RESTORE_BACKUP_EXPECTED) { [Console]::Out.Write('backup-changed'); return }",
    "    $backup.Position = 0",
    "    $target.Position = 0",
    "    $target.SetLength(0)",
    "    $backup.CopyTo($target)",
    "    $target.Flush($true)",
    "  } finally { $backup.Dispose() }",
    "  [Console]::Out.Write('restored')",
    "} finally { $target.Dispose() }"
  ].join("; ")
} as const;
