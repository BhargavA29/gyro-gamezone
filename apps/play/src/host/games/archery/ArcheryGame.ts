import * as THREE from "three";
import {
  clamp,
  MAX_PLAYERS,
  PLAYER_SLOT_PALETTE,
  type DifficultyPreset,
  type GameHostContext,
  type GamePlugin,
  type PlayerAimFrame,
  type PlayerGestureEvent,
} from "@gyro/shared";
import {
  ArcadeParticlePool,
  ArcadeShockwavePool,
  createSeededRng,
  createToonGradientTexture,
  observeThemeScheme,
} from "../shared/ArcadeSceneUtils.js";
import {
  buildArrowGroup,
  buildBowSight,
  createArcheryTextures,
  type ArcheryTextures,
  type BowSightRefs,
} from "./archeryVisuals.js";

const CAMERA_Z = 14;
const CAMERA_Y = 0.5;
const FOV_DEG = 44;
const ROUND_DURATION_MS = 75_000;
const DRAW_FULL_TIME_S = 0.95;
const ARROW_POOL_SIZE = 18;
const PINNED_POOL_SIZE = 32;
const WIND_STREAK_COUNT = 24;
const WIND_FLAG_COUNT = 6;
const CHECKPOINTS = [0.25, 0.5, 0.75, 0.96] as const;
const FWD_Z = new THREE.Vector3(0, 0, -1);

interface DifficultyConfig {
  windMax: number;
  windAccelScale: number;
  windShiftSec: number;
  gravScale: number;
  targetScale: number;
  moveSpeedMult: number;
  showAssistLead: boolean;
  scoreMult: number;
  musicBpm: number;
}

const DIFFICULTY_TUNING: Record<DifficultyPreset, DifficultyConfig> = {
  casual: {
    windMax: 2.2,
    windAccelScale: 1.5,
    windShiftSec: 15,
    gravScale: 0.72,
    targetScale: 1.15,
    moveSpeedMult: 0.72,
    showAssistLead: true,
    scoreMult: 1.0,
    musicBpm: 112,
  },
  arcade: {
    windMax: 3.8,
    windAccelScale: 2.35,
    windShiftSec: 12,
    gravScale: 1.0,
    targetScale: 1.0,
    moveSpeedMult: 1.0,
    showAssistLead: false,
    scoreMult: 1.0,
    musicBpm: 122,
  },
  pro: {
    windMax: 5.2,
    windAccelScale: 3.1,
    windShiftSec: 9.5,
    gravScale: 1.18,
    targetScale: 0.88,
    moveSpeedMult: 1.32,
    showAssistLead: false,
    scoreMult: 1.25,
    musicBpm: 134,
  },
};

interface BowSlot {
  sight: BowSightRefs;
  worldX: number;
  worldY: number;
  prevWorldX: number;
  prevWorldY: number;
  connected: boolean;
  wasPrimaryDown: boolean;
  drawing: boolean;
  drawTimeS: number;
  nextTickStep: number;
  cooldownS: number;
  hudSyncTimer: number;
  drawRatio: number;
}

interface RangeTarget {
  tier: "near" | "mid" | "far";
  group: THREE.Group;
  baseSightX: number;
  baseSightY: number;
  z: number;
  radius: number;
  distMult: number;
  labelDist: string;
  x: number;
  y: number;
  oscAmp: number;
  oscFreq: number;
  oscPhase: number;
  minWave: number;
  recoilZ: number;
}

interface FlyingArrow {
  active: boolean;
  slot: number;
  group: THREE.Group;
  vaneMat: THREE.MeshBasicMaterial;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  drawRatio: number;
  age: number;
}

interface PinnedArrow {
  active: boolean;
  targetIdx: number;
  group: THREE.Group;
  vaneMat: THREE.MeshBasicMaterial;
  localX: number;
  localY: number;
  localZ: number;
  tiltX: number;
  tiltY: number;
  age: number;
}

interface WindFlag {
  pivot: THREE.Group;
  ribbon: THREE.Mesh;
  phase: number;
}

interface WindStreak {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  z: number;
  len: number;
}

export class ArcheryGame implements GamePlugin {
  readonly id = "archery" as const;

  private ctx!: GameHostContext;
  private rng!: () => number;
  private canvas!: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private toonGradient!: THREE.DataTexture;
  private textures!: ArcheryTextures;
  private tuning: DifficultyConfig = DIFFICULTY_TUNING.arcade;

  private halfH = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * CAMERA_Z;
  private halfW = this.halfH * (16 / 9);

  private simTime = 0;
  private roundElapsedMs = 0;
  private currentWave = 1;
  private windX = 0;
  private windY = 0;
  private targetWindX = 0;
  private targetWindY = 0;
  private windShiftTimer = 9;
  private lastWindLabel = "";

  private tutorialHidden = false;
  private feverAnnounced = false;
  private musicStarted = false;
  private roundFinished = false;
  private localShake = 0;

  private floorGrid: THREE.GridHelper | null = null;
  private groundPlaneMat: THREE.MeshToonMaterial | null = null;
  private darkBgColor = new THREE.Color(0x0c141d);
  private lightBgColor = new THREE.Color(0xddebf7);

  private readonly bows: BowSlot[] = [];
  private readonly targets: RangeTarget[] = [];
  private readonly arrows: FlyingArrow[] = [];
  private arrowCursor = 0;
  private readonly pinnedArrows: PinnedArrow[] = [];
  private pinnedCursor = 0;
  private readonly flags: WindFlag[] = [];
  private readonly streaks: WindStreak[] = [];

  private particles!: ArcadeParticlePool;
  private shockwaves!: ArcadeShockwavePool;

  private readonly scores = new Int32Array(MAX_PLAYERS);
  private readonly streaksGold = new Int32Array(MAX_PLAYERS);
  private readonly tmpDir = new THREE.Vector3();

  private readonly disposables: Array<{ dispose(): void }> = [];
  private detachThemeObserver: (() => void) | null = null;

  init(ctx: GameHostContext): void {
    this.ctx = ctx;
    this.tuning = DIFFICULTY_TUNING[ctx.difficulty] ?? DIFFICULTY_TUNING.arcade;
    this.rng = createSeededRng(ctx.seed);

    this.scores.fill(0);
    this.streaksGold.fill(0);
    this.simTime = 0;
    this.roundElapsedMs = 0;
    this.currentWave = 1;
    this.windX = (this.rng() < 0.5 ? -1 : 1) * (0.6 + this.rng() * 0.6);
    this.windY = 0;
    this.targetWindX = this.windX;
    this.targetWindY = 0;
    this.windShiftTimer = this.tuning.windShiftSec * 0.75;
    this.lastWindLabel = "";
    this.tutorialHidden = false;
    this.feverAnnounced = false;
    this.musicStarted = false;
    this.roundFinished = false;
    this.localShake = 0;

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

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, width / height, 0.5, 110);
    this.camera.position.set(0, CAMERA_Y, CAMERA_Z);

    this.toonGradient = createToonGradientTexture();
    this.textures = createArcheryTextures();
    this.disposables.push(this.toonGradient, ...this.textures.disposables);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x26352f, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(7, 14, 12);
    this.scene.add(hemi, key);

    this.buildRangeGround();
    this.buildTargets();
    this.buildWindFlagsAndStreaks();
    this.buildArrowPools();
    this.buildBowSlots();
    this.particles = new ArcadeParticlePool(this.scene, 240, 0.12);
    this.shockwaves = new ArcadeShockwavePool(this.scene, 14);

    this.detachThemeObserver = observeThemeScheme((scheme) => this.applyThemePalette(scheme));
    this.onResize(width, height, Math.min(window.devicePixelRatio || 1, 2));

    const diffLabel =
      ctx.difficulty === "casual"
        ? "Chill (Assist Dot)"
        : ctx.difficulty === "pro"
          ? "Turbo (1.25×)"
          : "Arcade";

    this.ctx.hud.setRoundTimer(ROUND_DURATION_MS);
    this.ctx.hud.setTutorialVisible(true, [
      `Difficulty: ${diffLabel} · Hold pad / mouse to draw bowstring`,
      "Read Wind & distance (18m · 32m 1.5× · 48m 2.2×)",
      "Release at full draw to loose true · Hit inner Gold for X-Ring streak!",
    ]);
    this.syncWindHud(true);
    this.syncScoreboardHud();
    this.ctx.sendPadHud?.("all", {
      ammo: 0,
      maxAmmo: 10,
      reloading: false,
      streak: 0,
      prompt: this.formatWindPrompt(),
    });
  }

  private buildRangeGround(): void {
    const lawnGeo = new THREE.PlaneGeometry(54, 48);
    lawnGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshToonMaterial({
      color: 0x16251f,
      gradientMap: this.toonGradient,
    });
    this.groundPlaneMat = groundMat;
    this.disposables.push(lawnGeo, groundMat);

    const lawn = new THREE.Mesh(lawnGeo, groundMat);
    lawn.position.set(0, -4.6, -8);
    this.scene.add(lawn);
  }

  private rebuildRangeGrid(scheme: "dark" | "light"): void {
    if (this.floorGrid) {
      this.scene.remove(this.floorGrid);
      this.floorGrid.geometry.dispose();
      const mat = this.floorGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.floorGrid = null;
    }

    const major = scheme === "dark" ? 0x2f4d41 : 0x7da890;
    const minor = scheme === "dark" ? 0x1b2d25 : 0xa9ccb8;
    const grid = new THREE.GridHelper(52, 26, major, minor);
    grid.position.set(0, -4.58, -8);
    this.scene.add(grid);
    this.floorGrid = grid;
  }

  private buildTargets(): void {
    const specs: ReadonlyArray<{
      tier: "near" | "mid" | "far";
      sightX: number;
      sightY: number;
      z: number;
      radius: number;
      distMult: number;
      label: string;
      oscAmp: number;
      oscFreq: number;
      minWave: number;
    }> = [
      {
        tier: "near",
        sightX: -4.2,
        sightY: -0.5,
        z: -2.5,
        radius: 1.12,
        distMult: 1.0,
        label: "18m · 1×",
        oscAmp: 0,
        oscFreq: 0,
        minWave: 1,
      },
      {
        tier: "mid",
        sightX: -0.9,
        sightY: 1.15,
        z: -8.5,
        radius: 1.38,
        distMult: 1.5,
        label: "32m · 1.5×",
        oscAmp: 2.1,
        oscFreq: 0.72,
        minWave: 2,
      },
      {
        tier: "mid",
        sightX: 3.1,
        sightY: -1.1,
        z: -9.5,
        radius: 1.34,
        distMult: 1.5,
        label: "32m · 1.5×",
        oscAmp: 0,
        oscFreq: 0,
        minWave: 1,
      },
      {
        tier: "far",
        sightX: 3.4,
        sightY: 1.25,
        z: -16.0,
        radius: 1.66,
        distMult: 2.2,
        label: "48m · 2.2×",
        oscAmp: 2.8,
        oscFreq: 0.65,
        minWave: 3,
      },
    ];

    const legGeo = new THREE.BoxGeometry(0.16, 4.4, 0.16);
    const woodMat = new THREE.MeshToonMaterial({ color: 0x6b4423, gradientMap: this.toonGradient });
    const strawMat = new THREE.MeshToonMaterial({
      map: this.textures.strawSide,
      color: 0xffffff,
      gradientMap: this.toonGradient,
    });
    const faceMat = new THREE.MeshBasicMaterial({ map: this.textures.targetFace });
    this.disposables.push(legGeo, woodMat, strawMat, faceMat);

    specs.forEach((s, idx) => {
      const scaledR = s.radius * this.tuning.targetScale;
      const proj = (CAMERA_Z - s.z) / CAMERA_Z;
      const worldX = s.sightX * proj;
      const worldY = CAMERA_Y + (s.sightY - CAMERA_Y) * proj;

      const group = new THREE.Group();
      const baleGeo = new THREE.CylinderGeometry(scaledR, scaledR, 0.44, 28);
      baleGeo.rotateX(Math.PI / 2);
      const faceGeo = new THREE.CircleGeometry(scaledR * 0.98, 28);
      const badgeTex = this.textures.badges[s.tier];
      const badgeMat = new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true });
      const badgeGeo = new THREE.PlaneGeometry(scaledR * 1.45, scaledR * 0.48);
      this.disposables.push(baleGeo, faceGeo, badgeMat, badgeGeo);

      const bale = new THREE.Mesh(baleGeo, strawMat);
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.z = 0.23;

      const leftLeg = new THREE.Mesh(legGeo, woodMat);
      leftLeg.position.set(-scaledR * 0.58, -scaledR * 1.2, -0.2);
      leftLeg.rotation.z = -0.14;
      const rightLeg = new THREE.Mesh(legGeo, woodMat);
      rightLeg.position.set(scaledR * 0.58, -scaledR * 1.2, -0.2);
      rightLeg.rotation.z = 0.14;

      const badge = new THREE.Mesh(badgeGeo, badgeMat);
      badge.position.set(0, scaledR + 0.42, 0.05);

      group.add(leftLeg, rightLeg, bale, face, badge);
      group.position.set(worldX, worldY, s.z);
      this.scene.add(group);

      this.targets.push({
        tier: s.tier,
        group,
        baseSightX: worldX,
        baseSightY: worldY,
        z: s.z,
        radius: scaledR,
        distMult: s.distMult,
        labelDist: s.label,
        x: worldX,
        y: worldY,
        oscAmp: s.oscAmp,
        oscFreq: s.oscFreq,
        oscPhase: idx * 1.7,
        minWave: s.minWave,
        recoilZ: 0,
      });
    });
  }

  private buildWindFlagsAndStreaks(): void {
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.1, 6.2, 8);
    const ribbonGeo = new THREE.BoxGeometry(1.4, 0.34, 0.04);
    ribbonGeo.translate(0.7, 0, 0);
    const poleMat = new THREE.MeshToonMaterial({ color: 0x94a3b8, gradientMap: this.toonGradient });
    const ribbonMat = new THREE.MeshBasicMaterial({ color: 0xff5a36 });
    const streakGeo = new THREE.BoxGeometry(0.95, 0.035, 0.035);
    this.disposables.push(poleGeo, ribbonGeo, poleMat, ribbonMat, streakGeo);

    const xs = [-10.5, -13.2, -16.2, 10.5, 13.2, 16.2];
    const zs = [-1.5, -8.5, -15.5, -1.5, -8.5, -15.5];
    for (let i = 0; i < WIND_FLAG_COUNT; i++) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(xs[i]!, -1.6, zs[i]!);
      this.scene.add(pole);

      const pivot = new THREE.Group();
      pivot.position.set(xs[i]!, 1.35, zs[i]!);
      const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
      pivot.add(ribbon);
      this.scene.add(pivot);
      this.flags.push({ pivot, ribbon, phase: i * 1.1 });
    }

    for (let i = 0; i < WIND_STREAK_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe2e8f0,
        transparent: true,
        opacity: 0.28,
      });
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(streakGeo, mat);
      const sx = (this.rng() * 2 - 1) * 14;
      const sy = -2.5 + this.rng() * 7.5;
      const sz = -17 + this.rng() * 19;
      mesh.position.set(sx, sy, sz);
      this.scene.add(mesh);
      this.streaks.push({
        mesh,
        mat,
        x: sx,
        y: sy,
        z: sz,
        len: 0.65 + this.rng() * 0.75,
      });
    }
  }

  private buildArrowPools(): void {
    for (let i = 0; i < ARROW_POOL_SIZE; i++) {
      const { group, vaneMat } = buildArrowGroup(0xff4d2e, this.toonGradient, this.disposables);
      group.visible = false;
      this.scene.add(group);
      this.arrows.push({
        active: false,
        slot: 0,
        group,
        vaneMat,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        drawRatio: 1,
        age: 0,
      });
    }

    for (let i = 0; i < PINNED_POOL_SIZE; i++) {
      const { group, vaneMat } = buildArrowGroup(0xff4d2e, this.toonGradient, this.disposables);
      group.visible = false;
      this.scene.add(group);
      this.pinnedArrows.push({
        active: false,
        targetIdx: 0,
        group,
        vaneMat,
        localX: 0,
        localY: 0,
        localZ: 0.25,
        tiltX: 0,
        tiltY: 0,
        age: 0,
      });
    }
  }

  private buildBowSlots(): void {
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const palette = PLAYER_SLOT_PALETTE[slot]!;
      const sight = buildBowSight(palette.hex, this.disposables);
      sight.group.visible = false;
      this.scene.add(sight.group);

      this.bows.push({
        sight,
        worldX: 0,
        worldY: 0,
        prevWorldX: 0,
        prevWorldY: 0,
        connected: false,
        wasPrimaryDown: false,
        drawing: false,
        drawTimeS: 0,
        nextTickStep: 0,
        cooldownS: 0,
        hudSyncTimer: 0,
        drawRatio: 0,
      });
    }
  }

  private applyThemePalette(scheme: "dark" | "light"): void {
    this.darkBgColor.setHex(0x0c141d);
    this.lightBgColor.setHex(0xddebf7);
    this.scene.background = (scheme === "dark" ? this.darkBgColor : this.lightBgColor).clone();
    if (this.groundPlaneMat) {
      this.groundPlaneMat.color.setHex(scheme === "dark" ? 0x16251f : 0x5c8b68);
    }
    this.rebuildRangeGrid(scheme);
  }

  update(dt: number, inputs: readonly PlayerAimFrame[]): void {
    this.simTime += dt;
    this.localShake = Math.max(0, this.localShake - dt * 4.0);

    const sightHalfW = Math.max(3.0, this.halfW - 0.85);
    const sightHalfH = Math.max(2.0, this.halfH - 0.65);
    const isLive = this.ctx.getPhase() === "playing" && !this.roundFinished;

    if (isLive) {
      if (!this.musicStarted) {
        this.musicStarted = true;
        this.ctx.audio.startMusic?.(this.tuning.musicBpm);
      }

      this.roundElapsedMs += dt * 1000;
      const remainingMs = Math.max(0, ROUND_DURATION_MS - this.roundElapsedMs);
      this.ctx.hud.setRoundTimer(remainingMs);

      const elapsedSec = this.roundElapsedMs / 1000;
      const nextWave = elapsedSec < 20 ? 1 : elapsedSec < 45 ? 2 : 3;
      if (nextWave > this.currentWave) {
        this.currentWave = nextWave;
        this.ctx.hud.announce(
          nextWave === 2 ? "Wave 2 · Moving 32m Target & Breeze!" : "Wave 3 · Moving 48m Sniper!",
        );
      }

      if (!this.tutorialHidden && this.roundElapsedMs >= 8500) {
        this.tutorialHidden = true;
        this.ctx.hud.setTutorialVisible(false);
      }

      if (!this.feverAnnounced && remainingMs <= 5000 && remainingMs > 0) {
        this.feverAnnounced = true;
        this.ctx.audio.play("combo");
        this.ctx.hud.announce("FINAL 5 SECONDS · 2× ARCHERY POINTS!");
      }

      this.stepWindDirector(dt, nextWave);

      if (remainingMs <= 0) {
        this.finishGame();
        return;
      }
    }

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = inputs[slot];
      const bow = this.bows[slot];
      if (!frame || !bow) continue;

      const nextX = frame.cursorX * sightHalfW;
      const nextY = CAMERA_Y + frame.cursorY * sightHalfH;
      const wasConnected = bow.connected;

      bow.prevWorldX = wasConnected ? bow.worldX : nextX;
      bow.prevWorldY = wasConnected ? bow.worldY : nextY;
      bow.worldX = nextX;
      bow.worldY = nextY;
      bow.connected = frame.connected;
      bow.cooldownS = Math.max(0, bow.cooldownS - dt);

      if (isLive && frame.connected) {
        // Begin draw on initial primary press (after nock cooldown)
        if (!bow.wasPrimaryDown && frame.primaryDown && !bow.drawing && bow.cooldownS <= 0) {
          this.beginDraw(slot, bow);
        }

        if (bow.drawing) {
          bow.drawTimeS = Math.min(1.15, bow.drawTimeS + dt);
          bow.drawRatio = clamp(bow.drawTimeS / DRAW_FULL_TIME_S, 0, 1);

          if (bow.nextTickStep < CHECKPOINTS.length && bow.drawRatio >= CHECKPOINTS[bow.nextTickStep]!) {
            bow.nextTickStep += 1;
            this.ctx.audio.play("bow_draw");
            this.ctx.sendHaptic(slot, "tension");
          }

          bow.hudSyncTimer -= dt;
          if (bow.hudSyncTimer <= 0) {
            bow.hudSyncTimer = 0.1;
            const pct = Math.round(bow.drawRatio * 100);
            this.ctx.sendPadHud?.(slot, {
              ammo: Math.round(bow.drawRatio * 10),
              maxAmmo: 10,
              reloading: true,
              streak: this.streaksGold[slot] ?? 0,
              prompt: pct >= 90 ? "FULL DRAW! RELEASE TO LOOSE!" : `DRAW ${pct}% · ${this.formatWindShort()}`,
            });
          }

          if (bow.wasPrimaryDown && !frame.primaryDown) {
            this.looseArrow(slot, Math.max(0.38, bow.drawRatio));
          }
        } else {
          bow.drawRatio = 0;
        }
      } else {
        bow.drawing = false;
        bow.drawRatio = 0;
      }

      bow.wasPrimaryDown = frame.primaryDown;
    }

    this.stepTargets(dt);
    this.stepWindVisuals(dt);
    this.stepArrows(dt);
    this.stepPinnedArrows(dt);
    this.particles.update(dt);
    this.shockwaves.update(dt);
  }

  private beginDraw(slot: number, bow: BowSlot): void {
    bow.drawing = true;
    bow.drawTimeS = 0;
    bow.drawRatio = 0.08;
    bow.nextTickStep = 0;
    bow.hudSyncTimer = 0.02;
    this.ctx.audio.play("bow_draw");
    this.ctx.sendHaptic(slot, "tension");
  }

  private stepWindDirector(dt: number, wave: number): void {
    this.windShiftTimer -= dt;
    if (this.windShiftTimer <= 0) {
      this.windShiftTimer = this.tuning.windShiftSec * (0.75 + this.rng() * 0.5);
      const frac = wave === 1 ? 0.42 : wave === 2 ? 0.72 : 1.0;
      const mag = (0.35 + this.rng() * 0.65) * this.tuning.windMax * frac;
      const sign = this.rng() < 0.5 ? -1 : 1;
      this.targetWindX = sign * mag;
      this.targetWindY = (this.rng() - 0.5) * mag * 0.25;
      this.ctx.hud.announce(`Wind Shifted · ${this.formatWindDirection(this.targetWindX)}`);
    }

    const lerpRate = Math.min(1, dt * 1.6);
    this.windX += (this.targetWindX - this.windX) * lerpRate;
    this.windY += (this.targetWindY - this.windY) * lerpRate;
    this.syncWindHud(false);
  }

  private syncWindHud(force: boolean): void {
    const label = this.formatWindDirection(this.windX);
    if (force || label !== this.lastWindLabel) {
      this.lastWindLabel = label;
      this.ctx.hud.setWindHud?.(label);
    }
  }

  private formatWindDirection(wx: number): string {
    const abs = Math.abs(wx);
    if (abs < 0.35) return "Wind • Calm";
    const arrow = wx > 0 ? "→" : "←";
    return `Wind ${arrow} ${abs.toFixed(1)} m/s`;
  }

  private formatWindShort(): string {
    const abs = Math.abs(this.windX);
    if (abs < 0.35) return "WIND CALM";
    return `WIND ${this.windX > 0 ? "→" : "←"}${abs.toFixed(1)}`;
  }

  private formatWindPrompt(): string {
    return `${this.formatWindShort()} · Hold=Draw`;
  }

  private stepTargets(dt: number): void {
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      t.recoilZ = Math.max(0, t.recoilZ - dt * 1.8);
      if (this.currentWave >= t.minWave && t.oscAmp > 0) {
        const phase = this.simTime * t.oscFreq * this.tuning.moveSpeedMult + t.oscPhase;
        t.x = t.baseSightX + Math.sin(phase) * t.oscAmp;
      } else {
        t.x = t.baseSightX;
      }
      t.y = t.baseSightY;
      t.group.position.set(t.x, t.y, t.z - t.recoilZ);
    }
  }

  private stepWindVisuals(dt: number): void {
    const speed = Math.abs(this.windX);
    const dir = this.windX >= 0 ? 1 : -1;

    for (let i = 0; i < this.flags.length; i++) {
      const f = this.flags[i]!;
      const bend = clamp(this.windX * 0.24, -1.25, 1.25);
      const flutter = Math.sin(this.simTime * (4 + speed * 2.5) + f.phase) * (0.06 + speed * 0.04);
      f.pivot.rotation.y = dir >= 0 ? 0 : Math.PI;
      f.ribbon.rotation.z = -0.35 + Math.abs(bend) * 0.32 + flutter;
      f.ribbon.rotation.y = flutter * 1.5;
    }

    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i]!;
      s.x += (this.windX * 2.6 + dir * 0.7) * dt;
      s.y += this.windY * 1.1 * dt;
      if (s.x > 16) s.x = -16;
      else if (s.x < -16) s.x = 16;
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.scale.x = s.len * (0.6 + speed * 0.45);
      s.mat.opacity = clamp(0.1 + speed * 0.08, 0.1, 0.45);
    }
  }

  onGesture(event: PlayerGestureEvent): void {
    if (this.ctx.getPhase() !== "playing" || this.roundFinished) return;

    const slot = event.slot;
    const bow = this.bows[slot];
    if (!bow || !bow.connected) return;

    if (event.kind === "hold_start") {
      if (!bow.drawing && bow.cooldownS <= 0) {
        this.beginDraw(slot, bow);
      }
      return;
    }

    if (event.kind === "hold_end") {
      if (bow.drawing) {
        const ratio = clamp(Math.max(bow.drawTimeS, event.power) / DRAW_FULL_TIME_S, 0.35, 1.0);
        this.looseArrow(slot, ratio);
      }
      return;
    }

    if (event.kind === "tap" && !bow.drawing && bow.cooldownS <= 0) {
      // Quick tap shoots a light low-tension arrow so taps stay responsive while rewarding real holds
      this.looseArrow(slot, 0.38);
      if (!this.tutorialHidden) {
        this.ctx.hud.announce("Quick snap shot! Hold longer for flat trajectory");
      }
      return;
    }

    if (event.kind === "swing" && bow.cooldownS <= 0) {
      // Spacebar shortcut in desktop Simulator
      this.looseArrow(slot, 0.92);
    }
  }

  private looseArrow(slot: number, drawRatio: number): void {
    const bow = this.bows[slot];
    if (!bow) return;

    bow.drawing = false;
    bow.drawTimeS = 0;
    bow.drawRatio = 0;
    bow.cooldownS = 0.24;

    const a = this.arrows[this.arrowCursor];
    this.arrowCursor = (this.arrowCursor + 1) % this.arrows.length;
    if (!a) return;

    const palette = PLAYER_SLOT_PALETTE[slot]!;
    const eyeX = 0;
    const eyeY = CAMERA_Y;
    const eyeZ = CAMERA_Z;

    this.tmpDir.set(bow.worldX - eyeX, bow.worldY - eyeY, 0 - eyeZ).normalize();
    const speed = THREE.MathUtils.lerp(24, 54, clamp(drawRatio, 0.25, 1.0));

    a.active = true;
    a.slot = slot;
    a.drawRatio = drawRatio;
    a.age = 0;
    a.vaneMat.color.set(palette.hex);

    // Spawn just forward along aim ray so visual launch tracks smoothly
    a.pos.set(eyeX, eyeY, eyeZ).addScaledVector(this.tmpDir, 4.5);
    a.prevPos.copy(a.pos);
    a.vel.copy(this.tmpDir).multiplyScalar(speed);
    // Subtle slight vertical loft compensation on strong draws
    a.vel.y += 1.05 * this.tuning.gravScale;

    a.group.position.copy(a.pos);
    a.group.quaternion.setFromUnitVectors(FWD_Z, this.tmpDir);
    a.group.visible = true;

    this.ctx.audio.play("bow_release");
    this.ctx.sendHaptic(slot, "tap");
    this.ctx.sendPadHud?.(slot, {
      ammo: 0,
      maxAmmo: 10,
      reloading: false,
      streak: this.streaksGold[slot] ?? 0,
      prompt: this.formatWindPrompt(),
    });
  }

  private stepArrows(dt: number): void {
    const gravity = 7.4 * this.tuning.gravScale;
    const windAccelX = this.windX * this.tuning.windAccelScale;
    const windAccelY = this.windY * 0.45;

    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i]!;
      if (!a.active) continue;

      a.age += dt;
      a.prevPos.copy(a.pos);

      a.vel.x += windAccelX * dt;
      a.vel.y += (windAccelY - gravity) * dt;
      a.pos.addScaledVector(a.vel, dt);

      this.tmpDir.copy(a.vel).normalize();
      a.group.position.copy(a.pos);
      a.group.quaternion.setFromUnitVectors(FWD_Z, this.tmpDir);

      // Sweep segment against each range target plane (ordered near -> far cleanly)
      let hitTargetIdx = -1;
      let hitLocalX = 0;
      let hitLocalY = 0;
      let bestCrossZ = -Infinity;

      for (let ti = 0; ti < this.targets.length; ti++) {
        const t = this.targets[ti]!;
        if (a.prevPos.z >= t.z && a.pos.z <= t.z && t.z > bestCrossZ) {
          const alpha = (a.prevPos.z - t.z) / Math.max(1e-5, a.prevPos.z - a.pos.z);
          const hx = a.prevPos.x + (a.pos.x - a.prevPos.x) * alpha;
          const hy = a.prevPos.y + (a.pos.y - a.prevPos.y) * alpha;
          const r = Math.hypot(hx - t.x, hy - t.y);
          if (r <= t.radius * 1.05) {
            bestCrossZ = t.z;
            hitTargetIdx = ti;
            hitLocalX = hx - t.x;
            hitLocalY = hy - t.y;
          }
        }
      }

      if (hitTargetIdx !== -1) {
        a.active = false;
        a.group.visible = false;
        this.handleArrowHit(a, hitTargetIdx, hitLocalX, hitLocalY);
        continue;
      }

      if (a.pos.z < -20 || a.pos.y < -4.6 || a.age > 2.5) {
        a.active = false;
        a.group.visible = false;
        this.streaksGold[a.slot] = 0;
        this.particles.spawnBurst(a.pos.x, Math.max(-4.4, a.pos.y), a.pos.z, 0x94a3b8, 10, 3.2);
        this.ctx.audio.play("miss");
      }
    }
  }

  private handleArrowHit(
    arrow: FlyingArrow,
    targetIdx: number,
    localX: number,
    localY: number,
  ): void {
    const t = this.targets[targetIdx];
    if (!t) return;

    t.recoilZ = 0.24;
    const r = Math.hypot(localX, localY);
    const ratioR = r / t.radius;

    let ringPts = 20;
    let ringLabel = "OUTER";
    let isGold = false;
    let isBullseye = false;

    if (ratioR <= 0.16) {
      ringPts = 100;
      ringLabel = "X-RING BULLSEYE";
      isGold = true;
      isBullseye = true;
    } else if (ratioR <= 0.34) {
      ringPts = 80;
      ringLabel = "GOLD RING";
      isGold = true;
    } else if (ratioR <= 0.58) {
      ringPts = 55;
      ringLabel = "CRIMSON";
    } else if (ratioR <= 0.8) {
      ringPts = 35;
      ringLabel = "BLUE";
    }

    const nextGoldStreak = isGold ? (this.streaksGold[arrow.slot] ?? 0) + 1 : 0;
    this.streaksGold[arrow.slot] = nextGoldStreak;
    const streakBonus = nextGoldStreak >= 2 ? 35 * (nextGoldStreak - 1) : 0;
    const drawMult = arrow.drawRatio >= 0.8 ? 1.15 : 0.72 + arrow.drawRatio * 0.35;
    const feverMult = ROUND_DURATION_MS - this.roundElapsedMs <= 5000 ? 2.0 : 1.0;

    const totalPts = Math.round(
      (ringPts * t.distMult * drawMult + streakBonus) * this.tuning.scoreMult * feverMult,
    );
    this.scores[arrow.slot] = (this.scores[arrow.slot] ?? 0) + totalPts;

    // Pin the arrow into the straw target with quiver wobble
    const p = this.pinnedArrows[this.pinnedCursor];
    this.pinnedCursor = (this.pinnedCursor + 1) % this.pinnedArrows.length;
    if (p) {
      p.active = true;
      p.targetIdx = targetIdx;
      p.localX = localX;
      p.localY = localY;
      p.localZ = 0.38;
      p.tiltX = (this.rng() - 0.5) * 0.08;
      p.tiltY = clamp(-this.windX * 0.03, -0.14, 0.14);
      p.age = 0;
      p.vaneMat.color.set(PLAYER_SLOT_PALETTE[arrow.slot]!.hex);
      p.group.visible = true;
    }

    const wx = t.x + localX;
    const wy = t.y + localY;
    const wz = t.z + 0.35;
    const playerHex = PLAYER_SLOT_PALETTE[arrow.slot]!.hex;

    this.particles.spawnBurst(wx, wy, wz, isBullseye ? 0xfacc15 : playerHex, isBullseye ? 24 : 14, 5.2);
    if (isGold) {
      this.shockwaves.spawn(wx, wy, wz, 0xfacc15, 3.2, 0.32);
    }

    if (isBullseye) {
      this.localShake = Math.min(1, this.localShake + 0.32);
      this.ctx.fx.addScreenShake(0.28);
      this.ctx.fx.triggerHitStop(22);
      this.ctx.audio.play("bullseye");
      this.ctx.sendHaptic(arrow.slot, "combo");
    } else {
      this.ctx.fx.addScreenShake(0.12);
      this.ctx.audio.play("arrow_thunk");
      this.ctx.sendHaptic(arrow.slot, "hit");
    }

    const name = this.getPlayerName(arrow.slot);
    const tierShort = t.labelDist.split(" ")[0]!;
    if (isGold || streakBonus > 0) {
      this.ctx.hud.announce(
        `${name} ${ringLabel} (${tierShort}) +${totalPts}${nextGoldStreak >= 2 ? ` · ${nextGoldStreak}× GOLD!` : ""}`,
      );
    } else {
      this.ctx.hud.announce(`${name} ${ringLabel} ${tierShort} +${totalPts}`);
    }

    this.ctx.sendPadHud?.(arrow.slot, {
      ammo: 0,
      maxAmmo: 10,
      reloading: false,
      streak: nextGoldStreak,
      prompt: `${ringLabel} ${tierShort} +${totalPts}`,
    });
    this.syncScoreboardHud();
  }

  private stepPinnedArrows(dt: number): void {
    for (let i = 0; i < this.pinnedArrows.length; i++) {
      const p = this.pinnedArrows[i]!;
      if (!p.active) continue;
      const t = this.targets[p.targetIdx];
      if (!t) {
        p.active = false;
        p.group.visible = false;
        continue;
      }

      p.age += dt;
      const wobble = Math.exp(-p.age * 5.2) * Math.sin(p.age * 38) * 0.14;
      p.group.position.set(t.x + p.localX, t.y + p.localY, t.z + p.localZ - t.recoilZ);
      p.group.rotation.set(p.tiltX + wobble, p.tiltY + wobble * 0.6, 0);
    }
  }

  private finishGame(): void {
    if (this.roundFinished) return;
    this.roundFinished = true;
    this.ctx.audio.stopMusic?.();
    this.ctx.audio.play("end");
    this.ctx.hud.setWindHud?.(null);
    this.ctx.finishRound(this.getScores());
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

  render(alpha: number): void {
    for (let slot = 0; slot < this.bows.length; slot++) {
      const b = this.bows[slot]!;
      b.sight.group.visible = b.connected;
      if (!b.connected) continue;

      const rx = b.prevWorldX + (b.worldX - b.prevWorldX) * alpha;
      const ry = b.prevWorldY + (b.worldY - b.prevWorldY) * alpha;
      const zLayer = 0.25 + slot * 0.02;

      b.sight.group.position.set(rx, ry, zLayer);
      const scaleTension = b.drawing ? THREE.MathUtils.lerp(2.05, 0.72, b.drawRatio) : 1.0;
      b.sight.tensionRing.scale.setScalar(scaleTension);
      b.sight.tensionMat.opacity = b.drawing ? 0.92 : 0;
      b.sight.tensionMat.color.setHex(b.drawRatio >= 0.85 ? 0x22c55e : 0xfacc15);
      b.sight.outerRing.scale.setScalar(b.drawing ? 0.85 : 1.0);

      // On Chill difficulty show subtle lead hint compensating mid-range wind drift
      if (this.tuning.showAssistLead) {
        b.sight.leadMat.opacity = 0.65;
        b.sight.leadPip.position.set(this.windX * 0.22, -0.14, -0.02);
      } else {
        b.sight.leadMat.opacity = 0;
      }
    }

    if (this.localShake > 0.002) {
      const mag = this.localShake * 0.16;
      this.camera.position.set(
        (Math.random() * 2 - 1) * mag,
        CAMERA_Y + (Math.random() * 2 - 1) * mag,
        CAMERA_Z,
      );
    } else {
      this.camera.position.set(0, CAMERA_Y, CAMERA_Z);
    }

    this.renderer.render(this.scene, this.camera);
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
    this.ctx.audio.stopMusic?.();
    this.ctx.hud.setWindHud?.(null);
    this.detachThemeObserver?.();
    this.detachThemeObserver = null;

    if (this.floorGrid) {
      this.floorGrid.geometry.dispose();
      const mat = this.floorGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.floorGrid = null;
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
