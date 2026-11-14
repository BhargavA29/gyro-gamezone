import * as THREE from "three";
import {
  clamp,
  MAX_PLAYERS,
  PLAYER_SLOT_PALETTE,
  type GameHostContext,
  type GamePlugin,
  type PlayerAimFrame,
  type PlayerGestureEvent,
} from "@gyro/shared";
import {
  ArcadeParticlePool,
  ArcadeShockwavePool,
  createToonGradientTexture,
  observeThemeScheme,
} from "../shared/ArcadeSceneUtils.js";

const CAMERA_Z = 14;
const FOV_DEG = 42;

interface ReticleState {
  group: THREE.Group;
  bracketGroup: THREE.Group;
  triggerRing: THREE.Mesh;
  outerMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
  worldX: number;
  worldY: number;
  prevWorldX: number;
  prevWorldY: number;
  rollRad: number;
  prevRollRad: number;
  primaryDown: boolean;
  connected: boolean;
}

interface ArcadeTarget {
  group: THREE.Group;
  faceMat: THREE.MeshToonMaterial;
  rimMat: THREE.MeshBasicMaterial;
  baseX: number;
  baseY: number;
  freqX: number;
  freqY: number;
  ampX: number;
  ampY: number;
  phase: number;
  radius: number;
  posX: number;
  posY: number;
  prevX: number;
  prevY: number;
  hitFlash: number;
  respawnCooldown: number;
}

export class AimDemoGame implements GamePlugin {
  readonly id = "aim-demo" as const;

  private ctx!: GameHostContext;
  private canvas!: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private toonGradient!: THREE.DataTexture;

  private halfH = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * CAMERA_Z;
  private halfW = this.halfH * (16 / 9);
  private simTime = 0;
  private localShake = 0;

  private gridHelper: THREE.GridHelper | null = null;
  private centerRingMat!: THREE.MeshBasicMaterial;
  private centerCrossMat!: THREE.MeshBasicMaterial;
  private centerHighlight = 0;

  private reticles: ReticleState[] = [];
  private targets: ArcadeTarget[] = [];
  private particles!: ArcadeParticlePool;
  private shockwaves!: ArcadeShockwavePool;

  private readonly scores = new Int32Array(MAX_PLAYERS);
  private readonly streaks = new Int32Array(MAX_PLAYERS);
  private readonly disposables: Array<{ dispose(): void }> = [];
  private detachThemeObserver: (() => void) | null = null;

  init(ctx: GameHostContext): void {
    this.ctx = ctx;
    this.scores.fill(0);
    this.streaks.fill(0);

    this.canvas = document.createElement("canvas");
    this.canvas.className = "host-stage-canvas";
    ctx.container.replaceChildren(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    const width = Math.max(1, ctx.container.clientWidth || window.innerWidth);
    const height = Math.max(1, ctx.container.clientHeight || window.innerHeight);

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, width / height, 0.5, 80);
    this.camera.position.set(0, 0, CAMERA_Z);

    this.toonGradient = createToonGradientTexture();
    this.disposables.push(this.toonGradient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x3b4459, 1.35);
    const dir = new THREE.DirectionalLight(0xffffff, 1.15);
    dir.position.set(5, 8, 12);
    this.scene.add(hemi, dir);

    this.buildCalibrationStage();
    this.buildTargets();
    this.buildReticles();
    this.particles = new ArcadeParticlePool(this.scene, 180, 0.11);
    this.shockwaves = new ArcadeShockwavePool(this.scene, 10);

    this.detachThemeObserver = observeThemeScheme((scheme) => this.applyThemePalette(scheme));
    this.onResize(width, height, Math.min(window.devicePixelRatio || 1, 2));

    this.ctx.hud.setRoundTimer(null);
    this.ctx.hud.setTutorialVisible(true, [
      "Point your phone to steer your color reticle",
      "Tap to pop moving targets (+100 pts)",
      "Flick wrist or press R (simulator) for radar wave",
    ]);
    this.syncScoreboardHud();
  }

  private buildCalibrationStage(): void {
    const centerRingGeo = new THREE.RingGeometry(0.9, 1.0, 48);
    this.centerRingMat = new THREE.MeshBasicMaterial({
      color: 0x828ea3,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    const centerRing = new THREE.Mesh(centerRingGeo, this.centerRingMat);
    centerRing.position.set(0, 0, -0.5);
    this.scene.add(centerRing);

    const crossVerts = new Float32Array([
      -1.45, 0, -0.5, -0.45, 0, -0.5,
      0.45, 0, -0.5, 1.45, 0, -0.5,
      0, -1.45, -0.5, 0, -0.45, -0.5,
      0, 0.45, -0.5, 0, 1.45, -0.5,
    ]);
    const crossGeo = new THREE.BufferGeometry();
    crossGeo.setAttribute("position", new THREE.BufferAttribute(crossVerts, 3));
    this.centerCrossMat = new THREE.MeshBasicMaterial({
      color: 0x828ea3,
      transparent: true,
      opacity: 0.38,
    });
    const crossLines = new THREE.LineSegments(crossGeo, this.centerCrossMat);
    this.scene.add(crossLines);

    this.disposables.push(centerRingGeo, this.centerRingMat, crossGeo, this.centerCrossMat);
  }

  private rebuildGrid(scheme: "dark" | "light"): void {
    if (this.gridHelper) {
      this.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      const mat = this.gridHelper.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
      this.gridHelper = null;
    }

    const major = scheme === "dark" ? 0x2c3548 : 0x9aa8bf;
    const minor = scheme === "dark" ? 0x1a202d : 0xd0d8e5;
    const grid = new THREE.GridHelper(32, 32, major, minor);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0, 0, -2.2);
    this.scene.add(grid);
    this.gridHelper = grid;
  }

  private buildTargets(): void {
    const faceGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.24, 24);
    faceGeo.rotateX(Math.PI / 2);
    const rimGeo = new THREE.TorusGeometry(0.7, 0.065, 10, 28);
    const bullGeo = new THREE.CircleGeometry(0.24, 20);
    const bullMat = new THREE.MeshBasicMaterial({ color: 0xf4f7fb });
    this.disposables.push(faceGeo, rimGeo, bullGeo, bullMat);

    const presets = [
      { baseX: -4.2, baseY: 2.0, freqX: 0.72, freqY: 0.95, ampX: 1.9, ampY: 1.0, phase: 0.2, color: 0xff4d2e },
      { baseX: 4.2, baseY: 1.8, freqX: 0.85, freqY: 0.68, ampX: 1.8, ampY: 1.15, phase: 1.7, color: 0xffb800 },
      { baseX: -3.6, baseY: -2.0, freqX: 0.64, freqY: 0.82, ampX: 2.1, ampY: 0.95, phase: 3.1, color: 0x19d3ff },
      { baseX: 3.8, baseY: -1.9, freqX: 0.78, freqY: 0.75, ampX: 2.0, ampY: 1.05, phase: 4.5, color: 0x3ce87a },
    ];

    for (const p of presets) {
      const group = new THREE.Group();
      const faceMat = new THREE.MeshToonMaterial({
        color: p.color,
        gradientMap: this.toonGradient,
      });
      const rimMat = new THREE.MeshBasicMaterial({ color: 0x0b0e14 });

      const face = new THREE.Mesh(faceGeo, faceMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      const bull = new THREE.Mesh(bullGeo, bullMat);
      bull.position.z = 0.13;

      group.add(face, rim, bull);
      group.position.set(p.baseX, p.baseY, -0.15);
      this.scene.add(group);
      this.disposables.push(faceMat, rimMat);

      this.targets.push({
        group,
        faceMat,
        rimMat,
        baseX: p.baseX,
        baseY: p.baseY,
        freqX: p.freqX,
        freqY: p.freqY,
        ampX: p.ampX,
        ampY: p.ampY,
        phase: p.phase,
        radius: 0.76,
        posX: p.baseX,
        posY: p.baseY,
        prevX: p.baseX,
        prevY: p.baseY,
        hitFlash: 0,
        respawnCooldown: 0,
      });
    }
  }

  private buildReticles(): void {
    const outerGeo = new THREE.RingGeometry(0.28, 0.37, 28);
    const rimGeo = new THREE.RingGeometry(0.25, 0.4, 28);
    const dotGeo = new THREE.CircleGeometry(0.085, 16);
    const triggerGeo = new THREE.RingGeometry(0.43, 0.49, 28);
    const tickGeo = new THREE.PlaneGeometry(0.24, 0.055);
    this.disposables.push(outerGeo, rimGeo, dotGeo, triggerGeo, tickGeo);

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const palette = PLAYER_SLOT_PALETTE[slot]!;
      const group = new THREE.Group();
      group.visible = false;
      group.position.set(0, 0, 0.35 + slot * 0.02);

      const bracketGroup = new THREE.Group();
      const rimMat = new THREE.MeshBasicMaterial({ color: 0x0b0e14, side: THREE.DoubleSide });
      const outerMat = new THREE.MeshBasicMaterial({ color: palette.hex, side: THREE.DoubleSide });
      const triggerMat = new THREE.MeshBasicMaterial({
        color: palette.hex,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      });

      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.z = -0.01;
      const outer = new THREE.Mesh(outerGeo, outerMat);
      const dot = new THREE.Mesh(dotGeo, outerMat);

      const topTick = new THREE.Mesh(tickGeo, outerMat);
      topTick.position.y = 0.44;
      const bottomTick = new THREE.Mesh(tickGeo, outerMat);
      bottomTick.position.y = -0.44;

      bracketGroup.add(rim, outer, topTick, bottomTick);

      const triggerRing = new THREE.Mesh(triggerGeo, triggerMat);
      triggerRing.position.z = -0.02;

      group.add(bracketGroup, dot, triggerRing);
      this.scene.add(group);
      this.disposables.push(rimMat, outerMat, triggerMat);

      this.reticles.push({
        group,
        bracketGroup,
        triggerRing,
        outerMat,
        rimMat,
        worldX: 0,
        worldY: 0,
        prevWorldX: 0,
        prevWorldY: 0,
        rollRad: 0,
        prevRollRad: 0,
        primaryDown: false,
        connected: false,
      });
    }
  }

  private applyThemePalette(scheme: "dark" | "light"): void {
    const bgHex = scheme === "dark" ? 0x0d0f14 : 0xe9eef5;
    this.scene.background = new THREE.Color(bgHex);
    this.rebuildGrid(scheme);

    const outlineHex = scheme === "dark" ? 0x090b0f : 0xf7f9fc;
    for (const r of this.reticles) {
      r.rimMat.color.setHex(outlineHex);
    }
    for (const t of this.targets) {
      t.rimMat.color.setHex(scheme === "dark" ? 0x090b0f : 0x1e2636);
    }
  }

  update(dt: number, inputs: readonly PlayerAimFrame[]): void {
    this.simTime += dt;
    this.localShake = Math.max(0, this.localShake - dt * 3.5);

    let anyCenterAim = false;
    const safeHalfW = Math.max(2.5, this.halfW - 0.9);
    const safeHalfH = Math.max(1.8, this.halfH - 0.9);

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = inputs[slot];
      const reticle = this.reticles[slot];
      if (!frame || !reticle) continue;

      reticle.prevWorldX = reticle.worldX;
      reticle.prevWorldY = reticle.worldY;
      reticle.prevRollRad = reticle.rollRad;
      reticle.connected = frame.connected;
      reticle.primaryDown = frame.primaryDown;

      const wx = frame.cursorX * safeHalfW;
      const wy = frame.cursorY * safeHalfH;
      reticle.worldX = wx;
      reticle.worldY = wy;
      reticle.rollRad = frame.rollRad;

      if (frame.connected && Math.hypot(wx, wy) < 0.98) {
        anyCenterAim = true;
      }
    }

    const highlightTarget = anyCenterAim ? 1 : 0;
    this.centerHighlight += (highlightTarget - this.centerHighlight) * Math.min(1, dt * 12);
    this.centerRingMat.color.setHex(anyCenterAim ? 0x3ce87a : 0x828ea3);
    this.centerRingMat.opacity = 0.4 + this.centerHighlight * 0.45;
    this.centerCrossMat.opacity = 0.32 + this.centerHighlight * 0.4;

    const boundX = Math.max(1.5, this.halfW - 1.4);
    const boundY = Math.max(1.2, this.halfH - 1.2);
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      t.prevX = t.posX;
      t.prevY = t.posY;

      const scaleX = Math.min(1, boundX / 5.5);
      const scaleY = Math.min(1, boundY / 3.2);
      t.posX = clamp(
        t.baseX * scaleX + Math.sin(this.simTime * t.freqX + t.phase) * t.ampX * scaleX,
        -boundX,
        boundX,
      );
      t.posY = clamp(
        t.baseY * scaleY + Math.cos(this.simTime * t.freqY + t.phase) * t.ampY * scaleY,
        -boundY,
        boundY,
      );

      if (t.hitFlash > 0) {
        t.hitFlash = Math.max(0, t.hitFlash - dt * 5);
      }
      if (t.respawnCooldown > 0) {
        t.respawnCooldown = Math.max(0, t.respawnCooldown - dt);
      }
    }

    this.particles.update(dt);
    this.shockwaves.update(dt);
  }

  render(alpha: number): void {
    for (let slot = 0; slot < this.reticles.length; slot++) {
      const r = this.reticles[slot]!;
      r.group.visible = r.connected;
      if (!r.connected) continue;

      const rx = r.prevWorldX + (r.worldX - r.prevWorldX) * alpha;
      const ry = r.prevWorldY + (r.worldY - r.prevWorldY) * alpha;
      const rRoll = r.prevRollRad + (r.rollRad - r.prevRollRad) * alpha;

      r.group.position.set(rx, ry, 0.35 + slot * 0.02);
      r.bracketGroup.rotation.z = -rRoll;
      const trigScale = r.primaryDown ? 0.78 : 1.0;
      r.triggerRing.scale.setScalar(trigScale);
    }

    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      const tx = t.prevX + (t.posX - t.prevX) * alpha;
      const ty = t.prevY + (t.posY - t.prevY) * alpha;
      t.group.position.set(tx, ty, -0.15);

      const scaleFactor =
        t.respawnCooldown > 0 ? 0.65 + (1 - t.respawnCooldown / 0.25) * 0.35 : 1 + t.hitFlash * 0.25;
      t.group.scale.setScalar(clamp(scaleFactor, 0.6, 1.35));
      t.group.rotation.y = Math.sin(this.simTime * 1.1 + t.phase) * 0.14;
      t.group.rotation.x = Math.cos(this.simTime * 0.9 + t.phase) * 0.1;
    }

    if (this.localShake > 0.002) {
      const mag = this.localShake * 0.18;
      this.camera.position.set(
        (Math.random() * 2 - 1) * mag,
        (Math.random() * 2 - 1) * mag,
        CAMERA_Z,
      );
    } else {
      this.camera.position.set(0, 0, CAMERA_Z);
    }

    this.renderer.render(this.scene, this.camera);
  }

  onGesture(event: PlayerGestureEvent): void {
    const slot = event.slot;
    const reticle = this.reticles[slot];
    if (!reticle) return;

    const palette = PLAYER_SLOT_PALETTE[slot]!;
    const wx = reticle.worldX;
    const wy = reticle.worldY;

    if (event.kind === "flick" || event.kind === "swing") {
      this.ctx.audio.play("pop");
      this.ctx.sendHaptic(slot, "tap");
      this.shockwaves.spawn(wx, wy, 0.2, palette.hex, event.kind === "swing" ? 5.6 : 4.2, 0.46);
      this.particles.spawnBurst(wx, wy, 0.1, palette.hex, 12, 5.2);
      if (event.kind === "swing") {
        this.tryHitTargetsAt(slot, wx, wy, 1.35);
      }
      return;
    }

    if (event.kind === "swipe") {
      this.ctx.audio.play("pop");
      this.particles.spawnBurst(wx, wy, 0.1, palette.hex, 10, 4.4, event.dx * 3.5, -event.dy * 3.5);
      return;
    }

    if (event.kind === "tap" || event.kind === "hold_start") {
      const hit = this.tryHitTargetsAt(slot, wx, wy, 1.0);
      if (!hit && event.kind === "tap") {
        this.ctx.audio.play("pop");
        this.ctx.sendHaptic(slot, "tap");
        this.particles.spawnBurst(wx, wy, 0.1, palette.hex, 6, 3.0);
        this.shockwaves.spawn(wx, wy, 0.2, palette.hex, 1.8, 0.25);
      }
    }
  }

  triggerRecenterFeedback(slot: number): void {
    const palette = PLAYER_SLOT_PALETTE[slot];
    if (!palette) return;
    this.shockwaves.spawn(0, 0, 0.2, palette.hex, 3.2, 0.35);
    this.ctx.audio.play("pop");
  }

  private tryHitTargetsAt(slot: number, wx: number, wy: number, rangeBoost: number): boolean {
    const palette = PLAYER_SLOT_PALETTE[slot]!;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      if (t.respawnCooldown > 0.05) continue;

      const dist = Math.hypot(wx - t.posX, wy - t.posY);
      if (dist <= t.radius + 0.34 * rangeBoost) {
        const bullseye = dist <= t.radius * 0.48;
        const pts = bullseye ? 150 : 100;
        this.scores[slot] = (this.scores[slot] ?? 0) + pts;
        const nextStreak = (this.streaks[slot] ?? 0) + 1;
        this.streaks[slot] = nextStreak;

        t.hitFlash = 1.0;
        t.respawnCooldown = 0.22;
        this.localShake = Math.min(1.0, this.localShake + (bullseye ? 0.45 : 0.28));
        this.ctx.fx.addScreenShake(bullseye ? 0.35 : 0.2);

        this.particles.spawnBurst(t.posX, t.posY, 0.1, palette.hex, bullseye ? 22 : 16, bullseye ? 7.2 : 5.6);
        this.shockwaves.spawn(t.posX, t.posY, 0.2, palette.hex, bullseye ? 4.4 : 3.1, 0.36);

        if (nextStreak > 1 && nextStreak % 3 === 0) {
          this.ctx.audio.play("combo");
          this.ctx.sendHaptic(slot, "combo");
          this.ctx.hud.announce(`${this.getPlayerName(slot)} ×${nextStreak} streak!`);
        } else {
          this.ctx.audio.play("hit");
          this.ctx.sendHaptic(slot, "hit");
        }

        this.syncScoreboardHud();
        return true;
      }
    }
    this.streaks[slot] = 0;
    return false;
  }

  private getPlayerName(slot: number): string {
    const found = this.ctx.players.find((p) => p.slot === slot);
    return found?.name ?? `Player ${slot + 1}`;
  }

  private syncScoreboardHud(): void {
    const rows = this.ctx.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      colorHex: p.colorHex,
      score: this.scores[p.slot] ?? 0,
    }));
    this.ctx.hud.updateScoreboard(rows);
  }

  onResize(width: number, height: number, dpr: number): void {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    this.camera.aspect = safeW / safeH;
    this.camera.updateProjectionMatrix();
    this.halfH = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * CAMERA_Z;
    this.halfW = this.halfH * this.camera.aspect;

    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(safeW, safeH, false);
  }

  getScores(): Array<{ slot: number; score: number }> {
    const out: Array<{ slot: number; score: number }> = [];
    for (const p of this.ctx.players) {
      out.push({ slot: p.slot, score: this.scores[p.slot] ?? 0 });
    }
    return out;
  }

  dispose(): void {
    this.detachThemeObserver?.();
    this.detachThemeObserver = null;

    if (this.gridHelper) {
      this.gridHelper.geometry.dispose();
      const mat = this.gridHelper.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
      this.gridHelper = null;
    }

    this.particles.dispose();
    this.shockwaves.dispose();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.renderer.dispose();
  }
}
