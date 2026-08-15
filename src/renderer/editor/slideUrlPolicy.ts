const unsafeProtocols = new Set(["javascript:", "vbscript:", "data:", "blob:"]);

export function isUnsafeSlideUrl(value: string): boolean {
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, "");
  const protocol = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  return protocol ? unsafeProtocols.has(`${protocol}:`) : false;
}
