import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createContentFingerprint,
  importImageForDocument,
  openHtmlDocument,
  productionSaveOperations,
  saveHtmlDocument
} from "../../src/main/documentFiles.ts";
import { withDocumentSaveLock } from "../../src/main/documentSaveMutex.ts";

const ORIGINAL = "<!doctype html><html><body><section>Original</section></body></html>";
const EDITED = "<!doctype html><html><body><section>Edited</section></body></html>";
const TRANSACTION_OWNER = "html-slide-studio-legacy";

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

function injectedReplace({ beforeReplace, afterReplace, restoreFailure } = {}) {
  return {
    async replaceWithBackup(temporaryPath, targetPath, backupPath) {
      await beforeReplace?.({ temporaryPath, targetPath, backupPath });
      await rename(targetPath, backupPath);
      await rename(temporaryPath, targetPath);
      await afterReplace?.({ temporaryPath, targetPath, backupPath });
    },
    async restoreBackupIfTargetMatches(backupPath, targetPath, expectedTargetFingerprint) {
      if (restoreFailure) {
        throw new Error("injected rollback failure");
      }
      const current = await readFile(targetPath, "utf8");
      if (createContentFingerprint(current) !== expectedTargetFingerprint) {
        return "changed";
      }
      await writeFile(targetPath, await readFile(backupPath));
      return "restored";
    }
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
    assert.equal(await readFile(join(directory, `${transaction.prefix}.recovery.invalid`), "utf8"), "partial rollback bytes");
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
    assert.equal(await readFile(transaction.backupPath.replace(/\.bak$/, ".recovery.bak"), "utf8"), ORIGINAL);
  });
});

test("saveHtmlDocument uses the Windows File.Replace path and overwrites the same file", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const result = await saveHtmlDocument({
      filePath,
      html: EDITED,
      expectedFingerprint: createContentFingerprint(ORIGINAL)
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
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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
      { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
      injectedReplace({ beforeReplace: async () => { reachedReplace(); await replaceGate; } })
    ));
    const secondHtml = EDITED.replace("Edited", "Queued edit");
    const second = withDocumentSaveLock(filePath, () => saveHtmlDocument(
      { filePath, html: secondHtml, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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

test("backup fingerprint race restores the exact external version captured by replacement", async () => {
  await withDocument(async ({ filePath }) => {
    const external = ORIGINAL.replace("Original", "External just before replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
        injectedReplace({ beforeReplace: () => writeFile(filePath, external, "utf8") })
      ),
      /external version was restored/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
  });
});

test("production rollback restores the exact external version captured by File.Replace", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const external = ORIGINAL.replace("Original", "External captured by File.Replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
        {
          replaceWithBackup: async (temporaryPath, targetPath, backupPath) => {
            await writeFile(targetPath, external, "utf8");
            await productionSaveOperations.replaceWithBackup(temporaryPath, targetPath, backupPath);
          },
          restoreBackupIfTargetMatches: productionSaveOperations.restoreBackupIfTargetMatches
        }
      ),
      /external version was restored/
    );
    assert.equal(await readFile(filePath, "utf8"), external);
    assert.equal((await readdir(directory)).some((name) => name.includes("hss-save")), false);
  });
});

test("post-replace external race leaves the latest target untouched and retains recovery backup", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const latestExternal = ORIGINAL.replace("Original", "External after replace");
    await assert.rejects(
      saveHtmlDocument(
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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
        { filePath, html: EDITED, expectedFingerprint: createContentFingerprint(ORIGINAL) },
        injectedReplace({ beforeReplace: () => writeFile(filePath, external, "utf8"), restoreFailure: true })
      ),
      /recovery could not be verified/
    );
    const backups = (await readdir(directory)).filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(directory, backups[0]), "utf8"), external);
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
    await writeFile(join(assetDirectory, ".html-slide-studio-assets.json"), JSON.stringify({ schemaVersion: 1, owner: TRANSACTION_OWNER, files: [] }), "utf8");
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
        copyExclusive: (source, target) => copyFile(source, target),
        writeIndex: async () => { throw new Error("injected index failure"); }
      }),
      /injected index failure/
    );
    await assert.rejects(readFile(join(directory, "deck.assets", `source-${hash}.png`)), { code: "ENOENT" });
    const index = JSON.parse(await readFile(join(directory, "deck.assets", ".html-slide-studio-assets.json"), "utf8"));
    assert.deepEqual(index.files, []);
  });
});

test("an adjacent asset directory junction is rejected before copying or indexing", { skip: process.platform !== "win32" }, async () => {
  await withDocument(async ({ filePath, directory }) => {
    const realAssetDirectory = join(directory, "real-assets");
    const assetJunction = join(directory, "deck.assets");
    const sourceImage = join(directory, "source.png");
    await mkdir(realAssetDirectory);
    await writeFile(join(realAssetDirectory, ".html-slide-studio-assets.json"), JSON.stringify({ schemaVersion: 1, owner: TRANSACTION_OWNER, files: [] }), "utf8");
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
      { filePath, html: referencedHtml, expectedFingerprint: createContentFingerprint(ORIGINAL) },
      injectedReplace()
    );
    assert.ok((await readFile(importedPath)).length > 0);
    await saveHtmlDocument(
      { filePath, html: EDITED, expectedFingerprint: saved.fingerprint },
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

test("an escaping asset-index entry fails closed and cannot delete a neighboring file", async () => {
  await withDocument(async ({ filePath, directory }) => {
    const assetDirectory = join(directory, "deck.assets");
    const outsidePath = join(directory, "outside.png");
    await mkdir(assetDirectory);
    await writeFile(
      join(assetDirectory, ".html-slide-studio-assets.json"),
      JSON.stringify({ schemaVersion: 1, owner: "html-slide-studio-legacy", files: ["../outside.png"] }),
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
      { filePath, html: relativeHtml, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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
      '<html><body><video poster="//server/share/movie.mp4"></video></body></html>',
      '<html><body><object data="C:%5Csecret.pdf"></object></body></html>',
      '<html><body><img srcset="data:image/png;base64,AAAA 1x, C:\\secret.png 2x"></body></html>'
    ]) {
      await assert.rejects(
        saveHtmlDocument(
          { filePath, html: badHtml, expectedFingerprint: createContentFingerprint(ORIGINAL) },
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
      { filePath, html: explanatory, expectedFingerprint: createContentFingerprint(ORIGINAL) },
      injectedReplace()
    );
    assert.equal(await readFile(filePath, "utf8"), explanatory);
  });
});
