import { app, nativeImage } from "electron";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourcePath = resolve("build/icon-source.png");
const outputPath = resolve("build/icon.png");
const icoPath = resolve("build/icon.ico");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

app.whenReady().then(async () => {
  const source = nativeImage.createFromPath(sourcePath);
  if (source.isEmpty()) throw new Error(`App icon source could not be read: ${sourcePath}`);

  const icon = source.resize({ width: 512, height: 512, quality: "best" });
  if (icon.isEmpty()) throw new Error("App icon resize produced an empty image");

  await writeFile(outputPath, icon.toPNG());
  const icoEntries = iconSizes.map((size) => ({ size, png: source.resize({ width: size, height: size, quality: "best" }).toPNG() }));
  await writeFile(icoPath, encodeIco(icoEntries));
  console.log(JSON.stringify({ source: sourcePath, output: outputPath, ico: icoPath, size: icon.getSize(), iconSizes }, null, 2));
  app.quit();
}).catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  app.exit(1);
});

function encodeIco(entries) {
  const directorySize = 6 + entries.length * 16;
  const directory = Buffer.alloc(directorySize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);

  let offset = directorySize;
  entries.forEach((entry, index) => {
    const position = 6 + index * 16;
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, position);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, position + 1);
    directory.writeUInt8(0, position + 2);
    directory.writeUInt8(0, position + 3);
    directory.writeUInt16LE(1, position + 4);
    directory.writeUInt16LE(32, position + 6);
    directory.writeUInt32LE(entry.png.length, position + 8);
    directory.writeUInt32LE(offset, position + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([directory, ...entries.map((entry) => entry.png)]);
}
