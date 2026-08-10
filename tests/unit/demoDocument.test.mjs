import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_FILE_NAME, ensureDemoWorkingCopy } from "../../src/main/demoDocument.ts";

test("demo working copy is created once and later edits are not overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-demo-test-"));
  const userDataPath = join(root, "profile");
  const templatePath = join(root, "template.html");
  await mkdir(userDataPath);
  await writeFile(templatePath, "<!doctype html><section class=\"slide\">Original demo</section>", "utf8");

  try {
    const firstPath = await ensureDemoWorkingCopy(templatePath, userDataPath);
    assert.equal(firstPath, join(userDataPath, "demo", DEMO_FILE_NAME));
    assert.match(await readFile(firstPath, "utf8"), /Original demo/);

    await writeFile(firstPath, "<!doctype html><section class=\"slide\">Edited demo</section>", "utf8");
    const secondPath = await ensureDemoWorkingCopy(templatePath, userDataPath);
    assert.equal(secondPath, firstPath);
    assert.match(await readFile(secondPath, "utf8"), /Edited demo/);
    assert.match(await readFile(templatePath, "utf8"), /Original demo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent demo requests resolve to one fully written working copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-demo-concurrent-test-"));
  const userDataPath = join(root, "profile");
  const templatePath = join(root, "template.html");
  const template = `<!doctype html><section class="slide">${"Demo".repeat(100_000)}</section>`;
  await mkdir(userDataPath);
  await writeFile(templatePath, template, "utf8");

  try {
    const paths = await Promise.all(Array.from({ length: 6 }, () => ensureDemoWorkingCopy(templatePath, userDataPath)));
    assert.equal(new Set(paths).size, 1);
    assert.equal(await readFile(paths[0], "utf8"), template);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a junction at the demo directory is rejected before template bytes are copied", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-demo-junction-test-"));
  const userDataPath = join(root, "profile");
  const outsidePath = join(root, "outside");
  const templatePath = join(root, "template.html");
  await mkdir(userDataPath);
  await mkdir(outsidePath);
  await symlink(outsidePath, join(userDataPath, "demo"), "junction");
  await writeFile(templatePath, "<!doctype html><section class=\"slide\">Protected demo</section>", "utf8");

  try {
    await assert.rejects(ensureDemoWorkingCopy(templatePath, userDataPath), /canonical regular directory/);
    assert.deepEqual(await readdir(outsidePath), []);
    assert.match(await readFile(templatePath, "utf8"), /Protected demo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
