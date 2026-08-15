import { basename, isAbsolute, relative, resolve } from "node:path";

export function resolveElectronBinaryPath(electronDirectory, pathFileContent) {
  const fileName = pathFileContent.trim();
  if (!fileName || isAbsolute(fileName) || basename(fileName) !== fileName || fileName.includes("\0")) {
    return null;
  }

  const distDirectory = resolve(electronDirectory, "dist");
  const candidate = resolve(distDirectory, fileName);
  const relativePath = relative(distDirectory, candidate);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }
  return candidate;
}
