export function resolveDevelopmentRendererUrl(
  rawValue: string | undefined,
  isPackaged: boolean,
  expectedOrigin?: string
): string | null {
  if (!rawValue || isPackaged) return null;
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch (error) {
    throw new Error("ELECTRON_RENDERER_URL must be the allocated loopback HTTP origin", { cause: error });
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("ELECTRON_RENDERER_URL must be the allocated loopback HTTP origin");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("ELECTRON_RENDERER_URL port is outside the allowed development range");
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new Error("ELECTRON_RENDERER_URL does not match the allocated development endpoint");
  }
  return url.origin;
}

export function resolveDevelopmentRemoteDebuggingPort(rawValue: string | undefined, isPackaged: boolean): string | null {
  if (!rawValue || isPackaged) return null;
  if (!/^\d{4,5}$/.test(rawValue)) {
    throw new Error("HSS_REMOTE_DEBUGGING_PORT must be a development TCP port");
  }
  const port = Number(rawValue);
  if (port < 1024 || port > 65_535) {
    throw new Error("HSS_REMOTE_DEBUGGING_PORT must be a development TCP port");
  }
  return String(port);
}

export function findForbiddenPackagedChromiumSwitch(argv: readonly string[], isPackaged: boolean): string | null {
  if (!isPackaged) return null;
  const exactSwitches = new Set([
    "--allow-running-insecure-content",
    "--disable-features",
    "--disable-gpu-sandbox",
    "--disable-seccomp-filter-sandbox",
    "--disable-setuid-sandbox",
    "--disable-site-isolation-trials",
    "--disable-web-security",
    "--enable-node-leakage-in-renderers",
    "--inspect",
    "--inspect-brk",
    "--js-flags",
    "--no-sandbox"
  ]);
  for (const argument of argv.slice(1)) {
    if (argument === "--") break;
    const prefix = argument.startsWith("--") ? "--" : argument.startsWith("-") || argument.startsWith("/") ? argument[0] : null;
    if (!prefix) continue;
    const switchName = `--${argument.slice(prefix.length).split("=", 1)[0].toLowerCase()}`;
    if (switchName.startsWith("--remote-debugging-") || exactSwitches.has(switchName)) {
      return argument;
    }
  }
  return null;
}
