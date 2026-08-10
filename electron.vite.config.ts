import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";
import { resolveLocalEndpoint } from "./scripts/lib/local-endpoint.mjs";

const endpoint = resolveLocalEndpoint(__dirname);

function localEndpointIdentity(): Plugin {
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.method === "GET" && request.url === "/.well-known/fukamin-project") {
      const actualPort = request.socket.localPort;
      const canonical = actualPort === endpoint.port;
      const payload = JSON.stringify({ schemaVersion: 1, projectKey: endpoint.projectKey, endpointKey: endpoint.endpointKey, instanceKind: canonical ? "canonical" : "temporary", instanceKey: canonical ? "canonical" : `port-${actualPort}` });
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
      response.end(payload);
      return;
    }
    next();
  };
  return {
    name: "html-slide-studio-local-endpoint-identity",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); }
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "src/main/main.ts")
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          preload: resolve(__dirname, "src/preload/preload.ts"),
          presenter: resolve(__dirname, "src/preload/presenter.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    server: { host: endpoint.host, port: endpoint.port, strictPort: true },
    preview: { host: endpoint.host, port: endpoint.port, strictPort: true },
    plugins: [localEndpointIdentity(), react()]
  }
});
