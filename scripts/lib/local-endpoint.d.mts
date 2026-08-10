export type LocalEndpoint = {
  projectKey: string;
  endpointKey: string;
  host: "127.0.0.1";
  protocol: "http";
  port: number;
  source: "internal" | "public";
};

export function resolveLocalEndpoint(projectRoot: string, endpointKey?: string): LocalEndpoint;
