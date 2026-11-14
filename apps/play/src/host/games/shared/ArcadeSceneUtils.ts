import * as THREE from "three";
import { getRenderedScheme } from "../../../common/theme.js";

/**
 * Deterministic Mulberry32 PRNG so spawned waves match across synced room seeds.
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3-step nearest-filtered ramp texture for crisp cel/toon arcade shading.
 */
export function createToonGradientTexture(): THREE.DataTexture {
  const bands = new Uint8Array([
    105, 105, 105, 255,
    185, 185, 185, 255,
    255, 255, 255, 255,
  ]);
  const tex = new THREE.DataTexture(bands, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Subscribes to host light/dark theme toggle changes without polling DOM in hot paths.
 */
export function observeThemeScheme(onChange: (scheme: "dark" | "light") => void): () => void {
  onChange(getRenderedScheme());
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (!meta) return () => {};
  const observer = new MutationObserver(() => {
    onChange(getRenderedScheme());
  });
  observer.observe(meta, { attributes: true, attributeFilter: ["content"] });
  return () => observer.disconnect();
}

/**
 * Pooled single-draw-call InstancedMesh burst particles with zero heap allocations per frame.
 */
export class ArcadeParticlePool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly geo: THREE.OctahedronGeometry;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly capacity: number;
  private cursor = 0;

  private readonly pX: Float32Array;
  private readonly pY: Float32Array;
  private readonly pZ: Float32Array;
  private readonly pVx: Float32Array;
  private readonly pVy: Float32Array;
  private readonly pVz: Float32Array;
  private readonly pLife: Float32Array;
  private readonly pMaxLife: Float32Array;

  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene, capacity = 220, size = 0.11) {
    this.capacity = capacity;
    this.pX = new Float32Array(capacity);
    this.pY = new Float32Array(capacity);
    this.pZ = new Float32Array(capacity);
    this.pVx = new Float32Array(capacity);
    this.pVy = new Float32Array(capacity);
    this.pVz = new Float32Array(capacity);
    this.pLife = new Float32Array(capacity);
    this.pMaxLife = new Float32Array(capacity);

    this.geo = new THREE.OctahedronGeometry(size, 0);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    this.tmpScale.setScalar(0);
    this.tmpColor.setHex(0xffffff);
    for (let i = 0; i < capacity; i++) {
      this.tmpMat.compose(this.tmpPos.set(0, 0, -50), this.tmpQuat.identity(), this.tmpScale);
      this.mesh.setMatrixAt(i, this.tmpMat);
      this.mesh.setColorAt(i, this.tmpColor);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    scene.add(this.mesh);
  }

  spawnBurst(
    x: number,
    y: number,
    z: number,
    hex: string | number,
    count: number,
    speed: number,
    biasVx = 0,
    biasVy = 0,
  ): void {
    this.tmpColor.set(hex);
    for (let n = 0; n < count; n++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const angle = (Math.PI * 2 * n) / Math.max(1, count) + (Math.random() - 0.5) * 0.4;
      const mag = speed * (0.45 + Math.random() * 0.7);
      this.pX[idx] = x;
      this.pY[idx] = y;
      this.pZ[idx] = z;
      this.pVx[idx] = Math.cos(angle) * mag + biasVx;
      this.pVy[idx] = Math.sin(angle) * mag + biasVy;
      this.pVz[idx] = (Math.random() - 0.5) * 2.6;
      const ttl = 0.28 + Math.random() * 0.24;
      this.pLife[idx] = ttl;
      this.pMaxLife[idx] = ttl;
      this.mesh.setColorAt(idx, this.tmpColor);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt: number): void {
    let anyChanged = false;
    for (let i = 0; i < this.capacity; i++) {
      const rem = this.pLife[i] ?? 0;
      if (rem <= 0) continue;
      anyChanged = true;

      const next = rem - dt;
      this.pLife[i] = next;
      if (next <= 0) {
        this.tmpScale.setScalar(0);
        this.tmpMat.compose(this.tmpPos.set(0, 0, -50), this.tmpQuat.identity(), this.tmpScale);
        this.mesh.setMatrixAt(i, this.tmpMat);
        continue;
      }

      const x = (this.pX[i] ?? 0) + (this.pVx[i] ?? 0) * dt;
      const y = (this.pY[i] ?? 0) + (this.pVy[i] ?? 0) * dt;
      const z = (this.pZ[i] ?? 0) + (this.pVz[i] ?? 0) * dt;
      this.pX[i] = x;
      this.pY[i] = y;
      this.pZ[i] = z;
      this.pVy[i] = (this.pVy[i] ?? 0) - 7.5 * dt;

      const frac = next / Math.max(0.01, this.pMaxLife[i] ?? 0.3);
      this.tmpPos.set(x, y, z);
      this.tmpEuler.set(next * 9, next * 7, 0);
      this.tmpQuat.setFromEuler(this.tmpEuler);
      this.tmpScale.setScalar(0.7 * frac);
      this.tmpMat.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      this.mesh.setMatrixAt(i, this.tmpMat);
    }

    if (anyChanged) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

interface ShockwaveSlot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  active: boolean;
  age: number;
  maxAge: number;
  maxScale: number;
}

/**
 * Pooled expanding ring shockwaves for hit confirmation, reload bursts, and recenter feedback.
 */
export class ArcadeShockwavePool {
  private readonly geo: THREE.RingGeometry;
  private readonly slots: ShockwaveSlot[] = [];
  private cursor = 0;

  constructor(scene: THREE.Scene, capacity = 12) {
    this.geo = new THREE.RingGeometry(0.24, 0.33, 32);
    for (let i = 0; i < capacity; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.slots.push({
        mesh,
        mat,
        active: false,
        age: 0,
        maxAge: 0.4,
        maxScale: 3.5,
      });
    }
  }

  spawn(
    x: number,
    y: number,
    z: number,
    hex: string | number,
    maxScale = 3.5,
    maxAge = 0.38,
  ): void {
    const wave = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    if (!wave) return;

    wave.active = true;
    wave.age = 0;
    wave.maxAge = maxAge;
    wave.maxScale = maxScale;
    wave.mat.color.set(hex);
    wave.mat.opacity = 0.9;
    wave.mesh.position.set(x, y, z);
    wave.mesh.scale.setScalar(0.35);
    wave.mesh.visible = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const w = this.slots[i]!;
      if (!w.active) continue;
      w.age += dt;
      const t = w.age / w.maxAge;
      if (t >= 1) {
        w.active = false;
        w.mesh.visible = false;
        continue;
      }
      const easeOut = 1 - (1 - t) * (1 - t);
      w.mesh.scale.setScalar(0.35 + easeOut * w.maxScale);
      w.mat.opacity = 0.85 * (1 - t);
    }
  }

  dispose(): void {
    this.geo.dispose();
    for (const s of this.slots) {
      s.mat.dispose();
    }
    this.slots.length = 0;
  }
}
