import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { PartyRoom } from "./rooms/PartyRoom.js";

const PORT = Number(process.env.PORT ?? 2567);

function parseAllowedOrigins(raw: string | undefined): boolean | string[] {
  if (!raw || raw.trim() === "" || raw.trim() === "*") {
    return true;
  }
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : true;
}

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const SERVE_PLAY_DIST =
  process.env.SERVE_PLAY_DIST === "1" || process.env.SERVE_PLAY_DIST === "true";

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gyro-gamezone-server", now: Date.now() });
});

if (SERVE_PLAY_DIST) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const playDistDir = path.resolve(here, "../../play/dist");
  if (fs.existsSync(playDistDir)) {
    app.use(
      express.static(playDistDir, {
        index: "index.html",
        redirect: false,
        maxAge: "1h",
        setHeaders(res, filePath) {
          if (filePath.endsWith(".webmanifest")) {
            res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
          } else if (filePath.endsWith("sw.js")) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );

    const routePages: ReadonlyArray<readonly [string, string]> = [
      ["/host", "host/index.html"],
      ["/pad", "pad/index.html"],
      ["/pad/debug", "pad/debug/index.html"],
    ];
    for (const [route, relHtml] of routePages) {
      app.get(route, (_req, res) => {
        res.sendFile(path.join(playDistDir, relHtml));
      });
    }
  }
} else {
  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      service: "gyro-gamezone-server",
      health: "/health",
      roomType: "party",
    });
  });
}

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 5000,
    pingMaxRetries: 3,
  }),
});

gameServer.define("party", PartyRoom);

await gameServer.listen(PORT, "0.0.0.0");
console.log(
  `[gyro-server] Colyseus listening on http://0.0.0.0:${PORT}${SERVE_PLAY_DIST ? " (serving apps/play/dist)" : ""}`,
);
