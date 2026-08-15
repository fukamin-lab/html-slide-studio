import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveElectronBinaryPath } from "./lib/electron-binary-path.mjs";

const electronDirectory = resolve("node_modules/electron");
const pathFile = resolve(electronDirectory, "path.txt");
const binaryPath = existsSync(pathFile)
  ? resolveElectronBinaryPath(electronDirectory, readFileSync(pathFile, "utf8"))
  : null;
const installed = Boolean(binaryPath && existsSync(binaryPath));

if (installed) {
  console.log("[postinstall] Electron binary is already installed");
} else {
  const result = spawnSync(process.execPath, [resolve(electronDirectory, "install.js")], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron binary installation failed with exit code ${result.status}`);
}
