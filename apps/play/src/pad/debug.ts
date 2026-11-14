import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./pad.css";
import { bindThemeToggle, themeToggleHtml } from "../common/theme.js";
import { GestureDetector } from "./sensors/gestures.js";
import { GyroControllerPipeline } from "./sensors/orientation.js";

const root = document.getElementById("app")!;
const pipeline = new GyroControllerPipeline();
const gestureLog: string[] = [];

const detector = new GestureDetector((g) => {
  gestureLog.unshift(`${new Date().toLocaleTimeString()} · ${g.kind} (${g.power.toFixed(2)})`);
  if (gestureLog.length > 8) gestureLog.length = 8;
  const logEl = root.querySelector("[data-gesture-log]");
  if (logEl) {
    logEl.innerHTML = gestureLog.map((line) => `<li>${line}</li>`).join("");
  }
});

pipeline.onMotionSample((angVel, accelMag, ax, ay, az, ts) => {
  detector.pushMotionSample(angVel, accelMag, ax, ay, az, ts);
});

const historyLen = 140;
const rawYawBuf = new Float32Array(historyLen);
const filtYawBuf = new Float32Array(historyLen);
let cursor = 0;

root.innerHTML = `
  <div class="pad-shell" style="max-inline-size: 760px;">
    <header class="pad-topbar">
      <div class="pad-brand"><span>Gyro-Gamezone · Sensor Lab</span></div>
      <div class="pad-actions">
        <a class="btn btn-ghost" href="/pad">Back to Pad</a>
        ${themeToggleHtml()}
      </div>
    </header>

    <main class="pad-main">
      <section class="panel" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
        <div>
          <h1>Raw vs Filtered Telemetry</h1>
          <p class="field-hint">Inspect sensor backend, quaternion pose, One Euro smoothing, and motion gestures.</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn btn-accent" data-enable>Start / Request Permission</button>
          <button type="button" class="btn btn-primary" data-center>Zero Center</button>
        </div>
      </section>

      <section class="panel">
        <h2 style="margin-block-end: 12px;">Yaw Waveform (Raw vs One Euro Filtered)</h2>
        <canvas class="scope-canvas" data-scope></canvas>
        <div class="debug-grid" style="margin-block-start: 12px;">
          <div class="stat-tile"><div class="stat-label">Backend</div><div class="stat-val" data-backend>--</div></div>
          <div class="stat-tile"><div class="stat-label">Sample Rate</div><div class="stat-val" data-hz>0 Hz</div></div>
          <div class="stat-tile"><div class="stat-label">Raw Yaw / Pitch</div><div class="stat-val" data-raw-aim>0° / 0°</div></div>
          <div class="stat-tile"><div class="stat-label">Filtered Yaw / Pitch</div><div class="stat-val" data-filt-aim>0° / 0°</div></div>
          <div class="stat-tile"><div class="stat-label">Ang Speed / Accel</div><div class="stat-val" data-motion>0 rad/s</div></div>
          <div class="stat-tile"><div class="stat-label">Quaternion</div><div class="stat-val" data-quat style="font-size:0.8rem">0,0,0,1</div></div>
        </div>
      </section>

      <section class="panel">
        <h2 style="margin-block-end: 8px;">Touch &amp; Motion Gesture Surface</h2>
        <div class="pad-surface" data-debug-pad style="min-block-size:150px;">
          <div class="pad-surface-label">
            <strong>Tap, Hold, Swipe, or Flick Phone</strong>
            <span class="field-hint">Drag here if testing on a desktop without a gyroscope</span>
          </div>
        </div>
        <ul class="mono" data-gesture-log style="margin-block-start:12px;padding-inline-start:18px;font-size:0.8rem;color:var(--text-secondary);"></ul>
      </section>
    </main>
  </div>
`;

const themeBtn = root.querySelector<HTMLButtonElement>("[data-theme-toggle]");
if (themeBtn) bindThemeToggle(themeBtn);

root.querySelector("[data-enable]")?.addEventListener("click", () => {
  void pipeline.requestPermissionsAndStart();
});

root.querySelector("[data-center]")?.addEventListener("click", () => {
  pipeline.recenter();
});

const debugPad = root.querySelector<HTMLElement>("[data-debug-pad]");
if (debugPad) {
  detector.attachPadSurface(debugPad, (dx, dy) => {
    if (pipeline.getBackend() === "touch-fallback") {
      pipeline.nudgeTouchAim(dx, dy);
    }
  });
}

if (pipeline.getPermissionState() === "granted") {
  void pipeline.startSensors();
}

function renderScope(): void {
  const snap = pipeline.getDebugSnapshot();
  rawYawBuf[cursor] = snap.rawAimDeg.yaw;
  filtYawBuf[cursor] = snap.filteredAimDeg.yaw;
  cursor = (cursor + 1) % historyLen;

  const setTxt = (sel: string, txt: string) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = txt;
  };
  setTxt("[data-backend]", `${snap.backend} (${snap.permission})`);
  setTxt("[data-hz]", `${snap.sampleHz} Hz`);
  setTxt("[data-raw-aim]", `${snap.rawAimDeg.yaw.toFixed(1)}° / ${snap.rawAimDeg.pitch.toFixed(1)}°`);
  setTxt(
    "[data-filt-aim]",
    `${snap.filteredAimDeg.yaw.toFixed(1)}° / ${snap.filteredAimDeg.pitch.toFixed(1)}°`,
  );
  setTxt("[data-motion]", `${snap.angVelMag.toFixed(2)} r/s · ${snap.linearAccelMag.toFixed(1)} m/s²`);
  setTxt(
    "[data-quat]",
    `${snap.quat.x.toFixed(2)}, ${snap.quat.y.toFixed(2)}, ${snap.quat.z.toFixed(2)}, ${snap.quat.w.toFixed(2)}`,
  );

  const canvas = root.querySelector<HTMLCanvasElement>("[data-scope]");
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w > 0 && h > 0) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(142, 152, 171, 0.2)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        const drawTrace = (buf: Float32Array, color: string) => {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath();
          for (let i = 0; i < historyLen; i++) {
            const idx = (cursor + i) % historyLen;
            const x = (i / (historyLen - 1)) * w;
            const val = buf[idx] ?? 0;
            const y = h / 2 - (val / 45) * (h * 0.42);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        };

        drawTrace(rawYawBuf, "#FFB800");
        drawTrace(filtYawBuf, "#19D3FF");
      }
    }
  }

  window.requestAnimationFrame(renderScope);
}

window.requestAnimationFrame(renderScope);
