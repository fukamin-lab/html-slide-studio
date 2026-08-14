const allowedExternalProtocols = new Set(["https:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return allowedExternalProtocols.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

export function isSameRendererLocation(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.protocol === target.protocol &&
      current.host === target.host &&
      current.pathname === target.pathname &&
      current.search === target.search;
  } catch {
    return false;
  }
}
