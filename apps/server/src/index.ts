import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { PartyRoom } from "./rooms/PartyRoom.js";

const PORT = Number(process.env.PORT ?? 2567);
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : true;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gyro-gamezone-server", now: Date.now() });
});

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
console.log(`[gyro-server] Colyseus listening on http://0.0.0.0:${PORT}`);
