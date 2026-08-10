import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalEndpoint } from "../../scripts/lib/local-endpoint.mjs";

const roots = [];
const originalOverride = process.env.HSS_DEV_PORT;

afterEach(async () => {
  if (originalOverride == null) delete process.env.HSS_DEV_PORT;
  else process.env.HSS_DEV_PORT = originalOverride;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("public source uses the safe public endpoint and accepts an explicit port override", { concurrency: false }, async () => {
  const root = await createRoot();
  await mkdir(join(root, "config"));
  await writeManifest(join(root, "config", "public-endpoint.json"), "html-slide-studio", 5173);

  assert.deepEqual(resolveLocalEndpoint(root), {
    projectKey: "html-slide-studio",
    endpointKey: "dev",
    host: "127.0.0.1",
    protocol: "http",
    port: 5173,
    source: "public"
  });

  process.env.HSS_DEV_PORT = "5199";
  assert.equal(resolveLocalEndpoint(root).port, 5199);
});

test("internal source requires its governed manifest and ignores public port overrides", { concurrency: false }, async () => {
  const root = await createRoot();
  await writeFile(join(root, "PROJECT_ID.json"), "{}", "utf8");
  await writeFile(join(root, "AGENTS.md"), "internal", "utf8");
  await writeManifest(join(root, "LOCAL_ENDPOINT.json"), "html-slide-studio-legacy", 31220);
  process.env.HSS_DEV_PORT = "5199";

  const endpoint = resolveLocalEndpoint(root);
  assert.equal(endpoint.source, "internal");
  assert.equal(endpoint.port, 31220);
});

test("endpoint resolver rejects a non-loopback or mismatched manifest", async () => {
  const root = await createRoot();
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config", "public-endpoint.json"), JSON.stringify({
    schemaVersion: 1,
    projectKey: "wrong-project",
    endpoints: [{ endpointKey: "dev", protocol: "http", host: "0.0.0.0", port: 5173 }]
  }), "utf8");

  assert.throws(() => resolveLocalEndpoint(root), /projectKey must be html-slide-studio/);
});

test("endpoint resolver rejects a partial set of internal markers", async () => {
  const root = await createRoot();
  await mkdir(join(root, "config"));
  await writeManifest(join(root, "config", "public-endpoint.json"), "html-slide-studio", 5173);
  await writeFile(join(root, "PROJECT_ID.json"), "{}", "utf8");

  assert.throws(() => resolveLocalEndpoint(root), /Internal endpoint markers are incomplete/);
});

test("endpoint resolver rejects a wrong schema version and duplicate endpoint", async () => {
  const root = await createRoot();
  await mkdir(join(root, "config"));
  const publicManifest = join(root, "config", "public-endpoint.json");
  await writeFile(publicManifest, JSON.stringify({
    schemaVersion: 2,
    projectKey: "html-slide-studio",
    endpoints: [{ endpointKey: "dev", protocol: "http", host: "127.0.0.1", port: 5173 }]
  }), "utf8");
  assert.throws(() => resolveLocalEndpoint(root), /schemaVersion must be 1/);

  await writeFile(publicManifest, JSON.stringify({
    schemaVersion: 1,
    projectKey: "html-slide-studio",
    endpoints: [
      { endpointKey: "dev", protocol: "http", host: "127.0.0.1", port: 5173 },
      { endpointKey: "dev", protocol: "http", host: "127.0.0.1", port: 5174 }
    ]
  }), "utf8");
  assert.throws(() => resolveLocalEndpoint(root), /exactly one dev endpoint/);
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "hss-endpoint-"));
  roots.push(root);
  return root;
}

async function writeManifest(filePath, projectKey, port) {
  await writeFile(filePath, JSON.stringify({
    schemaVersion: projectKey === "html-slide-studio-legacy" ? 2 : 1,
    projectKey,
    endpoints: [{ endpointKey: "dev", protocol: "http", host: "127.0.0.1", port }]
  }), "utf8");
}
