const saveTails = new Map<string, Promise<void>>();

export async function withDocumentSaveLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  const previous = saveTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
  const tail = previous.catch(() => undefined).then(() => current);
  saveTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (saveTails.get(key) === tail) saveTails.delete(key);
  }
}
