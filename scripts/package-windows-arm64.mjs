import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Arch, Platform, build } from "electron-builder";

const projectRoot = process.cwd();
const { version } = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const configPath = resolve(projectRoot, "electron-builder.yml");
let portablePayloadPatched = false;
const portableOnly = process.argv.includes("--portable-only");

const artifacts = await build({
  projectDir: projectRoot,
  config: configPath,
  publish: "never",
  targets: Platform.WINDOWS.createTarget(portableOnly ? ["portable"] : ["portable", "zip"], Arch.arm64),
  effectiveOptionComputed: async (computed) => {
    if (!Array.isArray(computed)) return false;

    const [defines] = computed;
    const isArm64DirectoryPortable =
      defines &&
      typeof defines === "object" &&
      typeof defines.APP_DIR_ARM64 === "string" &&
      defines.APP_DIR_32 == null &&
      defines.APP_DIR_64 == null &&
      typeof defines.REQUEST_EXECUTION_LEVEL === "string";

    if (!isArm64DirectoryPortable) return false;

    // useZip makes electron-builder embed a directory directly. Its stock
    // template does not handle APP_DIR_ARM64 without APP_DIR_64, so expose
    // the sole ARM64 directory through the unconditional APP_DIR_32 branch.
    defines.APP_DIR_32 = defines.APP_DIR_ARM64;
    delete defines.APP_DIR_ARM64;
    portablePayloadPatched = true;
    return false;
  }
});

assert.equal(portablePayloadPatched, true, "ARM64 portable payload guard was not applied");
assert.equal(
  artifacts.some((artifact) => artifact.endsWith("HTML Slide Studio.exe")),
  true,
  "Portable executable was not produced"
);
if (!portableOnly) {
  assert.equal(
    artifacts.some((artifact) => artifact.endsWith(`HTML Slide Studio-${version}-arm64-win.zip`)),
    true,
    "ARM64 ZIP was not produced"
  );
}

console.log(JSON.stringify({ pass: true, artifacts }, null, 2));
