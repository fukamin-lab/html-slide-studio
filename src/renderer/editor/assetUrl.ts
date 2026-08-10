export function documentAssetUrl(sourceBaseUrl: string | undefined, assetPath: string | undefined): string {
  if (!assetPath) {
    return "";
  }
  if (/^(?:data:|blob:|https?:|file:)/i.test(assetPath)) {
    return assetPath;
  }
  if (!sourceBaseUrl) {
    return assetPath;
  }
  try {
    return new URL(assetPath, sourceBaseUrl).toString();
  } catch {
    return assetPath;
  }
}
