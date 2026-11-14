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

const CAMERA_Z = 14;
const FOV_DEG = 42;
const ROUND_DURATION_MS = 60_000;
const MAG_SIZE = 6;
const RELOAD_DURATION_S = 0.28;
const COMBO_WINDOW_S = 2.8;
const MAX_TARGETS = 10;
const BOLT_POOL_SIZE = 12;

interface DifficultyConfig {
  speedStart: number;
  speedEnd: number;
  targetScale: number;
  spawnCounts: readonly [number, number, number];
  spawnIntervals: readonly [number, number, number];
  wave2Sec: number;
  wave3Sec: number;
  ttlAddSec: number;
  scoreMult: number;
  musicBpm: number;
}

const DIFFICULTY_TUNING: Record<DifficultyPreset, DifficultyConfig> = {
  casual: {
    speedStart: 0.72,
    speedEnd: 1.15,
    targetScale: 1.12,
    spawnCounts: [4, 5, 5],
    spawnIntervals: [0.66, 0.52, 0.42],
    wave2Sec: 20,
    wave3Sec: 40,
    ttlAddSec: 1.2,
    scoreMult: 1.0,
    musicBpm: 118,
  },
  arcade: {
    speedStart: 1.0,
    speedEnd: 1.72,
    targetScale: 1.0,
    spawnCounts: [4, 6, 7],
    spawnIntervals: [0.55, 0.4, 0.28],
    wave2Sec: 16,
    wave3Sec: 36,
    ttlAddSec: 0,
    scoreMult: 1.0,
    musicBpm: 128,
  },
  pro: {
    speedStart: 1.28,
    speedEnd: 2.15,
    targetScale: 0.9,
    spawnCounts: [5, 7, 8],
    spawnIntervals: [0.42, 0.3, 0.22],
    wave2Sec: 11,
    wave3Sec: 28,
    ttlAddSec: -0.6,
    scoreMult: 1.25,
    musicBpm: 142,
  },
};

type TargetKind = "bullseye" | "runner" | "gold" | "hazard";

interface ReticleSlot {
  group: THREE.Group;
  bracketGroup: THREE.Group;
  pipRingGroup: THREE.Group;
  triggerRing: THREE.Mesh;
  emptyWarnRing: THREE.Mesh;
  promptSprite: THREE.Sprite;
  promptMat: THREE.SpriteMaterial;
  outerMat: THREE.MeshBasicMaterial;
  rimMat: THREE.MeshBasicMaterial;
  emptyWarnMat: THREE.MeshBasicMaterial;
  pips: THREE.Mesh[];
  pipMats: THREE.MeshBasicMaterial[];
  paletteHexNum: number;
  worldX: number;
  worldY: number;
  prevWorldX: number;
  prevWorldY: number;
  rollRad: number;
  prevRollRad: number;
  primaryDown: boolean;
  connected: boolean;
  recoil: number;
}

interface TargetEntity {
  active: boolean;
  knockedDown: boolean;
  kind: TargetKind;
  root: THREE.Group;
  hinge: THREE.Group;
  railMesh: THREE.Mesh;
  variants: Record<TargetKind, THREE.Group>;
  rimMats: THREE.MeshBasicMaterial[];
  laneZ: number;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  radius: number;
  ampX: number;
  ampY: number;
  freqX: number;
  freqY: number;
  oscPhaseX: number;
  oscPhaseY: number;
  phase: number;
  age: number;
  ttl: number;
  flipAngle: number;
  prevFlipAngle: number;
  knockTimer: number;
}

interface TracerBolt {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  age: number;
  maxAge: number;
}

export class TargetShootingGame implements GamePlugin {
  readonly id = "target-shooting" as const;

  private ctx!: GameHostContext;
  private rng!: () => number;
  private canvas!: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private toonGradient!: THREE.DataTexture;

  private halfH = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * CAMERA_Z;
  private halfW = this.halfH * (16 / 9);

  private simTime = 0;
  private roundElapsedMs = 0;
  private spawnTimer = 0;
  private currentWave = 1;
  private tutorialHidden = false;
  private feverAnnounced = false;
  private musicStarted = false;
  private roundFinished = false;
  private localShake = 0;
  private tuning: DifficultyConfig = DIFFICULTY_TUNING.arcade;

  private reloadPromptTex!: THREE.CanvasTexture;
  private reloadingTex!: THREE.CanvasTexture;

  private floorGrid: THREE.GridHelper | null = null;
  private backGrid: THREE.GridHelper | null = null;
  private pillarMats: THREE.MeshToonMaterial[] = [];

  private reticles: ReticleSlot[] = [];
  private targets: TargetEntity[] = [];
  private bolts: TracerBolt[] = [];
  private boltCursor = 0;

  private particles!: ArcadeParticlePool;
  private shockwaves!: ArcadeShockwavePool;

  // Per-player gameplay state stored in typed arrays for 0 allocations
  private readonly scores = new Int32Array(MAX_PLAYERS);
  private readonly ammo = new Int32Array(MAX_PLAYERS);
  private readonly streaks = new Int32Array(MAX_PLAYERS);
  private readonly comboTimers = new Float32Array(MAX_PLAYERS);
  private readonly reloadTimers = new Float32Array(MAX_PLAYERS);

  // Scratch vectors for tracer beam math
  private readonly tmpStart = new THREE.Vector3();
  private readonly tmpEnd = new THREE.Vector3();
  private readonly tmpMid = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly tmpQuat = new THREE.Quaternion();

  private readonly disposables: Array<{ dispose(): void }> = [];
  private detachThemeObserver: (() => void) | null = null;

  init(ctx: GameHostContext): void {
    this.ctx = ctx;
    this.tuning = DIFFICULTY_TUNING[ctx.difficulty] ?? DIFFICULTY_TUNING.arcade;
    this.rng = createSeededRng(ctx.seed);
    this.scores.fill(0);
    this.ammo.fill(MAG_SIZE);
    this.streaks.fill(0);
    this.comboTimers.fill(0);
    this.reloadTimers.fill(0);

    this.roundElapsedMs = 0;
    this.spawnTimer = 0;
    this.currentWave = 1;
    this.tutorialHidden = false;
    this.feverAnnounced = false;
    this.musicStarted = false;
    this.roundFinished = false;

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

    this.camera = new THREE.PerspectiveCamera(FOV_DEG, width / height, 0.5, 90);
    this.camera.position.set(0, 0, CAMERA_Z);

    this.toonGradient = createToonGradientTexture();
    this.disposables.push(this.toonGradient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x30384b, 1.35);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(6, 10, 12);
    this.scene.add(hemi, key);

    this.buildRangeBackdrop();
    this.buildTargetPool();
    this.buildReticles();
    this.buildBoltPool();
    this.particles = new ArcadeParticlePool(this.scene, 240, 0.11);
    this.shockwaves = new ArcadeShockwavePool(this.scene, 14);

    this.detachThemeObserver = observeThemeScheme((scheme) => this.applyThemePalette(scheme));
    this.onResize(width, height, Math.min(window.devicePixelRatio || 1, 2));

    // Pre-populate 3 welcoming targets right away so countdown feels alive!
    this.spawnTarget("bullseye", 0, -2.8, 1.1);
    this.spawnTarget("bullseye", 0, 2.8, -0.6);
    this.spawnTarget("runner", -2.2, 0, 1.7);

    const diffLabel =
      this.ctx.difficulty === "casual"
        ? "Chill"
        : this.ctx.difficulty === "pro"
          ? "Turbo (1.25×)"
          : "Arcade";

    this.ctx.hud.setRoundTimer(ROUND_DURATION_MS);
    this.ctx.hud.setTutorialVisible(true, [
      `Difficulty: ${diffLabel} · Point & tap to fire (6 shots)`,
      "Flick phone ↑ or tap RELOAD button on phone (R in Sim)",
      "Golden chimes = +300 · Avoid red X hazard plates (-150)",
    ]);
    this.syncScoreboardHud();
    this.syncAmmoHudAll();
  }

  private buildRangeBackdrop(): void {
    const pillarGeo = new THREE.BoxGeometry(0.9, 12, 1.2);
    const barGeo = new THREE.BoxGeometry(24, 0.35, 0.45);
    this.disposables.push(pillarGeo, barGeo);

    const leftMat = new THREE.MeshToonMaterial({ color: 0x202736, gradientMap: this.toonGradient });
    const rightMat = new THREE.MeshToonMaterial({ color: 0x202736, gradientMap: this.toonGradient });
    const railMat = new THREE.MeshToonMaterial({ color: 0x2a3346, gradientMap: this.toonGradient });
    this.pillarMats.push(leftMat, rightMat, railMat);
    this.disposables.push(leftMat, rightMat, railMat);

    const leftPillar = new THREE.Mesh(pillarGeo, leftMat);
    leftPillar.position.set(-10.5, 0, -3.2);
    const rightPillar = new THREE.Mesh(pillarGeo, rightMat);
    rightPillar.position.set(10.5, 0, -3.2);

    const topHeader = new THREE.Mesh(barGeo, railMat);
    topHeader.position.set(0, 5.2, -5.8);

    this.scene.add(leftPillar, rightPillar, topHeader);
  }

  private rebuildGrids(scheme: "dark" | "light"): void {
    if (this.floorGrid) {
      this.scene.remove(this.floorGrid);
      this.floorGrid.geometry.dispose();
      const mat = this.floorGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.floorGrid = null;
    }
    if (this.backGrid) {
      this.scene.remove(this.backGrid);
      this.backGrid.geometry.dispose();
      const mat = this.backGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.backGrid = null;
    }

    const major = scheme === "dark" ? 0x2e394f : 0x9aa8bf;
    const minor = scheme === "dark" ? 0x19202e : 0xcbd4e3;

    const floor = new THREE.GridHelper(34, 24, major, minor);
    floor.position.set(0, -4.4, -3.0);
    this.scene.add(floor);
    this.floorGrid = floor;

    const back = new THREE.GridHelper(34, 22, major, minor);
    back.rotation.x = Math.PI / 2;
    back.position.set(0, 0, -7.2);
    this.scene.add(back);
    this.backGrid = back;
  }

  private buildTargetPool(): void {
    // Shared geometries across all 10 pooled targets
    const discGeo = new THREE.CylinderGeometry(0.76, 0.76, 0.2, 24);
    discGeo.rotateX(Math.PI / 2);
    const ringGeo = new THREE.TorusGeometry(0.78, 0.07, 10, 28);
    const innerRingGeo = new THREE.CircleGeometry(0.46, 22);
    const centerDotGeo = new THREE.CircleGeometry(0.2, 18);

    const runnerHexGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.22, 6);
    runnerHexGeo.rotateX(Math.PI / 2);
    const runnerRimGeo = new THREE.TorusGeometry(0.7, 0.065, 8, 6);
    const railTrackGeo = new THREE.BoxGeometry(4.8, 0.1, 0.1);

    const goldGemGeo = new THREE.OctahedronGeometry(0.68, 0);
    const goldHaloGeo = new THREE.TorusGeometry(0.92, 0.06, 10, 24);

    const hazOctGeo = new THREE.CylinderGeometry(0.74, 0.74, 0.22, 8);
    hazOctGeo.rotateX(Math.PI / 2);
    const hazRimGeo = new THREE.TorusGeometry(0.76, 0.075, 8, 8);
    const xBarGeo = new THREE.BoxGeometry(0.92, 0.16, 0.08);

    // Shared flat/toon materials
    const creamMat = new THREE.MeshBasicMaterial({ color: 0xf6f8fc });
    const redMat = new THREE.MeshToonMaterial({ color: 0xff4d2e, gradientMap: this.toonGradient });
    const cyanMat = new THREE.MeshToonMaterial({ color: 0x19d3ff, gradientMap: this.toonGradient });
    const amberMat = new THREE.MeshToonMaterial({ color: 0xffb800, gradientMap: this.toonGradient });
    const goldMat = new THREE.MeshToonMaterial({ color: 0xffd028, gradientMap: this.toonGradient });
    const hazardBodyMat = new THREE.MeshToonMaterial({ color: 0x261d24, gradientMap: this.toonGradient });
    const hazardAccentMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const railMat = new THREE.MeshBasicMaterial({ color: 0x45526b });

    this.disposables.push(
      discGeo,
      ringGeo,
      innerRingGeo,
      centerDotGeo,
      runnerHexGeo,
      runnerRimGeo,
      railTrackGeo,
      goldGemGeo,
      goldHaloGeo,
      hazOctGeo,
      hazRimGeo,
      xBarGeo,
      creamMat,
      redMat,
      cyanMat,
      amberMat,
      goldMat,
      hazardBodyMat,
      hazardAccentMat,
      railMat,
    );

    for (let i = 0; i < MAX_TARGETS; i++) {
      const root = new THREE.Group();
      root.visible = false;

      const railMesh = new THREE.Mesh(railTrackGeo, railMat);
      railMesh.position.z = -0.2;
      railMesh.visible = false;
      root.add(railMesh);

      const hinge = new THREE.Group();
      hinge.position.y = -0.82;
      root.add(hinge);

      const rimMat = new THREE.MeshBasicMaterial({ color: 0x0b0e14 });
      this.disposables.push(rimMat);

      // 1. Bullseye mesh cluster
      const gBull = new THREE.Group();
      gBull.position.y = 0.82;
      const bBody = new THREE.Mesh(discGeo, redMat);
      const bRim = new THREE.Mesh(ringGeo, rimMat);
      const bMid = new THREE.Mesh(innerRingGeo, creamMat);
      bMid.position.z = 0.11;
      const bCenter = new THREE.Mesh(centerDotGeo, redMat);
      bCenter.position.z = 0.125;
      gBull.add(bBody, bRim, bMid, bCenter);

      // 2. Runner mesh cluster
      const gRun = new THREE.Group();
      gRun.position.y = 0.82;
      const rBody = new THREE.Mesh(runnerHexGeo, cyanMat);
      const rRim = new THREE.Mesh(runnerRimGeo, rimMat);
      const rCore = new THREE.Mesh(centerDotGeo, amberMat);
      rCore.position.z = 0.125;
      gRun.add(rBody, rRim, rCore);

      // 3. Gold spinner cluster
      const gGold = new THREE.Group();
      gGold.position.y = 0.82;
      const gCore = new THREE.Mesh(goldGemGeo, goldMat);
      const gHalo = new THREE.Mesh(goldHaloGeo, creamMat);
      gGold.add(gCore, gHalo);

      // 4. Hazard X-plate cluster
      const gHaz = new THREE.Group();
      gHaz.position.y = 0.82;
      const hBody = new THREE.Mesh(hazOctGeo, hazardBodyMat);
      const hRim = new THREE.Mesh(hazRimGeo, hazardAccentMat);
      const x1 = new THREE.Mesh(xBarGeo, hazardAccentMat);
      x1.position.z = 0.12;
      x1.rotation.z = Math.PI / 4;
      const x2 = new THREE.Mesh(xBarGeo, hazardAccentMat);
      x2.position.z = 0.12;
      x2.rotation.z = -Math.PI / 4;
      gHaz.add(hBody, hRim, x1, x2);

      hinge.add(gBull, gRun, gGold, gHaz);
      this.scene.add(root);

      this.targets.push({
        active: false,
        knockedDown: false,
        kind: "bullseye",
        root,
        hinge,
        railMesh,
        variants: {
          bullseye: gBull,
          runner: gRun,
          gold: gGold,
          hazard: gHaz,
        },
        rimMats: [rimMat],
        laneZ: 0,
        baseX: 0,
        baseY: 0,
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
        radius: 0.82,
        ampX: 0,
        ampY: 0,
        freqX: 0,
        freqY: 0,
        oscPhaseX: 0,
        oscPhaseY: 0,
        phase: 0,
        age: 0,
        ttl: 5,
        flipAngle: Math.PI / 2,
        prevFlipAngle: Math.PI / 2,
        knockTimer: 0,
      });
    }
  }

  private bakePromptTexture(text: string, bgHex: string, fgHex: string): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 96;
    const ctx2d = canvas.getContext("2d");
    if (ctx2d) {
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      const r = 24;
      const w = canvas.width - 12;
      const h = canvas.height - 12;
      const x = 6;
      const y = 6;
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, w, h, r);
      ctx2d.fillStyle = bgHex;
      ctx2d.fill();
      ctx2d.lineWidth = 5;
      ctx2d.strokeStyle = "#0b0e14";
      ctx2d.stroke();

      ctx2d.fillStyle = fgHex;
      ctx2d.font = "700 34px system-ui, -apple-system, sans-serif";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "middle";
      ctx2d.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.disposables.push(tex);
    return tex;
  }

  private buildReticles(): void {
    this.reloadPromptTex = this.bakePromptTexture("↑ FLICK RELOAD", "#FF3B30", "#FFF8F6");
    this.reloadingTex = this.bakePromptTexture("RELOADING...", "#19D3FF", "#0B0E14");

    const outerGeo = new THREE.RingGeometry(0.28, 0.36, 28);
    const rimGeo = new THREE.RingGeometry(0.25, 0.39, 28);
    const dotGeo = new THREE.CircleGeometry(0.08, 16);
    const triggerGeo = new THREE.RingGeometry(0.41, 0.46, 28);
    const emptyWarnGeo = new THREE.RingGeometry(0.5, 0.57, 28);
    const tickGeo = new THREE.PlaneGeometry(0.22, 0.055);
    const pipGeo = new THREE.CircleGeometry(0.062, 10);

    this.disposables.push(outerGeo, rimGeo, dotGeo, triggerGeo, emptyWarnGeo, tickGeo, pipGeo);

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const palette = PLAYER_SLOT_PALETTE[slot]!;
      const paletteHexNum = new THREE.Color(palette.hex).getHex();
      const group = new THREE.Group();
      group.visible = false;
      group.position.set(0, 0, 0.55 + slot * 0.02);

      const rimMat = new THREE.MeshBasicMaterial({ color: 0x0b0e14, side: THREE.DoubleSide });
      const outerMat = new THREE.MeshBasicMaterial({ color: palette.hex, side: THREE.DoubleSide });
      const triggerMat = new THREE.MeshBasicMaterial({
        color: palette.hex,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
      });
      const emptyWarnMat = new THREE.MeshBasicMaterial({
        color: 0xff3b30,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      });
      const promptMat = new THREE.SpriteMaterial({
        map: this.reloadPromptTex,
        transparent: true,
        depthTest: false,
      });
      this.disposables.push(rimMat, outerMat, triggerMat, emptyWarnMat, promptMat);

      const bracketGroup = new THREE.Group();
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.z = -0.01;
      const outer = new THREE.Mesh(outerGeo, outerMat);
      const dot = new THREE.Mesh(dotGeo, outerMat);

      const topTick = new THREE.Mesh(tickGeo, outerMat);
      topTick.position.y = 0.43;
      const bottomTick = new THREE.Mesh(tickGeo, outerMat);
      bottomTick.position.y = -0.43;

      bracketGroup.add(rim, outer, topTick, bottomTick);

      const triggerRing = new THREE.Mesh(triggerGeo, triggerMat);
      triggerRing.position.z = -0.02;

      const emptyWarnRing = new THREE.Mesh(emptyWarnGeo, emptyWarnMat);
      emptyWarnRing.position.z = -0.03;

      const promptSprite = new THREE.Sprite(promptMat);
      promptSprite.scale.set(2.15, 0.54, 1);
      promptSprite.position.set(0, 0.96, 0.08);
      promptSprite.visible = false;

      // 6 orbital magazine ammo pips around crosshair
      const pipRingGroup = new THREE.Group();
      const pips: THREE.Mesh[] = [];
      const pipMats: THREE.MeshBasicMaterial[] = [];
      for (let i = 0; i < MAG_SIZE; i++) {
        const angle = Math.PI / 2 - (i * Math.PI * 2) / MAG_SIZE;
        const pMat = new THREE.MeshBasicMaterial({
          color: palette.hex,
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
        });
        this.disposables.push(pMat);
        const pip = new THREE.Mesh(pipGeo, pMat);
        pip.position.set(Math.cos(angle) * 0.58, Math.sin(angle) * 0.58, 0.01);
        pipRingGroup.add(pip);
        pips.push(pip);
        pipMats.push(pMat);
      }

      group.add(bracketGroup, dot, triggerRing, emptyWarnRing, pipRingGroup, promptSprite);
      this.scene.add(group);

      this.reticles.push({
        group,
        bracketGroup,
        pipRingGroup,
        triggerRing,
        emptyWarnRing,
        promptSprite,
        promptMat,
        outerMat,
        rimMat,
        emptyWarnMat,
        pips,
        pipMats,
        paletteHexNum,
        worldX: 0,
        worldY: 0,
        prevWorldX: 0,
        prevWorldY: 0,
        rollRad: 0,
        prevRollRad: 0,
        primaryDown: false,
        connected: false,
        recoil: 0,
      });
    }
  }

  private buildBoltPool(): void {
    const boltGeo = new THREE.CylinderGeometry(0.035, 0.06, 1, 8);
    this.disposables.push(boltGeo);

    for (let i = 0; i < BOLT_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
      });
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(boltGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.bolts.push({
        mesh,
        mat,
        active: false,
        age: 0,
        maxAge: 0.11,
      });
    }
  }

  private applyThemePalette(scheme: "dark" | "light"): void {
    const bgHex = scheme === "dark" ? 0x0d0f14 : 0xe9eef5;
    this.scene.background = new THREE.Color(bgHex);
    this.rebuildGrids(scheme);

    const pillarColor = scheme === "dark" ? 0x1e2534 : 0xc7d2e2;
    for (const m of this.pillarMats) {
      m.color.setHex(pillarColor);
    }
    const outlineHex = scheme === "dark" ? 0x090b0f : 0xf7f9fc;
    for (const r of this.reticles) {
      r.rimMat.color.setHex(outlineHex);
    }
    for (const t of this.targets) {
      for (const rm of t.rimMats) rm.color.setHex(outlineHex);
    }
  }

  update(dt: number, inputs: readonly PlayerAimFrame[]): void {
    this.simTime += dt;
    this.localShake = Math.max(0, this.localShake - dt * 3.8);

    const safeHalfW = Math.max(2.6, this.halfW - 0.85);
    const safeHalfH = Math.max(1.8, this.halfH - 0.85);

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = inputs[slot];
      const reticle = this.reticles[slot];
      if (!frame || !reticle) continue;

      reticle.prevWorldX = reticle.worldX;
      reticle.prevWorldY = reticle.worldY;
      reticle.prevRollRad = reticle.rollRad;
      reticle.connected = frame.connected;
      reticle.primaryDown = frame.primaryDown;
      reticle.worldX = frame.cursorX * safeHalfW;
      reticle.worldY = frame.cursorY * safeHalfH;
      reticle.rollRad = frame.rollRad;
      reticle.recoil = Math.max(0, reticle.recoil - dt * 6.5);

      if ((this.reloadTimers[slot] ?? 0) > 0) {
        const nextReload = Math.max(0, (this.reloadTimers[slot] ?? 0) - dt);
        this.reloadTimers[slot] = nextReload;
        if (nextReload === 0) {
          this.ammo[slot] = MAG_SIZE;
          this.ctx.audio.play("reload");
          this.ctx.sendHaptic(slot, "tap");
          this.syncAmmoHudSlot(slot);
        }
      }

      if ((this.comboTimers[slot] ?? 0) > 0) {
        const nextCombo = Math.max(0, (this.comboTimers[slot] ?? 0) - dt);
        this.comboTimers[slot] = nextCombo;
        if (nextCombo === 0 && (this.streaks[slot] ?? 0) !== 0) {
          this.streaks[slot] = 0;
          this.syncAmmoHudSlot(slot);
        }
      }
    }

    const isLive = this.ctx.getPhase() === "playing";
    if (isLive && !this.roundFinished) {
      if (!this.musicStarted) {
        this.musicStarted = true;
        this.ctx.audio.startMusic?.(this.tuning.musicBpm);
      }

      this.roundElapsedMs += dt * 1000;
      const remainingMs = Math.max(0, ROUND_DURATION_MS - this.roundElapsedMs);
      this.ctx.hud.setRoundTimer(remainingMs);

      if (!this.tutorialHidden && this.roundElapsedMs >= 7500) {
        this.tutorialHidden = true;
        this.ctx.hud.setTutorialVisible(false);
      }

      if (!this.feverAnnounced && remainingMs <= 5000 && remainingMs > 0) {
        this.feverAnnounced = true;
        this.ctx.audio.play("combo");
        this.ctx.hud.announce("FINAL 5 SECONDS · 2× POINTS!");
      }

      if (remainingMs <= 0) {
        this.finishGame();
      } else {
        this.stepDirectorAndSpawns(dt);
      }
    }

    this.updateTargets(dt, isLive);
    this.updateBolts(dt);
    this.particles.update(dt);
    this.shockwaves.update(dt);
  }

  private getCurrentSpeedMult(): number {
    const progress = clamp(this.roundElapsedMs / ROUND_DURATION_MS, 0, 1);
    const ramp = progress * (0.4 + 0.6 * progress);
    return this.tuning.speedStart + (this.tuning.speedEnd - this.tuning.speedStart) * ramp;
  }

  private stepDirectorAndSpawns(dt: number): void {
    const elapsedSec = this.roundElapsedMs / 1000;
    const nextWave = elapsedSec < this.tuning.wave2Sec ? 1 : elapsedSec < this.tuning.wave3Sec ? 2 : 3;
    if (nextWave > this.currentWave) {
      this.currentWave = nextWave;
      this.ctx.hud.announce(
        nextWave === 2
          ? "Wave 2 · Moving Targets & Gold!"
          : "Wave 3 · Overdrive Pace!",
      );
    }

    const desiredCount = this.tuning.spawnCounts[nextWave - 1] ?? 6;
    const spawnInterval = this.tuning.spawnIntervals[nextWave - 1] ?? 0.4;

    let activeCount = 0;
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      if (t.active && !t.knockedDown) activeCount += 1;
    }

    this.spawnTimer -= dt;
    if (activeCount < desiredCount && this.spawnTimer <= 0) {
      this.spawnTimer = spawnInterval;
      this.spawnWaveTarget(nextWave);
    }
  }

  private spawnWaveTarget(wave: number): void {
    const roll = this.rng();
    let kind: TargetKind = "bullseye";
    if (wave === 1) {
      kind = roll < 0.65 ? "bullseye" : "runner";
    } else if (wave === 2) {
      if (roll < 0.36) kind = "bullseye";
      else if (roll < 0.72) kind = "runner";
      else if (roll < 0.87) kind = "gold";
      else kind = "hazard";
    } else {
      if (roll < 0.28) kind = "bullseye";
      else if (roll < 0.66) kind = "runner";
      else if (roll < 0.82) kind = "gold";
      else kind = "hazard";
    }

    // Avoid flooding hazards (cap 2 active; lower cap in Chill)
    if (kind === "hazard") {
      let hazCount = 0;
      for (const t of this.targets) {
        if (t.active && !t.knockedDown && t.kind === "hazard") hazCount += 1;
      }
      const maxHaz = this.ctx.difficulty === "casual" ? 1 : 2;
      if (hazCount >= maxHaz) kind = "runner";
    }

    const laneChoices = [0, -2.2, -4.4];
    const laneZ =
      kind === "gold"
        ? -2.2
        : laneChoices[Math.floor(this.rng() * laneChoices.length)] ?? 0;

    const scaleAtZ = (CAMERA_Z - laneZ) / CAMERA_Z;
    const spanX = Math.max(2.0, (this.halfW - 1.6) * scaleAtZ);
    const spanY = Math.max(1.2, (this.halfH - 1.5) * scaleAtZ);
    const bx = (this.rng() * 2 - 1) * spanX * 0.72;
    const by = (this.rng() * 2 - 1) * spanY * 0.75;

    this.spawnTarget(kind, laneZ, bx, by);
  }

  private spawnTarget(kind: TargetKind, laneZ: number, baseX: number, baseY: number): void {
    let slotEntity: TargetEntity | null = null;
    for (let i = 0; i < this.targets.length; i++) {
      if (!this.targets[i]!.active) {
        slotEntity = this.targets[i]!;
        break;
      }
    }
    if (!slotEntity) return;

    const elapsedSec = this.roundElapsedMs / 1000;
    const startPhase = this.rng() * Math.PI * 2;
    slotEntity.active = true;
    slotEntity.knockedDown = false;
    slotEntity.kind = kind;
    slotEntity.laneZ = laneZ;
    slotEntity.baseX = baseX;
    slotEntity.baseY = baseY;
    slotEntity.x = baseX;
    slotEntity.y = baseY;
    slotEntity.prevX = baseX;
    slotEntity.prevY = baseY;
    slotEntity.phase = startPhase;
    slotEntity.oscPhaseX = startPhase;
    slotEntity.oscPhaseY = startPhase;
    slotEntity.age = 0;
    slotEntity.flipAngle = Math.PI / 2;
    slotEntity.prevFlipAngle = Math.PI / 2;
    slotEntity.knockTimer = 0;

    let baseRadius = 0.82;
    if (kind === "runner") {
      baseRadius = 0.74;
      slotEntity.ampX = 2.1;
      slotEntity.ampY = 0.28;
      slotEntity.freqX = 1.65;
      slotEntity.freqY = 2.2;
      slotEntity.ttl = Math.max(3.2, 6.0 + this.tuning.ttlAddSec - elapsedSec * 0.03);
      slotEntity.railMesh.visible = true;
    } else if (kind === "gold") {
      baseRadius = 0.72;
      slotEntity.ampX = 2.5;
      slotEntity.ampY = 1.15;
      slotEntity.freqX = 2.2;
      slotEntity.freqY = 2.8;
      slotEntity.ttl = Math.max(2.6, 3.2 + this.tuning.ttlAddSec * 0.4);
      slotEntity.railMesh.visible = false;
      if (this.ctx.getPhase() === "playing") {
        this.ctx.audio.play("gold_spawn");
      }
    } else if (kind === "hazard") {
      baseRadius = 0.78;
      slotEntity.ampX = 1.3;
      slotEntity.ampY = 0.7;
      slotEntity.freqX = 1.1;
      slotEntity.freqY = 1.3;
      slotEntity.ttl = Math.max(3.6, 4.5 + this.tuning.ttlAddSec * 0.5);
      slotEntity.railMesh.visible = false;
    } else {
      baseRadius = 0.82;
      slotEntity.ampX = elapsedSec > 18 ? 0.9 : 0.25;
      slotEntity.ampY = 0.35;
      slotEntity.freqX = 1.15;
      slotEntity.freqY = 1.45;
      slotEntity.ttl = Math.max(3.4, 6.2 + this.tuning.ttlAddSec - elapsedSec * 0.03);
      slotEntity.railMesh.visible = false;
    }

    slotEntity.radius = baseRadius * this.tuning.targetScale;

    (Object.keys(slotEntity.variants) as TargetKind[]).forEach((k) => {
      const grp = slotEntity!.variants[k];
      grp.visible = k === kind;
      if (k === kind) {
        grp.scale.setScalar(this.tuning.targetScale);
      }
    });

    slotEntity.root.position.set(baseX, baseY, laneZ);
    slotEntity.root.visible = true;
  }

  private updateTargets(dt: number, isLive: boolean): void {
    const speedMult = this.getCurrentSpeedMult();
    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      if (!t.active) continue;

      t.prevX = t.x;
      t.prevY = t.y;
      t.prevFlipAngle = t.flipAngle;
      t.age += dt;

      if (t.knockedDown) {
        t.knockTimer += dt;
        t.flipAngle = Math.max(-Math.PI / 2, t.flipAngle - dt * 11.5);
        if (t.knockTimer >= 0.2) {
          t.active = false;
          t.root.visible = false;
        }
        continue;
      }

      const scaleAtZ = (CAMERA_Z - t.laneZ) / CAMERA_Z;
      const maxBoundX = Math.max(2.0, (this.halfW - 1.3) * scaleAtZ);
      const maxBoundY = Math.max(1.2, (this.halfH - 1.2) * scaleAtZ);

      t.oscPhaseX += dt * t.freqX * speedMult;
      t.oscPhaseY += dt * t.freqY * speedMult;

      t.x = clamp(t.baseX + Math.sin(t.oscPhaseX) * t.ampX, -maxBoundX, maxBoundX);
      t.y = clamp(t.baseY + Math.cos(t.oscPhaseY) * t.ampY, -maxBoundY, maxBoundY);

      if (t.kind === "gold") {
        t.variants.gold.rotation.y += dt * 3.8;
        t.variants.gold.rotation.x = Math.sin(this.simTime * 3) * 0.25;
      }

      if (isLive && t.age >= t.ttl) {
        // Auto-retract smoothly at end of window
        t.flipAngle = Math.min(Math.PI / 2, t.flipAngle + dt * 7.5);
        if (t.flipAngle >= Math.PI / 2 - 0.02) {
          t.active = false;
          t.root.visible = false;
        }
      } else {
        // Spring upward cleanly into view
        t.flipAngle += (0 - t.flipAngle) * Math.min(1, dt * 14);
      }
    }
  }

  private updateBolts(dt: number): void {
    for (let i = 0; i < this.bolts.length; i++) {
      const b = this.bolts[i]!;
      if (!b.active) continue;
      b.age += dt;
      const frac = b.age / b.maxAge;
      if (frac >= 1) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }
      b.mat.opacity = 0.85 * (1 - frac);
    }
  }

  private spawnTracerBolt(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    toZ: number,
    hex: string,
  ): void {
    const bolt = this.bolts[this.boltCursor];
    this.boltCursor = (this.boltCursor + 1) % this.bolts.length;
    if (!bolt) return;

    this.tmpStart.set(fromX * 0.45, -this.halfH - 0.4, 5.5);
    this.tmpEnd.set(toX, toY, toZ);
    this.tmpDir.subVectors(this.tmpEnd, this.tmpStart);
    const len = Math.max(0.1, this.tmpDir.length());
    this.tmpDir.divideScalar(len);
    this.tmpMid.addVectors(this.tmpStart, this.tmpEnd).multiplyScalar(0.5);
    this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpDir);

    bolt.active = true;
    bolt.age = 0;
    bolt.mat.color.set(hex);
    bolt.mat.opacity = 0.9;
    bolt.mesh.position.copy(this.tmpMid);
    bolt.mesh.quaternion.copy(this.tmpQuat);
    bolt.mesh.scale.set(1, len, 1);
    bolt.mesh.visible = true;
  }

  onGesture(event: PlayerGestureEvent): void {
    if (this.ctx.getPhase() !== "playing" || this.roundFinished) return;

    const slot = event.slot;
    const reticle = this.reticles[slot];
    if (!reticle) return;

    const palette = PLAYER_SLOT_PALETTE[slot]!;

    // Reload on wrist flick, swing, or swipe / phone Reload tap
    if (event.kind === "flick" || event.kind === "swing" || event.kind === "swipe") {
      if ((this.reloadTimers[slot] ?? 0) <= 0 && (this.ammo[slot] ?? MAG_SIZE) < MAG_SIZE) {
        this.reloadTimers[slot] = RELOAD_DURATION_S;
        this.ctx.audio.play("reload_start");
        this.ctx.sendHaptic(slot, "tap");
        this.shockwaves.spawn(reticle.worldX, reticle.worldY, 0.4, palette.hex, 2.4, 0.25);
        this.syncAmmoHudSlot(slot);
      }
      return;
    }

    if (event.kind !== "tap" && event.kind !== "hold_start") return;

    // Ignore shots while reload cylinder is spinning
    if ((this.reloadTimers[slot] ?? 0) > 0) return;

    const currentAmmo = this.ammo[slot] ?? 0;
    if (currentAmmo <= 0) {
      this.ctx.audio.play("dry_fire");
      this.ctx.sendHaptic(slot, "error");
      this.ctx.hud.announce(`${this.getPlayerName(slot)}: Empty! Flick ↑ or tap Reload!`);
      reticle.recoil = 0.45;
      this.syncAmmoHudSlot(slot, "Empty! Flick ↑ to reload!");
      return;
    }

    this.ammo[slot] = currentAmmo - 1;
    reticle.recoil = 1.0;

    this.fireShot(slot, reticle.worldX, reticle.worldY, palette.hex);
    this.syncAmmoHudSlot(slot);
  }

  private fireShot(slot: number, rx: number, ry: number, colorHex: string): void {
    let bestTarget: TargetEntity | null = null;
    let bestNormDist = Infinity;

    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      if (!t.active || t.knockedDown || Math.abs(t.flipAngle) > 0.9) continue;

      const depthScale = (CAMERA_Z - t.laneZ) / CAMERA_Z;
      const aimAtZ_X = rx * depthScale;
      const aimAtZ_Y = ry * depthScale;
      const dist = Math.hypot(aimAtZ_X - t.x, aimAtZ_Y - t.y);
      const effectiveRadius = t.radius + 0.36 * depthScale;

      if (dist <= effectiveRadius) {
        const norm = dist / effectiveRadius;
        // Prefer bullseye/gold/runner targets slightly ahead of hazards on near-ties
        const tieBias = t.kind === "hazard" ? 0.15 : 0;
        if (norm + tieBias < bestNormDist) {
          bestNormDist = norm + tieBias;
          bestTarget = t;
        }
      }
    }

    const ammoAfter = this.ammo[slot] ?? 0;

    if (!bestTarget) {
      this.streaks[slot] = 0;
      this.comboTimers[slot] = 0;
      this.ctx.audio.play("shot");
      if (ammoAfter > 0 && ammoAfter <= 2) {
        this.ctx.audio.play("low_ammo");
      }
      this.ctx.sendHaptic(slot, "tap");
      this.spawnTracerBolt(rx, ry, rx, ry, -0.5, colorHex);
      this.particles.spawnBurst(rx, ry, -0.2, colorHex, 5, 2.8);
      if (ammoAfter === 0) {
        this.ctx.hud.announce(`${this.getPlayerName(slot)}: Out of ammo — flick ↑ to reload!`);
      }
      return;
    }

    bestTarget.knockedDown = true;
    bestTarget.knockTimer = 0;
    this.spawnTracerBolt(rx, ry, bestTarget.x, bestTarget.y, bestTarget.laneZ, colorHex);

    if (bestTarget.kind === "hazard") {
      this.streaks[slot] = 0;
      this.comboTimers[slot] = 0;
      this.scores[slot] = Math.max(0, (this.scores[slot] ?? 0) - 150);
      this.localShake = Math.min(1, this.localShake + 0.65);
      this.ctx.fx.addScreenShake(0.65);
      this.ctx.audio.play("hazard");
      this.ctx.sendHaptic(slot, "error");
      this.particles.spawnBurst(bestTarget.x, bestTarget.y, bestTarget.laneZ + 0.2, 0xff3b30, 18, 6.2);
      this.shockwaves.spawn(bestTarget.x, bestTarget.y, bestTarget.laneZ + 0.2, 0xff3b30, 3.8, 0.36);
      this.ctx.hud.announce(`${this.getPlayerName(slot)} hit hazard! -150`);
      this.syncScoreboardHud();
      return;
    }

    const depthScale = (CAMERA_Z - bestTarget.laneZ) / CAMERA_Z;
    const hitDist = Math.hypot(rx * depthScale - bestTarget.x, ry * depthScale - bestTarget.y);
    const isBullseye = hitDist <= bestTarget.radius * 0.46;

    const nextStreak = (this.streaks[slot] ?? 0) + 1;
    this.streaks[slot] = nextStreak;
    this.comboTimers[slot] = COMBO_WINDOW_S;

    const comboMult =
      nextStreak >= 7 ? 3.0 : nextStreak >= 4 ? 2.0 : nextStreak >= 2 ? 1.5 : 1.0;
    const feverMult = ROUND_DURATION_MS - this.roundElapsedMs <= 5000 ? 2.0 : 1.0;

    const basePts =
      bestTarget.kind === "gold"
        ? 300
        : bestTarget.kind === "runner"
          ? isBullseye
            ? 225
            : 150
          : isBullseye
            ? 150
            : 100;

    const totalPts = Math.round(basePts * comboMult * feverMult * this.tuning.scoreMult);
    this.scores[slot] = (this.scores[slot] ?? 0) + totalPts;

    const burstColor = bestTarget.kind === "gold" ? 0xffd028 : colorHex;
    const burstCount = bestTarget.kind === "gold" ? 28 : isBullseye ? 22 : 16;
    this.particles.spawnBurst(
      bestTarget.x,
      bestTarget.y,
      bestTarget.laneZ + 0.2,
      burstColor,
      burstCount,
      bestTarget.kind === "gold" ? 8.2 : 6.4,
    );
    this.shockwaves.spawn(
      bestTarget.x,
      bestTarget.y,
      bestTarget.laneZ + 0.2,
      burstColor,
      bestTarget.kind === "gold" ? 5.0 : 3.4,
      0.34,
    );

    if (bestTarget.kind === "gold") {
      this.localShake = Math.min(1, this.localShake + 0.55);
      this.ctx.fx.addScreenShake(0.45);
      this.ctx.fx.triggerHitStop(26);
      this.ctx.audio.play("gold_hit");
      this.ctx.sendHaptic(slot, "combo");
      this.ctx.hud.announce(`${this.getPlayerName(slot)} GOLD +${totalPts}!`);
    } else if (nextStreak >= 3) {
      this.localShake = Math.min(1, this.localShake + 0.35);
      this.ctx.fx.addScreenShake(0.28);
      this.ctx.audio.play("combo");
      this.ctx.sendHaptic(slot, "combo");
      this.ctx.hud.announce(
        `${this.getPlayerName(slot)} ×${nextStreak} (${comboMult.toFixed(1)}×) +${totalPts}`,
      );
    } else if (isBullseye) {
      this.localShake = Math.min(1, this.localShake + 0.28);
      this.ctx.fx.addScreenShake(0.22);
      this.ctx.audio.play("bullseye");
      this.ctx.sendHaptic(slot, "hit");
      this.ctx.hud.announce(`${this.getPlayerName(slot)} BULLSEYE +${totalPts}!`);
    } else {
      this.localShake = Math.min(1, this.localShake + 0.24);
      this.ctx.fx.addScreenShake(0.18);
      this.ctx.audio.play("hit");
      this.ctx.sendHaptic(slot, "hit");
    }

    if (ammoAfter > 0 && ammoAfter <= 2) {
      this.ctx.audio.play("low_ammo");
    }
    if (ammoAfter === 0) {
      this.ctx.hud.announce(`${this.getPlayerName(slot)}: Empty — flick ↑ to reload!`);
    }

    this.syncScoreboardHud();
  }

  private finishGame(): void {
    if (this.roundFinished) return;
    this.roundFinished = true;
    this.ctx.audio.stopMusic?.();
    this.ctx.audio.play("end");
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

  private buildAmmoSnapshot(slot: number, explicitPrompt?: string) {
    const ammo = this.ammo[slot] ?? MAG_SIZE;
    const reloading = (this.reloadTimers[slot] ?? 0) > 0;
    const streak = this.streaks[slot] ?? 0;
    let prompt = explicitPrompt;
    if (!prompt) {
      if (reloading) prompt = "Reloading…";
      else if (ammo === 0) prompt = "Empty! Flick ↑ or tap Reload";
      else if (ammo <= 2) prompt = `${ammo} shot${ammo === 1 ? "" : "s"} left`;
    }
    return { ammo, maxAmmo: MAG_SIZE, reloading, streak, prompt };
  }

  private syncAmmoHudAll(): void {
    const rows = this.ctx.players.map((p) => {
      const snap = this.buildAmmoSnapshot(p.slot);
      this.ctx.sendPadHud?.(p.slot, {
        ammo: snap.ammo,
        maxAmmo: snap.maxAmmo,
        reloading: snap.reloading,
        streak: snap.streak,
        ...(snap.prompt ? { prompt: snap.prompt } : {}),
      });
      return {
        slot: p.slot,
        ammo: snap.ammo,
        maxAmmo: snap.maxAmmo,
        reloading: snap.reloading,
        streak: snap.streak,
      };
    });
    this.ctx.hud.setPlayerAmmoHud?.(rows);
  }

  private syncAmmoHudSlot(slot: number, explicitPrompt?: string): void {
    const snap = this.buildAmmoSnapshot(slot, explicitPrompt);
    this.ctx.sendPadHud?.(slot, {
      ammo: snap.ammo,
      maxAmmo: snap.maxAmmo,
      reloading: snap.reloading,
      streak: snap.streak,
      ...(snap.prompt ? { prompt: snap.prompt } : {}),
    });
    const rows = this.ctx.players.map((p) => {
      const s = p.slot === slot ? snap : this.buildAmmoSnapshot(p.slot);
      return {
        slot: p.slot,
        ammo: s.ammo,
        maxAmmo: s.maxAmmo,
        reloading: s.reloading,
        streak: s.streak,
      };
    });
    this.ctx.hud.setPlayerAmmoHud?.(rows);
  }

  render(alpha: number): void {
    for (let slot = 0; slot < this.reticles.length; slot++) {
      const r = this.reticles[slot]!;
      r.group.visible = r.connected;
      if (!r.connected) continue;

      const rx = r.prevWorldX + (r.worldX - r.prevWorldX) * alpha;
      const ry = r.prevWorldY + (r.worldY - r.prevWorldY) * alpha;
      const rRoll = r.prevRollRad + (r.rollRad - r.prevRollRad) * alpha;

      r.group.position.set(rx, ry, 0.55 + slot * 0.02);
      r.bracketGroup.rotation.z = -rRoll;
      const kickScale = (r.primaryDown ? 0.8 : 1.0) + r.recoil * 0.28;
      r.triggerRing.scale.setScalar(kickScale);

      const ammoCount = this.ammo[slot] ?? MAG_SIZE;
      const reloadingRem = this.reloadTimers[slot] ?? 0;
      const isLowAmmo = ammoCount > 0 && ammoCount <= 2 && reloadingRem <= 0;

      // Spin orbital ammo cylinder smoothly while reloading
      r.pipRingGroup.rotation.z =
        reloadingRem > 0 ? ((RELOAD_DURATION_S - reloadingRem) / RELOAD_DURATION_S) * Math.PI * 2 : 0;

      for (let p = 0; p < r.pips.length; p++) {
        const filled = reloadingRem > 0 || p < ammoCount;
        r.pips[p]!.scale.setScalar(filled ? 1.0 : 0.58);
        r.pipMats[p]!.opacity = filled ? 0.95 : 0.16;
        r.pipMats[p]!.color.setHex(
          reloadingRem > 0 ? 0x19d3ff : isLowAmmo && filled ? 0xffb800 : r.paletteHexNum,
        );
      }

      if (reloadingRem > 0) {
        r.emptyWarnMat.opacity = 0;
        r.promptSprite.visible = true;
        r.promptMat.map = this.reloadingTex;
        r.promptSprite.position.y = 0.94;
      } else if (ammoCount === 0) {
        r.emptyWarnMat.opacity = 0.45 + 0.45 * Math.sin(this.simTime * 10);
        r.promptSprite.visible = true;
        r.promptMat.map = this.reloadPromptTex;
        r.promptSprite.position.y = 0.94 + Math.abs(Math.sin(this.simTime * 6)) * 0.14;
      } else {
        r.emptyWarnMat.opacity = 0;
        r.promptSprite.visible = false;
      }
    }

    for (let i = 0; i < this.targets.length; i++) {
      const t = this.targets[i]!;
      if (!t.active) continue;

      const tx = t.prevX + (t.x - t.prevX) * alpha;
      const ty = t.prevY + (t.y - t.prevY) * alpha;
      const flip = t.prevFlipAngle + (t.flipAngle - t.prevFlipAngle) * alpha;

      t.root.position.set(tx, ty, t.laneZ);
      if (t.railMesh.visible) {
        // Keep rail track fixed at baseX while target slides along it!
        t.railMesh.position.x = t.baseX - tx;
      }
      t.hinge.rotation.x = flip;
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
    this.detachThemeObserver?.();
    this.detachThemeObserver = null;

    if (this.floorGrid) {
      this.floorGrid.geometry.dispose();
      const mat = this.floorGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.floorGrid = null;
    }
    if (this.backGrid) {
      this.backGrid.geometry.dispose();
      const mat = this.backGrid.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
      this.backGrid = null;
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
