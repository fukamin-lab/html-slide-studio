import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const releaseDirectory = resolve("release");
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const expected = [
  "HTML Slide Studio.exe",
  `HTML Slide Studio-${version}-arm64-win.zip`
];
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
await writeFile(resolve(releaseDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
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
