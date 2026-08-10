import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

let pendingLaunchHtmlPath: string | null = null;

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
  pendingLaunchHtmlPath = filePath;
}

export function takePendingLaunchHtmlPath(): string | null {
  const filePath = pendingLaunchHtmlPath;
  pendingLaunchHtmlPath = null;
  return filePath;
}
