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
const MAX_FRUITS = 14;
const SPLIT_POOL_SIZE = 28;
const FLASH_POOL_SIZE = 10;
const TRAIL_POINTS = 14;
const COMBO_WINDOW_S = 0.28;

type EntityKind = "watermelon" | "orange" | "kiwi" | "pineapple" | "starfruit" | "bomb";

interface FruitStyle {
  radius: number;
  basePts: number;
  rindHex: number;
  fleshHex: number;
  juiceHex: number;
}

const FRUIT_STYLES: Record<EntityKind, FruitStyle> = {
  watermelon: {
    radius: 0.9,
    basePts: 100,
    rindHex: 0x16a34a,
    fleshHex: 0xff3b5c,
    juiceHex: 0xff4966,
  },
  orange: {
    radius: 0.68,
    basePts: 120,
    rindHex: 0xf97316,
    fleshHex: 0xfdba74,
    juiceHex: 0xff8a1e,
  },
  kiwi: {
    radius: 0.6,
    basePts: 140,
    rindHex: 0x84cc16,
    fleshHex: 0xbef264,
    juiceHex: 0xa3e635,
  },
  pineapple: {
    radius: 0.78,
    basePts: 180,
    rindHex: 0xeab308,
    fleshHex: 0xfef08a,
    juiceHex: 0xfacc15,
  },
  starfruit: {
    radius: 0.74,
    basePts: 300,
    rindHex: 0xffd028,
    fleshHex: 0xfff8b3,
    juiceHex: 0xffe066,
  },
  bomb: {
    radius: 0.76,
    basePts: -200,
    rindHex: 0x1f2430,
    fleshHex: 0xff3b30,
    juiceHex: 0xff3b30,
  },
};

interface DifficultyConfig {
  gravity: number;
  waveCounts: readonly [number, number, number];
  waveIntervals: readonly [number, number, number];
  wave2Sec: number;
  wave3Sec: number;
  bombUnlockSec: number;
  bombChance: number;
  scaleMult: number;
  scoreMult: number;
  musicBpm: number;
}

const DIFFICULTY_TUNING: Record<DifficultyPreset, DifficultyConfig> = {
  casual: {
    gravity: 8.8,
    waveCounts: [3, 4, 5],
    waveIntervals: [1.85, 1.55, 1.3],
    wave2Sec: 18,
    wave3Sec: 38,
    bombUnlockSec: 14,
    bombChance: 0.09,
    scaleMult: 1.12,
    scoreMult: 1.0,
    musicBpm: 120,
  },
  arcade: {
    gravity: 11.2,
    waveCounts: [3, 5, 6],
    waveIntervals: [1.55, 1.25, 0.98],
    wave2Sec: 15,
    wave3Sec: 35,
    bombUnlockSec: 10,
    bombChance: 0.15,
    scaleMult: 1.0,
    scoreMult: 1.0,
    musicBpm: 132,
  },
  pro: {
    gravity: 13.6,
    waveCounts: [4, 6, 8],
    waveIntervals: [1.25, 0.95, 0.74],
    wave2Sec: 11,
    wave3Sec: 27,
    bombUnlockSec: 7,
    bombChance: 0.21,
    scaleMult: 0.92,
    scoreMult: 1.25,
    musicBpm: 144,
  },
};

interface BladeSlot {
  group: THREE.Group;
  ringMesh: THREE.Mesh;
  coreMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  coreMat: THREE.MeshBasicMaterial;
  trailMesh: THREE.Mesh;
  trailMat: THREE.MeshBasicMaterial;
  trailGeo: THREE.BufferGeometry;
  trailPositions: Float32Array;
  histX: Float32Array;
  histY: Float32Array;
  worldX: number;
  worldY: number;
  prevWorldX: number;
  prevWorldY: number;
  rollRad: number;
  connected: boolean;
  primaryDown: boolean;
  bladeHot: boolean;
  whooshCooldown: number;
}

interface TossedEntity {
  active: boolean;
  kind: EntityKind;
  root: THREE.Group;
  variants: Record<EntityKind, THREE.Group>;
  bombWarnMat: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  spinX: number;
  spinY: number;
  radius: number;
  spawnGraceS: number;
}

interface SlicedHalf {
  active: boolean;
  group: THREE.Group;
  shellMat: THREE.MeshToonMaterial;
  fleshMat: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotZ: number;
  spinX: number;
  spinZ: number;
  age: number;
  scale: number;
}

interface SlashFlash {
  active: boolean;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  maxAge: number;
}

export class FruitSlicerGame implements GamePlugin {
  readonly id = "fruit-slicer" as const;

  private ctx!: GameHostContext;
  private rng!: () => number;
  private canvas!: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private toonGradient!: THREE.DataTexture;
  private tuning: DifficultyConfig = DIFFICULTY_TUNING.arcade;

  private halfH = Math.tan(THREE.MathUtils.degToRad(FOV_DEG / 2)) * CAMERA_Z;
  private halfW = this.halfH * (16 / 9);

  private simTime = 0;
  private roundElapsedMs = 0;
  private waveTimer = 0;
  private currentWave = 1;
  private frenzyTimer = 0;
  private frenzyBurstTimer = 0;
  private starCooldown = 8;
  private tutorialHidden = false;
  private feverAnnounced = false;
  private musicStarted = false;
  private roundFinished = false;
  private localShake = 0;
  private flashTimer = 0;

  private floorGrid: THREE.GridHelper | null = null;
  private backGrid: THREE.GridHelper | null = null;
  private backdropMats: THREE.MeshToonMaterial[] = [];
  private darkBgColor = new THREE.Color(0x0d1017);
  private lightBgColor = new THREE.Color(0xeef3f9);
  private activeBgColor = new THREE.Color(0x0d1017);
  private bombFlashColor = new THREE.Color(0x4a0f12);

  private blades: BladeSlot[] = [];
  private entities: TossedEntity[] = [];
  private halves: SlicedHalf[] = [];
  private halfCursor = 0;
  private flashes: SlashFlash[] = [];
  private flashCursor = 0;

  private particles!: ArcadeParticlePool;
  private shockwaves!: ArcadeShockwavePool;

  // Zero-allocation per-player scoring & combo state
  private readonly scores = new Int32Array(MAX_PLAYERS);
  private readonly comboCounts = new Int32Array(MAX_PLAYERS);
  private readonly comboTimers = new Float32Array(MAX_PLAYERS);
  private readonly comboLastX = new Float32Array(MAX_PLAYERS);
  private readonly comboLastY = new Float32Array(MAX_PLAYERS);
  private readonly swipeFlashCooldown = new Float32Array(MAX_PLAYERS);

  private readonly disposables: Array<{ dispose(): void }> = [];
  private detachThemeObserver: (() => void) | null = null;

  init(ctx: GameHostContext): void {
    this.ctx = ctx;
    this.tuning = DIFFICULTY_TUNING[ctx.difficulty] ?? DIFFICULTY_TUNING.arcade;
    this.rng = createSeededRng(ctx.seed);

    this.scores.fill(0);
    this.comboCounts.fill(0);
    this.comboTimers.fill(0);
    this.swipeFlashCooldown.fill(0);

    this.simTime = 0;
    this.roundElapsedMs = 0;
    this.waveTimer = 0.25;
    this.currentWave = 1;
    this.frenzyTimer = 0;
    this.frenzyBurstTimer = 0;
    this.starCooldown = 8.5;
    this.tutorialHidden = false;
    this.feverAnnounced = false;
    this.musicStarted = false;
    this.roundFinished = false;
    this.localShake = 0;
    this.flashTimer = 0;

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

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2b3345, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(5, 11, 12);
    this.scene.add(hemi, key);

    this.buildDojoBackdrop();
    this.buildEntityPool();
    this.buildSplitHalfPool();
    this.buildSlashFlashPool();
    this.buildBladeSlots();
    this.particles = new ArcadeParticlePool(this.scene, 260, 0.12);
    this.shockwaves = new ArcadeShockwavePool(this.scene, 14);

    this.detachThemeObserver = observeThemeScheme((scheme) => this.applyThemePalette(scheme));
    this.onResize(width, height, Math.min(window.devicePixelRatio || 1, 2));

    const diffLabel =
      ctx.difficulty === "casual"
        ? "Chill"
        : ctx.difficulty === "pro"
          ? "Turbo (1.25×)"
          : "Arcade";

    this.ctx.hud.setRoundTimer(ROUND_DURATION_MS);
    this.ctx.hud.setTutorialVisible(true, [
      `Difficulty: ${diffLabel} · Sweep phone swiftly OR swipe pad to slice`,
      "Cut 3+ fruits together for Combo Multipliers",
      "Golden Starfruit = Frenzy Cascade · Dodge red Bombs (-200)",
    ]);
    this.syncScoreboardHud();
    this.ctx.sendPadHud?.("all", {
      ammo: 6,
      maxAmmo: 6,
      reloading: false,
      streak: 0,
      prompt: "Sweep phone or swipe to slice!",
    });
  }

  private buildDojoBackdrop(): void {
    const pillarGeo = new THREE.BoxGeometry(0.9, 13, 1.1);
    const railGeo = new THREE.BoxGeometry(24, 0.36, 0.4);
    this.disposables.push(pillarGeo, railGeo);

    const slatMat = new THREE.MeshToonMaterial({ color: 0x222938, gradientMap: this.toonGradient });
    const railMat = new THREE.MeshToonMaterial({ color: 0x2c364b, gradientMap: this.toonGradient });
    this.backdropMats.push(slatMat, railMat);
    this.disposables.push(slatMat, railMat);

    const leftPost = new THREE.Mesh(pillarGeo, slatMat);
    leftPost.position.set(-10.8, 0, -4.5);
    const rightPost = new THREE.Mesh(pillarGeo, slatMat);
    rightPost.position.set(10.8, 0, -4.5);
    const topBeam = new THREE.Mesh(railGeo, railMat);
    topBeam.position.set(0, 5.4, -5.2);

    this.scene.add(leftPost, rightPost, topBeam);
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

    const major = scheme === "dark" ? 0x2c384d : 0xa5b4cb;
    const minor = scheme === "dark" ? 0x181f2c : 0xd5dfed;

    const floor = new THREE.GridHelper(34, 22, major, minor);
    floor.position.set(0, -5.1, -3.0);
    this.scene.add(floor);
    this.floorGrid = floor;

    const back = new THREE.GridHelper(34, 18, major, minor);
    back.rotation.x = Math.PI / 2;
    back.position.set(0, 0, -7.8);
    this.scene.add(back);
    this.backGrid = back;
  }

  private buildEntityPool(): void {
    const melonGeo = new THREE.IcosahedronGeometry(0.84, 1);
    const bandGeo = new THREE.TorusGeometry(0.85, 0.08, 6, 18);
    const orangeGeo = new THREE.DodecahedronGeometry(0.65, 1);
    const stemGeo = new THREE.ConeGeometry(0.14, 0.28, 6);
    const kiwiGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.68, 12);
    const pineGeo = new THREE.CylinderGeometry(0.6, 0.66, 1.05, 8);
    const crownGeo = new THREE.ConeGeometry(0.42, 0.62, 6);
    const starGeo = new THREE.OctahedronGeometry(0.68, 0);
    const starHaloGeo = new THREE.TorusGeometry(0.92, 0.06, 8, 22);
    const bombGeo = new THREE.DodecahedronGeometry(0.7, 0);
    const fuseGeo = new THREE.CylinderGeometry(0.14, 0.18, 0.28, 8);
    const sparkGeo = new THREE.OctahedronGeometry(0.17, 0);
    const xBarGeo = new THREE.BoxGeometry(0.86, 0.16, 0.14);
    const warnRingGeo = new THREE.RingGeometry(0.86, 0.98, 24);

    const greenMat = new THREE.MeshToonMaterial({ color: 0x16a34a, gradientMap: this.toonGradient });
    const darkGreenMat = new THREE.MeshToonMaterial({ color: 0x14532d, gradientMap: this.toonGradient });
    const orangeMat = new THREE.MeshToonMaterial({ color: 0xf97316, gradientMap: this.toonGradient });
    const limeMat = new THREE.MeshToonMaterial({ color: 0x84cc16, gradientMap: this.toonGradient });
    const pineMat = new THREE.MeshToonMaterial({ color: 0xeab308, gradientMap: this.toonGradient });
    const tealLeafMat = new THREE.MeshToonMaterial({ color: 0x10b981, gradientMap: this.toonGradient });
    const goldMat = new THREE.MeshToonMaterial({ color: 0xffd028, gradientMap: this.toonGradient });
    const creamMat = new THREE.MeshBasicMaterial({ color: 0xfff8dc });
    const bombBodyMat = new THREE.MeshToonMaterial({ color: 0x1c212c, gradientMap: this.toonGradient });
    const bombAccentMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffb800 });

    this.disposables.push(
      melonGeo,
      bandGeo,
      orangeGeo,
      stemGeo,
      kiwiGeo,
      pineGeo,
      crownGeo,
      starGeo,
      starHaloGeo,
      bombGeo,
      fuseGeo,
      sparkGeo,
      xBarGeo,
      warnRingGeo,
      greenMat,
      darkGreenMat,
      orangeMat,
      limeMat,
      pineMat,
      tealLeafMat,
      goldMat,
      creamMat,
      bombBodyMat,
      bombAccentMat,
      sparkMat,
    );

    for (let i = 0; i < MAX_FRUITS; i++) {
      const root = new THREE.Group();
      root.visible = false;

      // Watermelon
      const gMelon = new THREE.Group();
      const mBody = new THREE.Mesh(melonGeo, greenMat);
      const mStripe1 = new THREE.Mesh(bandGeo, darkGreenMat);
      mStripe1.rotation.y = Math.PI / 2;
      gMelon.add(mBody, mStripe1);

      // Orange
      const gOrange = new THREE.Group();
      const oBody = new THREE.Mesh(orangeGeo, orangeMat);
      const oStem = new THREE.Mesh(stemGeo, tealLeafMat);
      oStem.position.y = 0.68;
      gOrange.add(oBody, oStem);

      // Kiwi
      const gKiwi = new THREE.Group();
      const kBody = new THREE.Mesh(kiwiGeo, limeMat);
      kBody.rotation.z = Math.PI / 2;
      gKiwi.add(kBody);

      // Pineapple
      const gPine = new THREE.Group();
      const pBody = new THREE.Mesh(pineGeo, pineMat);
      const pCrown = new THREE.Mesh(crownGeo, tealLeafMat);
      pCrown.position.y = 0.78;
      gPine.add(pBody, pCrown);

      // Starfruit (Bonus Frenzy)
      const gStar = new THREE.Group();
      const sCore = new THREE.Mesh(starGeo, goldMat);
      const sHalo = new THREE.Mesh(starHaloGeo, creamMat);
      gStar.add(sCore, sHalo);

      // Bomb
      const gBomb = new THREE.Group();
      const bBody = new THREE.Mesh(bombGeo, bombBodyMat);
      const bFuse = new THREE.Mesh(fuseGeo, bombBodyMat);
      bFuse.position.set(0.28, 0.72, 0);
      bFuse.rotation.z = -0.35;
      const bSpark = new THREE.Mesh(sparkGeo, sparkMat);
      bSpark.position.set(0.38, 0.92, 0);
      const bx1 = new THREE.Mesh(xBarGeo, bombAccentMat);
      bx1.position.z = 0.68;
      bx1.rotation.z = Math.PI / 4;
      const bx2 = new THREE.Mesh(xBarGeo, bombAccentMat);
      bx2.position.z = 0.68;
      bx2.rotation.z = -Math.PI / 4;
      const bombWarnMat = new THREE.MeshBasicMaterial({
        color: 0xff3b30,
        transparent: true,
        opacity: 0.75,
        side: THREE.DoubleSide,
      });
      this.disposables.push(bombWarnMat);
      const warnRing = new THREE.Mesh(warnRingGeo, bombWarnMat);
      warnRing.position.z = -0.15;
      gBomb.add(bBody, bFuse, bSpark, bx1, bx2, warnRing);

      root.add(gMelon, gOrange, gKiwi, gPine, gStar, gBomb);
      this.scene.add(root);

      this.entities.push({
        active: false,
        kind: "watermelon",
        root,
        variants: {
          watermelon: gMelon,
          orange: gOrange,
          kiwi: gKiwi,
          pineapple: gPine,
          starfruit: gStar,
          bomb: gBomb,
        },
        bombWarnMat,
        x: 0,
        y: 0,
        z: 0,
        prevX: 0,
        prevY: 0,
        vx: 0,
        vy: 0,
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        spinX: 0,
        spinY: 0,
        radius: 0.8,
        spawnGraceS: 0,
      });
    }
  }

  private buildSplitHalfPool(): void {
    const domeGeo = new THREE.SphereGeometry(0.68, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const capGeo = new THREE.CircleGeometry(0.68, 12);
    capGeo.rotateX(Math.PI / 2);
    this.disposables.push(domeGeo, capGeo);

    for (let i = 0; i < SPLIT_POOL_SIZE; i++) {
      const group = new THREE.Group();
      group.visible = false;

      const shellMat = new THREE.MeshToonMaterial({ color: 0x16a34a, gradientMap: this.toonGradient });
      const fleshMat = new THREE.MeshBasicMaterial({
        color: 0xff3b5c,
        side: THREE.DoubleSide,
      });
      this.disposables.push(shellMat, fleshMat);

      const dome = new THREE.Mesh(domeGeo, shellMat);
      const cap = new THREE.Mesh(capGeo, fleshMat);
      group.add(dome, cap);
      this.scene.add(group);

      this.halves.push({
        active: false,
        group,
        shellMat,
        fleshMat,
        x: 0,
        y: 0,
        z: 0,
        prevX: 0,
        prevY: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: 0,
        rotZ: 0,
        spinX: 0,
        spinZ: 0,
        age: 0,
        scale: 1,
      });
    }
  }

  private buildSlashFlashPool(): void {
    const slashGeo = new THREE.PlaneGeometry(1, 0.16);
    this.disposables.push(slashGeo);

    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(slashGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.flashes.push({
        active: false,
        mesh,
        mat,
        age: 0,
        maxAge: 0.16,
      });
    }
  }

  private buildBladeSlots(): void {
    const ringGeo = new THREE.RingGeometry(0.22, 0.3, 24);
    const coreGeo = new THREE.CircleGeometry(0.11, 16);
    this.disposables.push(ringGeo, coreGeo);

    // Pre-build triangle-strip index buffer for TRAIL_POINTS pairs
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const palette = PLAYER_SLOT_PALETTE[slot]!;
      const group = new THREE.Group();
      group.visible = false;

      const ringMat = new THREE.MeshBasicMaterial({
        color: palette.hex,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      });
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
      });
      const trailMat = new THREE.MeshBasicMaterial({
        color: palette.hex,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const trailPositions = new Float32Array(TRAIL_POINTS * 2 * 3);
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
      trailGeo.setIndex(indices);

      this.disposables.push(ringMat, coreMat, trailMat, trailGeo);

      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      const trailMesh = new THREE.Mesh(trailGeo, trailMat);
      trailMesh.frustumCulled = false;

      group.add(ringMesh, coreMesh);
      this.scene.add(group, trailMesh);

      this.blades.push({
        group,
        ringMesh,
        coreMesh,
        ringMat,
        coreMat,
        trailMesh,
        trailMat,
        trailGeo,
        trailPositions,
        histX: new Float32Array(TRAIL_POINTS),
        histY: new Float32Array(TRAIL_POINTS),
        worldX: 0,
        worldY: 0,
        prevWorldX: 0,
        prevWorldY: 0,
        rollRad: 0,
        connected: false,
        primaryDown: false,
        bladeHot: false,
        whooshCooldown: 0,
      });
    }
  }

  private applyThemePalette(scheme: "dark" | "light"): void {
    this.darkBgColor.setHex(0x0d1017);
    this.lightBgColor.setHex(0xeef3f9);
    this.activeBgColor.copy(scheme === "dark" ? this.darkBgColor : this.lightBgColor);
    this.scene.background = this.activeBgColor.clone();
    this.rebuildGrids(scheme);

    const slatHex = scheme === "dark" ? 0x202736 : 0xc6d2e4;
    for (const m of this.backdropMats) {
      m.color.setHex(slatHex);
    }
  }

  update(dt: number, inputs: readonly PlayerAimFrame[]): void {
    this.simTime += dt;
    this.localShake = Math.max(0, this.localShake - dt * 3.8);
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    }

    const safeHalfW = Math.max(2.6, this.halfW - 0.55);
    const safeHalfH = Math.max(1.8, this.halfH - 0.45);
    const isLive = this.ctx.getPhase() === "playing" && !this.roundFinished;

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = inputs[slot];
      const blade = this.blades[slot];
      if (!frame || !blade) continue;

      const nextX = frame.cursorX * safeHalfW;
      const nextY = frame.cursorY * safeHalfH;
      const wasConnected = blade.connected;

      blade.prevWorldX = wasConnected ? blade.worldX : nextX;
      blade.prevWorldY = wasConnected ? blade.worldY : nextY;
      blade.worldX = nextX;
      blade.worldY = nextY;
      blade.rollRad = frame.rollRad;
      blade.connected = frame.connected;
      blade.primaryDown = frame.primaryDown;
      blade.whooshCooldown = Math.max(0, blade.whooshCooldown - dt);
      this.swipeFlashCooldown[slot] = Math.max(0, (this.swipeFlashCooldown[slot] ?? 0) - dt);

      if (!wasConnected && frame.connected) {
        blade.histX.fill(nextX);
        blade.histY.fill(nextY);
      } else if (frame.connected) {
        // Shift ring trail history forward cleanly with zero allocations
        for (let i = 0; i < TRAIL_POINTS - 1; i++) {
          blade.histX[i] = blade.histX[i + 1]!;
          blade.histY[i] = blade.histY[i + 1]!;
        }
        blade.histX[TRAIL_POINTS - 1] = nextX;
        blade.histY[TRAIL_POINTS - 1] = nextY;
      }

      const dist = Math.hypot(nextX - blade.prevWorldX, nextY - blade.prevWorldY);
      const speed = dist / Math.max(0.001, dt);
      blade.bladeHot = frame.connected && (frame.primaryDown ? speed >= 0.75 : speed >= 3.2 || frame.angVelMag >= 2.2);

      // Update combo chain window
      if ((this.comboTimers[slot] ?? 0) > 0) {
        const nextT = Math.max(0, (this.comboTimers[slot] ?? 0) - dt);
        this.comboTimers[slot] = nextT;
        if (nextT === 0) {
          this.flushComboBonus(slot);
        }
      }

      if (isLive && blade.bladeHot && dist > 0.04) {
        if (speed >= 8.2 && blade.whooshCooldown <= 0) {
          blade.whooshCooldown = 0.2;
          this.ctx.audio.play("swipe");
        }
        this.sliceAlongSegment(slot, blade.prevWorldX, blade.prevWorldY, nextX, nextY, true);
      }
    }

    if (isLive) {
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
        this.ctx.hud.announce("FINAL 5 SECONDS · 2× SLICE POINTS!");
      }

      if (remainingMs <= 0) {
        this.finishGame();
      } else {
        this.stepFruitDirector(dt);
      }
    }

    this.updateEntities(dt);
    this.updateHalves(dt);
    this.updateFlashes(dt);
    this.particles.update(dt);
    this.shockwaves.update(dt);
  }

  private stepFruitDirector(dt: number): void {
    const elapsedSec = this.roundElapsedMs / 1000;
    const nextWave =
      elapsedSec < this.tuning.wave2Sec ? 1 : elapsedSec < this.tuning.wave3Sec ? 2 : 3;
    if (nextWave > this.currentWave) {
      this.currentWave = nextWave;
      this.ctx.hud.announce(
        nextWave === 2 ? "Wave 2 · Double Toss & Bombs!" : "Wave 3 · Ninja Cascade!",
      );
    }

    this.starCooldown -= dt;

    if (this.frenzyTimer > 0) {
      this.frenzyTimer = Math.max(0, this.frenzyTimer - dt);
      this.frenzyBurstTimer -= dt;
      if (this.frenzyBurstTimer <= 0) {
        this.frenzyBurstTimer = 0.34;
        this.spawnToss("fruit", elapsedSec, true);
      }
      return;
    }

    this.waveTimer -= dt;
    if (this.waveTimer <= 0) {
      this.waveTimer = this.tuning.waveIntervals[nextWave - 1] ?? 1.25;
      const tossCount = this.tuning.waveCounts[nextWave - 1] ?? 4;
      const count = Math.max(2, tossCount - (this.rng() < 0.35 ? 1 : 0));

      for (let i = 0; i < count; i++) {
        if (this.starCooldown <= 0 && elapsedSec > 8) {
          this.starCooldown = 14 + this.rng() * 5;
          this.spawnToss("starfruit", elapsedSec, false);
        } else {
          const canBomb = elapsedSec >= this.tuning.bombUnlockSec;
          const isBomb = canBomb && this.rng() < this.tuning.bombChance;
          this.spawnToss(isBomb ? "bomb" : "fruit", elapsedSec, false);
        }
      }
    }
  }

  private spawnToss(mode: "fruit" | "bomb" | "starfruit", elapsedSec: number, isFrenzy: boolean): void {
    let slot: TossedEntity | null = null;
    for (let i = 0; i < this.entities.length; i++) {
      if (!this.entities[i]!.active) {
        slot = this.entities[i]!;
        break;
      }
    }
    if (!slot) return;

    let kind: EntityKind = "watermelon";
    if (mode === "bomb") {
      kind = "bomb";
    } else if (mode === "starfruit") {
      kind = "starfruit";
    } else {
      const r = this.rng();
      if (r < 0.3) kind = "watermelon";
      else if (r < 0.58) kind = "orange";
      else if (r < 0.82) kind = "kiwi";
      else kind = "pineapple";
    }

    const spanX = Math.max(2.0, this.halfW - 1.35);
    const startX = isFrenzy
      ? (this.rng() < 0.5 ? -1 : 1) * (spanX * (0.45 + this.rng() * 0.45))
      : (this.rng() * 2 - 1) * spanX * 0.84;
    const startY = -this.halfH - 1.1;

    // Aim horizontal velocity gently toward arena center so fruits cross in view
    const biasInward = -Math.sign(startX) * (0.65 + this.rng() * 1.9);
    const vx = Math.abs(startX) > 1.2 ? biasInward : (this.rng() * 2 - 1) * 1.8;

    const progress = clamp(elapsedSec / 60, 0, 1);
    const heightMinFrac = 0.25 + progress * 0.1;
    const heightMaxFrac = 0.78;
    const peakY = this.halfH * (heightMinFrac + this.rng() * (heightMaxFrac - heightMinFrac));
    const rise = Math.max(2.0, peakY - startY);
    const vy = Math.sqrt(2 * this.tuning.gravity * rise);

    const style = FRUIT_STYLES[kind];
    slot.active = true;
    slot.kind = kind;
    slot.x = startX;
    slot.y = startY;
    slot.prevX = startX;
    slot.prevY = startY;
    slot.z = kind === "bomb" ? 0.2 : (this.rng() - 0.5) * 0.6;
    slot.vx = vx;
    slot.vy = vy;
    slot.rotX = this.rng() * Math.PI;
    slot.rotY = this.rng() * Math.PI;
    slot.rotZ = this.rng() * Math.PI;
    slot.spinX = (this.rng() * 2 - 1) * 3.2;
    slot.spinY = (this.rng() * 2 - 1) * 3.8;
    slot.radius = style.radius * this.tuning.scaleMult * (kind === "bomb" ? 0.84 : 1.04);
    slot.spawnGraceS = 0.12;

    (Object.keys(slot.variants) as EntityKind[]).forEach((k) => {
      const grp = slot!.variants[k];
      grp.visible = k === kind;
      if (k === kind) {
        grp.scale.setScalar(this.tuning.scaleMult);
      }
    });

    slot.root.position.set(startX, startY, slot.z);
    slot.root.visible = true;

    if (kind === "bomb") {
      this.ctx.audio.play("bomb_fuse");
    } else if (kind === "starfruit") {
      this.ctx.audio.play("gold_spawn");
      this.ctx.hud.announce("GOLDEN STARFRUIT! Slice it for Frenzy!");
    } else {
      this.ctx.audio.play("pop");
    }
  }

  private updateEntities(dt: number): void {
    const cullY = -this.halfH - 2.2;
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i]!;
      if (!e.active) continue;

      e.prevX = e.x;
      e.prevY = e.y;
      if (e.spawnGraceS > 0) {
        e.spawnGraceS = Math.max(0, e.spawnGraceS - dt);
      }

      e.vy -= this.tuning.gravity * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.rotX += e.spinX * dt;
      e.rotY += e.spinY * dt;

      if (e.kind === "bomb") {
        e.bombWarnMat.opacity = 0.45 + 0.4 * Math.sin(this.simTime * 11);
      }

      if (e.vy < 0 && e.y < cullY) {
        e.active = false;
        e.root.visible = false;
      }
    }
  }

  private updateHalves(dt: number): void {
    const cullY = -this.halfH - 2.4;
    for (let i = 0; i < this.halves.length; i++) {
      const h = this.halves[i]!;
      if (!h.active) continue;

      h.prevX = h.x;
      h.prevY = h.y;
      h.age += dt;
      h.vy -= this.tuning.gravity * 1.15 * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.z += h.vz * dt;
      h.rotX += h.spinX * dt;
      h.rotZ += h.spinZ * dt;

      if (h.y < cullY || h.age > 2.4) {
        h.active = false;
        h.group.visible = false;
      }
    }
  }

  private updateFlashes(dt: number): void {
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i]!;
      if (!f.active) continue;
      f.age += dt;
      const frac = f.age / f.maxAge;
      if (frac >= 1) {
        f.active = false;
        f.mesh.visible = false;
        continue;
      }
      f.mat.opacity = 0.92 * (1 - frac);
      f.mesh.scale.y = 1 - frac * 0.7;
    }
  }

  onGesture(event: PlayerGestureEvent): void {
    if (this.ctx.getPhase() !== "playing" || this.roundFinished) return;

    const slot = event.slot;
    const blade = this.blades[slot];
    if (!blade || !blade.connected) return;

    if (event.kind !== "swipe" && event.kind !== "flick" && event.kind !== "swing") {
      return;
    }

    const rawDx = event.dx;
    const rawDy = -event.dy; // screen-space Y points down; world +Y points up
    const mag = Math.hypot(rawDx, rawDy);
    const nx = mag > 0.05 ? rawDx / mag : 0.76;
    const ny = mag > 0.05 ? rawDy / mag : 0.65;

    const span = 3.2 + clamp(event.power, 0.4, 2.2) * 1.1;
    const halfSpan = span * 0.5;
    const ax = blade.worldX - nx * halfSpan;
    const ay = blade.worldY - ny * halfSpan;
    const bx = blade.worldX + nx * halfSpan;
    const by = blade.worldY + ny * halfSpan;

    const palette = PLAYER_SLOT_PALETTE[slot]!;
    this.spawnSlashFlash(ax, ay, bx, by, palette.hex);
    this.ctx.audio.play("swipe");

    this.sliceAlongSegment(slot, ax, ay, bx, by, false, 0.34);
  }

  private spawnSlashFlash(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    hex: string | number,
  ): void {
    const f = this.flashes[this.flashCursor];
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    if (!f) return;

    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.max(0.6, Math.hypot(dx, dy));
    f.active = true;
    f.age = 0;
    f.maxAge = 0.16;
    f.mat.color.set(hex);
    f.mat.opacity = 0.92;
    f.mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, 0.45);
    f.mesh.rotation.z = Math.atan2(dy, dx);
    f.mesh.scale.set(len, 1.15, 1);
    f.mesh.visible = true;
  }

  private sliceAlongSegment(
    slot: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    isContinuousTrail: boolean,
    extraReach = 0.12,
  ): void {
    const abx = bx - ax;
    const aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    const cutAngle = Math.atan2(aby, abx);
    const palette = PLAYER_SLOT_PALETTE[slot]!;

    let slicedAnyFruit = false;

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i]!;
      if (!e.active || e.spawnGraceS > 0) continue;

      let t = 0;
      if (lenSq > 1e-6) {
        t = clamp(((e.x - ax) * abx + (e.y - ay) * aby) / lenSq, 0, 1);
      }
      const cx = ax + abx * t;
      const cy = ay + aby * t;
      const distSq = (e.x - cx) * (e.x - cx) + (e.y - cy) * (e.y - cy);
      const hitRadius = e.kind === "bomb" ? e.radius : e.radius + extraReach;

      if (distSq > hitRadius * hitRadius) continue;

      e.active = false;
      e.root.visible = false;

      if (e.kind === "bomb") {
        this.handleBombHit(slot, e.x, e.y, e.z);
        return;
      }

      slicedAnyFruit = true;
      this.handleFruitSliced(slot, e, cutAngle, palette.hex);
    }

    if (slicedAnyFruit && isContinuousTrail && (this.swipeFlashCooldown[slot] ?? 0) <= 0) {
      this.swipeFlashCooldown[slot] = 0.08;
      this.spawnSlashFlash(ax, ay, bx, by, palette.hex);
    }
  }

  private handleBombHit(slot: number, bx: number, by: number, bz: number): void {
    this.comboCounts[slot] = 0;
    this.comboTimers[slot] = 0;
    this.scores[slot] = Math.max(0, (this.scores[slot] ?? 0) - 200);
    this.localShake = Math.min(1, this.localShake + 0.85);
    this.flashTimer = 0.22;

    this.ctx.fx.addScreenShake(0.8);
    this.ctx.fx.triggerHitStop(36);
    this.ctx.audio.play("bomb_boom");
    this.ctx.sendHaptic(slot, "error");

    this.particles.spawnBurst(bx, by, bz + 0.2, 0xff3b30, 26, 8.6);
    this.shockwaves.spawn(bx, by, bz + 0.2, 0xff3b30, 5.2, 0.42);
    this.ctx.hud.announce(`${this.getPlayerName(slot)} SLICED A BOMB! -200`);
    this.ctx.sendPadHud?.(slot, {
      ammo: 6,
      maxAmmo: 6,
      reloading: false,
      streak: 0,
      prompt: "BOMB HIT! -200 pts",
    });
    this.syncScoreboardHud();
  }

  private handleFruitSliced(
    slot: number,
    entity: TossedEntity,
    cutAngle: number,
    playerHex: string,
  ): void {
    const style = FRUIT_STYLES[entity.kind];
    const feverMult = ROUND_DURATION_MS - this.roundElapsedMs <= 5000 ? 2.0 : 1.0;
    const pts = Math.round(style.basePts * feverMult * this.tuning.scoreMult);

    this.scores[slot] = (this.scores[slot] ?? 0) + pts;
    const count = (this.comboCounts[slot] ?? 0) + 1;
    this.comboCounts[slot] = count;
    this.comboTimers[slot] = COMBO_WINDOW_S;
    this.comboLastX[slot] = entity.x;
    this.comboLastY[slot] = entity.y;

    this.spawnSplitHalves(entity, cutAngle, style);
    this.particles.spawnBurst(
      entity.x,
      entity.y,
      entity.z + 0.15,
      style.juiceHex,
      entity.kind === "starfruit" ? 26 : 18,
      6.8,
      entity.vx * 0.25,
      entity.vy * 0.2,
    );
    this.shockwaves.spawn(
      entity.x,
      entity.y,
      entity.z + 0.15,
      entity.kind === "starfruit" ? 0xffd028 : playerHex,
      entity.kind === "starfruit" ? 4.8 : 3.0,
      0.3,
    );

    if (entity.kind === "starfruit") {
      this.frenzyTimer = 3.8;
      this.frenzyBurstTimer = 0.05;
      this.localShake = Math.min(1, this.localShake + 0.55);
      this.ctx.fx.addScreenShake(0.45);
      this.ctx.fx.triggerHitStop(28);
      this.ctx.audio.play("frenzy");
      this.ctx.sendHaptic("all", "combo");
      this.ctx.hud.announce(`${this.getPlayerName(slot)} STARFRUIT FRENZY! +${pts}`);
      this.ctx.sendPadHud?.("all", {
        ammo: 6,
        maxAmmo: 6,
        reloading: false,
        streak: count,
        prompt: "STARFRUIT FRENZY! SLICE FAST!",
      });
    } else {
      this.localShake = Math.min(1, this.localShake + 0.2);
      this.ctx.fx.addScreenShake(0.16);
      this.ctx.audio.play("slice");
      this.ctx.sendHaptic(slot, "hit");
      if (count >= 3) {
        this.ctx.hud.announce(`${this.getPlayerName(slot)} ${count}× SLICE!`);
      }
    }

    this.syncScoreboardHud();
  }

  private flushComboBonus(slot: number): void {
    const count = this.comboCounts[slot] ?? 0;
    this.comboCounts[slot] = 0;
    if (count < 2) return;

    const bonus = count === 2 ? 50 : count * 100;
    const scaledBonus = Math.round(bonus * this.tuning.scoreMult);
    this.scores[slot] = (this.scores[slot] ?? 0) + scaledBonus;

    if (count >= 3) {
      const cx = this.comboLastX[slot] ?? 0;
      const cy = this.comboLastY[slot] ?? 0;
      this.ctx.audio.play("combo");
      this.ctx.sendHaptic(slot, "combo");
      this.ctx.fx.addScreenShake(0.32);
      this.shockwaves.spawn(cx, cy, 0.35, 0xffd028, 4.4, 0.36);
      this.ctx.hud.announce(`${this.getPlayerName(slot)} ${count}-FRUIT COMBO +${scaledBonus}!`);
      this.ctx.sendPadHud?.(slot, {
        ammo: 6,
        maxAmmo: 6,
        reloading: false,
        streak: count,
        prompt: `${count}-FRUIT COMBO +${scaledBonus}!`,
      });
    }
    this.syncScoreboardHud();
  }

  private spawnSplitHalves(entity: TossedEntity, cutAngle: number, style: FruitStyle): void {
    const nx = -Math.sin(cutAngle);
    const ny = Math.cos(cutAngle);
    const pushSpeed = 2.8;

    for (let side = -1; side <= 1; side += 2) {
      const h = this.halves[this.halfCursor];
      this.halfCursor = (this.halfCursor + 1) % this.halves.length;
      if (!h) continue;

      h.active = true;
      h.age = 0;
      h.x = entity.x + nx * side * 0.14;
      h.y = entity.y + ny * side * 0.14;
      h.z = entity.z;
      h.prevX = h.x;
      h.prevY = h.y;
      h.vx = entity.vx * 0.75 + nx * side * pushSpeed;
      h.vy = Math.max(-1.0, entity.vy * 0.75) + ny * side * pushSpeed + 1.4;
      h.vz = side * 0.65;
      h.rotX = 0.35 * side;
      h.rotZ = cutAngle + (side === -1 ? Math.PI : 0);
      h.spinX = side * 2.2;
      h.spinZ = side * 5.2;
      h.scale = (style.radius / 0.68) * this.tuning.scaleMult;

      h.shellMat.color.setHex(style.rindHex);
      h.fleshMat.color.setHex(style.fleshHex);
      h.group.position.set(h.x, h.y, h.z);
      h.group.rotation.set(h.rotX, 0.25, h.rotZ);
      h.group.scale.setScalar(h.scale);
      h.group.visible = true;
    }
  }

  private finishGame(): void {
    if (this.roundFinished) return;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      this.flushComboBonus(s);
    }
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

  render(alpha: number): void {
    for (let slot = 0; slot < this.blades.length; slot++) {
      const b = this.blades[slot]!;
      b.group.visible = b.connected;
      b.trailMesh.visible = b.connected;
      if (!b.connected) continue;

      const rx = b.prevWorldX + (b.worldX - b.prevWorldX) * alpha;
      const ry = b.prevWorldY + (b.worldY - b.prevWorldY) * alpha;
      const zLayer = 0.6 + slot * 0.02;

      b.group.position.set(rx, ry, zLayer);
      b.group.rotation.z = -b.rollRad;
      b.ringMat.opacity = b.bladeHot ? 0.96 : 0.45;
      b.coreMat.opacity = b.bladeHot ? 1.0 : 0.65;
      b.ringMesh.scale.setScalar(b.bladeHot ? 1.18 : 0.85);

      b.trailMat.opacity = b.bladeHot ? 0.88 : 0.24;
      const maxWidth = b.bladeHot ? 0.22 : 0.08;
      const pos = b.trailPositions;

      for (let i = 0; i < TRAIL_POINTS; i++) {
        const px = i === TRAIL_POINTS - 1 ? rx : b.histX[i]!;
        const py = i === TRAIL_POINTS - 1 ? ry : b.histY[i]!;

        const nxSrc = i < TRAIL_POINTS - 1 ? (i + 1 === TRAIL_POINTS - 1 ? rx : b.histX[i + 1]!) : px;
        const nySrc = i < TRAIL_POINTS - 1 ? (i + 1 === TRAIL_POINTS - 1 ? ry : b.histY[i + 1]!) : py;
        const pxPrev = i > 0 ? b.histX[i - 1]! : px;
        const pyPrev = i > 0 ? b.histY[i - 1]! : py;

        let tx = nxSrc - pxPrev;
        let ty = nySrc - pyPrev;
        const tLen = Math.hypot(tx, ty);
        if (tLen > 1e-4) {
          tx /= tLen;
          ty /= tLen;
        } else {
          tx = 1;
          ty = 0;
        }

        const nx = -ty;
        const ny = tx;
        const w = maxWidth * (i / (TRAIL_POINTS - 1));

        const base = i * 6;
        pos[base] = px - nx * w;
        pos[base + 1] = py - ny * w;
        pos[base + 2] = zLayer - 0.04;
        pos[base + 3] = px + nx * w;
        pos[base + 4] = py + ny * w;
        pos[base + 5] = zLayer - 0.04;
      }

      const attr = b.trailGeo.getAttribute("position") as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }

    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i]!;
      if (!e.active) continue;
      const ex = e.prevX + (e.x - e.prevX) * alpha;
      const ey = e.prevY + (e.y - e.prevY) * alpha;
      e.root.position.set(ex, ey, e.z);
      e.root.rotation.set(e.rotX, e.rotY, e.rotZ);
    }

    for (let i = 0; i < this.halves.length; i++) {
      const h = this.halves[i]!;
      if (!h.active) continue;
      const hx = h.prevX + (h.x - h.prevX) * alpha;
      const hy = h.prevY + (h.y - h.prevY) * alpha;
      h.group.position.set(hx, hy, h.z);
      h.group.rotation.x = h.rotX;
      h.group.rotation.z = h.rotZ;
    }

    if (this.scene.background instanceof THREE.Color) {
      if (this.flashTimer > 0) {
        this.scene.background.copy(this.activeBgColor).lerp(this.bombFlashColor, this.flashTimer / 0.22);
      } else {
        this.scene.background.copy(this.activeBgColor);
      }
    }

    if (this.localShake > 0.002) {
      const mag = this.localShake * 0.22;
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
