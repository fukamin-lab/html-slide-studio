import { BrowserWindow, shell, session } from "electron";

const PACKAGED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "media-src 'self' data: blob: file:",
  "frame-src 'self' data: about:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self' file:",
  "form-action 'none'"
].join("; ");

const allowedExternalProtocols = new Set(["https:", "mailto:"]);

export function configureGlobalSecurity(isDev: boolean): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [PACKAGED_CSP]
        }
      });
    });
  }
}

export function configureWindowSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    if (!currentUrl || currentUrl === "about:blank" || isSameRendererLocation(currentUrl, url)) {
      return;
    }
    event.preventDefault();
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return allowedExternalProtocols.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function isSameRendererLocation(currentUrl: string, targetUrl: string): boolean {
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
