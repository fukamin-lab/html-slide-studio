import { lstat, mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEMO_FILE_NAME = "html-slide-studio-demo.html";

let demoCopyQueue: Promise<void> = Promise.resolve();

export async function ensureDemoWorkingCopy(templatePath: string, userDataPath: string): Promise<string> {
  const operation = demoCopyQueue.then(() => ensureDemoWorkingCopyLocked(templatePath, userDataPath));
  demoCopyQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function ensureDemoWorkingCopyLocked(templatePath: string, userDataPath: string): Promise<string> {
  const canonicalUserDataPath = resolve(userDataPath);
  await requireCanonicalDirectory(canonicalUserDataPath, "Demo storage");

  const demoDirectory = join(canonicalUserDataPath, "demo");
  await mkdir(demoDirectory, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await requireCanonicalDirectory(demoDirectory, "Demo directory");

  const workingPath = join(demoDirectory, DEMO_FILE_NAME);
  try {
    await requireCanonicalRegularFile(workingPath);
    return workingPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const templateBytes = await readFile(resolve(templatePath));
  let handle: FileHandle | null = null;
  try {
    handle = await open(workingPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await requireCanonicalRegularFile(workingPath);
      return workingPath;
    }
    throw error;
  }

  try {
    await requireCanonicalDirectory(demoDirectory, "Demo directory");
    await requireHandleMatchesCanonicalPath(handle, workingPath);
    await handle.writeFile(templateBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await requireCanonicalRegularFile(workingPath);
  return workingPath;
}

async function requireCanonicalDirectory(directoryPath: string, label: string): Promise<void> {
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(await realpath(directoryPath), directoryPath)) {
    throw new Error(`${label} must be a canonical regular directory`);
  }
}

async function requireCanonicalRegularFile(filePath: string): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
    throw new Error("Demo working copy must be a canonical regular file");
  }
}

async function requireHandleMatchesCanonicalPath(handle: FileHandle, filePath: string): Promise<void> {
  const canonicalPath = await realpath(filePath);
  if (!samePath(canonicalPath, filePath)) {
    throw new Error("Demo working copy path changed during creation");
  }
  const [handleStats, pathStats] = await Promise.all([handle.stat(), lstat(filePath)]);
  if (pathStats.isSymbolicLink() || handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
    throw new Error("Demo working copy changed during creation");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
