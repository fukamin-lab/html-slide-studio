import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Arch, Platform, build } from "electron-builder";
import {
  getWindowsArtifactNames,
  parseWindowsArchitectures
} from "./lib/windows-package.mjs";

const projectRoot = process.cwd();
const { version } = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const configPath = resolve(projectRoot, "electron-builder.yml");
const portableOnly = process.argv.includes("--portable-only");
const installerOnly = process.argv.includes("--installer-only");
const architectureNames = parseWindowsArchitectures(process.argv.slice(2), { defaultArchitecture: "all" });
const builderArchitectures = { arm64: Arch.arm64, x64: Arch.x64 };

assert.equal(
  portableOnly && installerOnly,
  false,
  "--portable-only and --installer-only cannot be combined"
);

const releaseDir = resolve(projectRoot, "release");
const artifacts = [];

for (const architectureName of architectureNames) {
  const names = getWindowsArtifactNames(version, architectureName);
  const ownedArtifacts = [];
  if (!portableOnly) {
    ownedArtifacts.push(
      resolve(releaseDir, names.installer),
      resolve(releaseDir, names.installerBlockmap),
      resolve(releaseDir, names.zip)
    );
  }
  if (!installerOnly) ownedArtifacts.push(resolve(releaseDir, names.portable));

  // Remove only exact, versioned build-owned outputs. The ARM64 entries also
  // retire the pre-matrix artifact names so they cannot be uploaded by mistake.
  if (architectureName === "arm64") {
    if (!portableOnly) {
      ownedArtifacts.push(
        resolve(releaseDir, `HTML Slide Studio Setup ${version}.exe`),
        resolve(releaseDir, `HTML Slide Studio Setup ${version}.exe.blockmap`)
      );
    }
    if (!installerOnly) ownedArtifacts.push(resolve(releaseDir, "HTML Slide Studio.exe"));
  } else if (!portableOnly) {
    ownedArtifacts.push(resolve(releaseDir, `HTML Slide Studio-${version}-win.zip`));
  }
  await Promise.all(ownedArtifacts.map((artifact) => rm(artifact, { force: true })));

  if (!installerOnly) {
    let arm64PortablePayloadPatched = false;
    const portableArtifacts = await build({
      projectDir: projectRoot,
      config: configPath,
      publish: "never",
      targets: Platform.WINDOWS.createTarget(["portable"], builderArchitectures[architectureName]),
      effectiveOptionComputed: async (computed) => {
        if (architectureName !== "arm64" || !Array.isArray(computed)) return false;

        const [defines] = computed;
        const isArm64DirectoryPortable =
          defines &&
          typeof defines === "object" &&
          typeof defines.APP_DIR_ARM64 === "string" &&
          defines.APP_DIR_32 == null &&
          defines.APP_DIR_64 == null &&
          typeof defines.REQUEST_EXECUTION_LEVEL === "string";

        if (!isArm64DirectoryPortable) return false;

        // electron-builder's ZIP portable template has no ARM64-only branch.
        // Expose the sole verified directory through its unconditional branch.
        defines.APP_DIR_32 = defines.APP_DIR_ARM64;
        delete defines.APP_DIR_ARM64;
        arm64PortablePayloadPatched = true;
        return false;
      }
    });
    if (architectureName === "arm64") {
      assert.equal(arm64PortablePayloadPatched, true, "ARM64 portable payload guard was not applied");
    }
    assert.equal(
      portableArtifacts.some((artifact) => artifact.endsWith(names.portable)),
      true,
      `${architectureName} portable executable was not produced`
    );
    artifacts.push(...portableArtifacts);
  }

  // Keep the installer build last. electron-builder adds installer-specific
  // runtime files to appOutDir; the package verifier uses that final directory
  // to compare every embedded installer file and hash.
  if (!portableOnly) {
    const installerArtifacts = await build({
      projectDir: projectRoot,
      config: configPath,
      publish: "never",
      targets: Platform.WINDOWS.createTarget(["nsis", "zip"], builderArchitectures[architectureName])
    });
    assert.equal(
      installerArtifacts.some((artifact) => artifact.endsWith(names.installer)),
      true,
      `${architectureName} NSIS installer was not produced`
    );
    assert.equal(
      installerArtifacts.some((artifact) => artifact.endsWith(names.zip)),
      true,
      `${architectureName} ZIP was not produced`
    );
    artifacts.push(...installerArtifacts);
  }
}

console.log(JSON.stringify({ pass: true, architectures: architectureNames, artifacts }, null, 2));
