// HUB ROOM: circular station corridor built from procedural geometry.
// Central power core, four room doors + a locked beacon door, a window onto a rotating planet,
// GLSL starfield, mouse-parallax camera, GSAP door fly-through, flicker-on lighting when a room
// is powered, a floating astronaut placeholder and a hidden Easter-egg panel.
// Contract: exports { init(scene, ctx), enter(), exit(), update(dt) }. Everything built in
// enter() is disposed in exit().

import * as THREE from 'three';
import { gsap } from 'gsap';
import { emit, on } from '../core/events.js';
import { getState, update as saveState } from '../core/state.js';
import { disposeObject } from '../core/scene.js';

// ---------- layout constants ----------
const R = 9; // corridor radius
const WALL_H = 7;
const LOWER_H = 4.6; // doors live below this; the planet window sits above it
const DOOR_W = 2.4;
const DOOR_H = 3.3;
const WINDOW_HALF = 27; // window half-width in degrees
const FLY_TIME = 1.2; // door fly-through duration (seconds)

const rad = (d) => (d * Math.PI) / 180;
/** Point at angle `deg` from -Z (positive toward +X) on a circle of radius r. */
const polar = (deg, r = R, y = 0) => new THREE.Vector3(r * Math.sin(rad(deg)), y, -r * Math.cos(rad(deg)));

const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const C_GREY = new THREE.Color(0x5c7a86);
const _c = new THREE.Color();

const POWER_ROOMS = ['about', 'projects', 'skills', 'education'];
const DOORS = [
  { room: 'about', label: 'ABOUT', name: 'Crew Quarters', angle: -60 },
  { room: 'projects', label: 'PROJECTS', name: 'Engineering Bay', angle: -30 },
  { room: 'skills', label: 'SKILLS', name: 'Reactor Core', angle: 0 },
  { room: 'education', label: 'EDUCATION', name: 'Archive', angle: 30 },
  { room: 'beacon', label: 'BEACON', name: 'Comms Tower', angle: 60 },
];

// ---------- GLSL ----------
const STAR_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// One layer of stars: a jittered point per 3D cell, kept only above a density threshold.
vec3 starLayer(vec3 dir, float scale, float threshold, float seed) {
  vec3 p = dir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash13(id + seed);
  vec3 jitter = (vec3(hash13(id + 1.7), hash13(id + 5.3), hash13(id + 9.1)) - 0.5) * 0.5;
  float d = length(f - jitter);
  float size = 0.06 + 0.12 * hash13(id + 7.3);
  float core = smoothstep(size, 0.0, d) * step(threshold, h);
  float twinkle = 0.65 + 0.35 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
  vec3 tint = mix(vec3(0.6, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash13(id + 3.1));
  return tint * core * twinkle;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 c = vec3(0.012, 0.018, 0.04);
  c += vec3(0.0, 0.07, 0.11) * pow(clamp(d.y * 0.5 + 0.5, 0.0, 1.0), 3.0) * 0.5;
  c += starLayer(d, 70.0, 0.90, 0.0) * 1.4;
  c += starLayer(d, 130.0, 0.94, 11.0) * 1.0;
  c += starLayer(d, 28.0, 0.985, 23.0) * 3.0;
  gl_FragColor = vec4(c, 1.0);
}`;

const PLANET_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
void main() {
  vObj = position;
  vWN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const PLANET_FRAG = /* glsl */ `
varying vec3 vObj;
varying vec3 vWN;
varying vec3 vWP;
uniform vec3 uSun;
uniform float uTime;
float hash31(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x);
  float b = mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x);
  float c = mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x);
  float d = mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
void main() {
  vec3 n = normalize(vWN);
  vec3 v = normalize(cameraPosition - vWP);
  float h = fbm(vObj * 0.35 + 3.0);
  float land = smoothstep(0.48, 0.56, h);
  vec3 ocean = mix(vec3(0.02, 0.07, 0.18), vec3(0.03, 0.22, 0.35), h * 1.6);
  vec3 ground = mix(vec3(0.45, 0.2, 0.08), vec3(0.75, 0.4, 0.15), fbm(vObj * 0.9));
  vec3 col = mix(ocean, ground, land);
  float clouds = fbm(vObj * 0.5 + vec3(uTime * 0.03, 0.0, 0.0) + 10.0);
  col = mix(col, vec3(0.8, 0.95, 1.0), smoothstep(0.55, 0.75, clouds) * 0.7);
  float diff = smoothstep(0.25, 0.9, clamp(dot(n, normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0));
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 lit = col * (0.06 + 1.2 * diff) + vec3(0.0, 0.8, 1.0) * rim * (0.25 + 0.9 * diff);
  gl_FragColor = vec4(lit, 1.0);
}`;

const ATMO_VERT = /* glsl */ `
varying vec3 vN;
void main() {
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMO_FRAG = /* glsl */ `
varying vec3 vN;
void main() {
  float i = pow(max(0.58 - dot(vN, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
  gl_FragColor = vec4(vec3(0.0, 0.75, 1.0) * i * 2.2, i);
}`;

const CORE_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uPower;
uniform vec3 uColA;
uniform vec3 uColB;
void main() {
  float bands = 0.5 + 0.5 * sin(vUv.y * 40.0 - uTime * 3.0);
  float flick = 0.85 + 0.15 * sin(uTime * 37.0 + vUv.y * 5.0);
  float edge = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  vec3 col = mix(uColA, uColB, uPower);
  float a = (0.25 + 0.75 * bands) * edge * flick * (0.15 + 0.85 * uPower);
  gl_FragColor = vec4(col * (1.0 + 0.8 * uPower), a);
}`;

const UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// ---------- procedural textures (512px max, well under the 1024 budget) ----------
function makeFloorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1018';
  g.fillRect(0, 0, 512, 512);
  g.translate(256, 256);
  g.strokeStyle = 'rgba(0,229,255,0.35)';
  g.lineWidth = 1.5;
  for (let r = 40; r <= 250; r += 30) {
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = 'rgba(0,229,255,0.18)';
  for (let i = 0; i < 36; i++) {
    const a = (i * Math.PI) / 18;
    g.beginPath();
    g.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
    g.lineTo(Math.cos(a) * 250, Math.sin(a) * 250);
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,107,44,0.5)';
  g.lineWidth = 5;
  g.setLineDash([14, 10]);
  g.beginPath();
  g.arc(0, 0, 225, 0, Math.PI * 2);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** White text on transparent: the material colour tints it, so one texture serves every state. */
function makeSignTexture(label, sub) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.strokeRect(6, 6, 500, 148);
  g.font = '700 60px Orbitron, sans-serif';
  g.fillText(label, 256, 62);
  g.font = '22px "Share Tech Mono", monospace';
  g.fillText(sub.toUpperCase(), 256, 120);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Faint circuit-board pattern for the hidden panel (fixed pseudo-random cells). */
function makeEggTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 13; x++) if (rnd() > 0.45) g.fillRect(x * 10 + 2, y * 10 + 2, 6, 6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- builders: shell (walls, floor, ceiling, trim, window frame) ----------
function buildShell(root) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x131d2e, roughness: 0.6, metalness: 0.5, side: THREE.BackSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0x0f1826, roughness: 0.45, metalness: 0.7 });

  // Lower wall is closed; the upper wall leaves a gap (the window) centred on -Z.
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(R, R, LOWER_H, 72, 1, true), wallMat);
  lower.position.y = LOWER_H / 2;
  const upperLen = Math.PI * 2 - rad(WINDOW_HALF * 2);
  const upper = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, WALL_H - LOWER_H, 72, 1, true, Math.PI + rad(WINDOW_HALF), upperLen),
    wallMat
  );
  upper.position.y = LOWER_H + (WALL_H - LOWER_H) / 2;

  // The floor grid is also the emissive map, so it stays readable even with the station dark
  const floorTex = makeFloorTexture();
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex, roughness: 0.5, metalness: 0.45,
    emissive: 0xffffff, emissiveMap: floorTex, emissiveIntensity: 0.3,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 72), floorMat);
  floor.rotation.x = -Math.PI / 2;

  const ceiling = new THREE.Mesh(new THREE.RingGeometry(3.4, R, 72), new THREE.MeshStandardMaterial({ color: 0x0d1523, roughness: 0.7, metalness: 0.5 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_H;

  // Vertical ribs between the doors (one InstancedMesh = one draw call)
  const spots = [];
  for (let a = 0; a < 360; a += 10) {
    const nearDoor = DOORS.some((d) => Math.abs(((a - d.angle + 540) % 360) - 180) < 12);
    if (!nearDoor) spots.push(a);
  }
  const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, LOWER_H, 0.4), metal, spots.length);
  const dummy = new THREE.Object3D();
  spots.forEach((a, i) => {
    dummy.position.copy(polar(a, R - 0.18, LOWER_H / 2));
    dummy.rotation.set(0, -rad(a), 0);
    dummy.updateMatrix();
    ribs.setMatrixAt(i, dummy.matrix);
  });

  // Glowing trim rings and the orange emergency strip on the floor
  const trimMat = new THREE.MeshBasicMaterial({ color: C_CYAN });
  const trimGeo = new THREE.TorusGeometry(R - 0.06, 0.045, 8, 120);
  trimGeo.rotateX(Math.PI / 2);
  const trimLow = new THREE.Mesh(trimGeo, trimMat);
  trimLow.position.y = 0.28;
  const trimHigh = new THREE.Mesh(trimGeo, trimMat);
  trimHigh.position.y = LOWER_H - 0.02;
  const emergencyMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const stripGeo = new THREE.TorusGeometry(R - 0.9, 0.05, 8, 120);
  stripGeo.rotateX(Math.PI / 2);
  const strip = new THREE.Mesh(stripGeo, emergencyMat);
  strip.position.y = 0.03;

  // Window frame: four mullions plus top and sill arcs
  for (const a of [-18, -6, 6, 18]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, WALL_H - LOWER_H, 0.16), metal);
    bar.position.copy(polar(a, R - 0.03, LOWER_H + (WALL_H - LOWER_H) / 2));
    bar.rotation.y = -rad(a);
    root.add(bar);
  }
  for (const y of [LOWER_H, WALL_H]) {
    const g = new THREE.TorusGeometry(R - 0.03, 0.08, 8, 40, rad(WINDOW_HALF * 2));
    g.rotateX(Math.PI / 2);
    const arc = new THREE.Mesh(g, metal);
    arc.rotation.y = rad(90 + WINDOW_HALF); // centre the arc on -Z
    arc.position.y = y;
    root.add(arc);
  }

  root.add(lower, upper, floor, ceiling, ribs, trimLow, trimHigh, strip);
  return { trimMat, emergencyMat, floorMat };
}

// ---------- builders: space (starfield, planet, atmosphere) ----------
function buildSpace(root) {
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const stars = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -10;
  stars.userData.noPick = true;

  const planetMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSun: { value: new THREE.Vector3(1, 0.35, 0.7).normalize() } },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(11, 64, 48), planetMat);
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(12.4, 48, 32),
    new THREE.ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  const pivot = new THREE.Group();
  pivot.position.set(-4, 14, -50);
  pivot.add(planet, atmo);
  root.add(stars, pivot);
  return { starMat, planetMat, planet, stars };
}

// Light tuning (three r155+ uses physical units, so these numbers are large on purpose)
const LIGHT = { door: 60, core: 110, emergency: 40, hemiMin: 1.2, hemiMax: 2.3 };

// ---------- builders: doors with neon signs ----------
function buildDoors(root) {
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x101a28, roughness: 0.4, metalness: 0.7 });
  const postGeo = new THREE.BoxGeometry(0.25, DOOR_H + 0.25, 0.5);
  const topGeo = new THREE.BoxGeometry(DOOR_W + 0.5, 0.25, 0.5);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });

  return DOORS.map((def) => {
    const group = new THREE.Group();
    const base = polar(def.angle, R - 0.05, 0);
    group.position.copy(base);
    group.rotation.y = -rad(def.angle); // local +Z faces the hub centre
    const tangent = new THREE.Vector3(Math.cos(rad(def.angle)), 0, Math.sin(rad(def.angle)));
    const outward = polar(def.angle, 1, 0);

    const left = new THREE.Mesh(postGeo, frameMat);
    left.position.set(-(DOOR_W / 2 + 0.125), (DOOR_H + 0.25) / 2, 0);
    const right = new THREE.Mesh(postGeo, frameMat);
    right.position.set(DOOR_W / 2 + 0.125, (DOOR_H + 0.25) / 2, 0);
    const top = new THREE.Mesh(topGeo, frameMat);
    top.position.set(0, DOOR_H + 0.125, 0);

    const panelMat = new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.5, metalness: 0.6, emissive: C_CYAN, emissiveIntensity: 0 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.12), panelMat);
    panel.position.set(0, DOOR_H / 2, -0.12);

    const stripMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, DOOR_H - 0.3, 0.04), stripMat);
    strip.position.set(0, DOOR_H / 2, -0.05);

    const statusMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
    const status = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.08), statusMat);
    status.position.set(0, DOOR_H + 0.32, 0.05);

    const signMat = new THREE.MeshBasicMaterial({ map: makeSignTexture(def.label, def.name), transparent: true, color: C_ORANGE, depthWrite: false });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.75), signMat);
    sign.position.set(0, DOOR_H + 0.78, 0.1);

    const light = new THREE.PointLight(C_CYAN, 0, 14, 2);
    light.position.set(0, 2.6, 1.6);

    // Invisible, generous click target (raycaster ignores material.visible)
    const hit = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W + 0.8, DOOR_H + 1.5, 0.8), hitMat);
    hit.position.set(0, (DOOR_H + 1.5) / 2, 0.1);

    group.add(left, right, top, panel, strip, status, sign, light, hit);
    root.add(group);
    return {
      ...def, id: `door:${def.room}`, group, base, tangent, outward,
      panelMat, stripMat, statusMat, signMat, light,
      level: 0, on: false, hoverK: 0, shake: 0,
    };
  });
}

// ---------- builders: central power core ----------
/** Floating text above the pedestal: "POWER CORE" and the restored percentage. Faces the camera. */
function buildCoreLabel(root) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 0.45),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  mesh.position.set(0, 0.6, 0); // low, so it never covers the door behind the core
  mesh.userData.noPick = true;
  root.add(mesh);
  const g = canvas.getContext('2d');
  const draw = (pct) => {
    g.clearRect(0, 0, 512, 128);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = pct >= 100 ? '#46ff82' : '#00E5FF';
    g.font = '700 44px Orbitron, sans-serif';
    g.fillText('POWER CORE', 256, 42);
    g.fillStyle = '#9fc3cf';
    g.font = '28px "Share Tech Mono", monospace';
    g.fillText(pct >= 100 ? '100% RESTORED' : `${pct}% RESTORED`, 256, 94);
    tex.needsUpdate = true;
  };
  draw(0);
  return { mesh, draw };
}

function buildCore(root) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x182235, roughness: 0.4, metalness: 0.75 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.7, 0.5, 40), metal);
  base.position.y = 0.25;

  const ringMat = new THREE.MeshBasicMaterial({ color: C_CYAN });
  const ringGeo = new THREE.TorusGeometry(1.45, 0.05, 8, 64);
  ringGeo.rotateX(Math.PI / 2);
  const baseRing = new THREE.Mesh(ringGeo, ringMat);
  baseRing.position.y = 0.52;

  // Animated energy column (additive shader, brightness follows station power)
  const energyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0 },
      uColA: { value: C_ORANGE.clone() },
      uColB: { value: C_CYAN.clone() },
    },
    vertexShader: UV_VERT,
    fragmentShader: CORE_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const orbMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), orbMat);
  orb.position.y = 2.2;

  const rings = [0.85, 1.05, 1.25].map((r, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 64), ringMat);
    m.position.y = 2.2;
    m.rotation.set(i * 1.0, i * 0.7, 0);
    return m;
  });

  const beamMat = new THREE.MeshBasicMaterial({
    color: C_CYAN, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });

  const light = new THREE.PointLight(C_CYAN, 0, 30, 2);
  light.position.set(0, 2.2, 0);

  // Low-profile design: no tall column or beam, so the Skills door straight behind the core stays visible.
  // The invisible sphere is the click target.
  const hit = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 2.2;
  group.add(base, baseRing, orb, ...rings, light, hit);
  group.scale.setScalar(0.4);
  root.add(group);
  return { group, energyMat, ringMat, orbMat, orb, rings, beamMat, light, label: buildCoreLabel(root), labelPct: -1, p: 0 };
}

// ---------- builders: ceiling lamps (lit 3 per powered room, beacon gets its own 3) ----------
function buildCeilingLamps(root) {
  const geo = new THREE.BoxGeometry(1.5, 0.1, 0.45);
  const lamps = [];
  for (const d of DOORS) {
    for (const off of [-10, 0, 10]) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x111a26, roughness: 0.5, metalness: 0.6, emissive: C_CYAN, emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(polar(d.angle + off, 6.3, WALL_H - 0.06));
      mesh.rotation.y = -rad(d.angle + off);
      root.add(mesh);
      lamps.push({ room: d.room, mat, level: 0, on: false });
    }
  }
  return lamps;
}

// ---------- builders: astronaut placeholder (replaced by astronaut.glb later) ----------
function buildAstronaut(root) {
  const group = new THREE.Group(); // origin at the feet, ~1.8 units tall, faces +Z
  group.position.set(3.2, 0.5, 1.2);
  const suit = new THREE.MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.5, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x9aa7b5, roughness: 0.6, metalness: 0.3 });
  const visorMat = new THREE.MeshStandardMaterial({ color: 0x04121a, roughness: 0.15, metalness: 0.8, emissive: C_CYAN, emissiveIntensity: 0.5 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.75, 6, 16), suit);
  body.position.y = 0.7;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 16), suit);
  head.position.y = 1.55;
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), visorMat);
  visor.scale.set(1, 0.7, 0.5);
  visor.position.set(0, 1.56, 0.17);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.6, 0.22), dark);
  pack.position.set(0, 1.0, -0.32);

  const armGeo = new THREE.CapsuleGeometry(0.09, 0.4, 4, 8);
  const makeArm = (side) => {
    const pivot = new THREE.Group(); // rotates around the shoulder
    pivot.position.set(0.4 * side, 1.28, 0);
    const arm = new THREE.Mesh(armGeo, suit);
    arm.position.y = -0.25;
    pivot.add(arm);
    return pivot;
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);

  group.add(body, head, visor, pack, armL, armR);
  root.add(group);
  return { group, body, head, visor, pack, visorMat, armL, armR, baseY: 0.5, busy: false, avatar: null };
}

// ---------- builders: hidden Easter-egg maintenance panel ----------
function buildEgg(root) {
  const angle = 45;
  const group = new THREE.Group();
  group.position.copy(polar(angle, R - 0.04, 0.9));
  group.rotation.y = -rad(angle);
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.64, 0.42, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x0f1826, roughness: 0.6, metalness: 0.6 })
  );
  frame.position.z = -0.01;
  const mat = new THREE.MeshBasicMaterial({ map: makeEggTexture(), color: C_CYAN, transparent: true, opacity: 0.03, depthWrite: false });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.34), mat);
  panel.position.z = 0.02;
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.5), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.z = 0.1;
  group.add(frame, panel, hit);
  root.add(group);
  return { group, mat, found: false };
}

// ---------- runtime state ----------
let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the hub is not active
let backBtn = null;
let overlay = null;
let currentRoom = null;
let transitioning = false;

const reduced = () => !!ctx?.reducedMotion;

/** Power % = powered rooms / 4 * 100 (as a 0..1 fraction here). */
function powerFraction() {
  return H.doors.filter((d) => POWER_ROOMS.includes(d.room) && d.on).length / POWER_ROOMS.length;
}

/** Flicker an object's `level` (0..1) on, or fade it off. Door flickers play a sound. */
function flicker(obj, to, delay = 0, sfx = false) {
  gsap.killTweensOf(obj, 'level');
  if (reduced()) {
    obj.level = to;
    return;
  }
  H.gctx.add(() => {
    const tl = gsap.timeline({ delay });
    if (to > 0.5) {
      if (sfx) tl.call(() => ctx.audio.play('flicker'));
      for (const [v, d] of [[1, 0.05], [0.15, 0.06], [0.9, 0.05], [0.05, 0.07], [0.8, 0.05], [0.2, 0.04], [1, 0.12]]) {
        tl.to(obj, { level: v, duration: d, ease: 'none' });
      }
    } else {
      tl.to(obj, { level: 0, duration: 0.25 });
    }
  });
}

/** Read power/beacon state and bring doors, ceiling lamps and the core in line with it. */
function syncState(instant) {
  if (!H) return;
  const st = getState();
  const doorOn = {};
  for (const d of H.doors) {
    const on = d.room === 'beacon' ? !!st.beaconUnlocked : !!(st.power[d.room] || H.forced.has(d.room));
    doorOn[d.room] = on;
    if (d.on === on && !instant) continue;
    const wasOn = d.on;
    d.on = on;
    if (instant) {
      gsap.killTweensOf(d, 'level');
      d.level = on ? 1 : 0;
    } else {
      flicker(d, on ? 1 : 0, 0, true);
      if (on && !wasOn && d.room === 'beacon') ctx.input.toast('COMMS TOWER ONLINE: the beacon is unlocked.');
    }
  }
  // Ceiling lamps come on one by one after the door itself
  let seq = 0;
  for (const l of H.lamps) {
    const want = !!doorOn[l.room];
    if (l.on === want && !instant) continue;
    l.on = want;
    if (instant) {
      gsap.killTweensOf(l, 'level');
      l.level = want ? 1 : 0;
    } else {
      flicker(l, want ? 1 : 0, 0.4 + seq * 0.18);
      seq++;
    }
  }
  const frac = powerFraction();
  if (instant) {
    H.core.p = frac;
  } else if (frac !== H.corePct) {
    H.gctx.add(() => gsap.to(H.core, { p: frac, duration: 1.6, delay: 0.3, ease: 'power2.out' }));
  }
  H.corePct = frac;
}

/** Keep the camera framing sensible on narrow or tall screens. */
function fitCamera() {
  if (!H) return;
  const a = window.innerWidth / window.innerHeight;
  const cam = H.cam;
  if (a < 0.9) { cam.pos.set(0, 1.7, 9.5); cam.fov = 74; }
  else if (a < 1.3) { cam.pos.set(0, 1.7, 7.2); cam.fov = 66; }
  else { cam.pos.set(0, 1.7, 5.5); cam.fov = 60; }
  cam.look.set(0, 2.1, -3);
  if (!H.flying) {
    ctx.camera.fov = cam.fov;
    ctx.camera.updateProjectionMatrix();
  }
}

// ---------- interactions ----------
const doorLabel = (d) => {
  const status = d.room === 'beacon' ? (d.on ? 'ONLINE' : 'LOCKED') : d.on ? 'POWERED' : 'OFFLINE';
  return `${d.label}: ${d.name} [${status}]`;
};

function shakeDoor(d) {
  H.gctx.add(() => gsap.to(d, { keyframes: { shake: [0.07, -0.07, 0.05, -0.03, 0], easeEach: 'none' }, duration: 0.4 }));
}

function onDoor(d) {
  if (!H || H.flying || transitioning) return;
  if (d.room === 'beacon' && !d.on) {
    shakeDoor(d);
    ctx.audio.play('error');
    ctx.input.toast('COMMS TOWER LOCKED. Restore 100% power, then ask A.R.I.A one question to trace the rogue signal.');
    return;
  }
  if (!ctx.hasRoom(d.room)) {
    ctx.audio.play('error');
    ctx.input.toast(`${d.name.toUpperCase()} IS NOT BUILT YET.`);
    return;
  }
  flyToDoor(d);
}

/** 1.2s camera fly-through into a door, then hand over to the room via 'room:enter'. */
function flyToDoor(d) {
  transitioning = true;
  H.flying = true;
  ctx.input.setEnabled(false);
  ctx.audio.play('whoosh');
  const cam = ctx.camera;
  const from = cam.position.clone();
  const fromLook = H.look.clone();
  const door = d.base.clone().setY(1.7);
  const to = door.clone().addScaledVector(d.outward, 0.8); // just past the door plane
  const toLook = door.clone().addScaledVector(d.outward, 6);
  H.flyPos.copy(from);
  H.flyLook.copy(fromLook);
  const st = { t: 0 };
  H.gctx.add(() => {
    gsap.to(st, {
      t: 1,
      duration: reduced() ? 0.01 : FLY_TIME,
      ease: 'power2.inOut',
      onUpdate: () => {
        H.flyPos.lerpVectors(from, to, st.t);
        H.flyLook.lerpVectors(fromLook, toLook, st.t);
        if (reduced()) return;
        cam.fov = H.cam.fov + 16 * st.t; // speed feel
        cam.updateProjectionMatrix();
        ctx.stage.setBloom({ strength: 0.6 + 1.0 * st.t });
        overlay.style.opacity = String(Math.max(0, (st.t - 0.65) / 0.35));
      },
      onComplete: () => {
        emit('room:enter', { room: d.room }); // main calls exit() synchronously from here
        gsap.to(overlay, { opacity: 0, duration: reduced() ? 0 : 0.5, delay: 0.15, onComplete: () => { transitioning = false; } });
      },
    });
  });
}

/** Back button / Escape: fade out, return to the hub, fade in. */
function goHub() {
  if (transitioning || !currentRoom || currentRoom === 'hub') return;
  transitioning = true;
  ctx.audio.play('whoosh');
  const done = () => {
    emit('room:enter', { room: 'hub' });
    gsap.to(overlay, { opacity: 0, duration: reduced() ? 0 : 0.5, delay: 0.1, onComplete: () => { transitioning = false; } });
  };
  if (reduced()) done();
  else gsap.to(overlay, { opacity: 1, duration: 0.35, ease: 'power1.in', onComplete: done });
}

function onCore() {
  const pct = Math.round(powerFraction() * 100);
  ctx.audio.play('click');
  ctx.input.toast(pct < 100 ? `STATION POWER ${pct}%. Enter a room to restore more.` : 'STATION POWER 100%. All systems stable.');
}

/** Placeholder astronaut reacts to 'avatar:talk' {state}: Idle, Wave, Talk or Shrug. */
function react(state) {
  if (!H) return;
  const a = H.astro;
  const s = String(state || '').toLowerCase();
  if (a.avatar) {
    if (s === 'wave') a.avatar.wave(); // the real avatar has one clip: the greeting
    return;
  }
  H.gctx.add(() => {
    gsap.killTweensOf([a.armR.rotation, a.armL.rotation, a]);
    if (s === 'wave') {
      gsap.timeline()
        .to(a.armR.rotation, { z: 2.5, duration: 0.3, ease: 'power2.out' })
        .to(a.armR.rotation, { z: 2.0, duration: 0.18, repeat: 5, yoyo: true })
        .to(a.armR.rotation, { z: 0, duration: 0.4, ease: 'power2.inOut' });
    } else if (s === 'talk') {
      gsap.timeline().to(a, { glow: 1.4, duration: 0.15, repeat: 7, yoyo: true }).set(a, { glow: 0 });
    } else if (s === 'shrug') {
      gsap.timeline()
        .to(a.armL.rotation, { z: -0.9, duration: 0.25 }, 0)
        .to(a.armR.rotation, { z: 0.9, duration: 0.25 }, 0)
        .to([a.armL.rotation, a.armR.rotation], { z: 0, duration: 0.4 }, 0.9);
    }
  });
}

function onAstronaut() {
  ctx.audio.play('click');
  emit('avatar:talk', { state: 'Wave' });
  ctx.input.toast('MUHAMMAD AHMED WAVES HELLO.');
}

/** Easter egg: emits the achievement and records it so the secret project unlocks. */
function onEgg() {
  const has = () => getState().achievements.includes('hidden_beacon');
  if (H.egg.found || has()) {
    H.egg.found = true;
    ctx.input.toast('PANEL ALREADY SCANNED. The hidden file is unlocked.');
    return;
  }
  H.egg.found = true;
  emit('achievement:unlock', { id: 'hidden_beacon' });
  // Listeners run synchronously; if none recorded it yet, save it so the secret project stays unlocked
  if (!has()) saveState({ achievements: [...getState().achievements, 'hidden_beacon'] });
  ctx.input.toast('ANOMALY DETECTED: a hidden file was unlocked in the Engineering Bay.', 4200);
}

// ---------- room contract ----------
export function init(sceneArg, ctxArg) {
  scene = sceneArg;
  ctx = ctxArg;

  overlay = document.createElement('div');
  overlay.className = 'fade-overlay';
  document.body.appendChild(overlay);

  backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'btn back-btn';
  backBtn.textContent = '< BACK TO HUB';
  backBtn.setAttribute('aria-label', 'Back to hub');
  backBtn.hidden = true;
  backBtn.addEventListener('click', goHub);
  document.body.appendChild(backBtn);

  // Show the back button in every room except the hub
  on('room:enter', ({ room }) => {
    currentRoom = room;
    backBtn.hidden = room === 'hub';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    goHub();
  });
}

export function enter() {
  currentRoom = 'hub';
  backBtn.hidden = true;
  const camera = ctx.camera;

  const root = new THREE.Group();
  scene.add(root);
  const shell = buildShell(root);
  const space = buildSpace(root);
  const doors = buildDoors(root);
  const core = buildCore(root);
  const lamps = buildCeilingLamps(root);
  const astro = buildAstronaut(root);
  astro.glow = 0;
  const egg = buildEgg(root);

  const hemi = new THREE.HemisphereLight(0x4a6a9a, 0x0b0f1a, LIGHT.hemiMin);
  const emergency = new THREE.PointLight(C_ORANGE, LIGHT.emergency, 25, 2);
  emergency.position.set(0, 4.5, 3);
  root.add(hemi, emergency);

  H = {
    root, ...shell, ...space, doors, core, lamps, astro, egg, hemi, emergency,
    gctx: gsap.context(() => {}),
    offs: [],
    forced: new Set(), // rooms announced by 'room:power' before the saved state caught up
    flying: false,
    px: 0, py: 0, cur: { x: 0, y: 0 },
    intro: { k: reduced() ? 0 : 1 },
    cam: { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60 },
    look: new THREE.Vector3(0, 2.1, -3),
    flyPos: new THREE.Vector3(),
    flyLook: new THREE.Vector3(),
    corePct: -1,
    poll: 0,
    coreHover: 0,
  };
  egg.found = getState().achievements.includes('hidden_beacon');

  camera.position.set(0, 1.7, 5.5);
  ctx.stage.setBloom({ strength: 0.6, radius: 0.5, threshold: 0.9 }); // calmer glow, so the doors behind the core stay visible
  fitCamera();
  syncState(true);

  // Interactive objects, in logical Tab order
  const input = ctx.input;
  input.setEnabled(true);
  for (const d of doors) input.register(d.group, { id: d.id, label: () => doorLabel(d), onClick: () => onDoor(d) });
  input.register(core.group, { id: 'core', label: () => `POWER CORE: ${Math.round(powerFraction() * 100)}% RESTORED`, onClick: onCore });
  input.register(astro.group, { id: 'astronaut', label: 'MUHAMMAD AHMED', onClick: onAstronaut });
  input.register(egg.group, { id: 'egg', label: 'MAINTENANCE PANEL', onClick: onEgg });

  // Events and DOM listeners (removed again in exit)
  const onMove = (e) => {
    if (reduced()) return;
    H.px = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1));
    H.py = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1));
  };
  window.addEventListener('pointermove', onMove);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    ctx.stage.onResize(fitCamera),
    on('room:power', ({ room }) => { H.forced.add(room); syncState(false); }),
    on('achievement:unlock', () => syncState(false)),
    on('game:win', () => syncState(false)),
    on('avatar:talk', ({ state }) => react(state))
  );

  // Short fly-in from slightly closer to the door ring
  if (!reduced()) H.gctx.add(() => gsap.to(H.intro, { k: 0, duration: 1.0, ease: 'power2.out' }));
}

export function exit() {
  if (!H) return;
  H.gctx.kill();
  for (const off of H.offs) off();
  ctx.input.clear();
  ctx.input.setEnabled(true); // the next room starts with input on
  H.astro.avatar?.dispose(); // shared model: must leave the room before disposeObject
  scene.remove(H.root);
  disposeObject(H.root);
  ctx.camera.fov = 60;
  ctx.camera.updateProjectionMatrix();
  ctx.stage.setBloom({ strength: 0.9, radius: 0.55, threshold: 0.82 });
  H = null;
}

export function update(dt, t = 0) {
  if (!H) return;
  const camera = ctx.camera;
  const input = ctx.input;
  const tt = reduced() ? 0 : t; // freeze shader animation for reduced motion

  // Poll saved state so unlocks made elsewhere show up without a dedicated event
  H.poll += dt;
  if (H.poll > 0.5) {
    H.poll = 0;
    syncState(false);
  }

  // Backdrop
  H.starMat.uniforms.uTime.value = tt;
  H.planetMat.uniforms.uTime.value = tt;
  H.stars.position.copy(camera.position);
  if (!reduced()) H.planet.rotation.y += dt * 0.04;

  // Power core
  const core = H.core;
  const p = core.p;
  const noise = p < 1 ? 0.75 + 0.25 * Math.sin(tt * 23) * Math.sin(tt * 7.3) : 1;
  H.coreHover += ((input.isHovered('core') ? 1 : 0) - H.coreHover) * Math.min(1, dt * 10);
  const lvl = (0.12 + 0.88 * p) * noise * (1 + 0.25 * H.coreHover);
  _c.copy(C_ORANGE).lerp(C_CYAN, p);
  core.energyMat.uniforms.uTime.value = tt;
  core.energyMat.uniforms.uPower.value = p;
  core.orbMat.color.copy(_c).multiplyScalar(0.6 + 1.3 * lvl);
  core.ringMat.color.copy(_c).multiplyScalar(0.4 + 0.9 * lvl);
  core.beamMat.color.copy(_c);
  core.beamMat.opacity = 0.02 + 0.03 * p * noise;
  core.light.color.copy(_c);
  core.light.intensity = LIGHT.core * lvl;
  core.orb.position.y = 2.2 + (reduced() ? 0 : Math.sin(t * 1.4) * 0.08);
  const corePct = Math.round(p * 100);
  if (corePct !== core.labelPct) {
    core.labelPct = corePct;
    core.label.draw(corePct);
  }
  core.label.mesh.quaternion.copy(camera.quaternion); // label always faces the viewer
  if (!reduced()) {
    core.rings.forEach((r, i) => {
      r.rotation.x += dt * (0.4 + i * 0.2) * (0.3 + p);
      r.rotation.y += dt * (0.3 + i * 0.15) * (0.3 + p);
    });
  }

  // Ambient mood: warm emergency lighting fades as the station powers up
  H.hemi.intensity = LIGHT.hemiMin + (LIGHT.hemiMax - LIGHT.hemiMin) * p;
  H.emergency.intensity = LIGHT.emergency * (1 - p) * (0.85 + 0.15 * Math.sin(tt * 2));
  H.floorMat.emissiveIntensity = 0.3 + 0.7 * p;
  H.trimMat.color.copy(C_CYAN).multiplyScalar(0.08 + 0.8 * p);
  H.emergencyMat.color.copy(C_ORANGE).multiplyScalar((0.9 + 0.7 * Math.sin(tt * 2.2)) * (1 - p) + 0.05);

  // Doors, neon signs and their lights
  for (const d of H.doors) {
    d.hoverK += ((input.isHovered(d.id) ? 1 : 0) - d.hoverK) * Math.min(1, dt * 10);
    const lv = d.level;
    if (d.room === 'beacon' && !d.on && lv < 0.05) {
      // Locked beacon door: dead grey sign and a slow orange warning blink
      d.signMat.color.copy(C_GREY).multiplyScalar(0.18 + 0.06 * Math.sin(tt * 1.5) + 0.5 * d.hoverK);
      d.panelMat.emissiveIntensity = 0;
      d.stripMat.color.copy(C_GREY).multiplyScalar(0.12);
      d.statusMat.color.copy(C_ORANGE).multiplyScalar(0.3 + (Math.sin(tt * 3) > 0.6 ? 0.9 : 0));
      d.light.intensity = 0;
    } else {
      _c.copy(C_ORANGE).lerp(C_CYAN, lv);
      d.signMat.color.copy(_c).multiplyScalar(0.45 + 1.2 * lv + 0.9 * d.hoverK);
      d.panelMat.emissive.copy(_c);
      d.panelMat.emissiveIntensity = 0.05 + 0.55 * lv + 0.5 * d.hoverK;
      d.stripMat.color.copy(_c).multiplyScalar(0.25 + 1.1 * lv);
      d.statusMat.color.copy(_c).multiplyScalar(0.6 + 1.6 * lv);
      d.light.color.copy(_c);
      d.light.intensity = LIGHT.door * lv * (1 + 0.4 * d.hoverK);
    }
    d.group.position.copy(d.base).addScaledVector(d.tangent, d.shake);
  }
  for (const l of H.lamps) l.mat.emissiveIntensity = 2.0 * l.level;

  // Astronaut placeholder: floats, drifts and turns toward the camera
  const a = H.astro;
  if (a.avatar) {
    a.avatar.update(dt);
    a.group.position.y = a.baseY; // a person stands on the floor, no floating
    a.group.rotation.y = Math.atan2(camera.position.x - a.group.position.x, camera.position.z - a.group.position.z);
  } else {
    a.group.position.y = a.baseY + (reduced() ? 0 : Math.sin(t * 1.2) * 0.12);
    a.group.rotation.y = Math.atan2(camera.position.x - a.group.position.x, camera.position.z - a.group.position.z) + (reduced() ? 0 : Math.sin(t * 0.6) * 0.15);
    a.body.rotation.z = reduced() ? 0 : Math.sin(t * 0.9) * 0.04;
  }
  a.visorMat.emissiveIntensity = 0.5 + (input.isHovered('astronaut') ? 0.7 : 0) + a.glow;

  // Easter egg: barely visible flicker until found
  const e = H.egg;
  if (e.found) e.mat.opacity = 0.35;
  else {
    const f = Math.max(0, Math.sin(tt * 23) * Math.sin(tt * 5.1));
    e.mat.opacity = 0.025 + 0.15 * f * f + (input.isHovered('egg') ? 0.15 : 0);
  }

  // Camera: intro fly-in, parallax, or the door fly-through
  if (H.flying) {
    camera.position.copy(H.flyPos);
    camera.lookAt(H.flyLook);
  } else {
    const k = 1 - Math.exp(-dt * 3.5);
    H.cur.x += (H.px - H.cur.x) * k;
    H.cur.y += (H.py - H.cur.y) * k;
    const cam = H.cam;
    camera.position.set(cam.pos.x + H.cur.x * 0.7, cam.pos.y - H.cur.y * 0.3 + H.intro.k * 0.5, cam.pos.z + H.intro.k * 2.5);
    H.look.set(cam.look.x + H.cur.x * 1.4, cam.look.y - H.cur.y * 0.6, cam.look.z);
    camera.lookAt(H.look);
  }
}
