// Small dependency-free CDP client used by the current product smoke test.

const cdpCommandTimeoutMs = 8_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });

    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, cdpCommandTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

export async function evaluate(cdp, expression) {
  let response;
  try {
    response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
  } catch (error) {
    const preview = expression.replace(/\s+/g, " ").slice(0, 120);
    throw new Error(`Runtime.evaluate failed for ${preview}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Runtime.evaluate failed");
  }

  return response.result.value;
}

export async function waitFor(callback, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await callback();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(150);
  }

  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function waitForTarget(debugBaseUrl, predicate, timeoutMs) {
  return waitFor(async () => {
    const targets = await fetchJson(`${debugBaseUrl}/json/list`);
    return targets.find(predicate) ?? null;
  }, timeoutMs, "CDP target");
}

export async function waitForEval(cdp, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    const value = await evaluate(cdp, expression);
    return value || null;
  }, timeoutMs, `expression: ${expression.slice(0, 80)}`);
}

export async function waitForAnimationFrames(cdp, count) {
  await evaluate(
    cdp,
    `new Promise((resolve) => {
      let remaining = ${JSON.stringify(count)};
      const tick = () => {
        remaining -= 1;
        if (remaining <= 0) {
          resolve(true);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`
  );
}
