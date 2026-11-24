// SKILLS ROOM (Reactor Core): a holographic radar around a glowing reactor. Concentric rings are
// proficiency levels 1-5, spokes are skill categories, and every skill from data/skills.json is
// an orbiting sphere sitting on its level ring. Locked until the OXYGEN stabilizer game is won.
// Skills whose level is not a number from 1 to 5 (for example "[MISSING]") are shown as
// "not rated" on the outer rim and left out of the radar polygon.
// Contract: exports { init, enter, exit, update }.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { on } from '../core/events.js';
import { getState } from '../core/state.js';
import { disposeObject } from '../core/scene.js';
import { openModal, closeModal } from '../ui/modal.js';
import { startOxygen } from '../games/oxygen.js';
import skillsData from '@data/skills.json';
import projectsData from '@data/projects.json';

// ---------- constants ----------
const MAX_LEVEL = 5;
const RING_STEP = 1.1; // radius per proficiency level (level 5 ring = 5.5)
const UNRATED_R = 6.5; // unrated skills orbit just outside the level-5 ring
const LABEL_R = 7.5;
const CAT_COLORS = [0x00e5ff, 0xff6b2c, 0x7cff6b, 0xffd23f, 0xff3ea5, 0x8e7cff];

const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const _c = new THREE.Color();

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const polar = (deg, r, y = 0) => new THREE.Vector3(r * Math.sin(rad(deg)), y, -r * Math.cos(rad(deg)));
const catName = (c) => String(c).replace(/\s*Module$/i, '');

/** A level only counts when it is a number from 1 to 5; anything else means "not rated". */
function rating(skill) {
  const n = Number(skill.level);
  return Number.isFinite(n) && n >= 1 && n <= MAX_LEVEL ? Math.round(n) : 0;
}

// ---------- skill data prep ----------
function prepareSkills() {
  const cats = [...new Set(skillsData.map((s) => s.category))];
  const sector = 360 / Math.max(1, cats.length);
  const list = [];
  const sums = cats.map(() => ({ total: 0, n: 0 }));
  cats.forEach((cat, ci) => {
    const group = skillsData.filter((s) => s.category === cat);
    const center = 30 + ci * sector; // offset keeps the front (+Z) free for the console
    group.forEach((skill, k) => {
      const level = rating(skill);
      const spread = group.length > 1 ? (k / (group.length - 1) - 0.5) * sector * 0.6 : 0;
      if (level) { sums[ci].total += level; sums[ci].n++; }
      list.push({
        skill, id: `skill:${skill.name}`, cat: ci, level, rated: level > 0,
        angle: center + spread,
        radius: level ? level * RING_STEP + ((k % 3) - 1) * 0.1 : UNRATED_R,
        phase: (list.length * 2.399) % (Math.PI * 2),
        speed: 0.16 + 0.04 * (list.length % 4),
        group: null, mesh: null, mat: null, glow: null, reveal: 0, hoverK: 0,
      });
    });
  });
  const axes = cats.map((name, ci) => ({
    name, angle: 30 + ci * sector, color: CAT_COLORS[ci % CAT_COLORS.length],
    avg: sums[ci].n ? sums[ci].total / sums[ci].n : 0,
  }));
  return { list, axes, sector };
}

// ---------- related technologies (derived from projects.json and sibling skills) ----------
const STOP = new Set(['and', 'the', 'core', 'api', 'minimal', 'web', 'apps', 'app', 'with']);
const tokens = (str) =>
  String(str).toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t && !STOP.has(t) && (t.length >= 3 || /[+#]/.test(t)));

function relatedFor(entry, all) {
  const mine = new Set(tokens(entry.skill.name));
  const found = new Map(); // lowercase tech -> display tech
  const used = [];
  const showSecret = getState().achievements.includes('hidden_beacon');
  for (const p of projectsData) {
    if (p.secret && !showSecret) continue;
    let hit = false;
    for (const t of p.tech || []) {
      if (tokens(t).some((tok) => mine.has(tok))) {
        hit = true;
        found.set(t.toLowerCase(), t);
      }
    }
    if (hit) used.push(p.title);
  }
  for (const o of all) {
    if (o !== entry && o.cat === entry.cat) found.set(o.skill.name.toLowerCase(), o.skill.name);
  }
  found.delete(entry.skill.name.toLowerCase());
  return { chips: [...found.values()].slice(0, 12), used };
}

// ---------- shaders ----------
const UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Chamber wall: vertical light strips and bands, orange while unstable, cyan once stable
const WALL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uPower;
void main() {
  float strips = smoothstep(0.92, 1.0, abs(sin(vUv.x * 3.14159 * 48.0)));
  float bands = smoothstep(0.96, 1.0, sin((vUv.y * 6.0 - uTime * 0.05) * 3.14159));
  vec3 col = vec3(0.012, 0.022, 0.04);
  col += vec3(0.0, 0.9, 1.0) * (strips * 0.05 + bands * 0.08) * (0.25 + 0.75 * uPower);
  col += vec3(1.0, 0.4, 0.1) * bands * 0.06 * (1.0 - uPower);
  gl_FragColor = vec4(col * (0.5 + 0.5 * smoothstep(0.0, 0.25, vUv.y)), 1.0);
}`;

// Rising energy motes; positions animate on the GPU
const MOTE_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uPx;
varying float vA;
void main() {
  vec3 p = position;
  p.y = mod(position.y + uTime * (0.25 + 0.5 * aSeed), 9.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (0.5 + 1.0 * aSeed) * (60.0 / -mv.z) * uPx;
  vA = (0.3 + 0.7 * aSeed) * smoothstep(0.0, 1.0, p.y) * (1.0 - smoothstep(7.0, 9.0, p.y));
}`;
const MOTE_FRAG = /* glsl */ `
varying float vA;
uniform float uPower;
void main() {
  float d = length(gl_PointCoord - 0.5);
  vec3 col = mix(vec3(1.0, 0.4, 0.15), vec3(0.0, 0.9, 1.0), uPower);
  gl_FragColor = vec4(col, smoothstep(0.5, 0.0, d) * vA * (0.3 + 0.7 * uPower));
}`;

// ---------- textures ----------
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function makeLabelTexture(text, hex) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 72;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 26px Orbitron, sans-serif';
  g.shadowColor = hex;
  g.shadowBlur = 12;
  g.fillStyle = hex;
  g.fillText(text.toUpperCase(), 160, 36, 300);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- builders ----------
function buildChamber(root, mobile) {
  const wallMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
    vertexShader: UV_VERT,
    fragmentShader: WALL_FRAG,
    side: THREE.BackSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 14, 64, 1, true), wallMat);
  wall.position.y = 6;
  wall.userData.noPick = true;

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(7.6, 72),
    new THREE.MeshBasicMaterial({ color: 0x06101a, transparent: true, opacity: 0.85, depthWrite: false })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.02;
  disc.userData.noPick = true;
  const rimGeo = new THREE.TorusGeometry(7.6, 0.03, 8, 128);
  rimGeo.rotateX(Math.PI / 2);
  const rimMat = new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.3 });
  const rim = new THREE.Mesh(rimGeo, rimMat);

  // Rising motes
  const count = mobile ? 160 : 420;
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = 1.5 + Math.random() * 11.5;
    const a = Math.random() * Math.PI * 2;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 9;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uPx: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(geo, moteMat);
  motes.frustumCulled = false;
  motes.userData.noPick = true;
  root.add(wall, disc, rim, motes);
  return { wallMat, moteMat, rimMat };
}

function buildCore(root) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x4a5f80, roughness: 0.4, metalness: 0.75 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.3, 32), metal);
  base.position.y = 0.15;
  const orbMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 24), orbMat);
  orb.position.y = 1.1;
  const ringMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const rings = [0.8, 1.0, 1.2].map((r, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 64), ringMat);
    m.position.y = 1.1;
    m.rotation.set(i * 1.0, i * 0.7, 0);
    return m;
  });
  const beamMat = new THREE.MeshBasicMaterial({
    color: C_CYAN, transparent: true, opacity: 0.05, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 9, 16, 1, true), beamMat);
  beam.position.y = 4.5;
  beam.userData.noPick = true;
  const light = new THREE.PointLight(C_ORANGE, 0, 25, 2);
  light.position.set(0, 1.4, 0);
  group.add(base, orb, ...rings, beam, light);
  root.add(group);
  return { group, orb, orbMat, ringMat, rings, beamMat, light, p: 0 };
}

/** Level rings, category spokes and labels, and the average-level polygon. */
function buildRadar(root, axes, hasUnrated) {
  const rings = [];
  for (let i = 1; i <= MAX_LEVEL; i++) {
    const geo = new THREE.TorusGeometry(i * RING_STEP, 0.02, 8, 128);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: C_ORANGE, transparent: true, opacity: 0.12 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.02;
    root.add(mesh);
    rings.push({ mesh, mat, reveal: 0, hover: 0 });
  }
  if (hasUnrated) {
    const geo = new THREE.TorusGeometry(UNRATED_R, 0.012, 8, 128);
    geo.rotateX(Math.PI / 2);
    root.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.12 })));
  }

  const spokePts = [];
  for (const a of axes) spokePts.push(new THREE.Vector3(0, 0.02, 0), polar(a.angle, LABEL_R - 1.0, 0.02));
  const spokeMat = new THREE.LineBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.3 });
  root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokePts), spokeMat));

  // Radar polygon: average rated level per category (skipped if nothing is rated)
  const poly = new THREE.Group();
  const pts = axes.map((a) => polar(a.angle, a.avg * RING_STEP, 0.03));
  const anyRated = axes.some((a) => a.avg > 0);
  poly.visible = anyRated;
  const fillMat = new THREE.MeshBasicMaterial({
    color: C_CYAN, transparent: true, opacity: 0.18, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  if (anyRated && pts.length >= 3) {
    const verts = [0, 0.03, 0];
    pts.forEach((p) => verts.push(p.x, p.y, p.z));
    const idx = [];
    for (let i = 0; i < pts.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % pts.length));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    poly.add(new THREE.Mesh(g, fillMat));
    poly.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: C_CYAN })));
  }
  poly.userData.noPick = true;
  root.add(poly);

  const labels = axes.map((a) => {
    const hex = `#${new THREE.Color(a.color).getHexString()}`;
    const mat = new THREE.SpriteMaterial({ map: makeLabelTexture(catName(a.name), hex), transparent: true, depthTest: false, opacity: 0.3 });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(3.2, 0.72, 1);
    sp.position.copy(polar(a.angle, LABEL_R, 0.2));
    sp.renderOrder = 10;
    root.add(sp);
    return mat;
  });
  return { rings, poly, fillMat, spokeMat, labels };
}

function buildSkillSpheres(root, list, glowTex) {
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const s of list) {
    const col = new THREE.Color(CAT_COLORS[s.cat % CAT_COLORS.length]);
    const size = s.rated ? 0.2 + s.level * 0.04 : 0.22;
    s.baseEmissive = s.rated ? 1.1 : 0.6; // not-rated skills glow softer
    s.mat = new THREE.MeshStandardMaterial({
      color: col.clone().multiplyScalar(0.25), emissive: col, emissiveIntensity: s.baseEmissive,
      roughness: 0.3, metalness: 0.5,
    });
    s.mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 24, 16), s.mat);
    s.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: col, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: s.rated ? 0.85 : 0.5,
    }));
    s.glow.scale.setScalar(size * 5);
    s.baseGlow = s.rated ? 0.85 : 0.5;
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), hitMat);
    s.group = new THREE.Group();
    s.group.add(s.mesh, s.glow, hit);
    s.group.visible = false; // appears when the reactor is stabilized
    root.add(s.group);
  }
}

/** Stabilizer console: the clickable object that starts the oxygen game while the core is unstable. */
function buildConsole(root) {
  const group = new THREE.Group();
  group.position.set(0, 0, 4.1); // inside the camera's view (it used to sit just below the frame)
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 1.1, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x4a5f80, roughness: 0.5, metalness: 0.7 })
  );
  body.position.y = 0.55;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.8), new THREE.MeshBasicMaterial({ map: tex }));
  screen.position.set(0, 0.62, 0.36);
  screen.rotation.x = -0.25;
  const ledMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const ledGeo = new THREE.BoxGeometry(0.16, 0.06, 0.04);
  [-0.5, 0, 0.5].forEach((x) => {
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(x, 0.12, 0.36);
    group.add(led);
  });
  const light = new THREE.PointLight(C_ORANGE, 40, 10, 2);
  light.position.set(0, 2, 1.6);
  group.add(body, screen, light);
  root.add(group);

  const g = canvas.getContext('2d');
  const draw = (online) => {
    g.fillStyle = '#04121a';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = online ? '#00E5FF' : '#FF6B2C';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 22px Orbitron, sans-serif';
    g.fillText(online ? 'CORE STABLE' : 'CORE UNSTABLE', 128, 44);
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(online ? 'SKILLS ONLINE' : 'CLICK TO STABILIZE', 128, 86);
    tex.needsUpdate = true;
  };
  draw(false);
  return { group, ledMat, light, draw };
}

// ---------- runtime state ----------
let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the room is not active

const reduced = () => !!ctx?.reducedMotion;

/** Back the camera off on narrow screens so the whole radar and its labels stay in view. */
function fitCamera() {
  if (!H) return;
  const aspect = window.innerWidth / window.innerHeight;
  const fov = 55;
  const tanH = Math.tan(rad(fov / 2));
  H.cam.fov = fov;
  H.cam.dist = clamp(8.2 / (tanH * Math.min(aspect, 1.6)), 11.5, 30);
  H.cam.el = aspect < 0.8 ? rad(52) : rad(38); // look more top-down on phones
  ctx.camera.fov = fov;
  ctx.camera.updateProjectionMatrix();
}

// ---------- interactions ----------
function openSkill(entry) {
  const sk = entry.skill;
  const rel = relatedFor(entry, H.skills);
  const keyboardUser = document.activeElement?.classList?.contains('a11y-proxy');
  ctx.audio.play('click');
  ctx.input.setEnabled(false); // the modal owns input until it closes
  const meta = [];
  if (!entry.rated) meta.push({ label: 'PROFICIENCY', value: 'Not rated yet' });
  if (rel.used.length) meta.push({ label: 'USED IN', value: rel.used.join(', ') });
  openModal({
    kicker: `REACTOR MODULE // ${catName(sk.category).toUpperCase()}`,
    title: sk.name,
    description: sk.description,
    meter: entry.rated ? { label: 'PROFICIENCY', value: entry.level, max: MAX_LEVEL } : undefined,
    meta,
    chipsTitle: 'Related technologies',
    chips: rel.chips,
    onClose: () => {
      if (!H) return;
      ctx.input.setEnabled(true);
      if (keyboardUser) ctx.input.focus(entry.id); // keyboard users return to the sphere they opened
    },
  });
}

async function repair() {
  if (!H || H.unlocked || H.gameOpen) return;
  H.gameOpen = true;
  ctx.input.setEnabled(false);
  const won = await startOxygen({ room: 'skills' }); // emits game:win, room:power, xp:add itself
  if (!H) return;
  H.gameOpen = false;
  ctx.input.setEnabled(true);
  if (!won && !H.unlocked) ctx.input.toast('Reactor still unstable. Try again when ready.');
}

function onConsole() {
  if (!H) return;
  if (H.unlocked) ctx.input.toast('REACTOR STABLE. All skill modules are online.');
  else repair();
}

/** Bring the reactor online: core turns cyan, rings light up level by level, spheres launch, radar draws. */
function unlock(animate = true, quiet = false) {
  if (H.unlocked) return;
  H.unlocked = true;
  H.console.draw(true);
  H.console.group.visible = false; // the console has done its job: keep the view clear
  ctx.input.setActive('console', false);
  for (const s of H.skills) ctx.input.setActive(s.id, true);
  if (animate && !reduced()) {
    H.gctx.add(() => {
      gsap.to(H.core, { p: 1, duration: 1.8, ease: 'power2.out' });
      H.radar.rings.forEach((r, i) => gsap.to(r, { reveal: 1, duration: 0.5, delay: 0.3 + i * 0.25 }));
      H.skills.forEach((s, i) => gsap.to(s, { reveal: 1, duration: 0.9, delay: 1.0 + i * 0.08, ease: 'back.out(1.7)' }));
      gsap.to(H, { radarK: 1, duration: 1.2, delay: 1.6, ease: 'power2.out' });
    });
  } else {
    H.core.p = 1;
    H.radar.rings.forEach((r) => { r.reveal = 1; });
    H.skills.forEach((s) => { s.reveal = 1; });
    H.radarK = 1;
  }
  if (!quiet) ctx.input.toast('REACTOR STABILIZED: skill modules online.', 3500);
}

// ---------- room contract ----------
export function init(sceneArg, ctxArg) {
  scene = sceneArg;
  ctx = ctxArg;
}

export function enter() {
  const root = new THREE.Group();
  scene.add(root);
  const { list, axes, sector } = prepareSkills();
  const glowTex = makeGlowTexture();
  const chamber = buildChamber(root, ctx.isMobile);
  const core = buildCore(root);
  const radar = buildRadar(root, axes, list.some((s) => !s.rated));
  buildSkillSpheres(root, list, glowTex);
  const consoleObj = buildConsole(root);
  root.add(new THREE.HemisphereLight(0x6a8ab0, 0x0b0f1a, 2.4));

  H = {
    root, chamber, core, radar, skills: list, axes, glowTex, console: consoleObj,
    gctx: gsap.context(() => {}),
    offs: [],
    unlocked: false, gameOpen: false, radarK: 0,
    sweep: sector * 0.12, // degrees each sphere drifts either side of its anchor
    px: 0, py: 0, cur: { x: 0, y: 0 },
    cam: { fov: 55, dist: 12, el: rad(38) },
  };
  fitCamera();
  ctx.stage.setBloom({ strength: 1.0, radius: 0.6, threshold: 0.8 });

  // Interactive objects, in logical Tab order: the console first, then the skill spheres
  const input = ctx.input;
  input.setEnabled(true);
  input.register(consoleObj.group, {
    id: 'console',
    label: () => (H.unlocked ? 'STABILIZER CONSOLE: reactor stable' : 'STABILIZER CONSOLE: click to stabilize the reactor'),
    onClick: onConsole,
  });
  for (const s of list) {
    input.register(s.group, {
      id: s.id,
      label: () => s.rated ? `${s.skill.name} [LEVEL ${s.level}/${MAX_LEVEL}]` : s.skill.name,
      onClick: () => {
        if (H.unlocked) openSkill(s);
      },
    });
    input.setActive(s.id, false);
  }

  // Pointer parallax (orbits the camera a little) and resize handling
  const onMove = (e) => {
    if (reduced()) return;
    H.px = (e.clientX / window.innerWidth) * 2 - 1;
    H.py = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    ctx.stage.onResize(fitCamera),
    on('room:power', ({ room }) => {
      if (room === 'skills' && H) unlock(true);
    })
  );

  if (getState().power.skills) unlock(true, true);
  else input.toast('REACTOR CORE UNSTABLE. Use the stabilizer console to bring it online.', 4500);
}

export function exit() {
  if (!H) return;
  closeModal();
  H.gctx.kill();
  for (const off of H.offs) off();
  ctx.input.clear();
  ctx.input.setEnabled(true); // the next room starts with input on
  scene.remove(H.root);
  disposeObject(H.root);
  H.glowTex.dispose();
  ctx.camera.fov = 60;
  ctx.camera.updateProjectionMatrix();
  ctx.stage.setBloom({ strength: 0.9, radius: 0.55, threshold: 0.82 });
  H = null;
}

export function update(dt, t = 0) {
  if (!H) return;
  const cam = ctx.camera;
  const input = ctx.input;
  const tt = reduced() ? 0 : t; // freeze shader animation for reduced motion
  const core = H.core;
  const p = core.p;
  const k = 1 - Math.exp(-dt * 6);

  // Chamber: wall, motes and rim shift from orange (unstable) to cyan (stable)
  H.chamber.wallMat.uniforms.uTime.value = tt;
  H.chamber.wallMat.uniforms.uPower.value = p;
  H.chamber.moteMat.uniforms.uTime.value = tt;
  H.chamber.moteMat.uniforms.uPower.value = p;
  H.chamber.rimMat.color.copy(C_ORANGE).lerp(C_CYAN, p);

  // Reactor core: flickers while unstable, steady pulse once stable
  const noise = p < 1 ? 0.7 + 0.3 * Math.sin(tt * 23) * Math.sin(tt * 7.3) : 1;
  const lvl = (0.15 + 0.85 * p) * noise;
  _c.copy(C_ORANGE).lerp(C_CYAN, p);
  core.orbMat.color.copy(_c).multiplyScalar(0.7 + 2.2 * lvl);
  core.orb.scale.setScalar(1 + (reduced() ? 0 : Math.sin(tt * 2.4) * 0.06 * (0.4 + p)));
  core.ringMat.color.copy(_c).multiplyScalar(0.5 + 1.5 * lvl);
  core.beamMat.color.copy(_c);
  core.beamMat.opacity = 0.03 + 0.08 * p;
  core.light.color.copy(_c);
  core.light.intensity = 260 * lvl;
  if (!reduced()) {
    core.rings.forEach((r, i) => {
      r.rotation.x += dt * (0.4 + i * 0.2) * (0.3 + p);
      r.rotation.y += dt * (0.3 + i * 0.15) * (0.3 + p);
    });
  }

  // Which level ring should glow? The one belonging to the hovered sphere.
  let hoverLevel = 0;
  for (const s of H.skills) {
    s.hoverK += ((input.isHovered(s.id) ? 1 : 0) - s.hoverK) * Math.min(1, dt * 10);
    if (s.hoverK > 0.5 && s.rated) hoverLevel = s.level;
  }
  H.radar.rings.forEach((r, i) => {
    r.hover += ((hoverLevel === i + 1 ? 1 : 0) - r.hover) * Math.min(1, dt * 10);
    r.mat.color.copy(C_ORANGE).lerp(C_CYAN, r.reveal);
    r.mat.opacity = 0.12 + 0.45 * r.reveal + 0.4 * r.hover;
  });
  H.radar.spokeMat.opacity = 0.12 + 0.25 * p;
  H.radar.poly.scale.set(Math.max(0.001, H.radarK), 1, Math.max(0.001, H.radarK));
  H.radar.fillMat.opacity = 0.12 + (reduced() ? 0.04 : 0.04 * Math.sin(tt * 1.5) + 0.04);
  for (const m of H.radar.labels) m.opacity = 0.3 + 0.7 * p;

  // Skill spheres: sweep along their level ring inside their category sector
  for (const s of H.skills) {
    const a = rad(s.angle + (reduced() ? 0 : Math.sin(tt * s.speed + s.phase) * H.sweep));
    const r = s.radius + (reduced() ? 0 : Math.sin(tt * 0.9 + s.phase) * 0.08);
    const y = 0.45 + (reduced() ? 0 : Math.sin(tt * 1.1 + s.phase) * 0.12) + 0.25 * s.hoverK;
    s.group.position.set(r * Math.sin(a), y, -r * Math.cos(a));
    s.group.scale.setScalar(Math.max(0.0001, s.reveal * (1 + 0.4 * s.hoverK)));
    s.group.visible = s.reveal > 0.01;
    s.mat.emissiveIntensity = s.baseEmissive + 0.9 * s.hoverK;
    s.glow.material.opacity = s.baseGlow * (0.85 + (reduced() ? 0.15 : 0.15 * Math.sin(tt * 2 + s.phase))) + 0.3 * s.hoverK;
  }

  // Console: blinking orange LEDs while unstable, steady cyan once stable
  _c.copy(H.unlocked ? C_CYAN : C_ORANGE);
  H.console.ledMat.color.copy(_c).multiplyScalar(H.unlocked ? 1.6 : Math.sin(tt * 4) > 0 ? 1.8 : 0.3);
  H.console.light.color.copy(_c);

  // Camera orbits slightly with the pointer
  H.cur.x += (H.px - H.cur.x) * k;
  H.cur.y += (H.py - H.cur.y) * k;
  const az = H.cur.x * 0.35;
  const el = H.cam.el - H.cur.y * 0.08;
  const d = H.cam.dist;
  cam.position.set(d * Math.sin(az) * Math.cos(el), d * Math.sin(el), d * Math.cos(az) * Math.cos(el));
  cam.lookAt(0, 0.3, 0);
}
