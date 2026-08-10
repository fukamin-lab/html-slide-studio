import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const INTERNAL_PROJECT_KEY = "html-slide-studio-legacy";
const PUBLIC_PROJECT_KEY = "html-slide-studio";

export function resolveLocalEndpoint(projectRoot, endpointKey = "dev") {
  const root = resolve(projectRoot);
  const internalMarkers = ["PROJECT_ID.json", "AGENTS.md", "LOCAL_ENDPOINT.json"]
    .map((name) => existsSync(resolve(root, name)));
  if (internalMarkers.some(Boolean) && !internalMarkers.every(Boolean)) {
    throw new Error("Internal endpoint markers are incomplete");
  }
  const internal = internalMarkers.every(Boolean);
  const manifestPath = internal
    ? resolve(root, "LOCAL_ENDPOINT.json")
    : resolve(root, "config/public-endpoint.json");

  requireCanonicalRegularFile(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedProjectKey = internal ? INTERNAL_PROJECT_KEY : PUBLIC_PROJECT_KEY;
  const expectedSchemaVersion = internal ? 2 : 1;
  if (manifest.schemaVersion !== expectedSchemaVersion) {
    throw new Error(`${manifestPath} schemaVersion must be ${expectedSchemaVersion}`);
  }
  if (manifest.projectKey !== expectedProjectKey) {
    throw new Error(`${manifestPath} projectKey must be ${expectedProjectKey}`);
  }

  const matchingEndpoints = manifest.endpoints?.filter((candidate) => candidate.endpointKey === endpointKey) ?? [];
  if (matchingEndpoints.length !== 1) {
    throw new Error(`${manifestPath} must contain exactly one ${endpointKey} endpoint`);
  }
  const [endpoint] = matchingEndpoints;
  if (!endpoint || endpoint.protocol !== "http" || endpoint.host !== "127.0.0.1") {
    throw new Error(`${manifestPath} must contain the ${endpointKey} loopback HTTP endpoint`);
  }

  const configuredPort = internal ? endpoint.port : publicPortOverride(endpoint.port);
  if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
    throw new Error(`${manifestPath} ${endpointKey} port must be an integer from 1024 to 65535`);
  }

  return {
    projectKey: manifest.projectKey,
    endpointKey,
    host: endpoint.host,
    protocol: endpoint.protocol,
    port: configuredPort,
    source: internal ? "internal" : "public"
  };
}

function publicPortOverride(defaultPort) {
  const raw = process.env.HSS_DEV_PORT;
  if (raw == null || raw === "") return defaultPort;
  if (!/^\d+$/.test(raw)) throw new Error("HSS_DEV_PORT must be an integer");
  return Number(raw);
}

function requireCanonicalRegularFile(filePath) {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || !samePath(realpathSync(filePath), filePath)) {
    throw new Error(`${filePath} must be a canonical regular file`);
  }
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
