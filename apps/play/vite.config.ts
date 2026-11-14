import os from "node:os";
import path from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig, type Plugin } from "vite";

function detectLanIp(): string {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Rewrites /host, /pad, /pad/debug cleanly (including query strings like /pad?room=ABCD)
 * to their respective MPA HTML entrypoints during dev and preview.
 */
function mpaCleanRoutesPlugin(): Plugin {
  const routeMap = new Map<string, string>([
    ["/host", "/host/index.html"],
    ["/host/", "/host/index.html"],
    ["/pad", "/pad/index.html"],
    ["/pad/", "/pad/index.html"],
    ["/pad/debug", "/pad/debug/index.html"],
    ["/pad/debug/", "/pad/debug/index.html"],
  ]);

  return {
    name: "gyro-mpa-clean-routes",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next();
        const qIdx = req.url.indexOf("?");
        const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
        const search = qIdx === -1 ? "" : req.url.slice(qIdx);
        const target = routeMap.get(pathname);
        if (target) {
          req.url = `${target}${search}`;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next();
        const qIdx = req.url.indexOf("?");
        const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
        const search = qIdx === -1 ? "" : req.url.slice(qIdx);
        const target = routeMap.get(pathname);
        if (target) {
          req.url = `${target}${search}`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const lanIp = detectLanIp();
  const isServe = command === "serve";

  return {
    plugins: [isServe ? basicSsl() : undefined, mpaCleanRoutesPlugin()].filter(Boolean),
    optimizeDeps: {
      include: ["three", "qrcode", "@colyseus/sdk"],
    },
    define: {
      __DEV_LAN_ORIGIN__: JSON.stringify(isServe ? `https://${lanIp}:5173` : ""),
    },
    resolve: {
      alias: {
        "@gyro/shared": path.resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
      },
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        "/colyseus": {
          target: "http://127.0.0.1:2567",
          changeOrigin: true,
          ws: true,
          rewrite: (p) => p.replace(/^\/colyseus/, ""),
        },
      },
    },
    build: {
      target: "es2022",
      rollupOptions: {
        input: {
          main: path.resolve(import.meta.dirname, "index.html"),
          host: path.resolve(import.meta.dirname, "host/index.html"),
          pad: path.resolve(import.meta.dirname, "pad/index.html"),
          padDebug: path.resolve(import.meta.dirname, "pad/debug/index.html"),
        },
      },
    },
  };
});
