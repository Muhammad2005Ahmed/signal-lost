// QUICK PORTFOLIO: the no-game version of SIGNAL LOST. A normal scrolling page (about, toolkit,
// missions, medals, flight log, contact) over a fixed Three.js scene. Scrolling flies the camera
// through the space station: one 3D object per section. All page text comes from data/*.json and is
// inserted with textContent. Contract: mountQuickPortfolio({ onPlay }) -> unmount().

import * as THREE from 'three';
import { gsap } from 'gsap';
import './quick.css';
import profile from '@data/profile.json';
import resume from '@data/resume.json';
import projectsData from '@data/projects.json';
import { initChat, openChat, destroyChat } from '../ui/chat.js';
import { createContactForm } from '../ui/contactForm.js';
import { mountAvatar } from './avatar.js';

let contactForm = null; // the live contact form (destroyed on unmount)

const SPACING = 40; // distance between the 3D stops
const CAM_DIST = 16; // camera stays this far in front of the current stop
const CYAN = 0x00e5ff;
const ORANGE = 0xff6b2c;

const SECTIONS = [
  { id: 'qp-home', label: 'Home' },
  { id: 'qp-about', label: 'Crew' },
  { id: 'qp-toolkit', label: 'Toolkit' },
  { id: 'qp-missions', label: 'Missions' },
  { id: 'qp-medals', label: 'Medals' },
  { id: 'qp-log', label: 'Flight Log' },
  { id: 'qp-contact', label: 'Contact' },
];

/** Tiny DOM helper: strings become text nodes, so data can never inject HTML. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ico = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'qp-ico');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
};
const ICONS = {
  mail: 'M4 6h16v12H4z M4 7l8 6 8-6',
  phone: 'M6 3h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z',
  pin: 'M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  code: 'M8 8l-5 4 5 4 M16 8l5 4-5 4 M14 5l-4 14',
  down: 'M12 4v12 M6 12l6 6 6-6',
};

// ------------------------------------------------------------------ 3D scene

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
const baseMat = (color, opacity = 1, extra = {}) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, ...extra });
const ringMesh = (r, tube, color, opacity) => new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 96), baseMat(color, opacity));

function buildScene(canvas, { reduced, mobile }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x05070d, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070d, 0.011);
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 600);
  const glowTex = glowTexture();

  // Stars
  const starCount = mobile ? 900 : 2600;
  const pos = new Float32Array(starCount * 3);
  const col = new Float32Array(starCount * 3);
  const c = new THREE.Color();
  for (let i = 0; i < starCount; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 160;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 100;
    pos[i * 3 + 2] = 40 - Math.random() * (SPACING * (SECTIONS.length + 1));
    c.setHex(Math.random() < 0.12 ? ORANGE : Math.random() < 0.5 ? CYAN : 0xdfefff);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: mobile ? 0.28 : 0.2, vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true }));
  scene.add(stars);

  const dummy = new THREE.Object3D();
  const stops = [];
  const sprite = (color, scale, opacity = 0.9) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.setScalar(scale);
    return s;
  };

  // 0. HOME: the dark station core with orbiting rings and satellites
  {
    const g = new THREE.Group();
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.2, 1)), lineMat(CYAN, 0.55));
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 16), baseMat(ORANGE));
    const rings = [ringMesh(4.6, 0.025, CYAN, 0.8), ringMesh(5.5, 0.02, ORANGE, 0.7), ringMesh(6.4, 0.02, CYAN, 0.5)];
    rings[0].rotation.x = 1.2;
    rings[1].rotation.set(0.4, 0.8, 0);
    rings[2].rotation.set(-0.7, 0.2, 0.5);
    const sats = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.13), baseMat(CYAN), 36);
    g.add(wire, core, sprite(ORANGE, 7), ...rings, sats);
    stops.push({
      group: g,
      update(t) {
        wire.rotation.y = t * 0.15;
        wire.rotation.x = t * 0.05;
        rings.forEach((r, i) => { r.rotation.z = t * (0.12 + i * 0.07); });
        for (let i = 0; i < 36; i++) {
          const a = t * (0.25 + (i % 5) * 0.05) + i * 0.7;
          const rad = 4.6 + (i % 3) * 0.9;
          dummy.position.set(Math.cos(a) * rad, Math.sin(a * 0.8 + i) * 1.6, Math.sin(a) * rad);
          dummy.scale.setScalar(1);
          dummy.rotation.set(a, a, 0);
          dummy.updateMatrix();
          sats.setMatrixAt(i, dummy.matrix);
        }
        sats.instanceMatrix.needsUpdate = true;
      },
    });
  }

  // 1. CREW: a torus knot with a ring of crew orbs
  {
    const g = new THREE.Group();
    const knot = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.TorusKnotGeometry(2.1, 0.55, 120, 12)), lineMat(ORANGE, 0.55));
    const orbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 12, 8), baseMat(CYAN), 10);
    g.add(knot, orbs, sprite(CYAN, 6, 0.35));
    stops.push({
      group: g,
      update(t) {
        knot.rotation.set(t * 0.12, t * 0.2, 0);
        for (let i = 0; i < 10; i++) {
          const a = t * 0.3 + (i / 10) * Math.PI * 2;
          dummy.position.set(Math.cos(a) * 5, Math.sin(a * 2) * 0.5, Math.sin(a) * 5);
          dummy.scale.setScalar(1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          orbs.setMatrixAt(i, dummy.matrix);
        }
        orbs.instanceMatrix.needsUpdate = true;
      },
    });
  }

  // 2. TOOLKIT: reactor rings with orbiting tool spheres
  {
    const g = new THREE.Group();
    const rings = [2.2, 3.4, 4.6, 5.8].map((r, i) => ringMesh(r, 0.02, i % 2 ? ORANGE : CYAN, 0.7 - i * 0.1));
    rings.forEach((r) => { r.rotation.x = Math.PI / 2.4; });
    const orbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 12, 8), baseMat(CYAN), 28);
    g.add(...rings, orbs, sprite(CYAN, 5, 0.7));
    stops.push({
      group: g,
      update(t) {
        g.rotation.z = t * 0.05;
        for (let i = 0; i < 28; i++) {
          const ring = i % 4;
          const a = t * (0.5 - ring * 0.08) + i * 1.3;
          const r = 2.2 + ring * 1.2;
          dummy.position.set(Math.cos(a) * r, Math.sin(a) * r * Math.cos(Math.PI / 2.4), Math.sin(a) * r * Math.sin(Math.PI / 2.4));
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          orbs.setMatrixAt(i, dummy.matrix);
        }
        orbs.instanceMatrix.needsUpdate = true;
      },
    });
  }

  // 3. MISSIONS: drifting wireframe cubes (the project files)
  {
    const g = new THREE.Group();
    const N = 22;
    const cubes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.7 }), N);
    const seeds = [];
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(2.5 + Math.random() * 4);
      seeds.push({ v, s: 0.5 + Math.random() * 1.1, p: Math.random() * 6.28 });
      cubes.setColorAt(i, new THREE.Color(i % 4 === 0 ? ORANGE : CYAN));
    }
    g.add(cubes);
    stops.push({
      group: g,
      update(t) {
        seeds.forEach((s, i) => {
          dummy.position.copy(s.v);
          dummy.position.y += Math.sin(t * 0.6 + s.p) * 0.4;
          dummy.rotation.set(t * 0.2 + s.p, t * 0.25, 0);
          dummy.scale.setScalar(s.s);
          dummy.updateMatrix();
          cubes.setMatrixAt(i, dummy.matrix);
        });
        cubes.instanceMatrix.needsUpdate = true;
      },
    });
  }

  // 4. MEDALS: a signal beacon with expanding rings
  {
    const g = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 5, 6, 1, true), new THREE.MeshBasicMaterial({ color: ORANGE, wireframe: true, transparent: true, opacity: 0.7 }));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 22, 8), baseMat(ORANGE, 0.55, { blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.y = 9;
    const waves = [0, 1, 2, 3].map(() => new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), baseMat(CYAN, 0.6, { side: THREE.DoubleSide, depthWrite: false })));
    waves.forEach((w) => { w.rotation.x = Math.PI / 2; w.position.y = -2.4; });
    g.add(cone, beam, sprite(ORANGE, 5, 0.6), ...waves);
    stops.push({
      group: g,
      update(t) {
        cone.rotation.y = t * 0.4;
        waves.forEach((w, i) => {
          const k = (t * 0.25 + i / 4) % 1;
          w.scale.setScalar(1 + k * 9);
          w.material.opacity = 0.6 * (1 - k);
        });
      },
    });
  }

  // 5. FLIGHT LOG: a helix of waypoints
  {
    const g = new THREE.Group();
    const n = 320;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 6;
      p[i * 3] = Math.cos(a) * 3;
      p[i * 3 + 1] = (i / n) * 14 - 7;
      p[i * 3 + 2] = Math.sin(a) * 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const helix = new THREE.Points(geo, new THREE.PointsMaterial({ color: CYAN, size: 0.12, transparent: true, opacity: 0.9, depthWrite: false }));
    const nodes = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 12, 8), baseMat(ORANGE), 4);
    for (let i = 0; i < 4; i++) {
      const a = ((i * 0.3 + 0.1) * Math.PI * 6);
      dummy.position.set(Math.cos(a) * 3, (i * 0.3 + 0.1) * 14 - 7, Math.sin(a) * 3);
      dummy.scale.setScalar(1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      nodes.setMatrixAt(i, dummy.matrix);
    }
    g.add(helix, nodes);
    stops.push({ group: g, update(t) { g.rotation.y = t * 0.2; } });
  }

  // 6. CONTACT: a radar sweep listening for a transmission
  {
    const g = new THREE.Group();
    const grid = [1.5, 3, 4.5, 6].map((r) => new THREE.Mesh(new THREE.RingGeometry(r - 0.015, r, 64), baseMat(CYAN, 0.5, { side: THREE.DoubleSide })));
    const sweep = new THREE.Mesh(new THREE.RingGeometry(0.01, 6, 48, 1, 0, Math.PI / 3), baseMat(CYAN, 0.22, { side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    const blips = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 10, 8), baseMat(ORANGE), 6);
    for (let i = 0; i < 6; i++) {
      const a = i * 1.1 + 0.4;
      const r = 1.5 + (i % 4) * 1.3;
      dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      dummy.scale.setScalar(1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      blips.setMatrixAt(i, dummy.matrix);
    }
    g.add(...grid, sweep, blips, sprite(CYAN, 3, 0.5));
    g.rotation.x = -0.5;
    stops.push({ group: g, update(t) { sweep.rotation.z = -t * 1.2; } });
  }

  stops.forEach((s) => scene.add(s.group));

  // Place stops: on wide screens they sit left/right of the text, on phones behind it and dimmer
  const SIDE = [5.5, -6, 6, -6, 6, -6, 0];
  function layout(isMobile) {
    stops.forEach((s, i) => {
      s.group.position.set(isMobile ? 0 : SIDE[i], isMobile ? 3 : 0, -i * SPACING - (isMobile ? 4 : 0));
      s.group.scale.setScalar(isMobile ? 0.7 : 1);
      s.group.traverse((o) => {
        const m = o.material;
        if (!m || Array.isArray(m)) return;
        if (m.userData.base === undefined) m.userData.base = m.opacity;
        m.transparent = true;
        m.opacity = m.userData.base * (isMobile ? 0.4 : 1); // dimmer behind the text on phones
        m.needsUpdate = true;
      });
    });
  }
  layout(mobile);

  return { renderer, scene, camera, stops, stars, layout, glowTex };
}

// ------------------------------------------------------------------ page sections

const real = (v) => (typeof v === 'string' && v && !v.startsWith('[MISSING') ? v : '');

function sectionHead(kicker, title) {
  return h('header', { class: 'qp-sechead' }, h('p', { class: 'qp-kicker', text: kicker }), h('h2', { text: title }));
}

function buildHome(onNavigate) {
  const c = profile.contact;
  return h('section', { id: 'qp-home', class: 'qp-sec qp-hero', 'aria-labelledby': 'qp-name' },
    h('div', { class: 'qp-hero__in' },
      h('div', { class: 'qp-avatar', 'aria-hidden': 'true' }), // the 3D avatar mounts here (avatar.js)
      h('p', { class: 'qp-kicker qp-hero__kicker', text: '// TRANSMISSION ESTABLISHED' }),
      h('h1', { id: 'qp-name', class: 'qp-hero__name', text: profile.name }),
      h('p', { class: 'qp-hero__role', text: 'Game Developer · Unity & C# · Data Science' }),
      h('p', { class: 'qp-hero__tag', text: profile.tagline }),
      h('div', { class: 'qp-actions' },
        h('a', { class: 'qp-btn qp-btn--solid', href: '#qp-missions', onclick: onNavigate, text: 'VIEW MISSIONS' }),
        h('a', { class: 'qp-btn', href: c.cv, download: 'Muhammad_Ahmed_CV.pdf', text: 'DOWNLOAD CV' }),
        h('button', { class: 'qp-btn qp-btn--warn', type: 'button', onclick: () => openChat(), text: 'ASK A.R.I.A' })
      ),
      h('a', { class: 'qp-scrollcue', href: '#qp-about', onclick: onNavigate, 'aria-label': 'Scroll to the next section' }, ico(ICONS.down))
    )
  );
}

function buildTicker() {
  const items = resume.tools.flatMap((g) => g.items);
  const track = h('div', { class: 'qp-ticker__track' });
  for (let rep = 0; rep < 2; rep++) {
    const set = h('ul', { class: 'qp-ticker__set', 'aria-hidden': rep ? 'true' : null });
    items.forEach((t) => set.append(h('li', { text: t })));
    track.append(set);
  }
  return h('div', { class: 'qp-ticker', role: 'presentation' }, track);
}

function buildAbout() {
  const stats = h('div', { class: 'qp-stats' });
  resume.stats.forEach((s) => {
    const num = parseFloat(s.value);
    const decimals = (String(s.value).split('.')[1] || '').length;
    stats.append(h('div', { class: 'qp-stat' },
      h('span', { class: 'qp-stat__v', 'data-to': String(num), 'data-dec': String(decimals), text: s.value }),
      h('span', { class: 'qp-stat__l', text: s.label })));
  });
  const list = h('ul', { class: 'qp-list' });
  resume.summary.forEach((t) => list.append(h('li', { text: t })));
  return h('section', { id: 'qp-about', class: 'qp-sec', 'aria-labelledby': 'qp-about-h' },
    h('div', { class: 'qp-wrap' },
      sectionHead('// 01 · CREW PROFILE', 'Know Your Engineer'),
      h('div', { class: 'qp-grid qp-grid--about' },
        h('div', { class: 'qp-panel qp-reveal' }, h('h3', { text: 'Professional Summary' }), list,
          h('p', { class: 'qp-note', text: `${profile.program}, ${profile.university}.` })),
        stats)));
}

function buildToolkit() {
  const grid = h('div', { class: 'qp-grid qp-grid--tools' });
  resume.tools.forEach((g) => {
    const chips = h('ul', { class: 'qp-chips' });
    g.items.forEach((i) => chips.append(h('li', { class: 'qp-chip', text: i })));
    grid.append(h('div', { class: 'qp-panel qp-reveal' }, h('h3', { text: g.group }), chips));
  });
  const interests = h('p', { class: 'qp-note qp-reveal', text: `Off-duty: ${resume.interests.join(' · ')}` });
  return h('section', { id: 'qp-toolkit', class: 'qp-sec', 'aria-labelledby': 'qp-tool-h' },
    h('div', { class: 'qp-wrap' }, sectionHead('// 02 · TOOLKIT', 'Tools of the Trade'), grid, interests));
}

function buildMissions() {
  const list = projectsData.filter((p) => !p.secret);
  const freq = new Map();
  list.forEach((p) => (p.tech || []).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
  const tags = [...freq.entries()].filter((e) => e[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  if (list.some((p) => p.badge)) tags.push('Awarded');
  const grid = h('div', { class: 'qp-grid qp-grid--projects' });
  const count = h('p', { class: 'qp-note', 'aria-live': 'polite' });

  const cards = list.map((p, i) => {
    const chips = h('ul', { class: 'qp-chips' });
    (p.tech || []).forEach((t) => chips.append(h('li', { class: 'qp-chip qp-chip--sm', text: t })));
    const card = h('article', { class: 'qp-card qp-reveal' },
      h('p', { class: 'qp-card__no', text: `MISSION ${String(i + 1).padStart(2, '0')}` }),
      real(p.badge) ? h('p', { class: 'qp-badge', text: p.badge }) : null,
      h('h3', { text: p.title }),
      h('p', { class: 'qp-card__text', text: p.shortDescription }),
      chips);
    grid.append(card);
    return { card, p };
  });

  const bar = h('ul', { class: 'qp-filters', 'aria-label': 'Filter missions' });
  const btns = [];
  const apply = (tag) => {
    let shown = 0;
    cards.forEach(({ card, p }) => {
      const ok = !tag || (tag === 'Awarded' ? !!real(p.badge) : (p.tech || []).includes(tag));
      card.hidden = !ok;
      if (ok) shown++;
    });
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tag === (tag || ''))));
    count.textContent = `${shown} of ${cards.length} missions`;
  };
  for (const tag of [null, ...tags]) {
    const b = h('button', { type: 'button', class: 'qp-chip qp-chip--btn', 'data-tag': tag || '', 'aria-pressed': String(tag === null), text: tag || 'ALL', onclick: () => apply(tag) });
    btns.push(b);
    bar.append(h('li', {}, b));
  }
  apply(null);
  return h('section', { id: 'qp-missions', class: 'qp-sec', 'aria-labelledby': 'qp-mis-h' },
    h('div', { class: 'qp-wrap' }, sectionHead('// 03 · MISSIONS COMPLETED', 'Projects I Built'), bar, count, grid));
}

function buildMedals() {
  const grid = h('div', { class: 'qp-grid qp-grid--medals' });
  resume.awards.forEach((a) => grid.append(h('div', { class: 'qp-panel qp-medal qp-reveal' },
    h('span', { class: 'qp-medal__ico', 'aria-hidden': 'true', text: a.icon }), h('h3', { text: a.title }), h('p', { text: a.detail }))));
  resume.certifications.forEach((c) => grid.append(h('div', { class: 'qp-panel qp-medal qp-reveal' },
    h('span', { class: 'qp-medal__ico', 'aria-hidden': 'true', text: '📜' }), h('h3', { text: c.title }), h('p', { text: `${c.issuer}. ${c.detail}` }))));
  return h('section', { id: 'qp-medals', class: 'qp-sec', 'aria-labelledby': 'qp-med-h' },
    h('div', { class: 'qp-wrap' }, sectionHead('// 04 · MEDALS & CERTIFICATES', 'Trophies in the Vault'), grid));
}

function buildLog() {
  const ol = h('ol', { class: 'qp-timeline' });
  resume.timeline.forEach((t) => ol.append(h('li', { class: 'qp-tl qp-reveal' },
    h('p', { class: 'qp-tl__when', text: t.period }), h('h3', { text: t.title }),
    h('p', { class: 'qp-tl__where', text: t.place }), h('p', { text: t.detail }))));
  return h('section', { id: 'qp-log', class: 'qp-sec', 'aria-labelledby': 'qp-log-h' },
    h('div', { class: 'qp-wrap' }, sectionHead('// 05 · FLIGHT LOG', 'Stations So Far'), ol));
}

/** "Ask my AI" panel: opens the shared A.R.I.A terminal, optionally with a first question. */
function buildAsk() {
  const chips = [
    ['What projects has he built?', 'What projects has Muhammad built?'],
    ['Skills?', 'What skills does Muhammad have?'],
    ['Education?', "What is Muhammad's education?"],
  ];
  return h('div', { class: 'qp-panel qp-ask qp-reveal' },
    h('p', { class: 'qp-kicker', text: '// ASK MY AI' }),
    h('h3', { text: 'A.R.I.A knows this portfolio' }),
    h('p', { text: 'The station AI answers only from verified logs about Muhammad. Ask in English or Urdu, by typing or by voice.' }),
    h('div', { class: 'qp-actions qp-ask__actions' },
      h('button', { class: 'qp-btn qp-btn--solid', type: 'button', onclick: () => openChat(), text: 'OPEN A.R.I.A TERMINAL' }),
      ...chips.map(([label, q]) => h('button', { class: 'qp-chip qp-chip--btn', type: 'button', onclick: () => openChat({ ask: q }), text: label }))));
}

function buildContact() {
  const c = profile.contact;
  const row = (icon, label, text, href, ext) => h('li', {},
    h('a', { class: 'qp-contact', href, target: ext ? '_blank' : null, rel: ext ? 'noopener noreferrer' : null },
      ico(ICONS[icon]), h('span', { class: 'qp-contact__l', text: label }), h('span', { text })));
  const phoneHref = `tel:${String(c.phone).replace(/[^+\d]/g, '')}`;
  contactForm = createContactForm(); // posts to /api/contact (same form as the game's Comms Tower)
  return h('section', { id: 'qp-contact', class: 'qp-sec', 'aria-labelledby': 'qp-con-h' },
    h('div', { class: 'qp-wrap' }, sectionHead('// 06 · OPEN CHANNEL', 'Send a Transmission'),
      buildAsk(),
      h('div', { class: 'qp-grid qp-grid--contact' },
        h('div', { class: 'qp-panel qp-reveal' },
          h('ul', { class: 'qp-contactlist' },
            row('mail', 'EMAIL', c.email, `mailto:${c.email}`),
            row('phone', 'PHONE', c.phone, phoneHref),
            row('link', 'LINKEDIN', 'muhammad-ahmed-927081215', c.linkedin, true),
            row('code', 'GITHUB', 'Muhammad2005Ahmed', c.github, true),
            h('li', {}, h('span', { class: 'qp-contact qp-contact--static' }, ico(ICONS.pin), h('span', { class: 'qp-contact__l', text: 'BASE' }), h('span', { text: c.city })))),
          h('div', { class: 'qp-actions' },
            h('a', { class: 'qp-btn qp-btn--solid', href: c.cv, download: 'Muhammad_Ahmed_CV.pdf', text: 'DOWNLOAD CV' }),
            h('a', { class: 'qp-btn', href: c.cv, target: '_blank', rel: 'noopener noreferrer', text: 'VIEW CV' }))),
        h('div', { class: 'qp-panel qp-reveal' }, contactForm.el))));
}

// ------------------------------------------------------------------ mount

export function mountQuickPortfolio({ onPlay } = {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const html = document.documentElement;
  html.classList.add('qp-mode');
  let mobile = window.innerWidth < 768;

  const canvas = h('canvas', { class: 'qp-canvas', 'aria-hidden': 'true' });
  const navLinks = SECTIONS.map((s) => h('a', { href: `#${s.id}`, 'data-id': s.id, text: s.label }));
  const nav = h('nav', { class: 'qp-nav', id: 'qp-nav', 'aria-label': 'Sections' }, navLinks,
    h('button', { class: 'qp-nav__play', type: 'button', onclick: () => onPlay?.(), text: 'PLAY THE MISSION' }));
  const menuBtn = h('button', { class: 'qp-menu', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'qp-nav', 'aria-label': 'Menu', text: 'MENU' });
  const closeMenu = () => { nav.classList.remove('is-open'); menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  const head = h('header', { class: 'qp-head' },
    h('a', { class: 'qp-brand', href: '#qp-home', 'aria-label': 'Back to top' }, h('span', { text: 'MA' }), h('span', { class: 'qp-brand__sub', text: '// SIGNAL LOST' })),
    nav,
    h('div', { class: 'qp-head__tools' },
      h('button', { class: 'qp-btn qp-btn--sm', type: 'button', 'aria-label': 'Ask A.R.I.A, the AI assistant (C)', onclick: () => openChat(), text: 'A.R.I.A' }),
      h('a', { class: 'qp-btn qp-btn--sm', href: profile.contact.cv, download: 'Muhammad_Ahmed_CV.pdf', text: 'CV' }),
      h('button', { class: 'qp-btn qp-btn--sm qp-btn--warn', type: 'button', onclick: () => onPlay?.(), text: 'PLAY THE MISSION' }),
      menuBtn));

  const main = h('main', { id: 'qp-main' },
    buildHome(closeMenu), buildTicker(), buildAbout(), buildToolkit(), buildMissions(), buildMedals(), buildLog(), buildContact());
  const foot = h('footer', { class: 'qp-foot' },
    h('p', { text: `© ${new Date().getFullYear()} ${profile.name}. Built with Vite, Three.js and GSAP.` }),
    h('button', { class: 'qp-link', type: 'button', onclick: () => onPlay?.(), text: 'Prefer a game? Play the mission instead' }));
  const root = h('div', { id: 'qp', class: 'qp' }, h('a', { class: 'qp-skip', href: '#qp-main', text: 'Skip to content' }), canvas, head, main, foot);
  document.body.append(root);
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });

  // Fix ids used by aria-labelledby for headings that have none
  root.querySelectorAll('section[aria-labelledby]').forEach((sec) => {
    const hd = sec.querySelector('h2');
    if (hd) { hd.id = sec.getAttribute('aria-labelledby'); }
  });

  // 3D scene (if WebGL is missing the page still works, just without the background)
  let three = null;
  try {
    three = buildScene(canvas, { reduced, mobile });
  } catch (err) {
    console.warn('[quick] WebGL unavailable, showing the page without 3D', err);
    canvas.hidden = true;
  }

  // Scroll -> fractional stop index, from the real section positions
  const secEls = SECTIONS.map((s) => root.querySelector(`#${s.id}`));
  let centers = [];
  const measure = () => { centers = secEls.map((el) => el.getBoundingClientRect().top + window.scrollY + el.offsetHeight / 2); };
  const stopIndex = () => {
    const y = window.scrollY + window.innerHeight * 0.5;
    if (y <= centers[0]) return 0;
    for (let i = 0; i < centers.length - 1; i++) {
      if (y <= centers[i + 1]) return i + (y - centers[i]) / (centers[i + 1] - centers[i]);
    }
    return centers.length - 1;
  };
  measure();

  const mouse = { x: 0, y: 0 };
  const onMouse = (e) => { mouse.x = (e.clientX / window.innerWidth) * 2 - 1; mouse.y = (e.clientY / window.innerHeight) * 2 - 1; };
  window.addEventListener('pointermove', onMouse, { passive: true });

  const onResize = () => {
    measure();
    if (!three) return;
    const w = window.innerWidth;
    const h2 = window.innerHeight;
    three.renderer.setSize(w, h2, false);
    three.camera.aspect = w / h2;
    three.camera.updateProjectionMatrix();
    const m = w < 768;
    if (m !== mobile) { mobile = m; three.layout(m); }
  };
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(measure); // images/fonts can change the page height
  ro.observe(main);

  // Render loop
  let raf = 0;
  let last = performance.now();
  let t = 0;
  const camPos = new THREE.Vector3(0, 0, CAM_DIST);
  const look = new THREE.Vector3();
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (!three) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduced) t += dt;
    const f = stopIndex();
    const k = reduced ? 1 : 1 - Math.exp(-dt * 3);
    const tx = Math.sin(f * 1.3) * 1.5 + (reduced ? 0 : mouse.x * 0.9);
    const ty = Math.cos(f * 0.9) * 0.8 - (reduced ? 0 : mouse.y * 0.6);
    const tz = -f * SPACING + CAM_DIST;
    camPos.x += (tx - camPos.x) * k;
    camPos.y += (ty - camPos.y) * k;
    camPos.z += (tz - camPos.z) * k;
    three.camera.position.copy(camPos);
    look.set(camPos.x * 0.4, camPos.y * 0.4, camPos.z - 20);
    three.camera.lookAt(look);
    three.stops.forEach((s) => s.update(t));
    three.stars.rotation.z = t * 0.004;
    three.renderer.render(three.scene, three.camera);
  };
  raf = requestAnimationFrame(frame);

  // Reveal on scroll, active nav link, counters
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('is-in');
      io.unobserve(en.target);
    });
  }, { threshold: 0.12 });
  root.querySelectorAll('.qp-reveal').forEach((el, i) => {
    el.style.transitionDelay = reduced ? '0s' : `${(i % 4) * 0.07}s`;
    io.observe(el);
  });

  const navIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) navLinks.forEach((a) => a.classList.toggle('is-active', a.dataset.id === en.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  secEls.forEach((el) => navIO.observe(el));

  const counters = root.querySelectorAll('.qp-stat__v');
  const countIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      countIO.unobserve(en.target);
      if (reduced) return;
      const to = parseFloat(en.target.dataset.to);
      const dec = Number(en.target.dataset.dec);
      const o = { v: 0 };
      gsap.to(o, { v: to, duration: 1.4, ease: 'power2.out', onUpdate: () => { en.target.textContent = o.v.toFixed(dec); } });
    });
  }, { threshold: 0.6 });
  counters.forEach((c) => countIO.observe(c));

  // Hero intro
  if (!reduced) {
    gsap.from('.qp-hero__in > *:not(.qp-avatar)', { opacity: 0, y: 24, duration: 0.8, stagger: 0.12, ease: 'power3.out', delay: 0.1 });
  }

  // Gentle 3D tilt on mission cards (mouse only)
  const tiltOn = !reduced && window.matchMedia('(hover: hover)').matches;
  const tiltMove = (e) => {
    const card = e.target.closest?.('.qp-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 6}deg`);
    card.style.setProperty('--rx', `${-((e.clientY - r.top) / r.height - 0.5) * 6}deg`);
  };
  const tiltLeave = (e) => {
    const card = e.target.closest?.('.qp-card');
    if (card) { card.style.setProperty('--ry', '0deg'); card.style.setProperty('--rx', '0deg'); }
  };
  if (tiltOn) {
    main.addEventListener('pointermove', tiltMove);
    main.addEventListener('pointerout', tiltLeave);
  }

  let avatar = null;
  try { avatar = mountAvatar(root.querySelector('.qp-avatar'), { reduced, mobile }); } catch (err) { console.warn('[quick] avatar skipped', err); }

  initChat(); // A.R.I.A terminal (C key, header button, Ask my AI panel)
  document.title = `${profile.name} | Quick Portfolio`;
  window.scrollTo(0, 0);

  return function unmount() {
    destroyChat();
    avatar?.destroy();
    contactForm?.destroy();
    contactForm = null;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMouse);
    window.removeEventListener('resize', onResize);
    ro.disconnect(); io.disconnect(); navIO.disconnect(); countIO.disconnect();
    gsap.killTweensOf('.qp-hero__in > *:not(.qp-avatar)');
    if (three) {
      three.scene.traverse((o) => {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        mats.forEach((m) => { m.map?.dispose?.(); m.dispose(); });
      });
      three.glowTex.dispose();
      three.renderer.dispose();
    }
    root.remove();
    html.classList.remove('qp-mode');
  };
}
