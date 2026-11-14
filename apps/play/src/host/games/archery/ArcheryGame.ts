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
  observeThemeScheme,
} from "../shared/ArcadeSceneUtils.js";
import {
  buildArrowGroup,
  buildBowSight,
  buildChampionshipTarget,
  buildRecurveBow,
  buildWindBanner,
  createArcheryTextures,
  updateRecurveBowPose,
  type ArcheryTextures,
  type ArticulatedWindBanner,
  type BowSightRefs,
  type RecurveBowRefs,
  type TargetAssemblyRefs,
} from "./archeryVisuals.js";

const CAMERA_BASE_X = 0;
const CAMERA_BASE_Y = 0.45;
const CAMERA_BASE_Z = 14;
const FOV_BASE_DEG = 44;
const FOV_DRAW_DEG = 37.5;
const DRAW_FULL_TIME_S = 0.92;
const MIN_DRAW_TIME_S = 0.08;
const TOTAL_ATTEMPTS = 6;

const ARROW_POOL_SIZE = 12;
const PINNED_POOL_SIZE = 28;
const WIND_STREAK_COUNT = 26;
const WIND_BANNER_COUNT = 6;
const CHECKPOINTS = [0.25, 0.5, 0.75, 0.96] as const;
const FWD_Z = new THREE.Vector3(0, 0, -1);

interface DifficultyConfig {
  windMult: number;
  windAccelScale: number;
  gravScale: number;
  targetScale: number;
  moveAmpMult: number;
  moveFreqMult: number;
  showAssistLead: boolean;
  scoreMult: number;
  musicBpm: number;
}

const DIFFICULTY_TUNING: Record<DifficultyPreset, DifficultyConfig> = {
  casual: {
    windMult: 0.58,
    windAccelScale: 1.45,
    gravScale: 0.72,
    targetScale: 1.16,
    moveAmpMult: 0.68,
    moveFreqMult: 0.66,
    showAssistLead: true,
    scoreMult: 1.0,
    musicBpm: 110,
  },
  arcade: {
    windMult: 1.0,
    windAccelScale: 2.3,
    gravScale: 1.0,
    targetScale: 1.0,
    moveAmpMult: 1.0,
    moveFreqMult: 1.0,
    showAssistLead: false,
    scoreMult: 1.0,
    musicBpm: 122,
  },
  pro: {
    windMult: 1.38,
    windAccelScale: 3.05,
    gravScale: 1.18,
    targetScale: 0.86,
    moveAmpMult: 1.24,
    moveFreqMult: 1.28,
    showAssistLead: false,
    scoreMult: 1.25,
    musicBpm: 134,
  },
};

interface AttemptSpec {
  title: string;
  z: number;
  baseWind: number;
  gustAmp: number;
  oscAmpX: number;
  oscFreqX: number;
  oscAmpY: number;
  oscFreqY: number;
  pointsMult: number;
}

const ATTEMPT_SCHEDULE: readonly AttemptSpec[] = [
  {
    title: "Warm-Up · Still Target",
    z: -5.5,
    baseWind: 0.4,
    gustAmp: 0.0,
    oscAmpX: 0,
    oscFreqX: 0,
    oscAmpY: 0,
    oscFreqY: 0,
    pointsMult: 1.0,
  },
  {
    title: "Crosswind · Mid Range",
    z: -8.5,
    baseWind: 1.75,
    gustAmp: 0.15,
    oscAmpX: 0,
    oscFreqX: 0,
    oscAmpY: 0,
    oscFreqY: 0,
    pointsMult: 1.0,
  },
  {
    title: "Sliding Rail · Breeze",
    z: -9.8,
    baseWind: 2.25,
    gustAmp: 0.25,
    oscAmpX: 2.1,
    oscFreqX: 0.7,
    oscAmpY: 0,
    oscFreqY: 0,
    pointsMult: 1.15,
  },
  {
    title: "Bob & Weave · Gust Shift",
    z: -11.5,
    baseWind: 2.85,
    gustAmp: 0.4,
    oscAmpX: 2.6,
    oscFreqX: 0.85,
    oscAmpY: 0.65,
    oscFreqY: 1.1,
    pointsMult: 1.25,
  },
  {
    title: "Long Range · Figure-8",
    z: -13.8,
    baseWind: 3.35,
    gustAmp: 0.5,
    oscAmpX: 3.0,
    oscFreqX: 0.95,
    oscAmpY: 0.82,
    oscFreqY: 1.45,
    pointsMult: 1.5,
  },
  {
    title: "Championship Final · 2× GOLD",
    z: -12.4,
    baseWind: 3.1,
    gustAmp: 0.45,
    oscAmpX: 2.9,
    oscFreqX: 1.02,
    oscAmpY: 0.78,
    oscFreqY: 1.55,
    pointsMult: 2.0,
  },
];

type AttemptPhase = "intro_glide" | "aiming" | "inspect" | "complete";

interface BowSlot {
  sight: BowSightRefs;
  bow3d: RecurveBowRefs;
  worldX: number;
  worldY: number;
  prevWorldX: number;
  prevWorldY: number;
  connected: boolean;
  wasPrimaryDown: boolean;
  drawing: boolean;
  drawTimeS: number;
  nextTickStep: number;
  hudSyncTimer: number;
  drawRatio: number;
  shotThisEnd: boolean;
  inFlight: boolean;
  stringSnap: number;
  stringSnapPhase: number;
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
  spinAngle: number;
}

interface PinnedArrow {
  active: boolean;
  group: THREE.Group;
  vaneMat: THREE.MeshBasicMaterial;
  localX: number;
  localY: number;
  localZ: number;
  tiltX: number;
  tiltY: number;
  age: number;
}

interface WindStreak {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  z: number;
  len: number;
}

function easeOutCubic(t: number): number {
  const k = 1 - clamp(t, 0, 1);
  return 1 - k * k * k;
}

export class ArcheryGame implements GamePlugin {
  readonly id = "archery" as const;

  private ctx!: GameHostContext;
  private rng!: () => number;
  private canvas!: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private textures!: ArcheryTextures;
  private tuning: DifficultyConfig = DIFFICULTY_TUNING.arcade;

  private halfH = Math.tan(THREE.MathUtils.degToRad(FOV_BASE_DEG / 2)) * CAMERA_BASE_Z;
  private halfW = this.halfH * (16 / 9);

  // Attempt state & progression
  private attemptIdx = 0;
  private attemptPhase: AttemptPhase = "intro_glide";
  private phaseTimer = 0;
  private groupWaitTimer = 0;
  private simTime = 0;
  private railPhaseTime = 0;

  // Wind physics
  private windSign = 1;
  private windX = 0;
  private windY = 0;
  private targetWindX = 0;
  private targetWindY = 0;
  private lastWindLabel = "";

  // Single hero target & rail animation
  private targetAssembly!: TargetAssemblyRefs;
  private targetRadius = 1.65;
  private targetX = 0;
  private targetY = 0.25;
  private targetZ = -5.5;
  private startTargetZ = -5.5;
  private goalTargetZ = -5.5;
  private targetRecoilZ = 0;
  private targetTiltX = 0;
  private targetTiltY = 0;
  private targetTiltVelX = 0;
  private targetTiltVelY = 0;
  private trolleyDistanceX = 0;
  private railTrackGroup!: THREE.Group;

  // Smooth camera kinematics
  private camPos = new THREE.Vector3(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z);
  private camTargetPos = new THREE.Vector3(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z);
  private camLookAt = new THREE.Vector3(0, 0.25, -8);
  private camLookTarget = new THREE.Vector3(0, 0.25, -8);
  private currentFov = FOV_BASE_DEG;
  private inspectFocusX = 0;
  private inspectFocusY = 0.25;
  private localShake = 0;

  // Environment visuals
  private lawnMat: THREE.MeshStandardMaterial | null = null;
  private skyFog: THREE.Fog | null = null;
  private darkBgColor = new THREE.Color(0x0b131e);
  private lightBgColor = new THREE.Color(0xcde5fa);

  // Player bows & pooled geometry
  private readonly bows: BowSlot[] = [];
  private readonly arrows: FlyingArrow[] = [];
  private arrowCursor = 0;
  private readonly pinnedArrows: PinnedArrow[] = [];
  private pinnedCursor = 0;
  private readonly flags: ArticulatedWindBanner[] = [];
  private readonly streaks: WindStreak[] = [];

  private particles!: ArcadeParticlePool;
  private shockwaves!: ArcadeShockwavePool;

  // Scores & per-attempt scorecard [slot][0..5]
  private readonly scores = new Int32Array(MAX_PLAYERS);
  private readonly streaksGold = new Int32Array(MAX_PLAYERS);
  private readonly attemptScores: Array<Array<number | null>> = Array.from(
    { length: MAX_PLAYERS },
    () => Array<number | null>(TOTAL_ATTEMPTS).fill(null),
  );

  private tutorialHidden = false;
  private musicStarted = false;
  private roundFinished = false;

  // Pre-allocated scratch vectors (zero per-frame allocations)
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpAimPos = new THREE.Vector3();

  private readonly disposables: Array<{ dispose(): void }> = [];
  private detachThemeObserver: (() => void) | null = null;

  init(ctx: GameHostContext): void {
    this.ctx = ctx;
    this.tuning = DIFFICULTY_TUNING[ctx.difficulty] ?? DIFFICULTY_TUNING.arcade;
    this.rng = createSeededRng(ctx.seed);

    this.scores.fill(0);
    this.streaksGold.fill(0);
    for (let s = 0; s < MAX_PLAYERS; s++) {
      this.attemptScores[s]!.fill(null);
    }

    this.attemptIdx = 0;
    this.attemptPhase = "intro_glide";
    this.phaseTimer = 0.75;
    this.groupWaitTimer = 0;
    this.simTime = 0;
    this.railPhaseTime = 0;
    this.windSign = this.rng() < 0.5 ? -1 : 1;
    this.windX = 0;
    this.windY = 0;
    this.targetWindX = 0;
    this.targetWindY = 0;
    this.lastWindLabel = "";
    this.tutorialHidden = false;
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    const width = Math.max(1, ctx.container.clientWidth || window.innerWidth);
    const height = Math.max(1, ctx.container.clientHeight || window.innerHeight);

    this.camera = new THREE.PerspectiveCamera(FOV_BASE_DEG, width / height, 0.3, 120);
    this.camPos.set(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z);
    this.camTargetPos.copy(this.camPos);
    this.camLookAt.set(0, 0.25, -8);
    this.camLookTarget.copy(this.camLookAt);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLookAt);
    this.currentFov = FOV_BASE_DEG;

    this.textures = createArcheryTextures();
    this.scene.environment = this.textures.envTex;
    this.disposables.push(...this.textures.disposables);

    // Three-point outdoor stadium lighting
    const hemi = new THREE.HemisphereLight(0xf0f9ff, 0x1e3528, 1.05);
    const keySun = new THREE.DirectionalLight(0xfffbeb, 1.85);
    keySun.position.set(7.5, 13.5, 11);
    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.72);
    rimLight.position.set(-9, 6, -12);
    this.scene.add(hemi, keySun, rimLight);

    this.buildRangeEnvironment();
    this.buildHeroTarget();
    this.buildWindFlagsAndStreaks();
    this.buildArrowPools();
    this.buildBowSlots();
    this.particles = new ArcadeParticlePool(this.scene, 260, 0.11);
    this.shockwaves = new ArcadeShockwavePool(this.scene, 14);

    this.detachThemeObserver = observeThemeScheme((scheme) => this.applyThemePalette(scheme));
    this.onResize(width, height, Math.min(window.devicePixelRatio || 1, 2));
    // Pre-compile PBR materials during countdown so first live draw has zero shader hitch
    this.renderer.compile(this.scene, this.camera);

    this.configureAttempt(0, true);
    this.syncHudAll();

    const diffName =
      ctx.difficulty === "casual"
        ? "Chill (Assist Reticle)"
        : ctx.difficulty === "pro"
          ? "Turbo (1.25×)"
          : "Arcade";

    this.ctx.hud.setTutorialVisible(true, [
      `${diffName} · 1 Target · 6 Championship Ends`,
      "Hold pad/mouse to draw the 3D bow & inspect every hit arrow up close",
      "Wind & rail motion escalate each end · End 6 pays 2× GOLD points!",
    ]);
  }

  private buildRangeEnvironment(): void {
    // Rich mowed-stripe turf plane with grain bump map
    const lawnGeo = new THREE.PlaneGeometry(72, 64);
    lawnGeo.rotateX(-Math.PI / 2);
    const lawnMat = new THREE.MeshStandardMaterial({
      map: this.textures.grassAlbedo,
      bumpMap: this.textures.grassBump,
      bumpScale: 0.08,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.lawnMat = lawnMat;
    const lawn = new THREE.Mesh(lawnGeo, lawnMat);
    lawn.position.set(0, -3.55, -10);
    this.scene.add(lawn);

    // Center shooting lane earth strip + timber edge curbs
    const pathGeo = new THREE.PlaneGeometry(5.8, 36);
    pathGeo.rotateX(-Math.PI / 2);
    const pathMat = new THREE.MeshStandardMaterial({
      map: this.textures.strawAlbedo,
      bumpMap: this.textures.strawBump,
      bumpScale: 0.06,
      color: 0x8b6e4e,
      roughness: 0.96,
    });
    const pathMesh = new THREE.Mesh(pathGeo, pathMat);
    pathMesh.position.set(0, -3.53, -4);
    this.scene.add(pathMesh);

    const woodMat = new THREE.MeshStandardMaterial({
      map: this.textures.woodAlbedo,
      bumpMap: this.textures.woodBump,
      bumpScale: 0.05,
      roughness: 0.78,
    });

    // Side oak yardage curbs & wooden distance posts
    const curbGeo = new THREE.BoxGeometry(0.24, 0.22, 34);
    for (const side of [-3.05, 3.05]) {
      const curb = new THREE.Mesh(curbGeo, woodMat);
      curb.position.set(side, -3.44, -4);
      this.scene.add(curb);
    }

    // Timber range pavilion backdrop archway behind max range
    const postGeo = new THREE.BoxGeometry(0.45, 7.6, 0.45);
    const beamGeo = new THREE.BoxGeometry(16.2, 0.55, 0.55);
    for (const px of [-7.6, 7.6]) {
      const post = new THREE.Mesh(postGeo, woodMat);
      post.position.set(px, 0.25, -18.5);
      this.scene.add(post);
    }
    const headerBeam = new THREE.Mesh(beamGeo, woodMat);
    headerBeam.position.set(0, 4.15, -18.5);
    this.scene.add(headerBeam);

    // Stylized sculpted low-poly pines along range horizon for depth perception
    const trunkMat = woodMat;
    const foilMat = new THREE.MeshStandardMaterial({
      color: 0x1a4731,
      roughness: 0.85,
      metalness: 0.02,
    });
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.34, 2.2, 7);
    const coneLowerGeo = new THREE.ConeGeometry(1.45, 3.1, 7);
    const coneTopGeo = new THREE.ConeGeometry(1.05, 2.4, 7);

    const treePositions: ReadonlyArray<[number, number]> = [
      [-13.5, -16],
      [-10.2, -21],
      [-16.2, -10],
      [13.5, -16],
      [10.2, -21],
      [16.2, -10],
      [-5.2, -24],
      [5.2, -24],
    ];
    for (const [tx, tz] of treePositions) {
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.set(tx, -2.5, tz);
      const lower = new THREE.Mesh(coneLowerGeo, foilMat);
      lower.position.set(tx, -0.4, tz);
      const top = new THREE.Mesh(coneTopGeo, foilMat);
      top.position.set(tx, 1.1, tz);
      this.scene.add(trunk, lower, top);
    }

    // Lateral brushed steel track assembly that moves in Z with the trolley target
    this.railTrackGroup = new THREE.Group();
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.28,
      metalness: 0.8,
    });
    const railGeo = new THREE.BoxGeometry(11.6, 0.14, 0.14);
    const frontRail = new THREE.Mesh(railGeo, steelMat);
    frontRail.position.set(0, -3.45, 0.15);
    const rearRail = new THREE.Mesh(railGeo, steelMat);
    rearRail.position.set(0, -3.45, -0.65);

    const tieGeo = new THREE.BoxGeometry(0.28, 0.12, 1.35);
    for (let tx = -5.4; tx <= 5.41; tx += 1.35) {
      const tie = new THREE.Mesh(tieGeo, woodMat);
      tie.position.set(tx, -3.51, -0.25);
      this.railTrackGroup.add(tie);
    }
    this.railTrackGroup.add(frontRail, rearRail);
    this.scene.add(this.railTrackGroup);

    this.disposables.push(
      lawnGeo,
      lawnMat,
      pathGeo,
      pathMat,
      woodMat,
      curbGeo,
      postGeo,
      beamGeo,
      foilMat,
      trunkGeo,
      coneLowerGeo,
      coneTopGeo,
      steelMat,
      railGeo,
      tieGeo,
    );
  }

  private buildHeroTarget(): void {
    this.targetRadius = 1.65 * this.tuning.targetScale;
    this.targetAssembly = buildChampionshipTarget(
      this.targetRadius,
      this.textures,
      this.disposables,
    );
    this.targetAssembly.root.position.set(0, this.targetY, this.targetZ);
    this.scene.add(this.targetAssembly.root);
  }

  private buildWindFlagsAndStreaks(): void {
    const xs = [-7.8, -8.8, -9.8, 7.8, 8.8, 9.8];
    const zs = [-3.0, -9.0, -15.0, -3.0, -9.0, -15.0];
    const heights = [4.6, 5.0, 5.4, 4.6, 5.0, 5.4];
    const colors = [0xff5a36, 0xf5b82e, 0x38bdf8, 0xff5a36, 0xf5b82e, 0x38bdf8];

    for (let i = 0; i < WIND_BANNER_COUNT; i++) {
      const banner = buildWindBanner(heights[i]!, colors[i]!, this.textures, this.disposables);
      banner.root.position.set(xs[i]!, -3.55, zs[i]!);
      banner.phase = i * 1.15;
      this.scene.add(banner.root);
      this.flags.push(banner);
    }

    const streakGeo = new THREE.BoxGeometry(0.95, 0.03, 0.03);
    this.disposables.push(streakGeo);
    for (let i = 0; i < WIND_STREAK_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xe2e8f0,
        transparent: true,
        opacity: 0.24,
      });
      this.disposables.push(mat);
      const mesh = new THREE.Mesh(streakGeo, mat);
      const sx = (this.rng() * 2 - 1) * 11;
      const sy = -2.0 + this.rng() * 6.5;
      const sz = -15 + this.rng() * 17;
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
      const { group, vaneMat } = buildArrowGroup(0xff4d2e, this.textures, this.disposables);
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
        spinAngle: 0,
      });
    }

    for (let i = 0; i < PINNED_POOL_SIZE; i++) {
      const { group, vaneMat } = buildArrowGroup(0xff4d2e, this.textures, this.disposables);
      group.visible = false;
      // Attach directly to bossPivot so stuck arrows ride rail, recoil & impact tilt seamlessly!
      this.targetAssembly.bossPivot.add(group);
      this.pinnedArrows.push({
        active: false,
        group,
        vaneMat,
        localX: 0,
        localY: 0,
        localZ: 0.56,
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

      const bow3d = buildRecurveBow(palette.hex, this.textures, this.disposables);
      bow3d.root.visible = false;
      this.scene.add(bow3d.root);

      this.bows.push({
        sight,
        bow3d,
        worldX: 0,
        worldY: 0.25,
        prevWorldX: 0,
        prevWorldY: 0.25,
        connected: false,
        wasPrimaryDown: false,
        drawing: false,
        drawTimeS: 0,
        nextTickStep: 0,
        hudSyncTimer: 0,
        drawRatio: 0,
        shotThisEnd: false,
        inFlight: false,
        stringSnap: 0,
        stringSnapPhase: 0,
      });
    }
  }

  private applyThemePalette(scheme: "dark" | "light"): void {
    this.darkBgColor.setHex(0x0b131e);
    this.lightBgColor.setHex(0xcde5fa);
    const bg = scheme === "dark" ? this.darkBgColor : this.lightBgColor;
    this.scene.background = bg.clone();
    this.skyFog = new THREE.Fog(bg.getHex(), 26, 58);
    this.scene.fog = this.skyFog;

    if (this.lawnMat) {
      this.lawnMat.color.setHex(scheme === "dark" ? 0x6b9e78 : 0xb2dfbe);
    }
  }

  private getCurrentSpec(): AttemptSpec {
    return ATTEMPT_SCHEDULE[clamp(this.attemptIdx, 0, ATTEMPT_SCHEDULE.length - 1)]!;
  }

  private configureAttempt(idx: number, immediate: boolean): void {
    this.attemptIdx = idx;
    const spec = this.getCurrentSpec();

    // Flip wind sign unpredictably on alternating ends so players adapt cleanly
    if (idx > 0) {
      this.windSign = this.rng() < 0.72 ? -this.windSign : this.windSign;
    }

    const scaledWind = spec.baseWind * this.tuning.windMult * this.windSign;
    this.targetWindX = scaledWind;
    this.targetWindY = (this.rng() - 0.5) * Math.abs(scaledWind) * 0.22;

    if (immediate) {
      this.windX = this.targetWindX;
      this.windY = this.targetWindY;
      this.targetZ = spec.z;
    }

    this.startTargetZ = this.targetZ;
    this.goalTargetZ = spec.z;
    this.railPhaseTime = 0;

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const b = this.bows[slot]!;
      b.drawing = false;
      b.drawTimeS = 0;
      b.drawRatio = 0;
      b.shotThisEnd = false;
      b.inFlight = false;
      b.nextTickStep = 0;
    }

    // Highlight X-ring medallion brighter during Championship End 6
    this.targetAssembly.goldGlowMat.emissiveIntensity = idx === TOTAL_ATTEMPTS - 1 ? 0.85 : 0.25;

    // On End 1, open immediately into 'aiming' once countdown finishes; Ends 2..6 glide cleanly
    this.attemptPhase = immediate ? "aiming" : "intro_glide";
    this.phaseTimer = immediate ? 0 : 0.85;
    this.groupWaitTimer = 0;

    const endNum = idx + 1;
    this.ctx.hud.setRoundLabel?.(
      `End ${endNum}/${TOTAL_ATTEMPTS}`,
      endNum === TOTAL_ATTEMPTS,
    );
    this.ctx.hud.announce(
      `End ${endNum}/${TOTAL_ATTEMPTS} · ${spec.title} · ${this.formatWindDirection(this.targetWindX)}`,
    );
    this.syncWindHud(true);
    this.sendIdlePadPromptAll();
  }

  private sendIdlePadPromptAll(): void {
    const endLabel = `END ${this.attemptIdx + 1}/${TOTAL_ATTEMPTS}`;
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const b = this.bows[slot];
      const msg = b?.shotThisEnd
        ? `${endLabel} SHOT RECORDED`
        : `${endLabel} · ${this.formatWindShort()} · Hold=Draw`;
      this.ctx.sendPadHud?.(slot, {
        ammo: 0,
        maxAmmo: 10,
        reloading: false,
        streak: this.streaksGold[slot] ?? 0,
        prompt: msg,
      });
    }
  }

  onGesture(ev: PlayerGestureEvent): void {
    if (this.roundFinished || this.ctx.getPhase() !== "playing") return;
    if (this.attemptPhase !== "aiming") return;
    const bow = this.bows[ev.slot];
    if (!bow || bow.shotThisEnd || bow.inFlight) return;

    if (ev.kind === "hold_start") {
      if (!bow.drawing) {
        this.beginDraw(ev.slot, bow);
        bow.drawTimeS = 0.2;
      }
      return;
    }

    if (ev.kind === "hold_end") {
      bow.stringSnap = 1.0;
      bow.stringSnapPhase = 0;
      const ratio = clamp(Math.max(bow.drawRatio, ev.power / DRAW_FULL_TIME_S), 0.45, 1.0);
      this.looseArrow(ev.slot, ratio);
      return;
    }

    // Keyboard simulator Space emits a 'swing' quick-loose at strong draw
    if (ev.kind === "swing") {
      bow.stringSnap = 1.0;
      bow.stringSnapPhase = 0;
      this.looseArrow(ev.slot, 0.8);
    }
  }

  update(dt: number, inputs: readonly PlayerAimFrame[]): void {
    this.simTime += dt;
    this.localShake = Math.max(0, this.localShake - dt * 3.8);

    const sightHalfW = Math.max(3.2, this.halfW - 0.8);
    const sightHalfH = Math.max(2.2, this.halfH - 0.6);
    const isPlaying = this.ctx.getPhase() === "playing" && !this.roundFinished;

    if (isPlaying) {
      if (!this.musicStarted) {
        this.musicStarted = true;
        this.ctx.audio.startMusic?.(this.tuning.musicBpm);
      }
      if (!this.tutorialHidden && this.simTime >= 9.0) {
        this.tutorialHidden = true;
        this.ctx.hud.setTutorialVisible(false);
      }
      this.stepAttemptStateMachine(dt);
    }

    // Wind blends smoothly + subtle live gust waves on Ends 2..6
    const spec = this.getCurrentSpec();
    const gustWave =
      spec.gustAmp > 0 ? Math.sin(this.simTime * 1.45) * spec.gustAmp * this.tuning.windMult : 0;
    const desiredWindX = this.targetWindX + gustWave;
    const windLerp = Math.min(1, dt * 3.2);
    this.windX += (desiredWindX - this.windX) * windLerp;
    this.windY += (this.targetWindY - this.windY) * windLerp;
    this.syncWindHud(false);

    // Update each player's aim & draw mechanics
    let anyDrawing = false;
    let maxDrawRatio = 0;

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const frame = inputs[slot];
      const bow = this.bows[slot];
      if (!frame || !bow) continue;

      const nextX = frame.cursorX * sightHalfW;
      const nextY = CAMERA_BASE_Y + frame.cursorY * sightHalfH;
      const wasConnected = bow.connected;

      bow.prevWorldX = wasConnected ? bow.worldX : nextX;
      bow.prevWorldY = wasConnected ? bow.worldY : nextY;
      bow.worldX = nextX;
      bow.worldY = nextY;
      bow.connected = frame.connected;

      if (bow.stringSnap > 0.002) {
        bow.stringSnap = Math.max(0, bow.stringSnap - dt * 4.5);
        bow.stringSnapPhase += dt * 48;
      }

      const canShoot =
        isPlaying &&
        frame.connected &&
        this.attemptPhase === "aiming" &&
        !bow.shotThisEnd &&
        !bow.inFlight;

      if (canShoot) {
        if (!bow.wasPrimaryDown && frame.primaryDown && !bow.drawing) {
          this.beginDraw(slot, bow);
        }

        if (bow.drawing) {
          bow.drawTimeS = Math.min(1.25, bow.drawTimeS + dt);
          bow.drawRatio = clamp(bow.drawTimeS / DRAW_FULL_TIME_S, 0, 1);
          anyDrawing = true;
          maxDrawRatio = Math.max(maxDrawRatio, bow.drawRatio);

          if (
            bow.nextTickStep < CHECKPOINTS.length &&
            bow.drawRatio >= CHECKPOINTS[bow.nextTickStep]!
          ) {
            bow.nextTickStep += 1;
            this.ctx.audio.play("bow_draw");
            this.ctx.sendHaptic(slot, "tension");
          }

          bow.hudSyncTimer -= dt;
          if (bow.hudSyncTimer <= 0) {
            bow.hudSyncTimer = 0.09;
            const pct = Math.round(bow.drawRatio * 100);
            this.ctx.sendPadHud?.(slot, {
              ammo: Math.round(bow.drawRatio * 10),
              maxAmmo: 10,
              reloading: true,
              streak: this.streaksGold[slot] ?? 0,
              prompt:
                pct >= 90
                  ? "FULL DRAW! RELEASE TO LOOSE!"
                  : `DRAW ${pct}% · ${this.formatWindShort()}`,
            });
          }

          if (bow.wasPrimaryDown && !frame.primaryDown) {
            if (bow.drawTimeS < MIN_DRAW_TIME_S) {
              // Accidental feather-tap safety: reset cleanly without burning the End
              bow.drawing = false;
              bow.drawTimeS = 0;
              bow.drawRatio = 0;
              bow.stringSnap = 0.3;
              this.ctx.sendPadHud?.(slot, {
                ammo: 0,
                maxAmmo: 10,
                reloading: false,
                streak: this.streaksGold[slot] ?? 0,
                prompt: `Hold longer to draw · ${this.formatWindShort()}`,
              });
            } else {
              bow.stringSnap = 1.0;
              bow.stringSnapPhase = 0;
              this.looseArrow(slot, Math.max(0.45, bow.drawRatio));
            }
          }
        }
      } else {
        bow.drawing = false;
        bow.drawRatio = 0;
      }

      bow.wasPrimaryDown = canShoot ? frame.primaryDown : false;
    }

    // Smooth camera FOV compression when drawing, then seamless dolly camera motion
    const targetFov =
      this.attemptPhase === "inspect"
        ? 40
        : anyDrawing
          ? THREE.MathUtils.lerp(FOV_BASE_DEG, FOV_DRAW_DEG, maxDrawRatio)
          : FOV_BASE_DEG;
    this.currentFov += (targetFov - this.currentFov) * Math.min(1, dt * 8.5);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.02) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    this.stepTargetPhysics(dt);
    this.stepWindVisuals(dt);
    this.stepArrows(dt);
    this.stepPinnedArrows(dt);
    this.stepCameraMotion(dt);
    this.particles.update(dt);
    this.shockwaves.update(dt);
  }

  private stepAttemptStateMachine(dt: number): void {
    const spec = this.getCurrentSpec();

    if (this.attemptPhase === "intro_glide") {
      this.phaseTimer -= dt;
      const t = 1 - Math.max(0, this.phaseTimer) / 0.85;
      this.targetZ = THREE.MathUtils.lerp(this.startTargetZ, this.goalTargetZ, easeOutCubic(t));
      this.camTargetPos.set(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z);
      this.camLookTarget.set(0, 0.25, this.targetZ);

      if (this.phaseTimer <= 0) {
        this.targetZ = this.goalTargetZ;
        this.attemptPhase = "aiming";
        this.groupWaitTimer = 0;
      }
      return;
    }

    if (this.attemptPhase === "aiming") {
      this.railPhaseTime += dt;
      this.camTargetPos.set(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z);
      this.camLookTarget.set(this.targetX * 0.25, this.targetY * 0.35 + 0.15, this.targetZ);

      const connectedPlayers = this.ctx.players.filter((p) => p.connected);
      if (connectedPlayers.length === 0) return;

      let someShot = false;
      let allFinished = true;
      for (const p of connectedPlayers) {
        const b = this.bows[p.slot];
        if (!b) continue;
        if (b.shotThisEnd) someShot = true;
        if (!b.shotThisEnd || b.inFlight) allFinished = false;
      }

      if (someShot && !allFinished) {
        this.groupWaitTimer += dt;
        if (this.groupWaitTimer >= 14.0) {
          // Record 0 for anyone who didn't shoot within group timeout (except still in flight)
          for (const p of connectedPlayers) {
            const b = this.bows[p.slot];
            if (b && !b.shotThisEnd) {
              b.shotThisEnd = true;
              this.attemptScores[p.slot]![this.attemptIdx] = 0;
            }
          }
          allFinished = connectedPlayers.every((p) => !this.bows[p.slot]?.inFlight);
        }
      }

      if (allFinished) {
        this.enterInspectPhase();
      }
      return;
    }

    if (this.attemptPhase === "inspect") {
      this.phaseTimer -= dt;
      // Gently glide toward target face so stuck arrows shimmer in close-up!
      this.camTargetPos.set(
        this.inspectFocusX * 0.45,
        this.inspectFocusY * 0.65 + 0.25,
        this.targetZ + 5.9,
      );
      this.camLookTarget.set(this.targetX, this.targetY, this.targetZ);

      if (this.phaseTimer <= 0) {
        if (this.attemptIdx + 1 < TOTAL_ATTEMPTS) {
          this.configureAttempt(this.attemptIdx + 1, false);
        } else {
          this.attemptPhase = "complete";
          this.phaseTimer = 1.25;
          this.ctx.hud.announce("6 ENDS COMPLETE · TALLYING FINAL SCORES!");
          this.ctx.audio.play("combo");
        }
      }
      return;
    }

    if (this.attemptPhase === "complete") {
      this.phaseTimer -= dt;
      this.camTargetPos.set(
        this.targetX * 0.25,
        this.targetY + 0.25,
        spec.z + 7.2,
      );
      this.camLookTarget.set(this.targetX, this.targetY, this.targetZ);
      if (this.phaseTimer <= 0) {
        this.finishGame();
      }
    }
  }

  private enterInspectPhase(): void {
    this.attemptPhase = "inspect";
    this.phaseTimer = this.attemptIdx === TOTAL_ATTEMPTS - 1 ? 1.55 : 1.15;
    this.inspectFocusX = this.targetX;
    this.inspectFocusY = this.targetY;
    this.syncScoreboardHud();
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

  private looseArrow(slot: number, drawRatio: number): void {
    const bow = this.bows[slot];
    if (!bow || bow.shotThisEnd) return;

    bow.drawing = false;
    bow.drawTimeS = 0;
    bow.drawRatio = 0;
    bow.shotThisEnd = true;
    bow.inFlight = true;

    const a = this.arrows[this.arrowCursor];
    this.arrowCursor = (this.arrowCursor + 1) % this.arrows.length;
    if (!a) return;

    const palette = PLAYER_SLOT_PALETTE[slot]!;
    this.tmpDir
      .set(bow.worldX - CAMERA_BASE_X, bow.worldY - CAMERA_BASE_Y, 0 - CAMERA_BASE_Z)
      .normalize();

    const speed = THREE.MathUtils.lerp(27, 50, clamp(drawRatio, 0.35, 1.0));

    a.active = true;
    a.slot = slot;
    a.drawRatio = drawRatio;
    a.age = 0;
    a.spinAngle = 0;
    a.vaneMat.color.set(palette.hex);

    // Launch directly from foreground bow riser position along aim ray
    a.pos.set(CAMERA_BASE_X, CAMERA_BASE_Y, CAMERA_BASE_Z).addScaledVector(this.tmpDir, 4.2);
    a.prevPos.copy(a.pos);
    a.vel.copy(this.tmpDir).multiplyScalar(speed);
    // Natural arc loft proportional to target range & gravity setting
    a.vel.y += (0.8 + Math.abs(this.targetZ) * 0.06) * this.tuning.gravScale;

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
      prompt: `END ${this.attemptIdx + 1}/${TOTAL_ATTEMPTS} IN FLIGHT…`,
    });
  }

  private stepTargetPhysics(dt: number): void {
    const spec = this.getCurrentSpec();
    const prevX = this.targetX;

    if (spec.oscAmpX > 0 && (this.attemptPhase === "aiming" || this.attemptPhase === "intro_glide")) {
      this.targetX =
        Math.sin(this.railPhaseTime * spec.oscFreqX * this.tuning.moveFreqMult) *
        spec.oscAmpX *
        this.tuning.moveAmpMult;
    } else if (this.attemptPhase === "intro_glide") {
      this.targetX += (0 - this.targetX) * Math.min(1, dt * 6);
    }

    if (spec.oscAmpY > 0 && this.attemptPhase === "aiming") {
      this.targetY =
        0.25 +
        Math.sin(this.railPhaseTime * spec.oscFreqY * this.tuning.moveFreqMult) *
          spec.oscAmpY *
          this.tuning.moveAmpMult;
    } else if (this.attemptPhase === "intro_glide") {
      this.targetY += (0.25 - this.targetY) * Math.min(1, dt * 6);
    }

    // Rotate trolley brass wheels realistically based on lateral rail travel
    const deltaX = this.targetX - prevX;
    this.trolleyDistanceX += deltaX;
    const wheelAngle = -this.trolleyDistanceX / 0.16;
    for (let i = 0; i < this.targetAssembly.wheelMeshes.length; i++) {
      this.targetAssembly.wheelMeshes[i]!.rotation.z = wheelAngle;
    }

    // Spring-damped target impact recoil & directional off-center torque
    this.targetRecoilZ = Math.max(0, this.targetRecoilZ - dt * 1.4);
    const springK = 140;
    const dampK = 14;
    this.targetTiltVelX += (-this.targetTiltX * springK - this.targetTiltVelX * dampK) * dt;
    this.targetTiltVelY += (-this.targetTiltY * springK - this.targetTiltVelY * dampK) * dt;
    this.targetTiltX += this.targetTiltVelX * dt;
    this.targetTiltY += this.targetTiltVelY * dt;

    this.targetAssembly.root.position.set(this.targetX, this.targetY, this.targetZ);
    this.targetAssembly.bossPivot.position.z = -this.targetRecoilZ;
    this.targetAssembly.bossPivot.rotation.set(this.targetTiltX, this.targetTiltY, 0);

    // Track rail keeps right underneath the trolley at every depth smoothly
    this.railTrackGroup.position.set(0, this.targetY - 0.25, this.targetZ);
  }

  private stepWindVisuals(dt: number): void {
    const speed = Math.abs(this.windX);
    const dir = this.windX >= 0 ? 1 : -1;
    const waveSpeed = 4.2 + speed * 2.8;
    const tautness = clamp(speed / 3.2, 0.12, 1.0);

    for (let i = 0; i < this.flags.length; i++) {
      const flag = this.flags[i]!;
      const goalYaw = dir >= 0 ? 0 : Math.PI;
      // Smooth shortest-arc yaw turn around the pole
      let diff = goalYaw - flag.pivot.rotation.y;
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      flag.pivot.rotation.y += diff * Math.min(1, dt * 5.0);

      for (let s = 0; s < flag.segments.length; s++) {
        const seg = flag.segments[s]!;
        const wave = Math.sin(this.simTime * waveSpeed + flag.phase - s * 0.72);
        const drop = s === 0 ? -0.45 * (1 - tautness) : -0.1 * (1 - tautness);
        seg.rotation.z = drop + wave * (0.045 + speed * 0.025);
        seg.rotation.y = wave * (0.1 + speed * 0.045);
      }
    }

    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i]!;
      s.x += (this.windX * 2.8 + dir * 0.65) * dt;
      s.y += this.windY * 1.1 * dt;
      if (s.x > 13) s.x = -13;
      if (s.x < -13) s.x = 13;
      if (s.y > 4.8) s.y = -2.2;
      if (s.y < -2.2) s.y = 4.8;

      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.scale.set(Math.max(0.3, speed * 0.52) * s.len, 1, 1);
      s.mat.opacity = clamp(0.06 + speed * 0.08, 0.06, 0.42);
    }
  }

  private stepArrows(dt: number): void {
    const gravity = 7.4 * this.tuning.gravScale;
    const windAccelX = this.windX * this.tuning.windAccelScale;
    const windAccelY = this.windY * 0.45;
    const faceZ = this.targetZ + 0.27;

    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i]!;
      if (!a.active) continue;

      a.age += dt;
      a.spinAngle += dt * 22;
      a.prevPos.copy(a.pos);

      a.vel.x += windAccelX * dt;
      a.vel.y += (windAccelY - gravity) * dt;
      a.pos.addScaledVector(a.vel, dt);

      this.tmpDir.copy(a.vel).normalize();
      a.group.position.copy(a.pos);
      a.group.quaternion.setFromUnitVectors(FWD_Z, this.tmpDir);
      a.group.rotateZ(a.spinAngle);

      // Subtle aerodynamic particle slipstream while airborne
      if (Math.floor(a.age * 60) % 2 === 0) {
        this.particles.spawnBurst(a.pos.x, a.pos.y, a.pos.z + 0.4, 0xf8fafc, 1, 0.6);
      }

      // Swept segment against our ONE championship target face plane
      if (a.prevPos.z >= faceZ && a.pos.z <= faceZ) {
        const alpha = (a.prevPos.z - faceZ) / Math.max(1e-5, a.prevPos.z - a.pos.z);
        const hx = a.prevPos.x + (a.pos.x - a.prevPos.x) * alpha;
        const hy = a.prevPos.y + (a.pos.y - a.prevPos.y) * alpha;
        const localX = hx - this.targetX;
        const localY = hy - this.targetY;
        const r = Math.hypot(localX, localY);

        if (r <= this.targetRadius * 1.04) {
          a.active = false;
          a.group.visible = false;
          const bow = this.bows[a.slot];
          if (bow) bow.inFlight = false;
          this.handleArrowHit(a, localX, localY);
          continue;
        }
      }

      if (a.pos.z < -20 || a.pos.y < -3.55 || a.age > 2.4) {
        a.active = false;
        a.group.visible = false;
        const bow = this.bows[a.slot];
        if (bow) bow.inFlight = false;
        this.handleArrowMiss(a);
      }
    }
  }

  private handleArrowMiss(arrow: FlyingArrow): void {
    this.streaksGold[arrow.slot] = 0;
    this.attemptScores[arrow.slot]![this.attemptIdx] = 0;

    this.particles.spawnBurst(
      arrow.pos.x,
      Math.max(-3.45, arrow.pos.y),
      arrow.pos.z,
      0x94a3b8,
      12,
      3.5,
    );
    this.ctx.audio.play("miss");
    this.ctx.sendHaptic(arrow.slot, "error");

    const name = this.getPlayerName(arrow.slot);
    this.ctx.hud.announce(`${name} · MISS (0 pts)`);
    this.ctx.sendPadHud?.(arrow.slot, {
      ammo: 0,
      maxAmmo: 10,
      reloading: false,
      streak: 0,
      prompt: `END ${this.attemptIdx + 1}/${TOTAL_ATTEMPTS} · MISS (0)`,
    });
    this.syncScoreboardHud();
  }

  private handleArrowHit(arrow: FlyingArrow, localX: number, localY: number): void {
    const spec = this.getCurrentSpec();
    const r = Math.hypot(localX, localY);
    const ratioR = r / this.targetRadius;

    let ringPts = 20;
    let ringLabel = "OUTER RING";
    let isGold = false;
    let isBullseye = false;

    if (ratioR <= 0.14) {
      ringPts = 100;
      ringLabel = "X-RING BULLSEYE!";
      isGold = true;
      isBullseye = true;
    } else if (ratioR <= 0.31) {
      ringPts = 85;
      ringLabel = "GOLD RING!";
      isGold = true;
    } else if (ratioR <= 0.51) {
      ringPts = 65;
      ringLabel = "CRIMSON";
    } else if (ratioR <= 0.72) {
      ringPts = 45;
      ringLabel = "BLUE";
    } else if (ratioR <= 0.89) {
      ringPts = 30;
      ringLabel = "DARK RING";
    }

    const nextGoldStreak = isGold ? (this.streaksGold[arrow.slot] ?? 0) + 1 : 0;
    this.streaksGold[arrow.slot] = nextGoldStreak;
    const streakBonus = nextGoldStreak >= 2 ? 25 * (nextGoldStreak - 1) : 0;
    const drawMult = arrow.drawRatio >= 0.82 ? 1.15 : 0.78 + arrow.drawRatio * 0.3;

    const totalPts = Math.round(
      (ringPts * spec.pointsMult * drawMult + streakBonus) * this.tuning.scoreMult,
    );
    this.scores[arrow.slot] = (this.scores[arrow.slot] ?? 0) + totalPts;
    this.attemptScores[arrow.slot]![this.attemptIdx] = totalPts;

    // Trigger physical off-center target torque & recoil
    this.targetRecoilZ = isBullseye ? 0.34 : 0.24;
    this.targetTiltVelX -= clamp(localY * 4.5, -6, 6);
    this.targetTiltVelY += clamp(localX * 4.5, -6, 6);

    // Pin persistent 3D arrow directly onto bossPivot so it rides rail & recoil together
    const p = this.pinnedArrows[this.pinnedCursor];
    this.pinnedCursor = (this.pinnedCursor + 1) % this.pinnedArrows.length;
    if (p) {
      p.active = true;
      p.localX = localX;
      p.localY = localY;
      p.localZ = 0.56;
      p.tiltX = (this.rng() - 0.5) * 0.07;
      p.tiltY = clamp(-this.windX * 0.025, -0.14, 0.14);
      p.age = 0;
      p.vaneMat.color.set(PLAYER_SLOT_PALETTE[arrow.slot]!.hex);
      p.group.position.set(p.localX, p.localY, p.localZ);
      p.group.visible = true;
    }

    const wx = this.targetX + localX;
    const wy = this.targetY + localY;
    const wz = this.targetZ + 0.42;
    const playerHex = PLAYER_SLOT_PALETTE[arrow.slot]!.hex;

    this.particles.spawnBurst(
      wx,
      wy,
      wz,
      isBullseye ? 0xfacc15 : playerHex,
      isBullseye ? 28 : 15,
      5.6,
    );
    if (isGold) {
      this.shockwaves.spawn(wx, wy, wz, 0xfacc15, 3.6, 0.36);
    }

    if (isBullseye) {
      this.localShake = Math.min(1, this.localShake + 0.35);
      this.ctx.fx.addScreenShake(0.3);
      this.ctx.fx.triggerHitStop(24);
      this.ctx.audio.play("bullseye");
      this.ctx.sendHaptic(arrow.slot, "combo");
    } else {
      this.ctx.fx.addScreenShake(0.12);
      this.ctx.audio.play("arrow_thunk");
      this.ctx.sendHaptic(arrow.slot, "hit");
    }

    const name = this.getPlayerName(arrow.slot);
    this.ctx.hud.announce(
      `${name} · ${ringLabel} +${totalPts}${nextGoldStreak >= 2 ? ` · ${nextGoldStreak}× GOLD` : ""}`,
    );

    this.ctx.sendPadHud?.(arrow.slot, {
      ammo: 0,
      maxAmmo: 10,
      reloading: false,
      streak: nextGoldStreak,
      prompt: `END ${this.attemptIdx + 1}/${TOTAL_ATTEMPTS} · ${ringLabel} +${totalPts}`,
    });
    this.syncScoreboardHud();
  }

  private stepPinnedArrows(dt: number): void {
    for (let i = 0; i < this.pinnedArrows.length; i++) {
      const p = this.pinnedArrows[i]!;
      if (!p.active) continue;
      p.age += dt;
      const wobble = Math.exp(-p.age * 5.0) * Math.sin(p.age * 40) * 0.14;
      p.group.position.set(p.localX, p.localY, p.localZ);
      p.group.rotation.set(p.tiltX + wobble, p.tiltY + wobble * 0.55, 0);
    }
  }

  private stepCameraMotion(dt: number): void {
    const glide = Math.min(1, dt * 4.8);
    this.camPos.lerp(this.camTargetPos, glide);
    this.camLookAt.lerp(this.camLookTarget, Math.min(1, dt * 6.5));
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
    if (abs < 0.3) return "Wind • Calm";
    const arrow = wx > 0 ? "→" : "←";
    return `Wind ${arrow} ${abs.toFixed(1)} m/s`;
  }

  private formatWindShort(): string {
    const abs = Math.abs(this.windX);
    if (abs < 0.3) return "CALM";
    return `WIND ${this.windX > 0 ? "→" : "←"}${abs.toFixed(1)}`;
  }

  private syncHudAll(): void {
    this.syncWindHud(true);
    this.syncScoreboardHud();
  }

  private finishGame(): void {
    if (this.roundFinished) return;
    this.roundFinished = true;
    this.ctx.audio.stopMusic?.();
    this.ctx.audio.play("end");
    this.ctx.hud.setWindHud?.(null);
    this.ctx.hud.setRoundLabel?.(null);
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
      attempts: this.attemptScores[p.slot] ?? [],
    }));
    this.ctx.hud.updateScoreboard(rows);
  }

  render(alpha: number): void {
    const connectedBows: BowSlot[] = [];
    for (let slot = 0; slot < this.bows.length; slot++) {
      if (this.bows[slot]!.connected) connectedBows.push(this.bows[slot]!);
    }
    const numActive = connectedBows.length;
    const hideBowsForInspect =
      this.attemptPhase === "inspect" || this.attemptPhase === "complete";

    for (let slot = 0; slot < this.bows.length; slot++) {
      const b = this.bows[slot]!;
      b.sight.group.visible = b.connected && !hideBowsForInspect && !b.shotThisEnd;
      b.bow3d.root.visible = b.connected && !hideBowsForInspect;
      if (!b.connected) continue;

      const rx = b.prevWorldX + (b.worldX - b.prevWorldX) * alpha;
      const ry = b.prevWorldY + (b.worldY - b.prevWorldY) * alpha;
      const zLayer = 0.25 + slot * 0.02;

      b.sight.group.position.set(rx, ry, zLayer);
      const scaleTension = b.drawing ? THREE.MathUtils.lerp(1.95, 0.72, b.drawRatio) : 1.0;
      b.sight.tensionRing.scale.setScalar(scaleTension);
      b.sight.tensionMat.opacity = b.drawing ? 0.94 : 0;
      b.sight.tensionMat.color.setHex(b.drawRatio >= 0.85 ? 0x22c55e : 0xfacc15);
      b.sight.outerRing.scale.setScalar(b.drawing ? 0.85 : 1.0);

      if (this.tuning.showAssistLead) {
        b.sight.leadMat.opacity = 0.65;
        b.sight.leadPip.position.set(
          this.windX * 0.25,
          -(0.12 + Math.abs(this.targetZ) * 0.012),
          -0.02,
        );
      } else {
        b.sight.leadMat.opacity = 0;
      }

      // Position player's 3D foreground recurve bow along firing line & aim toward crosshair!
      if (b.bow3d.root.visible) {
        const activeOrder = connectedBows.indexOf(b);
        const spreadX =
          numActive <= 1 ? 0 : ((activeOrder / (numActive - 1)) * 2 - 1) * 1.55;
        const bowBaseX = spreadX + clamp(rx * 0.14, -0.5, 0.5);
        const bowBaseY = -1.65 + clamp(ry * 0.14, -0.35, 0.45);
        const bowBaseZ = 9.8;
        b.bow3d.root.position.set(bowBaseX, bowBaseY, bowBaseZ);
        // Point bow's -Z axis (arrow tip) directly toward aim target via reflected lookAt
        const aimTargetZ = this.targetZ * 0.45;
        this.tmpAimPos.set(
          bowBaseX * 2 - rx,
          bowBaseY * 2 - ry,
          bowBaseZ * 2 - aimTargetZ,
        );
        b.bow3d.root.lookAt(this.tmpAimPos);
        // Slight natural archer cant
        b.bow3d.root.rotateZ(0.14);

        const vib = Math.sin(b.stringSnapPhase) * b.stringSnap;
        updateRecurveBowPose(b.bow3d, b.drawRatio, vib, !b.shotThisEnd);
      }
    }

    if (this.localShake > 0.002) {
      const mag = this.localShake * 0.15;
      this.camera.position.set(
        this.camPos.x + (Math.random() * 2 - 1) * mag,
        this.camPos.y + (Math.random() * 2 - 1) * mag,
        this.camPos.z,
      );
    } else {
      this.camera.position.copy(this.camPos);
    }
    this.camera.lookAt(this.camLookAt);

    this.renderer.render(this.scene, this.camera);
  }

  onResize(width: number, height: number, dpr: number): void {
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);
    this.camera.aspect = safeW / safeH;
    this.camera.updateProjectionMatrix();
    this.halfH = Math.tan(THREE.MathUtils.degToRad(FOV_BASE_DEG / 2)) * CAMERA_BASE_Z;
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
    this.ctx.hud.setRoundLabel?.(null);
    this.detachThemeObserver?.();
    this.detachThemeObserver = null;

    this.particles.dispose();
    this.shockwaves.dispose();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.renderer.dispose();
  }
}
