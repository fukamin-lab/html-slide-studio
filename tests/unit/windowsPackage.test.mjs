import assert from "node:assert/strict";
import test from "node:test";
import {
  getWindowsArchitecture,
  getWindowsArtifactNames,
  parseWindowsArchitectures,
  WINDOWS_ARCHITECTURES
} from "../../scripts/lib/windows-package.mjs";

test("Windows package architectures are a stable arm64/x64 matrix", () => {
  assert.deepEqual(WINDOWS_ARCHITECTURES, ["arm64", "x64"]);
  assert.deepEqual(getWindowsArchitecture("arm64"), {
    name: "arm64",
    peMachine: 0xaa64,
    peMachineHex: "0xAA64"
  });
  assert.deepEqual(getWindowsArchitecture("x64"), {
    name: "x64",
    peMachine: 0x8664,
    peMachineHex: "0x8664"
  });
});

test("architecture parsing accepts one architecture or the complete matrix", () => {
  assert.deepEqual(parseWindowsArchitectures([], { defaultArchitecture: "x64" }), ["x64"]);
  assert.deepEqual(parseWindowsArchitectures(["--arch=arm64"]), ["arm64"]);
  assert.deepEqual(parseWindowsArchitectures(["--arch=all"]), ["arm64", "x64"]);
  assert.throws(() => parseWindowsArchitectures(["--arch=all"], { allowAll: false }), /not supported/);
  assert.throws(() => parseWindowsArchitectures(["--arch=x86"]), /Unsupported Windows architecture/);
  assert.throws(() => parseWindowsArchitectures(["--arch=x64", "--arch=arm64"]), /only once/);
});

test("artifact names always include architecture and version", () => {
  assert.deepEqual(getWindowsArtifactNames("0.2.0", "x64"), {
    installer: "HTML Slide Studio Setup 0.2.0-x64.exe",
    installerBlockmap: "HTML Slide Studio Setup 0.2.0-x64.exe.blockmap",
    portable: "HTML Slide Studio-0.2.0-x64-portable.exe",
    zip: "HTML Slide Studio-0.2.0-x64-win.zip",
    unpackedDirectory: "win-unpacked"
  });
});
