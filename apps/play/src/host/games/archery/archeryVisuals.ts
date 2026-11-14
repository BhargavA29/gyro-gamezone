import * as THREE from "three";

export interface ArcheryTextures {
  targetFace: THREE.CanvasTexture;
  targetBump: THREE.CanvasTexture;
  strawAlbedo: THREE.CanvasTexture;
  strawBump: THREE.CanvasTexture;
  woodAlbedo: THREE.CanvasTexture;
  woodBump: THREE.CanvasTexture;
  grassAlbedo: THREE.CanvasTexture;
  grassBump: THREE.CanvasTexture;
  envTex: THREE.CanvasTexture;
  disposables: THREE.Texture[];
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  return [canvas, ctx];
}

function toTex(
  canvas: HTMLCanvasElement,
  color: boolean,
  repeat = 1,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  if (repeat !== 1) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
  }
  tex.needsUpdate = true;
  return tex;
}

/** Simple deterministic pseudo-random helper for repeatable procedural textures. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function createTargetFaceTextures(): {
  albedo: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const size = 512;
  const c = size / 2;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  aCtx.fillStyle = "#e8d8b7";
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = "#404040";
  bCtx.fillRect(0, 0, size, size);

  const zones: ReadonlyArray<{
    r: number;
    fill: string;
    rim: string;
    bumpVal: string;
    num: string;
    numColor: string;
  }> = [
    { r: 244, fill: "#f8fafc", rim: "#94a3b8", bumpVal: "#686868", num: "2", numColor: "#475569" },
    { r: 204, fill: "#e2e8f0", rim: "#64748b", bumpVal: "#747474", num: "4", numColor: "#334155" },
    { r: 164, fill: "#1e293b", rim: "#475569", bumpVal: "#868686", num: "5", numColor: "#cbd5e1" },
    { r: 126, fill: "#0284c7", rim: "#0369a1", bumpVal: "#9a9a9a", num: "7", numColor: "#e0f2fe" },
    { r: 88, fill: "#dc2626", rim: "#991b1b", bumpVal: "#b2b2b2", num: "8", numColor: "#fee2e2" },
    { r: 52, fill: "#facc15", rim: "#b45309", bumpVal: "#d4d4d4", num: "9", numColor: "#78350f" },
    { r: 22, fill: "#fef08a", rim: "#854d0e", bumpVal: "#f5f5f5", num: "X", numColor: "#713f12" },
  ];

  for (const z of zones) {
    aCtx.beginPath();
    aCtx.arc(c, c, z.r, 0, Math.PI * 2);
    aCtx.fillStyle = z.fill;
    aCtx.fill();
    aCtx.strokeStyle = z.rim;
    aCtx.lineWidth = 2.5;
    aCtx.stroke();

    bCtx.beginPath();
    bCtx.arc(c, c, z.r, 0, Math.PI * 2);
    bCtx.fillStyle = z.bumpVal;
    bCtx.fill();
    bCtx.strokeStyle = "#222222";
    bCtx.lineWidth = 3;
    bCtx.stroke();
  }

  // Subtle paper weave / paint brush micro-grain
  for (let i = 0; i < 4200; i++) {
    const px = Math.floor(hash2(i, 1) * size);
    const py = Math.floor(hash2(i, 2) * size);
    const bright = hash2(i, 3) > 0.5;
    aCtx.fillStyle = bright ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.035)";
    aCtx.fillRect(px, py, 2, 2);
    bCtx.fillStyle = bright ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
    bCtx.fillRect(px, py, 2, 2);
  }

  // Painted score numerals at cardinal angles
  aCtx.font = "800 15px system-ui, -apple-system, sans-serif";
  aCtx.textAlign = "center";
  aCtx.textBaseline = "middle";
  for (let i = 0; i < zones.length - 1; i++) {
    const z = zones[i]!;
    const nextR = zones[i + 1]!.r;
    const midR = (z.r + nextR) * 0.5;
    aCtx.fillStyle = z.numColor;
    aCtx.fillText(z.num, c, c - midR);
    aCtx.fillText(z.num, c, c + midR);
  }

  // Gold X-Ring center mark
  aCtx.fillStyle = "#78350f";
  aCtx.font = "900 18px system-ui, -apple-system, sans-serif";
  aCtx.fillText("X", c, c + 1);

  return {
    albedo: toTex(albedoC, true),
    bump: toTex(bumpC, false),
  };
}

function createStrawTextures(): { albedo: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 256;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  aCtx.fillStyle = "#c99244";
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = "#808080";
  bCtx.fillRect(0, 0, size, size);

  // Braided rope coils along horizontal bands
  for (let y = 0; y < size; y += 8) {
    const shade = Math.floor(hash2(y, 7) * 28 - 14);
    aCtx.fillStyle = `rgb(${198 + shade}, ${144 + shade}, ${66 + Math.floor(shade * 0.6)})`;
    aCtx.fillRect(0, y, size, 6);
    aCtx.fillStyle = "#7c5020";
    aCtx.fillRect(0, y + 6, size, 2);

    bCtx.fillStyle = "#c8c8c8";
    bCtx.fillRect(0, y + 1, size, 4);
    bCtx.fillStyle = "#262626";
    bCtx.fillRect(0, y + 6, size, 2);

    for (let x = (y % 16 === 0 ? 0 : 8); x < size; x += 16) {
      aCtx.strokeStyle = "rgba(92, 56, 18, 0.55)";
      aCtx.lineWidth = 1.5;
      aCtx.beginPath();
      aCtx.moveTo(x, y);
      aCtx.lineTo(x + 6, y + 6);
      aCtx.stroke();

      bCtx.strokeStyle = "#555555";
      bCtx.lineWidth = 1.5;
      bCtx.beginPath();
      bCtx.moveTo(x, y);
      bCtx.lineTo(x + 6, y + 6);
      bCtx.stroke();
    }
  }

  return {
    albedo: toTex(albedoC, true, 2),
    bump: toTex(bumpC, false, 2),
  };
}

function createWoodTextures(): { albedo: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 256;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  aCtx.fillStyle = "#6e4726";
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = "#888888";
  bCtx.fillRect(0, 0, size, size);

  for (let x = 0; x < size; x += 3) {
    const n = hash2(x, 19);
    const wave = Math.sin(x * 0.14) * 14 + n * 16;
    aCtx.fillStyle = `rgb(${Math.round(98 + wave)}, ${Math.round(62 + wave * 0.65)}, ${Math.round(33 + wave * 0.38)})`;
    aCtx.fillRect(x, 0, 3, size);
    const bVal = Math.round(115 + wave * 2.1);
    bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
    bCtx.fillRect(x, 0, 3, size);
  }

  // Plank grooves
  for (let x = 64; x < size; x += 64) {
    aCtx.fillStyle = "#3a210e";
    aCtx.fillRect(x - 1, 0, 2, size);
    bCtx.fillStyle = "#222222";
    bCtx.fillRect(x - 1, 0, 3, size);
  }

  return {
    albedo: toTex(albedoC, true),
    bump: toTex(bumpC, false),
  };
}

function createGrassTextures(): { albedo: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  // Subtle alternating mowed turf bands
  const bands = 8;
  const bandW = size / bands;
  for (let i = 0; i < bands; i++) {
    aCtx.fillStyle = i % 2 === 0 ? "#244230" : "#1f3a2a";
    aCtx.fillRect(i * bandW, 0, bandW, size);
  }
  bCtx.fillStyle = "#787878";
  bCtx.fillRect(0, 0, size, size);

  // Grass tuft specks & bump relief
  for (let i = 0; i < 9000; i++) {
    const x = hash2(i, 11) * size;
    const y = hash2(i, 13) * size;
    const h = 3 + hash2(i, 17) * 6;
    aCtx.fillStyle = hash2(i, 23) > 0.5 ? "rgba(96, 168, 108, 0.28)" : "rgba(12, 28, 18, 0.25)";
    aCtx.fillRect(x, y, 2, h);
    bCtx.fillStyle = hash2(i, 29) > 0.5 ? "#a8a8a8" : "#4a4a4a";
    bCtx.fillRect(x, y, 2, h);
  }

  return {
    albedo: toTex(albedoC, true, 5),
    bump: toTex(bumpC, false, 5),
  };
}

function createSkyEnvTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 64);
  const grad = ctx.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0.0, "#3b82f6");
  grad.addColorStop(0.45, "#bae6fd");
  grad.addColorStop(0.52, "#fef3c7");
  grad.addColorStop(0.58, "#1e3a2f");
  grad.addColorStop(1.0, "#0f172a");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createArcheryTextures(): ArcheryTextures {
  const target = createTargetFaceTextures();
  const straw = createStrawTextures();
  const wood = createWoodTextures();
  const grass = createGrassTextures();
  const envTex = createSkyEnvTexture();

  return {
    targetFace: target.albedo,
    targetBump: target.bump,
    strawAlbedo: straw.albedo,
    strawBump: straw.bump,
    woodAlbedo: wood.albedo,
    woodBump: wood.bump,
    grassAlbedo: grass.albedo,
    grassBump: grass.bump,
    envTex,
    disposables: [
      target.albedo,
      target.bump,
      straw.albedo,
      straw.bump,
      wood.albedo,
      wood.bump,
      grass.albedo,
      grass.bump,
      envTex,
    ],
  };
}

export interface TargetAssemblyRefs {
  root: THREE.Group;
  bossPivot: THREE.Group;
  goldGlowMat: THREE.MeshStandardMaterial;
  wheelMeshes: THREE.Mesh[];
}

/**
 * Builds ONE sculptural 3D championship archery target mounted on an oak tripod & steel trolley.
 * Concentric 3D stepped ring disks protrude slightly in Z so key light accentuates every scoring boundary.
 */
export function buildChampionshipTarget(
  baseRadius: number,
  textures: ArcheryTextures,
  disposables: Array<{ dispose(): void }>,
): TargetAssemblyRefs {
  const root = new THREE.Group();
  const bossPivot = new THREE.Group();
  root.add(bossPivot);

  const strawMat = new THREE.MeshStandardMaterial({
    map: textures.strawAlbedo,
    bumpMap: textures.strawBump,
    bumpScale: 0.085,
    roughness: 0.9,
    metalness: 0.02,
  });

  const woodMat = new THREE.MeshStandardMaterial({
    map: textures.woodAlbedo,
    bumpMap: textures.woodBump,
    bumpScale: 0.06,
    roughness: 0.78,
    metalness: 0.04,
  });

  const burlapMat = new THREE.MeshStandardMaterial({
    color: 0x3b2a1c,
    bumpMap: textures.strawBump,
    bumpScale: 0.05,
    roughness: 0.95,
    metalness: 0.02,
  });

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    roughness: 0.3,
    metalness: 0.78,
  });

  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xf5b82e,
    roughness: 0.26,
    metalness: 0.85,
  });

  const facePaperMat = new THREE.MeshStandardMaterial({
    map: textures.targetFace,
    bumpMap: textures.targetBump,
    bumpScale: 0.032,
    roughness: 0.55,
    metalness: 0.04,
  });

  const goldGlowMat = new THREE.MeshStandardMaterial({
    color: 0xfacc15,
    emissive: 0xd97706,
    emissiveIntensity: 0.25,
    roughness: 0.28,
    metalness: 0.65,
  });

  // 1. Main coiled straw drum boss + burlap outer rim collar
  const bossGeo = new THREE.CylinderGeometry(baseRadius * 1.04, baseRadius * 1.07, 0.54, 40);
  bossGeo.rotateX(Math.PI / 2);
  const bossMesh = new THREE.Mesh(bossGeo, strawMat);
  bossPivot.add(bossMesh);

  const rimGeo = new THREE.TorusGeometry(baseRadius * 1.03, 0.085, 12, 42);
  const rimMesh = new THREE.Mesh(rimGeo, burlapMat);
  rimMesh.position.z = 0.22;
  bossPivot.add(rimMesh);

  // 2. Sculpted physical 3D face + stepped relief rings (0..4 tiers projecting slightly forward)
  const mainFaceGeo = new THREE.CircleGeometry(baseRadius * 0.99, 44);
  const mainFaceMesh = new THREE.Mesh(mainFaceGeo, facePaperMat);
  mainFaceMesh.position.z = 0.275;
  bossPivot.add(mainFaceMesh);

  const reliefSpecs: ReadonlyArray<{ rRatio: number; color: number; depth: number; isGold?: boolean }> = [
    { rRatio: 0.54, color: 0x0284c7, depth: 0.014 },
    { rRatio: 0.37, color: 0xdc2626, depth: 0.022 },
    { rRatio: 0.22, color: 0xfacc15, depth: 0.032, isGold: true },
  ];

  const reliefMats: THREE.Material[] = [];
  for (let i = 0; i < reliefSpecs.length; i++) {
    const spec = reliefSpecs[i]!;
    const nextR = i + 1 < reliefSpecs.length ? reliefSpecs[i + 1]!.rRatio : 0.095;
    const outerR = baseRadius * spec.rRatio;
    const innerR = baseRadius * nextR;
    const ringGeo = new THREE.RingGeometry(innerR, outerR, 40);
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      bumpMap: textures.targetBump,
      bumpScale: 0.02,
      roughness: spec.isGold ? 0.34 : 0.5,
      metalness: spec.isGold ? 0.35 : 0.05,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(ringGeo, mat);
    ringMesh.position.z = 0.28 + spec.depth;
    bossPivot.add(ringMesh);
    disposables.push(ringGeo);
    reliefMats.push(mat);
  }

  // Raised metallic 3D brass X-ring button right at bullseye dead center
  const centerRimGeo = new THREE.TorusGeometry(baseRadius * 0.1, 0.022, 10, 28);
  const centerRimMesh = new THREE.Mesh(centerRimGeo, goldGlowMat);
  centerRimMesh.position.z = 0.295;
  bossPivot.add(centerRimMesh);

  // Brass mounting medallions on top & corners
  const rivetGeo = new THREE.SphereGeometry(0.065, 10, 8);
  for (const ang of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
    const rivet = new THREE.Mesh(rivetGeo, brassMat);
    rivet.position.set(Math.cos(ang) * baseRadius * 0.94, Math.sin(ang) * baseRadius * 0.94, 0.29);
    bossPivot.add(rivet);
  }

  // 3. Oak A-frame tripod stand + crossbeam + sliding trolley undercarriage
  const legHeight = 3.85;
  const frontLegGeo = new THREE.BoxGeometry(0.2, legHeight, 0.2);
  const backLegGeo = new THREE.BoxGeometry(0.18, legHeight * 1.04, 0.18);
  const crossBeamGeo = new THREE.BoxGeometry(baseRadius * 1.68, 0.2, 0.22);
  const trolleyDeckGeo = new THREE.BoxGeometry(baseRadius * 1.9, 0.22, 1.35);
  const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.16, 16);
  wheelGeo.rotateZ(Math.PI / 2);

  const leftLeg = new THREE.Mesh(frontLegGeo, woodMat);
  leftLeg.position.set(-baseRadius * 0.64, -1.55, 0.05);
  leftLeg.rotation.z = -0.15;
  const rightLeg = new THREE.Mesh(frontLegGeo, woodMat);
  rightLeg.position.set(baseRadius * 0.64, -1.55, 0.05);
  rightLeg.rotation.z = 0.15;
  const backLeg = new THREE.Mesh(backLegGeo, woodMat);
  backLeg.position.set(0, -1.52, -0.78);
  backLeg.rotation.x = 0.3;

  const crossBeam = new THREE.Mesh(crossBeamGeo, woodMat);
  crossBeam.position.set(0, -1.25, 0.02);

  const deckY = -3.35;
  const deck = new THREE.Mesh(trolleyDeckGeo, steelMat);
  deck.position.set(0, deckY, -0.25);

  const wheelMeshes: THREE.Mesh[] = [];
  for (const wx of [-baseRadius * 0.72, baseRadius * 0.72]) {
    for (const wz of [-0.65, 0.15]) {
      const wheel = new THREE.Mesh(wheelGeo, brassMat);
      wheel.position.set(wx, deckY - 0.18, wz);
      wheelMeshes.push(wheel);
      root.add(wheel);
    }
  }

  root.add(leftLeg, rightLeg, backLeg, crossBeam, deck);

  disposables.push(
    strawMat,
    woodMat,
    burlapMat,
    steelMat,
    brassMat,
    facePaperMat,
    goldGlowMat,
    bossGeo,
    rimGeo,
    mainFaceGeo,
    centerRimGeo,
    rivetGeo,
    frontLegGeo,
    backLegGeo,
    crossBeamGeo,
    trolleyDeckGeo,
    wheelGeo,
    ...reliefMats,
  );

  return { root, bossPivot, goldGlowMat, wheelMeshes };
}

export interface RecurveBowRefs {
  root: THREE.Group;
  upperLimbPivot: THREE.Group;
  lowerLimbPivot: THREE.Group;
  upperStringMesh: THREE.Mesh;
  lowerStringMesh: THREE.Mesh;
  nockMesh: THREE.Mesh;
  nockedArrowGroup: THREE.Group;
}

/**
 * Builds a sleek 3D foreground recurve bow with flexing laminated limbs & dynamic bowstring.
 */
export function buildRecurveBow(
  playerHex: string,
  textures: ArcheryTextures,
  disposables: Array<{ dispose(): void }>,
): RecurveBowRefs {
  const root = new THREE.Group();

  const riserMat = new THREE.MeshStandardMaterial({
    color: playerHex,
    roughness: 0.34,
    metalness: 0.62,
  });
  const limbMat = new THREE.MeshStandardMaterial({
    map: textures.woodAlbedo,
    bumpMap: textures.woodBump,
    bumpScale: 0.04,
    color: 0xe6caa0,
    roughness: 0.52,
    metalness: 0.08,
  });
  const stringMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
  const gripMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.88,
    metalness: 0.05,
  });

  // Sculpted central riser + grip
  const riserGeo = new THREE.BoxGeometry(0.11, 0.72, 0.14);
  const gripGeo = new THREE.BoxGeometry(0.125, 0.24, 0.155);
  const riser = new THREE.Mesh(riserGeo, riserMat);
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.position.y = -0.06;
  root.add(riser, grip);

  // Upper & lower limbs angled gracefully outward with hinge pivots for real flexing
  const limbGeo = new THREE.BoxGeometry(0.068, 0.78, 0.032);
  const upperLimbPivot = new THREE.Group();
  upperLimbPivot.position.set(0, 0.34, -0.02);
  const upperLimb = new THREE.Mesh(limbGeo, limbMat);
  upperLimb.position.set(0, 0.39, 0.04);
  upperLimb.rotation.x = 0.12;
  upperLimbPivot.add(upperLimb);

  const lowerLimbPivot = new THREE.Group();
  lowerLimbPivot.position.set(0, -0.34, -0.02);
  const lowerLimb = new THREE.Mesh(limbGeo, limbMat);
  lowerLimb.position.set(0, -0.39, 0.04);
  lowerLimb.rotation.x = -0.12;
  lowerLimbPivot.add(lowerLimb);

  // Two-piece dynamic string spanning from upper tip -> nock point -> lower tip
  const strGeo = new THREE.CylinderGeometry(0.008, 0.008, 1.0, 6);
  const upperStringMesh = new THREE.Mesh(strGeo, stringMat);
  const lowerStringMesh = new THREE.Mesh(strGeo, stringMat);

  const nockGeo = new THREE.SphereGeometry(0.024, 8, 8);
  const nockMesh = new THREE.Mesh(nockGeo, stringMat);

  const nockedArrow = buildArrowGroup(playerHex, textures, disposables);
  nockedArrow.group.scale.setScalar(0.68);
  nockedArrow.group.position.set(0, 0.04, -0.2);

  root.add(upperLimbPivot, lowerLimbPivot, upperStringMesh, lowerStringMesh, nockMesh, nockedArrow.group);

  disposables.push(
    riserMat,
    limbMat,
    stringMat,
    gripMat,
    riserGeo,
    gripGeo,
    limbGeo,
    strGeo,
    nockGeo,
  );

  return {
    root,
    upperLimbPivot,
    lowerLimbPivot,
    upperStringMesh,
    lowerStringMesh,
    nockMesh,
    nockedArrowGroup: nockedArrow.group,
  };
}

/**
 * Updates 3D bow limb bend, string V-tension, and nocked arrow draw pullback without heap allocations.
 */
export function updateRecurveBowPose(
  bow: RecurveBowRefs,
  drawRatio: number,
  stringSnapVib: number,
  showArrow: boolean,
): void {
  const bendRad = drawRatio * 0.24;
  bow.upperLimbPivot.rotation.x = bendRad;
  bow.lowerLimbPivot.rotation.x = -bendRad;

  const tipY = 1.08 - drawRatio * 0.06;
  const tipZ = 0.08 + drawRatio * 0.14;
  const pullZ = 0.14 + drawRatio * 0.62 + stringSnapVib * 0.08;

  bow.nockMesh.position.set(0, 0.02, pullZ);
  bow.nockedArrowGroup.visible = showArrow;
  bow.nockedArrowGroup.position.set(0, 0.02, pullZ - 0.72);

  // Align upper string segment midpoint between (0, tipY, tipZ) and (0, 0.02, pullZ)
  const dyUp = tipY - 0.02;
  const dzUp = tipZ - pullZ;
  const lenUp = Math.hypot(dyUp, dzUp);
  bow.upperStringMesh.position.set(0, (tipY + 0.02) * 0.5, (tipZ + pullZ) * 0.5);
  bow.upperStringMesh.scale.set(1, lenUp, 1);
  bow.upperStringMesh.rotation.x = Math.atan2(dzUp, dyUp);

  // Align lower string segment midpoint between (0, -tipY, tipZ) and (0, 0.02, pullZ)
  const dyDn = -tipY - 0.02;
  const dzDn = tipZ - pullZ;
  const lenDn = Math.hypot(dyDn, dzDn);
  bow.lowerStringMesh.position.set(0, (-tipY + 0.02) * 0.5, (tipZ + pullZ) * 0.5);
  bow.lowerStringMesh.scale.set(1, lenDn, 1);
  bow.lowerStringMesh.rotation.x = Math.atan2(dzDn, dyDn) + Math.PI;
}

export interface ArticulatedWindBanner {
  root: THREE.Group;
  pivot: THREE.Group;
  segments: THREE.Mesh[];
  phase: number;
}

/**
 * Creates a grounded range banner pole with a multi-segment cloth ribbon that ripples in crosswinds.
 */
export function buildWindBanner(
  poleHeight: number,
  accentColor: number,
  textures: ArcheryTextures,
  disposables: Array<{ dispose(): void }>,
): ArticulatedWindBanner {
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.position.y = poleHeight - 0.35;

  const poleMat = new THREE.MeshStandardMaterial({
    map: textures.woodAlbedo,
    bumpMap: textures.woodBump,
    bumpScale: 0.04,
    roughness: 0.7,
    metalness: 0.1,
  });
  const finialMat = new THREE.MeshStandardMaterial({
    color: 0xf5b82e,
    roughness: 0.25,
    metalness: 0.85,
  });
  const clothMat = new THREE.MeshStandardMaterial({
    color: accentColor,
    roughness: 0.65,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  const poleGeo = new THREE.CylinderGeometry(0.08, 0.11, poleHeight, 10);
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = poleHeight * 0.5;
  root.add(pole);

  const finialGeo = new THREE.SphereGeometry(0.14, 10, 8);
  const finial = new THREE.Mesh(finialGeo, finialMat);
  finial.position.y = poleHeight + 0.08;
  root.add(finial);

  const segGeo = new THREE.BoxGeometry(0.42, 0.36, 0.026);
  segGeo.translate(0.21, 0, 0);

  const segments: THREE.Mesh[] = [];
  let parentObj: THREE.Object3D = pivot;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(segGeo, clothMat);
    const scaleY = 1 - i * 0.13;
    seg.scale.set(1, scaleY, 1);
    if (i > 0) {
      seg.position.set(0.39, 0, 0);
    }
    parentObj.add(seg);
    segments.push(seg);
    parentObj = seg;
  }

  root.add(pivot);
  disposables.push(poleMat, finialMat, clothMat, segGeo, poleGeo, finialGeo);
  return { root, pivot, segments, phase: 0 };
}

/**
 * Creates a detailed 3D tournament arrow oriented along -Z with steel broadhead & carbon shaft.
 */
export function buildArrowGroup(
  fletchingColorHex: string | number,
  textures: ArcheryTextures,
  disposables: Array<{ dispose(): void }>,
): { group: THREE.Group; vaneMat: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();

  const shaftGeo = new THREE.CylinderGeometry(0.03, 0.028, 2.25, 8);
  shaftGeo.rotateX(Math.PI / 2);
  const ferruleGeo = new THREE.CylinderGeometry(0.04, 0.032, 0.1, 8);
  ferruleGeo.rotateX(Math.PI / 2);
  const headGeo = new THREE.ConeGeometry(0.068, 0.26, 6);
  headGeo.rotateX(-Math.PI / 2);
  const vaneGeo = new THREE.BoxGeometry(0.014, 0.15, 0.36);

  const shaftMat = new THREE.MeshStandardMaterial({
    map: textures.woodAlbedo,
    color: 0xe2c799,
    roughness: 0.42,
    metalness: 0.18,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.2,
    metalness: 0.9,
  });
  const vaneMat = new THREE.MeshBasicMaterial({ color: fletchingColorHex });

  disposables.push(shaftGeo, ferruleGeo, headGeo, vaneGeo, shaftMat, headMat, vaneMat);

  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  const ferrule = new THREE.Mesh(ferruleGeo, headMat);
  ferrule.position.z = -1.12;
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.z = -1.28;

  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(vaneGeo, vaneMat);
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.sin(a) * 0.054, Math.cos(a) * 0.054, 0.92);
    fin.rotation.z = -a;
    group.add(fin);
  }

  group.add(shaft, ferrule, head);
  return { group, vaneMat };
}

export interface BowSightRefs {
  group: THREE.Group;
  outerRing: THREE.Mesh;
  outerMat: THREE.MeshBasicMaterial;
  tensionRing: THREE.Mesh;
  tensionMat: THREE.MeshBasicMaterial;
  centerDot: THREE.Mesh;
  leadPip: THREE.Mesh;
  leadMat: THREE.MeshBasicMaterial;
}

export function buildBowSight(
  playerHex: string,
  disposables: Array<{ dispose(): void }>,
): BowSightRefs {
  const group = new THREE.Group();

  const outerGeo = new THREE.RingGeometry(0.24, 0.29, 32);
  const tensionGeo = new THREE.RingGeometry(0.3, 0.35, 32);
  const dotGeo = new THREE.CircleGeometry(0.065, 16);
  const leadGeo = new THREE.RingGeometry(0.09, 0.14, 18);

  const outerMat = new THREE.MeshBasicMaterial({
    color: playerHex,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
  });
  const tensionMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
  });
  const leadMat = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });

  disposables.push(outerGeo, tensionGeo, dotGeo, leadGeo, outerMat, tensionMat, dotMat, leadMat);

  const outerRing = new THREE.Mesh(outerGeo, outerMat);
  const tensionRing = new THREE.Mesh(tensionGeo, tensionMat);
  const centerDot = new THREE.Mesh(dotGeo, dotMat);
  const leadPip = new THREE.Mesh(leadGeo, leadMat);
  leadPip.position.z = -0.02;

  group.add(leadPip, outerRing, tensionRing, centerDot);
  return {
    group,
    outerRing,
    outerMat,
    tensionRing,
    tensionMat,
    centerDot,
    leadPip,
    leadMat,
  };
}
