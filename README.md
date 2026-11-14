# Gyro-Gamezone

Browser-based 3D motion party arcade. The desktop browser runs the shared 3D screen (`/host`), and phones pair via QR code (`/pad`) over HTTPS + WebSockets at 60 Hz with no app store install required.

## Workspace Structure

- `packages/shared` (`@gyro/shared`): Strict TypeScript protocol, binary 28-byte input packet packer, One Euro filter, quaternion math, calibration solver, and game plugin interfaces.
- `apps/play` (`@gyro/play`): Vite + TypeScript static frontend with Three.js desktop host (`/host`) and lightweight DOM/Canvas controller (`/pad`, `/pad/debug`).
- `apps/server` (`@gyro/server`): Stateful Node + Express + Colyseus WebSocket room relay (`party` room, 4 players max, 30s reconnect grace, rate limiting).

## Local Development (HTTPS)

```bash
pnpm install
pnpm dev
```

- Desktop host: `https://localhost:5173/host` (includes Simulator mode for mouse-as-gyro dev)
- Phone controller on LAN: `https://<your-lan-ip>:5173/pad` (accept self-signed dev cert on first visit)
- Sensor telemetry scope: `https://<your-lan-ip>:5173/pad/debug`

## Build & Verification

```bash
pnpm build       # Builds @gyro/shared, @gyro/play, and @gyro/server
pnpm typecheck   # Runs tsc --noEmit across all packages
pnpm lint        # ESLint across workspace
pnpm test        # Vitest unit tests (filters, calibration, quaternions, binary protocol)
pnpm test:e2e    # Playwright two-context Host + Phone E2E suite
```

## Free Production Hosting

Because **Vercel Functions do not run stateful WebSocket game rooms**, split deployment across two free tiers (or run both on a single free Node host):

### Option 1: Vercel Free (Frontend) + Render Free (Colyseus WebSocket Server) — Recommended

1. **Deploy the relay server on Render (free, no credit card required):**
   - Push this repo to GitHub.
   - In Render, click **New + -> Blueprint** and select this repo (it reads `render.yaml` automatically), **or** create a **Web Service (Free)** with:
     - **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter @gyro/shared build && pnpm --filter @gyro/server build`
     - **Start Command:** `pnpm --filter @gyro/server start`
     - **Health Check Path:** `/health`
   - Copy your Render URL, e.g. `https://gyro-gamezone-server.onrender.com`.

2. **Deploy the frontend on Vercel Free (Hobby):**
   - Import the same repo in Vercel (root `vercel.json` configures pnpm monorepo build + `/host`, `/pad`, `/pad/debug` rewrites + manifest/SW headers automatically).
   - Add one **Environment Variable** in Vercel Project Settings:
     - `VITE_SERVER_URL` = `https://gyro-gamezone-server.onrender.com` (no trailing slash)
   - Trigger a redeploy so Vite bakes `VITE_SERVER_URL` into the static bundle.
   - *(Optional security hardening)* Set `ALLOWED_ORIGINS=https://your-app.vercel.app` in Render env vars once you have your exact Vercel domain.

3. **Keep-alive tip for Render Free:** Render sleeps free services after 15 minutes with no traffic (~30–50s cold start to wake up; active WebSocket gameplay keeps it awake). You can add a free **UptimeRobot** monitor pinging `https://your-server.onrender.com/health` every 10–14 minutes if you want instant wakefulness.

### Option 2: Single Free Service on Render (Zero CORS Config)

Run everything from one Node service on Render:
- **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter @gyro/shared build && pnpm --filter @gyro/play build && pnpm --filter @gyro/server build`
- **Start Command:** `pnpm --filter @gyro/server start`
- **Environment Variable:** `SERVE_PLAY_DIST=1`
- Leave `VITE_SERVER_URL` empty — `@gyro/play` connects automatically to the same origin.

### Option 3: Instant Zero-Deploy Living Room Hosting (Cloudflare Quick Tunnel)

Best ping (~5–15 ms) when friends are in the same room or remote without deploying:
1. Build and serve locally or run `pnpm dev`.
2. Run a free Cloudflare Quick Tunnel: `cloudflared tunnel --url https://localhost:5173 --no-tls-verify` (when using `vite dev`, which already proxies `/colyseus` over HTTPS).
3. Open the generated `https://*.trycloudflare.com/host` URL — valid trusted HTTPS certificate works immediately on iOS Safari motion permissions.
