import { isAbsolute } from "node:path";

const MAX_WINDOWS_PATH_CHARACTERS = 32_767;
const MAX_HTML_BYTES = 64 * 1024 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

type SavePayload = {
  filePath: string;
  html: string;
  expectedFingerprint: string;
  expectedSlideCount: number;
};

export function isPathPayload(value: unknown): value is { filePath: string } {
  return isExactRecord(value, ["filePath"]) && isSafeAbsolutePath(value.filePath);
}

export function isSavePayload(value: unknown): value is SavePayload {
  if (!isExactRecord(value, ["expectedFingerprint", "expectedSlideCount", "filePath", "html"])) return false;
  return isSafeAbsolutePath(value.filePath) &&
    typeof value.html === "string" &&
    Buffer.byteLength(value.html, "utf8") <= MAX_HTML_BYTES &&
    typeof value.expectedFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(value.expectedFingerprint) &&
    typeof value.expectedSlideCount === "number" &&
    Number.isInteger(value.expectedSlideCount) &&
    value.expectedSlideCount >= 1 &&
    value.expectedSlideCount <= 10_000;
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WINDOWS_PATH_CHARACTERS &&
    !value.includes("\0") &&
    isAbsolute(value);
}

function isExactRecord(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}
