import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  getWindowsArtifactNames,
  parseWindowsArchitectures
} from "./lib/windows-package.mjs";

const releaseDirectory = resolve("release");
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const architectureNames = parseWindowsArchitectures(process.argv.slice(2), { defaultArchitecture: "all" });
const expected = architectureNames.flatMap((architectureName) => {
  const names = getWindowsArtifactNames(version, architectureName);
  return [names.installer, names.portable, names.zip];
});
const available = new Set(await readdir(releaseDirectory));
for (const fileName of expected) {
  if (!available.has(fileName)) throw new Error(`Missing release artifact: ${fileName}`);
}

const lines = [];
for (const fileName of expected) {
  const filePath = resolve(releaseDirectory, fileName);
  const digest = await sha256(filePath);
  lines.push(`${digest}  ${basename(filePath)}`);
}
const outputName = architectureNames.length === 1
  ? `SHA256SUMS-${architectureNames[0]}.txt`
  : "SHA256SUMS.txt";
await writeFile(resolve(releaseDirectory, outputName), `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));

function sha256(filePath) {
  return new Promise((resolveDigest, rejectDigest) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectDigest);
    stream.on("end", () => resolveDigest(hash.digest("hex")));
  });
}
