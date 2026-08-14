import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createContentFingerprint,
  importImageForDocument,
  openHtmlDocument,
  productionAssetOperations,
  productionAssetGcOperations,
  productionSaveOperations,
  saveHtmlDocument
} from "../../src/main/documentFiles.ts";
import { withDocumentSaveLock } from "../../src/main/documentSaveMutex.ts";

const ORIGINAL = "<!doctype html><html><body><section>Original</section></body></html>";
const EDITED = "<!doctype html><html><body><section>Edited</section></body></html>";
const TRANSACTION_OWNER = "html-slide-studio-legacy";

function emptyAssetIndex(documentName = "deck.html") {
  return { schemaVersion: 3, owner: TRANSACTION_OWNER, documentName, files: [] };
}

async function withDocument(run) {
  const directory = await mkdtemp(join(tmpdir(), "hss-document-files-"));
  const filePath = join(directory, "deck.html");
  await writeFile(filePath, ORIGINAL, "utf8");
  try {
    await run({ directory, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function injectedReplace({ beforeReplace, afterReplace, beforeRestore, restoreFailure } = {}) {
  return {
    async replaceWithBackup(temporaryPath, targetPath, backupPath) {
      await beforeReplace?.({ temporaryPath, targetPath, backupPath });
      await rename(targetPath, backupPath);
      await rename(temporaryPath, targetPath);
      await afterReplace?.({ temporaryPath, targetPath, backupPath });
    },
    async restoreBackupIfTargetMatches(backupPath, targetPath, expectedTargetFingerprint, expectedBackupFingerprint) {
      if (restoreFailure) {
        throw new Error("injected rollback failure");
      }
      const current = await readFile(targetPath, "utf8");
      if (createContentFingerprint(current) !== expectedTargetFingerprint) {
        return "changed";
      }
      const backup = await readFile(backupPath);
      if (createContentFingerprint(backup) !== expectedBackupFingerprint) {
        return "backup-changed";
      }
      await writeFile(targetPath, backup);
      return "restored";
    },
    beforeRestore
  };
}

async function createInterruptedTransaction({
  directory,
  operationId = "00000000-0000-4000-8000-000000000001",
  targetName = "deck.html",
  createdAt = "2026-08-10T00:00:00.000Z",
  expectedHtml = ORIGINAL,
  intendedHtml = EDITED,
  backupHtml = ORIGINAL,
  temporaryHtml = EDITED
}) {
  const prefix = `.${targetName}.hss-save-${operationId}`;
  const transactionPath = join(directory, `${prefix}.txn.json`);
  const backupPath = join(directory, `${prefix}.bak`);
  const temporaryPath = join(directory, `${prefix}.tmp`);
  await writeFile(transactionPath, JSON.stringify({
    schemaVersion: 1,
    owner: TRANSACTION_OWNER,
    operationId,
    targetName,
    createdAt,
    expectedFingerprint: createContentFingerprint(expectedHtml),
    intendedFingerprint: createContentFingerprint(intendedHtml)
  }), "utf8");
  if (backupHtml !== null) await writeFile(backupPath, backupHtml, "utf8");
  if (temporaryHtml !== null) await writeFile(temporaryPath, temporaryHtml, "utf8");
  return { transactionPath, backupPath, temporaryPath, prefix };
}

test("openHtmlDocument returns a canonical document and SHA-256 fingerprint", async () => {
  await withDocument(async ({ filePath }) => {
    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.html, ORIGINAL);
    assert.equal(opened.filePath, filePath);
    assert.equal(opened.fingerprint, createContentFingerprint(ORIGINAL));
    assert.deepEqual(opened.warnings, []);
  });
});

test("open recovers an invalid target left by an interrupted rollback and retains the invalid bytes", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ directory, filePath }) => {
    await writeFile(filePath, "partial rollback bytes", "utf8");
    const transaction = await createInterruptedTransaction({ directory });
    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.html, ORIGINAL);
    assert.equal(await readFile(filePath, "utf8"), ORIGINAL);
    await assert.rejects(readFile(transaction.transactionPath), { code: "ENOENT" });
    await assert.rejects(readFile(transaction.backupPath), { code: "ENOENT" });
    await assert.rejects(readFile(transaction.temporaryPath), { code: "ENOENT" });
    const invalidCaptures = (await readdir(directory)).filter((name) => name.endsWith(".recovery.invalid"));
    assert.equal(invalidCaptures.length, 1);
    assert.equal(await readFile(join(directory, invalidCaptures[0]), "utf8"), "partial rollback bytes");
  });
});

test("recovery preserves a valid external target that replaces invalid bytes after inspection", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ directory, filePath }) => {
    const invalid = "partial rollback bytes";
    const external = ORIGINAL.replace("Original", "External after inspection");
    const displacedInvalid = join(directory, "displaced-invalid.html");
    await writeFile(filePath, invalid, "utf8");
    const transaction = await createInterruptedTransaction({ directory });

    await assert.rejects(
      openHtmlDocument(filePath, undefined, {
        beforeRestoreInvalid: async () => {
          await rename(filePath, displacedInvalid);
          await writeFile(filePath, external, "utf8");
        }
      }),
      /target changed before recovery/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
    assert.equal(await readFile(displacedInvalid, "utf8"), invalid);
    assert.equal(await readFile(transaction.backupPath, "utf8"), ORIGINAL);
    assert.ok((await readFile(transaction.transactionPath, "utf8")).includes(TRANSACTION_OWNER));
  });
});

test("recovery exclusive restore never overwrites a newer target created after quarantine", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ directory, filePath }) => {
    const changedInvalid = "changed invalid bytes";
    const newer = ORIGINAL.replace("Original", "Newer during restore");
    await writeFile(filePath, "initial invalid bytes", "utf8");
    const transaction = await createInterruptedTransaction({ directory });

    await assert.rejects(
      openHtmlDocument(filePath, undefined, {
        beforeRestoreInvalid: async () => writeFile(filePath, changedInvalid, "utf8"),
        beforeRestoreQuarantine: async () => writeFile(filePath, newer, { encoding: "utf8", flag: "wx" })
      }),
      /quarantined file was retained/
    );
    assert.equal(await readFile(filePath, "utf8"), newer);
    const invalidCaptures = (await readdir(directory)).filter((name) => name.endsWith(".recovery.invalid"));
    assert.equal(invalidCaptures.length, 1);
    assert.equal(await readFile(join(directory, invalidCaptures[0]), "utf8"), changedInvalid);
    assert.equal(await readFile(transaction.backupPath, "utf8"), ORIGINAL);
    assert.ok((await readFile(transaction.transactionPath, "utf8")).includes(TRANSACTION_OWNER));
  });
});

test("recovery uses unique capture names without overwriting preexisting recovery files", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ directory, filePath }) => {
    await writeFile(filePath, "invalid target", "utf8");
    const transaction = await createInterruptedTransaction({ directory });
    const fixedInvalidPath = join(directory, `${transaction.prefix}.recovery.invalid`);
    await writeFile(fixedInvalidPath, "PREEXISTING INVALID RECOVERY", "utf8");
    await openHtmlDocument(filePath);

    assert.equal(await readFile(fixedInvalidPath, "utf8"), "PREEXISTING INVALID RECOVERY");
    const invalidCaptures = (await readdir(directory)).filter(
      (name) => name.endsWith(".recovery.invalid") && join(directory, name) !== fixedInvalidPath
    );
    assert.equal(invalidCaptures.length, 1);
    assert.equal(await readFile(join(directory, invalidCaptures[0]), "utf8"), "invalid target");
  });

  await withDocument(async ({ directory, filePath }) => {
    const external = ORIGINAL.replace("Original", "External current");
    await writeFile(filePath, external, "utf8");
    const transaction = await createInterruptedTransaction({ directory });
    const fixedBackupPath = join(directory, `${transaction.prefix}.recovery.bak`);
    await writeFile(fixedBackupPath, "PREEXISTING BACKUP RECOVERY", "utf8");
    await openHtmlDocument(filePath);

    assert.equal(await readFile(fixedBackupPath, "utf8"), "PREEXISTING BACKUP RECOVERY");
    const backupCaptures = (await readdir(directory)).filter(
      (name) => name.endsWith(".recovery.bak") && join(directory, name) !== fixedBackupPath
    );
    assert.equal(backupCaptures.length, 1);
    assert.equal(await readFile(join(directory, backupCaptures[0]), "utf8"), ORIGINAL);
  });
});

test("recovery chooses the newest valid owner journal by explicit timestamp", async () => {
  await withDocument(async ({ directory, filePath }) => {
    await rm(filePath);
    const older = ORIGINAL.replace("Original", "Older backup");
    const newer = ORIGINAL.replace("Original", "Newest backup");
    await createInterruptedTransaction({
      directory,
      operationId: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-08-10T00:00:00.000Z",
      expectedHtml: older,
      backupHtml: older
    });
    await createInterruptedTransaction({
      directory,
      operationId: "00000000-0000-4000-8000-000000000003",
      createdAt: "2026-08-10T00:01:00.000Z",
      expectedHtml: newer,
      backupHtml: newer
    });
    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.html, newer);
    const recoveryBackups = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recoveryBackups.length, 1);
    assert.equal(await readFile(join(directory, recoveryBackups[0]), "utf8"), older);
    assert.equal(opened.warnings.length, 2);
  });
});

test("strict-looking artifacts without a valid owner journal are never removed", async () => {
  await withDocument(async ({ directory, filePath }) => {
    const operationId = "00000000-0000-4000-8000-000000000004";
    const backupPath = join(directory, `.deck.html.hss-save-${operationId}.bak`);
    const temporaryPath = join(directory, `.deck.html.hss-save-${operationId}.tmp`);
    const transactionPath = join(directory, `.deck.html.hss-save-${operationId}.txn.json`);
    await writeFile(backupPath, "user backup", "utf8");
    await writeFile(temporaryPath, "user temp", "utf8");
    await writeFile(transactionPath, JSON.stringify({ owner: "someone-else" }), "utf8");
    await openHtmlDocument(filePath);
    assert.equal(await readFile(backupPath, "utf8"), "user backup");
    assert.equal(await readFile(temporaryPath, "utf8"), "user temp");
    assert.match(await readFile(transactionPath, "utf8"), /someone-else/);
  });
});

test("a valid external target remains untouched while the interrupted backup is retained", async () => {
  await withDocument(async ({ directory, filePath }) => {
    const external = ORIGINAL.replace("Original", "External latest");
    await writeFile(filePath, external, "utf8");
    const transaction = await createInterruptedTransaction({ directory });
    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.html, external);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /left untouched.*recovery backup/i);
    assert.equal(await readFile(filePath, "utf8"), external);
    const recoveryBackups = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recoveryBackups.length, 1);
    assert.equal(await readFile(join(directory, recoveryBackups[0]), "utf8"), ORIGINAL);
  });
});

test("saveHtmlDocument uses the Windows File.Replace path and overwrites the same file", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const result = await saveHtmlDocument({
      filePath,
      html: EDITED,
      expectedFingerprint: createContentFingerprint(ORIGINAL),
      expectedSlideCount: 1
    });
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    assert.equal(result.fingerprint, createContentFingerprint(EDITED));
    assert.deepEqual(result.warnings, []);
    assert.equal((await readdir(directory)).some((name) => name.includes("hss-save")), false);
  });
});

test("saveHtmlDocument rejects a change visible before replacement without touching it", async () => {
  await withDocument(async ({ filePath }) => {
    const external = ORIGINAL.replace("Original", "External");
    await writeFile(filePath, external, "utf8");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace()
      ),
      /changed outside/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
  });
});

test("per-document save lock permits only one transaction and makes a queued stale save fail", async () => {
  await withDocument(async ({ filePath, directory }) => {
    let releaseFirst;
    let reachedReplace;
    const replaceGate = new Promise((resolve) => { releaseFirst = resolve; });
    const reachedReplaceGate = new Promise((resolve) => { reachedReplace = resolve; });
    const first = withDocumentSaveLock(filePath, () => saveHtmlDocument(
      { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      injectedReplace({ beforeReplace: async () => { reachedReplace(); await replaceGate; } })
    ));
    const secondHtml = EDITED.replace("Edited", "Queued edit");
    const second = withDocumentSaveLock(filePath, () => saveHtmlDocument(
      { filePath, html: secondHtml, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      injectedReplace()
    ));
    const secondRejected = assert.rejects(second, /changed outside/);
    await reachedReplaceGate;
    const activeArtifacts = (await readdir(directory)).filter((name) => name.includes("hss-save"));
    assert.equal(new Set(activeArtifacts.map((name) => name.match(/hss-save-([0-9a-f-]+)/)?.[1])).size, 1);
    releaseFirst();
    await first;
    await secondRejected;
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    assert.equal((await readdir(directory)).some((name) => name.includes("hss-save")), false);
  });
});

test("a pre-replace external backup is retained instead of being restored over the saved HTML", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const external = ORIGINAL.replace("Original", "External just before replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace({ beforeReplace: () => writeFile(filePath, external, "utf8") })
      ),
      /untrusted backup was retained/
    );
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), external);
  });
});

test("a backup changed after replacement is never restored over the current HTML", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const injectedBackup = ORIGINAL.replace("Original", "Injected backup replacement");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace({
          afterReplace: async ({ backupPath }) => writeFile(backupPath, injectedBackup, "utf8")
        })
      ),
      /untrusted backup was retained/
    );
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), injectedBackup);
  });
});

test("production File.Replace retains a pre-replace external backup without restoring it", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const external = ORIGINAL.replace("Original", "External captured by File.Replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        {
          replaceWithBackup: async (temporaryPath, targetPath, backupPath) => {
            await writeFile(targetPath, external, "utf8");
            await productionSaveOperations.replaceWithBackup(temporaryPath, targetPath, backupPath);
          },
          restoreBackupIfTargetMatches: productionSaveOperations.restoreBackupIfTargetMatches
        }
      ),
      /untrusted backup was retained/
    );
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), external);
  });
});

test("post-replace external race leaves the latest target untouched and retains recovery backup", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const latestExternal = ORIGINAL.replace("Original", "External after replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace({ afterReplace: () => writeFile(filePath, latestExternal, "utf8") })
      ),
      /latest target was left untouched/
    );
    assert.equal(await readFile(filePath, "utf8"), latestExternal);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), ORIGINAL);
  });
});

test("production rollback guard leaves a post-File.Replace external write untouched", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const latestExternal = ORIGINAL.replace("Original", "Latest external after File.Replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        {
          replaceWithBackup: async (temporaryPath, targetPath, backupPath) => {
            await productionSaveOperations.replaceWithBackup(temporaryPath, targetPath, backupPath);
            await writeFile(targetPath, latestExternal, "utf8");
          },
          restoreBackupIfTargetMatches: productionSaveOperations.restoreBackupIfTargetMatches
        }
      ),
      /latest target was left untouched/
    );
    assert.equal(await readFile(filePath, "utf8"), latestExternal);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), ORIGINAL);
  });
});

test("rollback failure retains a recovery backup", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const external = ORIGINAL.replace("Original", "External at replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace({ beforeReplace: () => writeFile(filePath, external, "utf8"), restoreFailure: true })
      ),
      /untrusted backup was retained/
    );
    const backups = (await readdir(directory)).filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(directory, backups[0]), "utf8"), external);
  });
});

test("same-byte target replacement is detected by file identity before save is accepted", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const originalFile = join(directory, "original-file.html");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace({
          beforeReplace: async () => {
            await rename(filePath, originalFile);
            await writeFile(filePath, ORIGINAL, "utf8");
          }
        })
      ),
      /untrusted backup was retained/
    );
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    assert.equal(await readFile(originalFile, "utf8"), ORIGINAL);
  });
});

test("open authorization rejects a same-byte path replacement before save or image import", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const opened = await openHtmlDocument(filePath);
    const displaced = join(directory, "opened-original.html");
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await rename(filePath, displaced);
    await writeFile(filePath, ORIGINAL, "utf8");

    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: opened.fingerprint, expectedSlideCount: 1 },
        injectedReplace(),
        undefined,
        opened.documentIdentity
      ),
      /identity changed after it was opened/
    );
    await assert.rejects(
      importImageForDocument(filePath, sourceImage, undefined, opened.documentIdentity),
      /identity changed after it was opened/
    );
    assert.equal(await readFile(filePath, "utf8"), ORIGINAL);
    assert.equal(await readFile(displaced, "utf8"), ORIGINAL);
    assert.equal((await readdir(directory)).some((name) => name === "deck.assets"), false);
  });
});

test("open removes only indexed assets left unreferenced by an unsaved edit", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    assert.equal((await readFile(importedPath)).length, 8);

    const opened = await openHtmlDocument(filePath);
    assert.deepEqual(opened.warnings, []);
    await assert.rejects(readFile(importedPath), { code: "ENOENT" });
    const index = JSON.parse(await readFile(join(directory, "deck.assets", ".html-slide-studio-assets.json"), "utf8"));
    assert.deepEqual(index.files, []);
    assert.equal(await readFile(sourceImage).then((value) => value.length), 8);
  });
});

test("invalid asset ownership index fails closed without deleting files", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, ".html-slide-studio-assets.json"), "{}", "utf8");
    await writeFile(join(assetDirectory, "keep.png"), "user bytes", "utf8");

    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /cleanup was skipped/);
    assert.equal(await readFile(join(assetDirectory, "keep.png"), "utf8"), "user bytes");
  });
});

test("a forged ownership index cannot mark an arbitrary file for garbage collection", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const arbitraryPath = join(assetDirectory, "keep.txt");
    const bytes = Buffer.from("user bytes", "utf8");
    await mkdir(assetDirectory);
    await writeFile(arbitraryPath, bytes);
    await writeFile(
      join(assetDirectory, ".html-slide-studio-assets.json"),
      JSON.stringify({
        ...emptyAssetIndex(),
        files: [{ name: "keep.txt", sha256: createContentFingerprint(bytes), bytes: bytes.length }]
      }),
      "utf8"
    );

    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /ownership index is invalid/);
    assert.equal(await readFile(arbitraryPath, "utf8"), "user bytes");
  });
});

test("externally modified indexed image is preserved and remains indexed", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    await writeFile(importedPath, "externally modified", "utf8");

    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /changed outside HTML Slide Studio and was preserved/);
    assert.equal(await readFile(importedPath, "utf8"), "externally modified");
    const index = JSON.parse(await readFile(join(dirname(importedPath), ".html-slide-studio-assets.json"), "utf8"));
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].name, basename(importedPath));
  });
});

test("same-byte indexed image replacement is preserved by identity checking", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(sourceImage, bytes);
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const displacedPath = join(dirname(importedPath), "displaced.png");

    const opened = await openHtmlDocument(filePath, {
      beforeRemove: async () => {
        await rename(importedPath, displacedPath);
        await writeFile(importedPath, bytes);
      }
    });
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /path identity changed and was preserved/);
    assert.deepEqual(await readFile(importedPath), bytes);
    assert.deepEqual(await readFile(displacedPath), bytes);
  });
});

test("asset GC quarantines and restores a replacement introduced after final validation", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(sourceImage, content);
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const displacedPath = join(directory, "displaced-before-gc.png");

    const opened = await openHtmlDocument(filePath, {
      removeOwnedAsset: async (assetPath, expected) => {
        await rename(assetPath, displacedPath);
        await writeFile(assetPath, "USER REPLACEMENT", "utf8");
        await productionAssetGcOperations.removeOwnedAsset(assetPath, expected);
      }
    });
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /identity or content changed before removal/);
    assert.equal(await readFile(importedPath, "utf8"), "USER REPLACEMENT");
    assert.deepEqual(await readFile(displacedPath), content);
  });
});

test("legacy background references keep an indexed asset owned by the open document", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    await writeFile(filePath, `<!doctype html><html><body background="${imported.relativePath}"><section>Slide</section></body></html>`, "utf8");

    const opened = await openHtmlDocument(filePath);
    assert.deepEqual(opened.warnings, []);
    assert.ok((await readFile(importedPath)).length > 0);
  });
});

test("legacy asset indexes migrate only after generated bytes and document ownership are verified", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createContentFingerprint(bytes);
    const assetName = `legacy-${hash.slice(0, 12)}.png`;
    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, assetName), bytes);
    await writeFile(
      join(assetDirectory, ".html-slide-studio-assets.json"),
      JSON.stringify({ schemaVersion: 1, owner: TRANSACTION_OWNER, files: [assetName] }),
      "utf8"
    );
    await writeFile(
      filePath,
      `<!doctype html><html><body><section><img src="deck.assets/${assetName}"></section></body></html>`,
      "utf8"
    );

    const opened = await openHtmlDocument(filePath);
    assert.deepEqual(opened.warnings, []);
    const index = JSON.parse(await readFile(join(assetDirectory, ".html-slide-studio-assets.json"), "utf8"));
    assert.equal(index.schemaVersion, 3);
    assert.equal(index.documentName, "deck.html");
    assert.deepEqual(index.files, [{ name: assetName, sha256: hash, bytes: bytes.length }]);
  });
});

test("ambiguous legacy asset ownership is preserved without migration or deletion", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createContentFingerprint(bytes);
    const assetName = `legacy-${hash.slice(0, 12)}.png`;
    const legacyIndex = { schemaVersion: 1, owner: TRANSACTION_OWNER, files: [assetName] };
    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, assetName), bytes);
    await writeFile(join(assetDirectory, ".html-slide-studio-assets.json"), JSON.stringify(legacyIndex), "utf8");
    await writeFile(join(directory, "deck!.html"), ORIGINAL, "utf8");

    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /preserved because the owning HTML file could not be identified/);
    assert.deepEqual(JSON.parse(await readFile(join(assetDirectory, ".html-slide-studio-assets.json"), "utf8")), legacyIndex);
    assert.deepEqual(await readFile(join(assetDirectory, assetName)), bytes);
    await assert.rejects(importImageForDocument(filePath, join(assetDirectory, assetName)), /could not be identified unambiguously/);
  });
});

test("an unmarked adjacent asset directory is treated as a collision", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const sourceImage = join(directory, "source.png");
    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, "user-file.png"), "user bytes", "utf8");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    await assert.rejects(importImageForDocument(filePath, sourceImage), /not owned/);
    assert.equal(await readFile(join(assetDirectory, "user-file.png"), "utf8"), "user bytes");
  });
});

test("an unindexed same-name asset is a collision even when its bytes match", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const sourceImage = join(directory, "source.png");
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    await mkdir(assetDirectory);
    await writeFile(join(assetDirectory, ".html-slide-studio-assets.json"), JSON.stringify(emptyAssetIndex()), "utf8");
    await writeFile(join(assetDirectory, `source-${hash}.png`), content);
    await writeFile(sourceImage, content);
    await assert.rejects(importImageForDocument(filePath, sourceImage), /not owned/);
    const index = JSON.parse(await readFile(join(assetDirectory, ".html-slide-studio-assets.json"), "utf8"));
    assert.deepEqual(index.files, []);
  });
});

test("asset copy is rolled back when the ownership index update fails", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    await writeFile(sourceImage, content);
    await assert.rejects(
      importImageForDocument(filePath, sourceImage, {
        copyExclusive: (_source, target, bytes) => writeFile(target, bytes, { flag: "wx" }),
        writeIndex: async () => { throw new Error("injected index failure"); }
      }),
      /injected index failure/
    );
    await assert.rejects(readFile(join(directory, "deck.assets", `source-${hash}.png`)), { code: "ENOENT" });
    const index = JSON.parse(await readFile(join(directory, "deck.assets", ".html-slide-studio-assets.json"), "utf8"));
    assert.deepEqual(index.files, []);
  });
});

test("image import rollback preserves a replacement placed at the generated asset path", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const hash = createContentFingerprint(content).slice(0, 12);
    const targetPath = join(directory, "deck.assets", `source-${hash}.png`);
    const displacedPath = join(directory, "displaced-app-asset.png");
    await writeFile(sourceImage, content);

    await assert.rejects(
      importImageForDocument(filePath, sourceImage, {
        copyExclusive: async (_source, target, bytes) => writeFile(target, bytes, { flag: "wx" }),
        writeIndex: async () => {
          await rename(targetPath, displacedPath);
          await writeFile(targetPath, "USER REPLACEMENT", "utf8");
          throw new Error("injected index failure after replacement");
        }
      }),
      /could not be safely cleaned up/
    );
    assert.equal(await readFile(targetPath, "utf8"), "USER REPLACEMENT");
    assert.deepEqual(await readFile(displacedPath), content);
  });
});

test("image import indexes the exact bytes read before a source-path replacement", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    const original = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const replacement = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const hash = createContentFingerprint(original);
    const assetName = `source-${hash.slice(0, 12)}.png`;
    await writeFile(sourceImage, original);

    const imported = await importImageForDocument(filePath, sourceImage, {
      copyExclusive: async (source, target, bytes) => {
        await writeFile(source, replacement);
        await writeFile(target, bytes, { flag: "wx" });
      },
      writeIndex: async (indexPath, index) => writeFile(indexPath, JSON.stringify(index), "utf8")
    });

    assert.equal(imported.bytes, original.length);
    assert.deepEqual(await readFile(join(directory, "deck.assets", assetName)), original);
    const index = JSON.parse(await readFile(join(directory, "deck.assets", ".html-slide-studio-assets.json"), "utf8"));
    assert.deepEqual(index.files, [{ name: assetName, sha256: hash, bytes: original.length }]);
    assert.deepEqual(await readFile(sourceImage), replacement);
  });
});

test("asset index replacement preserves an external update introduced after the final check", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const firstSource = join(directory, "first.png");
    const secondSource = join(directory, "second.png");
    const firstBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const secondBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]);
    await writeFile(firstSource, firstBytes);
    await writeFile(secondSource, secondBytes);
    const first = await importImageForDocument(filePath, firstSource);
    const indexPath = join(directory, "deck.assets", ".html-slide-studio-assets.json");
    const externalIndex = "USER INDEX UPDATE";

    await assert.rejects(
      importImageForDocument(filePath, secondSource, {
        ...productionAssetOperations,
        beforeIndexInstall: async () => writeFile(indexPath, externalIndex, { encoding: "utf8", flag: "wx" })
      }),
      /previous index was retained/
    );

    assert.equal(await readFile(indexPath, "utf8"), externalIndex);
    assert.ok((await readFile(join(directory, ...first.relativePath.split("/")))).equals(firstBytes));
    const indexQuarantines = (await readdir(dirname(indexPath))).filter((name) => name.includes(".hss-index-") && name.endsWith(".quarantine"));
    assert.equal(indexQuarantines.length, 1);
    const retainedIndex = JSON.parse(await readFile(join(dirname(indexPath), indexQuarantines[0]), "utf8"));
    assert.equal(retainedIndex.files.length, 1);
    assert.equal(retainedIndex.files[0].name, basename(first.relativePath));
    const secondHash = createContentFingerprint(secondBytes).slice(0, 12);
    await assert.rejects(readFile(join(directory, "deck.assets", `second-${secondHash}.png`)), { code: "ENOENT" });
  });
});

test("an adjacent asset directory junction is rejected before copying or indexing", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const realAssetDirectory = join(directory, "real-assets");
    const assetJunction = join(directory, "deck.assets");
    const sourceImage = join(directory, "source.png");
    await mkdir(realAssetDirectory);
    await writeFile(join(realAssetDirectory, ".html-slide-studio-assets.json"), JSON.stringify(emptyAssetIndex()), "utf8");
    await symlink(realAssetDirectory, assetJunction, "junction");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.rejects(importImageForDocument(filePath, sourceImage), /regular directory|reparse point/);
    assert.deepEqual((await readdir(realAssetDirectory)).sort(), [".html-slide-studio-assets.json"]);
  });
});

test("save keeps referenced app assets and removes them only after a later successful unreferencing save", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const referencedHtml = `<!doctype html><html><body><section><img src="${imported.relativePath}"></section></body></html>`;
    const saved = await saveHtmlDocument(
      { filePath, html: referencedHtml, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      injectedReplace()
    );
    assert.ok((await readFile(importedPath)).length > 0);
    await saveHtmlDocument(
      { filePath, html: EDITED, expectedFingerprint: saved.fingerprint, expectedSlideCount: 1 },
      injectedReplace()
    );
    await assert.rejects(readFile(importedPath), { code: "ENOENT" });
  });
});

test("asset GC recognizes unquoted, CSS, and percent-encoded references", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const encoded = imported.relativePath.replace("deck.assets/", "deck%2Eassets%2F");
    await writeFile(
      filePath,
      `<!doctype html><html><body><section><img src=${imported.relativePath}><div style="background:url(${encoded})"></div></section></body></html>`,
      "utf8"
    );
    const opened = await openHtmlDocument(filePath);
    assert.deepEqual(opened.warnings, []);
    assert.ok((await readFile(importedPath)).length > 0);
  });
});

test("asset GC recognizes escaped CSS url identifiers", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    await writeFile(
      filePath,
      `<!doctype html><html><body><section><div style="background:u\\72l(${imported.relativePath})"></div></section></body></html>`,
      "utf8"
    );

    const opened = await openHtmlDocument(filePath);
    assert.deepEqual(opened.warnings, []);
    assert.ok((await readFile(importedPath)).length > 0);
  });
});

test("an escaping asset-index entry fails closed and cannot delete a neighboring file", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const outsidePath = join(directory, "outside.png");
    await mkdir(assetDirectory);
    await writeFile(
      join(assetDirectory, ".html-slide-studio-assets.json"),
      JSON.stringify({ ...emptyAssetIndex(), files: ["../outside.png"] }),
      "utf8"
    );
    await writeFile(outsidePath, "outside bytes", "utf8");

    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /cleanup was skipped/);
    assert.equal(await readFile(outsidePath, "utf8"), "outside bytes");
  });
});

test("HTML paths through a directory junction fail closed", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hss-document-junction-"));
  const realDirectory = join(directory, "real");
  const junctionDirectory = join(directory, "junction");
  await mkdir(realDirectory);
  await writeFile(join(realDirectory, "deck.html"), ORIGINAL, "utf8");
  const transaction = await createInterruptedTransaction({ directory: realDirectory });
  await symlink(realDirectory, junctionDirectory, "junction");
  try {
    await assert.rejects(openHtmlDocument(join(junctionDirectory, "deck.html")), /reparse points/);
    assert.equal(await readFile(transaction.backupPath, "utf8"), ORIGINAL);
    assert.ok((await readFile(transaction.transactionPath, "utf8")).includes(TRANSACTION_OWNER));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-path save preserves relative stylesheet and image references", async () => {
  await withDocument(async ({ filePath }) => {
    const relativeHtml = '<!doctype html><html><head><link rel="stylesheet" href="styles/deck.css"></head><body><section><img src="images/diagram.png" alt="diagram"></section></body></html>';
    await saveHtmlDocument(
      { filePath, html: relativeHtml, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      injectedReplace()
    );
    const saved = await readFile(filePath, "utf8");
    assert.match(saved, /href="styles\/deck\.css"/);
    assert.match(saved, /src="images\/diagram\.png"/);
  });
});

test("portable output rejects file URLs, absolute Windows references, and .hslides paths", () => {
  return withDocument(async ({ filePath }) => {
    for (const badHtml of [
      '<html><body><img src="file:///C:/secret.png"></body></html>',
      '<html><body><img src="C:\\secret.png"></body></html>',
      '<html><body><img src="work.hslides/assets/a.png"></body></html>',
      '<html><body style="background-image:url(\\\\server\\share\\secret.png)"></body></html>',
      '<html><body><img srcset="images/a.png 1x, /private/a.png 2x"></body></html>',
      '<html><head><style>@import "../outside.css"</style></head><body></body></html>',
      '<html><head><style>@i\\6dport "f\\69le:///C:/secret.css"</style></head><body></body></html>',
      '<html><head><style>@im/**/port "file:///C:/secret.css"</style></head><body></body></html>',
      '<html><body><div style="background:u\\72l(f\\69le:///C:/secret.png)"></div></body></html>',
      '<html><body><div style="background:u/**/rl(file:///C:/secret.png)"></div></body></html>',
      '<html><body><svg><rect fill="url(file:///C:/secret.svg)"></rect></svg></body></html>',
      '<html><body><video poster="//server/share/movie.mp4"></video></body></html>',
      '<html><body><object data="C:%5Csecret.pdf"></object></body></html>',
      '<html><body><img srcset="data:image/png;base64,AAAA 1x, C:\\secret.png 2x"></body></html>',
      '<html><body background="C:\\secret.png"></body></html>',
      '<html><head><link rel="preload" imagesrcset="images/a.png 1x, /private/a.png 2x"></head><body></body></html>',
      '<html><body><iframe srcdoc="&lt;img src=\'file:///C:/secret.png\'&gt;"></iframe></body></html>',
      '<html><head><meta http-equiv="refresh" content="0; url=file:///C:/secret.html"></head><body></body></html>'
    ]) {
      await assert.rejects(
        saveHtmlDocument(
          { filePath, html: badHtml, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
          injectedReplace()
        ),
        /must not contain/
      );
      assert.equal(await readFile(filePath, "utf8"), ORIGINAL);
    }
  });
});

test("portable validation examines references rather than rejecting path-like explanatory text", async () => {
  await withDocument(async ({ filePath }) => {
    const explanatory = '<!doctype html><html><body><section><p>例: file:///C:/secret.png は使いません。</p></section></body></html>';
    await saveHtmlDocument(
      { filePath, html: explanatory, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      injectedReplace()
    );
    assert.equal(await readFile(filePath, "utf8"), explanatory);
  });
});

test("asset ownership is bound to the exact HTML basename across extension and sanitized-stem collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-asset-owner-"));
  try {
    for (const [directoryName, ownerName, collidingName] of [
      ["extension", "deck.html", "deck.htm"],
      ["sanitized", "A B.html", "A-B.html"]
    ]) {
      const directory = join(root, directoryName);
      await mkdir(directory);
      const ownerPath = join(directory, ownerName);
      const collidingPath = join(directory, collidingName);
      const sourceImage = join(directory, "source.png");
      await writeFile(ownerPath, ORIGINAL, "utf8");
      await writeFile(collidingPath, ORIGINAL, "utf8");
      await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const imported = await importImageForDocument(ownerPath, sourceImage);
      const importedPath = join(directory, ...imported.relativePath.split("/"));

      const opened = await openHtmlDocument(collidingPath);
      assert.equal(opened.warnings.length, 1);
      assert.match(opened.warnings[0], /ownership index is invalid/);
      assert.ok((await readFile(importedPath)).length > 0, "the other deck must not garbage-collect the owner's asset");
      await assert.rejects(importImageForDocument(collidingPath, sourceImage), /ownership index is invalid/);
      assert.ok((await readFile(importedPath)).length > 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset GC aborts and restores ownership when the HTML changes immediately before removal", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const external = `<!doctype html><html><body><section><img src="${imported.relativePath}"></section></body></html>`;

    await assert.rejects(
      openHtmlDocument(filePath, {
        beforeRemove: async () => writeFile(filePath, external, "utf8")
      }),
      /changed while it was being opened/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
    assert.ok((await readFile(importedPath)).length > 0);
    const index = JSON.parse(await readFile(join(dirname(importedPath), ".html-slide-studio-assets.json"), "utf8"));
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].name, basename(importedPath));
    assert.equal(index.files[0].sha256, createContentFingerprint(await readFile(importedPath)));
    assert.equal(index.files[0].bytes, (await readFile(importedPath)).length);
  });
});

test("post-save asset-GC race preserves the external target, indexed asset, and recovery backup", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const sourceImage = join(directory, "source.png");
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const imported = await importImageForDocument(filePath, sourceImage);
    const importedPath = join(directory, ...imported.relativePath.split("/"));
    const external = `<!doctype html><html><body><section><img src="${imported.relativePath}">External</section></body></html>`;

    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace(),
        { beforeRemove: async () => writeFile(filePath, external, "utf8") }
      ),
      /changed externally during post-save image cleanup/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
    assert.ok((await readFile(importedPath)).length > 0);
    const recovery = (await readdir(directory)).filter((name) => name.endsWith(".recovery.bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(directory, recovery[0]), "utf8"), ORIGINAL);
  });
});

test("raw-byte fingerprints and fatal UTF-8 decoding fail closed on malformed external bytes", async () => {
  assert.notEqual(createContentFingerprint(Buffer.from([0x80])), createContentFingerprint(Buffer.from([0x81])));
  await withDocument(async ({ filePath }) => {
    const malformed = Buffer.concat([Buffer.from(ORIGINAL, "utf8"), Buffer.from([0xc3])]);
    await writeFile(filePath, malformed);
    await assert.rejects(openHtmlDocument(filePath), /valid UTF-8/);
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
        injectedReplace()
      ),
      /valid UTF-8/
    );
    assert.deepEqual(await readFile(filePath), malformed);
  });
});

test("save rejects duplicate IDs, unresolved internal references, and slide-count loss before replacement", async () => {
  await withDocument(async ({ filePath }) => {
    for (const [html, expectedSlideCount, message] of [
      ['<!doctype html><html><body><section><div id="same"></div><span id="same"></span></section></body></html>', 1, /duplicate id/],
      ['<!doctype html><html><body><section aria-labelledby="missing">Slide</section></body></html>', 1, /unresolved internal reference/],
      [EDITED, 2, /slide count changed unexpectedly/]
    ]) {
      await assert.rejects(
        saveHtmlDocument(
          { filePath, html, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount },
          injectedReplace()
        ),
        message
      );
      assert.equal(await readFile(filePath, "utf8"), ORIGINAL);
    }
  });
});

test("portable output rejects CSS-escaped local references and embedded data/blob URLs", async () => {
  await withDocument(async ({ filePath }) => {
    for (const badHtml of [
      '<!doctype html><html><head><style>@import "f\\69le:///C:/secret.css";</style></head><body></body></html>',
      '<!doctype html><html><body style="background:url(\\2f private.png)"></body></html>',
      '<!doctype html><html><body style="background:url(C\\3a /secret.png)"></body></html>',
      '<!doctype html><html><body><img src="data:image/png;base64,AAAA"></body></html>',
      '<!doctype html><html><body style="background:url(data:image/png;base64,AAAA)"></body></html>',
      '<!doctype html><html><body><img src="blob:https://example.test/id"></body></html>'
    ]) {
      await assert.rejects(
        saveHtmlDocument(
          { filePath, html: badHtml, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
          injectedReplace()
        ),
        /must not contain/
      );
      assert.equal(await readFile(filePath, "utf8"), ORIGINAL);
    }
  });
});

test("cleanup failure retains the owner journal until the next open can finish recovery", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const operations = injectedReplace();
    let failedBackupRemoval = false;
    operations.removeArtifact = async (artifactPath) => {
      if (!failedBackupRemoval && artifactPath.endsWith(".bak")) {
        failedBackupRemoval = true;
        throw new Error("injected backup cleanup failure");
      }
      await rm(artifactPath, { force: true });
    };
    const saved = await saveHtmlDocument(
      { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      operations
    );
    assert.equal(await readFile(filePath, "utf8"), EDITED);
    assert.equal(saved.warnings.length, 1);
    assert.match(saved.warnings[0], /cleanup is pending/);
    const pending = (await readdir(directory)).filter((name) => name.includes("hss-save"));
    assert.equal(pending.some((name) => name.endsWith(".bak")), true);
    assert.equal(pending.some((name) => name.endsWith(".txn.json")), true);

    const reopened = await openHtmlDocument(filePath);
    assert.equal(reopened.html, EDITED);
    assert.equal((await readdir(directory)).some((name) => name.includes("hss-save")), false);
  });
});

test("save cleanup preserves a replacement introduced at an owned artifact path", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const displacedJournal = join(directory, "displaced-owner-journal.json");
    let replacedJournalPath = null;
    const result = await saveHtmlDocument(
      { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL), expectedSlideCount: 1 },
      {
        ...injectedReplace(),
        beforeRemoveArtifact: async (artifactPath) => {
          if (!artifactPath.endsWith(".txn.json")) return;
          replacedJournalPath = artifactPath;
          await rename(artifactPath, displacedJournal);
          await writeFile(artifactPath, "USER REPLACEMENT", "utf8");
        }
      }
    );

    assert.equal(await readFile(filePath, "utf8"), EDITED);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /identity or content changed before removal/);
    assert.equal(await readFile(replacedJournalPath, "utf8"), "USER REPLACEMENT");
    assert.match(await readFile(displacedJournal, "utf8"), new RegExp(TRANSACTION_OWNER));
  });
});

test("pre-replace crash followed by an external edit reports a warning instead of silently cleaning it", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const external = ORIGINAL.replace("Original", "External after crash");
    await writeFile(filePath, external, "utf8");
    const transaction = await createInterruptedTransaction({ directory, backupHtml: null });
    const opened = await openHtmlDocument(filePath);
    assert.equal(opened.html, external);
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /interrupted pre-replace save/);
    await assert.rejects(readFile(transaction.transactionPath), { code: "ENOENT" });
    await assert.rejects(readFile(transaction.temporaryPath), { code: "ENOENT" });
  });
});

test("import rejects an ownership index symlink without modifying its target", async (context) => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const realIndex = join(directory, "real-index.json");
    const linkedIndex = join(assetDirectory, ".html-slide-studio-assets.json");
    const sourceImage = join(directory, "source.png");
    const content = JSON.stringify(emptyAssetIndex());
    await mkdir(assetDirectory);
    await writeFile(realIndex, content, "utf8");
    try {
      await symlink(realIndex, linkedIndex, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        context.skip(`file symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.rejects(importImageForDocument(filePath, sourceImage), /ownership index must be a regular file/);
    assert.equal(await readFile(realIndex, "utf8"), content);
  });
});

test("import rejects a hard-linked ownership index without modifying the other link", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const realIndex = join(directory, "real-index.json");
    const linkedIndex = join(assetDirectory, ".html-slide-studio-assets.json");
    const sourceImage = join(directory, "source.png");
    const content = JSON.stringify(emptyAssetIndex());
    await mkdir(assetDirectory);
    await writeFile(realIndex, content, "utf8");
    await link(realIndex, linkedIndex);
    await writeFile(sourceImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await assert.rejects(importImageForDocument(filePath, sourceImage), /ownership index must be a regular file/);
    assert.equal(await readFile(realIndex, "utf8"), content);
  });
});
