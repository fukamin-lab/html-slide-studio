export type LaunchOpenGate<T> = {
  beginBlockingOperation: () => void;
  endBlockingOperation: () => Promise<void>;
  notify: () => Promise<void>;
  dispose: () => void;
};

type LaunchOpenGateOptions<T> = {
  consume: () => Promise<T | null>;
  apply: (value: T) => void;
  onConsumeStart: () => void;
  onConsumeEnd: () => void;
  onError: (error: unknown) => void;
};

export function createLaunchOpenGate<T>({ consume, apply, onConsumeStart, onConsumeEnd, onError }: LaunchOpenGateOptions<T>): LaunchOpenGate<T> {
  let blockingOperations = 0;
  let pendingNotification = false;
  let deferredValue: T | null = null;
  let disposed = false;
  let drainPromise: Promise<void> | null = null;

  const drain = (): Promise<void> => {
    if (disposed || blockingOperations > 0) return Promise.resolve();
    if (drainPromise) return drainPromise;

    drainPromise = (async () => {
      let consumedValues = 0;
      while (!disposed && blockingOperations === 0) {
        if (deferredValue !== null) {
          const value = deferredValue;
          deferredValue = null;
          apply(value);
          continue;
        }
        if (!pendingNotification) break;
        if (consumedValues >= 64) break;

        pendingNotification = false;
        onConsumeStart();
        try {
          const value = await consume();
          if (disposed || value === null) continue;
          consumedValues += 1;
          if (blockingOperations > 0) {
            deferredValue = value;
            pendingNotification = true;
            break;
          }
          apply(value);
          pendingNotification = true;
        } finally {
          onConsumeEnd();
        }
      }
    })()
      .catch(onError)
      .finally(() => {
        drainPromise = null;
        if (!disposed && blockingOperations === 0 && (pendingNotification || deferredValue !== null)) {
          void drain();
        }
      });

    return drainPromise;
  };

  return {
    beginBlockingOperation: () => {
      blockingOperations += 1;
    },
    endBlockingOperation: () => {
      blockingOperations = Math.max(0, blockingOperations - 1);
      return drain();
    },
    notify: () => {
      pendingNotification = true;
      return drain();
    },
    dispose: () => {
      disposed = true;
      pendingNotification = false;
      deferredValue = null;
    }
  };
}
