import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const MAX_PENDING_LAUNCHES = 64;
const pendingLaunchHtmlPaths: string[] = [];

export function findLaunchHtmlPath(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg || arg.startsWith("-")) {
      continue;
    }

    const candidate = resolve(arg);
    const extension = extname(candidate).toLowerCase();
    if (![".html", ".htm"].includes(extension)) {
      continue;
    }

    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible launch arguments.
    }
  }

  return null;
}

export function setPendingLaunchHtmlPath(filePath: string | null): void {
  if (filePath === null) {
    pendingLaunchHtmlPaths.length = 0;
    return;
  }
  if (pendingLaunchHtmlPaths.length >= MAX_PENDING_LAUNCHES) {
    throw new Error("Too many HTML launch requests are pending");
  }
  pendingLaunchHtmlPaths.push(filePath);
}

export function takePendingLaunchHtmlPath(): string | null {
  return pendingLaunchHtmlPaths.shift() ?? null;
}
