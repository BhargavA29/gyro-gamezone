import * as THREE from "three";

export type FruitTextureKey =
  | "watermelon"
  | "orange"
  | "kiwi"
  | "pineapple"
  | "starfruit"
  | "bomb";

export interface FruitTexturePack {
  skins: Record<FruitTextureKey, THREE.CanvasTexture>;
  flesh: Record<Exclude<FruitTextureKey, "bomb">, THREE.CanvasTexture>;
  splats: THREE.CanvasTexture[];
  disposables: THREE.Texture[];
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable for procedural fruit textures");
  }
  return [canvas, ctx];
}

function toTexture(canvas: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createWatermelonSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#15803d");
  grad.addColorStop(0.5, "#1ea34a");
  grad.addColorStop(1, "#14532d");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Dark jagged emerald stripes wrapping the sphere
  const stripeCount = 8;
  for (let i = 0; i < stripeCount; i++) {
    const cx = ((i + 0.5) / stripeCount) * 256;
    ctx.beginPath();
    for (let y = 0; y <= 256; y += 8) {
      const wobble = Math.sin(y * 0.14 + i * 1.9) * 5.5 + Math.cos(y * 0.28 + i) * 3;
      const w = 9.5 + Math.sin(y * 0.08 + i) * 3;
      if (y === 0) ctx.moveTo(cx - w + wobble, y);
      else ctx.lineTo(cx - w + wobble, y);
    }
    for (let y = 256; y >= 0; y -= 8) {
      const wobble = Math.sin(y * 0.14 + i * 1.9) * 5.5 + Math.cos(y * 0.28 + i) * 3;
      const w = 9.5 + Math.sin(y * 0.08 + i) * 3;
      ctx.lineTo(cx + w + wobble, y);
    }
    ctx.closePath();
    ctx.fillStyle = "#083d1b";
    ctx.fill();
  }

  // Light shine flecks
  ctx.fillStyle = "rgba(187, 247, 208, 0.16)";
  for (let i = 0; i < 42; i++) {
    const sx = ((i * 59) % 240) + 8;
    const sy = ((i * 97) % 240) + 8;
    ctx.beginPath();
    ctx.arc(sx, sy, 2 + (i % 3), 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(canvas);
}

function createWatermelonFlesh(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const c = 128;
  ctx.fillStyle = "#16a34a";
  ctx.fillRect(0, 0, 256, 256);

  // Pale green-white pith ring
  ctx.beginPath();
  ctx.arc(c, c, 118, 0, Math.PI * 2);
  ctx.fillStyle = "#ecfccb";
  ctx.fill();

  // Deep ruby radial center
  const rad = ctx.createRadialGradient(c, c, 12, c, c, 108);
  rad.addColorStop(0, "#ff2a55");
  rad.addColorStop(0.75, "#f43f5e");
  rad.addColorStop(1, "#e11d48");
  ctx.beginPath();
  ctx.arc(c, c, 108, 0, Math.PI * 2);
  ctx.fillStyle = rad;
  ctx.fill();

  // Black teardrop seeds arranged radially
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.15;
    const r = i % 2 === 0 ? 64 : 52;
    ctx.save();
    ctx.translate(c + Math.cos(a) * r, c + Math.sin(a) * r);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.ellipse(0, 0, 5.5, 10.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1314";
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-1.5, -3, 1.5, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fill();
    ctx.restore();
  }
  return toTexture(canvas);
}

function createOrangeSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const grad = ctx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, "#fb923c");
  grad.addColorStop(0.5, "#f97316");
  grad.addColorStop(1, "#ea580c");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Citrus peel pores
  for (let i = 0; i < 240; i++) {
    const x = (i * 73) % 256;
    const y = (i * 139) % 256;
    ctx.fillStyle = i % 3 === 0 ? "rgba(255, 237, 213, 0.25)" : "rgba(154, 52, 18, 0.26)";
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(canvas);
}

function createOrangeFlesh(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const c = 128;
  ctx.fillStyle = "#f97316";
  ctx.fillRect(0, 0, 256, 256);

  // White pith border
  ctx.beginPath();
  ctx.arc(c, c, 114, 0, Math.PI * 2);
  ctx.fillStyle = "#fff7ed";
  ctx.fill();

  // 8 juicy wedges
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * Math.PI * 2 + 0.055;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - 0.055;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, 102, a0, a1);
    ctx.closePath();
    ctx.fillStyle = "#ff8c1a";
    ctx.fill();

    // Inner bright highlight triangle inside wedge
    ctx.beginPath();
    ctx.moveTo(c + Math.cos((a0 + a1) * 0.5) * 18, c + Math.sin((a0 + a1) * 0.5) * 18);
    ctx.arc(c, c, 86, a0 + 0.04, a1 - 0.04);
    ctx.closePath();
    ctx.fillStyle = "#fdba74";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(c, c, 15, 0, Math.PI * 2);
  ctx.fillStyle = "#fff7ed";
  ctx.fill();
  return toTexture(canvas);
}

function createKiwiSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#7c532d");
  grad.addColorStop(0.5, "#8f6237");
  grad.addColorStop(1, "#623f1e");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Fine fibrous fuzzy kiwi skin striations
  for (let i = 0; i < 320; i++) {
    const x = (i * 47) % 256;
    const y = (i * 89) % 256;
    ctx.strokeStyle = i % 2 === 0 ? "rgba(62, 39, 18, 0.35)" : "rgba(181, 138, 86, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 2);
    ctx.lineTo(x + 4, y + 2);
    ctx.stroke();
  }
  return toTexture(canvas);
}

function createKiwiFlesh(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const c = 128;
  ctx.fillStyle = "#7c532d";
  ctx.fillRect(0, 0, 256, 256);

  const grad = ctx.createRadialGradient(c, c, 24, c, c, 118);
  grad.addColorStop(0, "#bef264");
  grad.addColorStop(0.55, "#84cc16");
  grad.addColorStop(1, "#4d7c0f");
  ctx.beginPath();
  ctx.arc(c, c, 116, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Radial bright spokes
  ctx.strokeStyle = "rgba(236, 252, 203, 0.42)";
  ctx.lineWidth = 2.5;
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * 28, c + Math.sin(a) * 28);
    ctx.lineTo(c + Math.cos(a) * 96, c + Math.sin(a) * 96);
    ctx.stroke();
  }

  // Creamy white center core
  ctx.beginPath();
  ctx.ellipse(c, c, 32, 22, 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "#ecfccb";
  ctx.fill();

  // Seed ring
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r = i % 2 === 0 ? 48 : 54;
    ctx.beginPath();
    ctx.ellipse(c + Math.cos(a) * r, c + Math.sin(a) * r, 3.6, 2.2, a, 0, Math.PI * 2);
    ctx.fillStyle = "#171717";
    ctx.fill();
  }
  return toTexture(canvas);
}

function createPineappleSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  ctx.fillStyle = "#eab308";
  ctx.fillRect(0, 0, 256, 256);

  // Diagonal criss-cross diamond scales
  ctx.strokeStyle = "#92400e";
  ctx.lineWidth = 4;
  const step = 32;
  for (let offset = -256; offset <= 512; offset += step) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + 256, 256);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(offset, 256);
    ctx.lineTo(offset + 256, 0);
    ctx.stroke();
  }

  // Amber center dimple dots in diamond cells
  ctx.fillStyle = "#b45309";
  for (let y = 16; y < 256; y += step) {
    for (let x = 16; x < 256; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x - step / 2, y - step / 2, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return toTexture(canvas);
}

function createPineappleFlesh(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const c = 128;
  ctx.fillStyle = "#ca8a04";
  ctx.fillRect(0, 0, 256, 256);

  const grad = ctx.createRadialGradient(c, c, 20, c, c, 114);
  grad.addColorStop(0, "#fef9c3");
  grad.addColorStop(0.32, "#fde047");
  grad.addColorStop(0.95, "#facc15");
  ctx.beginPath();
  ctx.arc(c, c, 112, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Fibrous core circle
  ctx.beginPath();
  ctx.arc(c, c, 28, 0, Math.PI * 2);
  ctx.fillStyle = "#fef08a";
  ctx.fill();
  ctx.strokeStyle = "rgba(180, 83, 9, 0.25)";
  ctx.lineWidth = 3;
  ctx.stroke();
  return toTexture(canvas);
}

function createStarfruitSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const grad = ctx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, "#fde047");
  grad.addColorStop(0.5, "#facc15");
  grad.addColorStop(1, "#f59e0b");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  ctx.strokeStyle = "rgba(161, 98, 7, 0.45)";
  ctx.lineWidth = 5;
  for (let x = 24; x < 256; x += 51) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  return toTexture(canvas);
}

function createStarfruitFlesh(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const c = 128;
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(0, 0, 256, 256);

  ctx.beginPath();
  ctx.arc(c, c, 114, 0, Math.PI * 2);
  ctx.fillStyle = "#fef08a";
  ctx.fill();

  // Inner bright star emblem
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 78 : 36;
    const px = c + Math.cos(a) * r;
    const py = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = "#fffbeb";
  ctx.fill();
  return toTexture(canvas);
}

function createBombSkin(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256);
  const grad = ctx.createRadialGradient(96, 86, 16, 128, 128, 148);
  grad.addColorStop(0, "#3b4254");
  grad.addColorStop(0.55, "#1c212c");
  grad.addColorStop(1, "#0b0e14");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Rivet band along equator
  ctx.fillStyle = "#4b5563";
  ctx.fillRect(0, 118, 256, 20);
  ctx.fillStyle = "#9ca3af";
  for (let x = 16; x < 256; x += 32) {
    ctx.beginPath();
    ctx.arc(x, 128, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bold hazard X emblem on front UV center (u=0.5, v=0.5)
  ctx.save();
  ctx.translate(128, 128);
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = 18;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-28, -28);
  ctx.lineTo(28, 28);
  ctx.moveTo(28, -28);
  ctx.lineTo(-28, 28);
  ctx.stroke();
  ctx.restore();

  return toTexture(canvas);
}

function createJuiceSplatTexture(variant: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128);
  const c = 64;
  ctx.clearRect(0, 0, 128, 128);

  // White alpha mask so MeshBasicMaterial.color tints dynamically per fruit
  ctx.fillStyle = "#ffffff";

  // Irregular central splash puddle with organic lobes
  ctx.beginPath();
  const points = 24;
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const wave =
      26 +
      Math.sin(a * 4 + variant * 1.7) * 9 +
      Math.cos(a * 7 + variant * 2.9) * 7 +
      Math.sin(a * 2 + variant) * 4;
    const x = c + Math.cos(a) * wave;
    const y = c + Math.sin(a) * wave;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // Scattered radial droplets
  for (let d = 0; d < 10; d++) {
    const a = ((d + 0.35 * variant) / 10) * Math.PI * 2;
    const dist = 36 + ((d * 13 + variant * 7) % 20);
    const r = 3.2 + ((d + variant) % 4) * 1.4;
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * dist, c + Math.sin(a) * dist, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Gravity drip streak downwards
  ctx.beginPath();
  ctx.roundRect(c - 4 + (variant - 1.5) * 6, c + 18, 8, 28 + variant * 5, 4);
  ctx.fill();

  return toTexture(canvas, false);
}

export function createFruitTexturePack(): FruitTexturePack {
  const skins: FruitTexturePack["skins"] = {
    watermelon: createWatermelonSkin(),
    orange: createOrangeSkin(),
    kiwi: createKiwiSkin(),
    pineapple: createPineappleSkin(),
    starfruit: createStarfruitSkin(),
    bomb: createBombSkin(),
  };
  const flesh: FruitTexturePack["flesh"] = {
    watermelon: createWatermelonFlesh(),
    orange: createOrangeFlesh(),
    kiwi: createKiwiFlesh(),
    pineapple: createPineappleFlesh(),
    starfruit: createStarfruitFlesh(),
  };
  const splats = [
    createJuiceSplatTexture(0),
    createJuiceSplatTexture(1),
    createJuiceSplatTexture(2),
    createJuiceSplatTexture(3),
  ];

  const disposables: THREE.Texture[] = [
    ...Object.values(skins),
    ...Object.values(flesh),
    ...splats,
  ];
  return { skins, flesh, splats, disposables };
}

export interface SwordVisualRefs {
  group: THREE.Group;
  bladeMesh: THREE.Mesh;
  edgeMat: THREE.MeshBasicMaterial;
  spineMat: THREE.MeshBasicMaterial;
  guardMesh: THREE.Mesh;
  gripMat: THREE.MeshBasicMaterial;
  sheathRing: THREE.Mesh;
  sheathMat: THREE.MeshBasicMaterial;
}

/**
 * Builds a low-poly 3D Katana cursor oriented so the sharp blade belly/tip sits right around (0, 0).
 */
export function buildSwordVisual(
  playerHex: string,
  disposables: Array<{ dispose(): void }>,
): SwordVisualRefs {
  const group = new THREE.Group();

  // Steel blade + player-colored spine inside a tilted sub-assembly
  const swordPivot = new THREE.Group();
  swordPivot.rotation.z = -Math.PI * 0.22;

  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(-0.07, -0.42);
  bladeShape.lineTo(0.06, -0.42);
  bladeShape.lineTo(0.05, 0.72);
  bladeShape.lineTo(0.0, 1.02);
  bladeShape.lineTo(-0.06, 0.78);
  bladeShape.closePath();

  const bladeGeo = new THREE.ShapeGeometry(bladeShape);
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0xf4f7ff,
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
  });

  const spineGeo = new THREE.BoxGeometry(0.05, 1.24, 0.04);
  const spineMat = new THREE.MeshBasicMaterial({
    color: playerHex,
    transparent: true,
    opacity: 0.95,
  });

  const guardGeo = new THREE.BoxGeometry(0.36, 0.08, 0.09);
  const guardMat = new THREE.MeshBasicMaterial({
    color: 0xf5b82e,
    transparent: true,
    opacity: 0.95,
  });

  const gripGeo = new THREE.BoxGeometry(0.09, 0.44, 0.06);
  const gripMat = new THREE.MeshBasicMaterial({
    color: 0x1e2533,
    transparent: true,
    opacity: 0.95,
  });

  const pommelGeo = new THREE.OctahedronGeometry(0.08, 0);
  const sheathGeo = new THREE.RingGeometry(0.28, 0.34, 24);
  const sheathMat = new THREE.MeshBasicMaterial({
    color: 0x94a3b8,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });

  disposables.push(
    bladeGeo,
    edgeMat,
    spineGeo,
    spineMat,
    guardGeo,
    guardMat,
    gripGeo,
    gripMat,
    pommelGeo,
    sheathGeo,
    sheathMat,
  );

  const bladeMesh = new THREE.Mesh(bladeGeo, edgeMat);
  bladeMesh.position.z = 0.01;
  const spineMesh = new THREE.Mesh(spineGeo, spineMat);
  spineMesh.position.set(-0.055, 0.19, 0.02);

  const guardMesh = new THREE.Mesh(guardGeo, guardMat);
  guardMesh.position.set(-0.005, -0.45, 0.02);

  const gripMesh = new THREE.Mesh(gripGeo, gripMat);
  gripMesh.position.set(-0.005, -0.71, 0.01);

  const pommelMesh = new THREE.Mesh(pommelGeo, spineMat);
  pommelMesh.position.set(-0.005, -0.96, 0.02);

  swordPivot.add(bladeMesh, spineMesh, guardMesh, gripMesh, pommelMesh);
  // Shift hilt slightly down-right so the cutting zone lands on (0,0)
  swordPivot.position.set(0.08, -0.18, 0);

  const sheathRing = new THREE.Mesh(sheathGeo, sheathMat);
  sheathRing.position.z = -0.02;

  group.add(sheathRing, swordPivot);
  return {
    group,
    bladeMesh,
    edgeMat,
    spineMat,
    guardMesh,
    gripMat,
    sheathRing,
    sheathMat,
  };
}
