import * as THREE from "three";

export interface ArcheryTextures {
  targetFace: THREE.CanvasTexture;
  strawSide: THREE.CanvasTexture;
  badges: {
    near: THREE.CanvasTexture;
    mid: THREE.CanvasTexture;
    far: THREE.CanvasTexture;
  };
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

function toTex(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createTargetFaceTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 256);
  const c = 128;

  ctx.fillStyle = "#d4a359";
  ctx.fillRect(0, 0, 256, 256);

  const zones: ReadonlyArray<{ r: number; fill: string; stroke: string }> = [
    { r: 122, fill: "#f8fafc", stroke: "#cbd5e1" }, // 1-2 White
    { r: 98, fill: "#1e293b", stroke: "#475569" }, // 3-4 Black/Charcoal
    { r: 74, fill: "#0ea5e9", stroke: "#0369a1" }, // 5-6 Blue
    { r: 50, fill: "#ef4444", stroke: "#b91c1c" }, // 7-8 Red
    { r: 27, fill: "#facc15", stroke: "#ca8a04" }, // 9-10 Gold
    { r: 12, fill: "#fde047", stroke: "#a16207" }, // X-ring
  ];

  for (const z of zones) {
    ctx.beginPath();
    ctx.arc(c, c, z.r, 0, Math.PI * 2);
    ctx.fillStyle = z.fill;
    ctx.fill();
    ctx.strokeStyle = z.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Crosshair center tick
  ctx.strokeStyle = "#78350f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(c - 5, c);
  ctx.lineTo(c + 5, c);
  ctx.moveTo(c, c - 5);
  ctx.lineTo(c, c + 5);
  ctx.stroke();

  return toTex(canvas);
}

function createStrawTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  ctx.fillStyle = "#c9964a";
  ctx.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 6) {
    ctx.fillStyle = y % 12 === 0 ? "#b07c36" : "#dbb067";
    ctx.fillRect(0, y, 128, 3);
  }
  return toTex(canvas);
}

function createDistanceBadge(label: string, accentHex: string): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(192, 64);
  ctx.clearRect(0, 0, 192, 64);

  ctx.fillStyle = "#111827";
  ctx.beginPath();
  ctx.roundRect(4, 4, 184, 56, 12);
  ctx.fill();
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.font = "700 26px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 96, 33);

  return toTex(canvas);
}

export function createArcheryTextures(): ArcheryTextures {
  const targetFace = createTargetFaceTexture();
  const strawSide = createStrawTexture();
  const badges = {
    near: createDistanceBadge("18m · 1×", "#38bdf8"),
    mid: createDistanceBadge("32m · 1.5×", "#f59e0b"),
    far: createDistanceBadge("48m · 2.2×", "#ef4444"),
  };
  return {
    targetFace,
    strawSide,
    badges,
    disposables: [targetFace, strawSide, badges.near, badges.mid, badges.far],
  };
}

/**
 * Creates a low-poly 3D arrow oriented forward along -Z so velocity-quaternion alignment works cleanly.
 */
export function buildArrowGroup(
  fletchingColorHex: string | number,
  toonGradient: THREE.DataTexture,
  disposables: Array<{ dispose(): void }>,
): { group: THREE.Group; vaneMat: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();

  const shaftGeo = new THREE.CylinderGeometry(0.032, 0.032, 2.2, 6);
  shaftGeo.rotateX(Math.PI / 2);
  const headGeo = new THREE.ConeGeometry(0.075, 0.24, 4);
  headGeo.rotateX(-Math.PI / 2);
  const vaneGeo = new THREE.BoxGeometry(0.015, 0.16, 0.36);

  const shaftMat = new THREE.MeshToonMaterial({ color: 0xdfb882, gradientMap: toonGradient });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
  const vaneMat = new THREE.MeshBasicMaterial({ color: fletchingColorHex });

  disposables.push(shaftGeo, headGeo, vaneGeo, shaftMat, headMat, vaneMat);

  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.z = -1.2;

  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(vaneGeo, vaneMat);
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.sin(a) * 0.055, Math.cos(a) * 0.055, 0.88);
    fin.rotation.z = -a;
    group.add(fin);
  }

  group.add(shaft, head);
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

  const outerGeo = new THREE.RingGeometry(0.26, 0.32, 28);
  const tensionGeo = new THREE.RingGeometry(0.32, 0.37, 28);
  const dotGeo = new THREE.CircleGeometry(0.075, 16);
  const leadGeo = new THREE.RingGeometry(0.09, 0.14, 16);

  const outerMat = new THREE.MeshBasicMaterial({
    color: playerHex,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
  });
  const tensionMat = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    transparent: true,
    opacity: 0.0,
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
    opacity: 0.0,
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
