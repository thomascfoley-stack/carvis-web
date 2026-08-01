"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

/**
 * JARVIS — neural-net particle cloud.
 *
 * The thing that makes it read as a *brain* is not the particles, it's the
 * connection lines drawn between nearby ones in a filled volume — and the
 * electrons that run along them while it thinks.
 *
 * Motion is deliberately restrained. An earlier version drove brightness
 * straight from per-frame FFT output, which changes at up to 60Hz: that is a
 * strobe, and a photosensitive-seizure risk. Every visual response now comes
 * from a heavily low-passed envelope, and prefers-reduced-motion is honoured.
 */
export default function Orb({
  state,
  getOutputAnalyser,
  getInputAnalyser,
}: {
  state: OrbState;
  getOutputAnalyser: () => AnalyserNode | null;
  getInputAnalyser?: () => AnalyserNode | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const outRef = useRef(getOutputAnalyser);
  const inRef = useRef(getInputAnalyser);

  stateRef.current = state;
  outRef.current = getOutputAnalyser;
  inRef.current = getInputAnalyser;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // No WebGL — the rest of the app still works.
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 1000);
    camera.position.z = 40;

    const N = 2200;
    const BASE_R = 26;

    const pos = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3);
    const phase = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      // sqrt keeps density even through the volume rather than clumping at
      // the centre — this is what gives it mass instead of a hollow look.
      const r = Math.pow(Math.random(), 0.5) * BASE_R * 0.8;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      phase[i] = Math.random() * 1000;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x6fd8ff,
      size: 0.42,
      transparent: true,
      opacity: 0.75,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    // Bounding spheres are computed once from an all-zero buffer, so anything
    // filled in later would be frustum-culled. These are always on screen.
    points.frustumCulled = false;
    scene.add(points);

    /* ------------------------- connection lines ------------------------ */

    const MAX_LINES = 9000;
    const linePos = new Float32Array(MAX_LINES * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
    lineGeo.setDrawRange(0, 0);

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x4ca8e8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    lines.frustumCulled = false;
    scene.add(lines);

    /* ---------------------------- electrons ---------------------------- */

    const MAX_ELECTRONS = 220;
    const ePos = new Float32Array(MAX_ELECTRONS * 3);
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
    eGeo.setDrawRange(0, 0);

    const eMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.9,
      transparent: true,
      opacity: 1,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const electrons = new THREE.Points(eGeo, eMat);
    electrons.frustumCulled = false;
    scene.add(electrons);

    type Electron = {
      sx: number; sy: number; sz: number;
      ex: number; ey: number; ez: number;
      t: number; speed: number;
    };
    const active: Electron[] = [];
    let connections: number[][] = [];

    /* ------------------------------ state ------------------------------ */

    let targetRadius = 28, curRadius = 28;
    let targetSpeed = 0.2, curSpeed = 0.2;
    let targetBright = 0.5, curBright = 0.5;
    let targetSize = 0.38, curSize = 0.38;
    let lineAmount = 0, targetLineAmount = 0;
    let eRate = 0, targetERate = 0;

    let spinX = 0, spinY = 0, spinZ = 0;
    let transitionEnergy = 0;
    let lastState: OrbState = "idle";
    let cloudZ = 0, cloudZVel = 0;

    const freq = new Uint8Array(64);
    const micFreq = new Uint8Array(64);

    // Smoothed envelopes. Raw per-frame FFT values change at up to 60Hz, and
    // driving brightness from them produces a strobe. Photosensitive-epilepsy
    // guidance is to stay under ~3 luminance changes per second, so these are
    // low-passed hard and every visual response is derived from them.
    let sBass = 0, sMid = 0;
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (!w || !h) return;
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let raf = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      const s = stateRef.current;

      // Connection count scales with density (N/R^3), so a tighter cloud webs
      // up dramatically. Thinking is the densest, and it shows.
      switch (s) {
        case "idle":
          targetRadius = 21; targetSpeed = 0.2; targetBright = 0.5; targetSize = 0.36;
          targetLineAmount = 0.55; targetERate = 0.002; break;
        case "listening":
          targetRadius = 18; targetSpeed = 0.24; targetBright = 0.68; targetSize = 0.42;
          targetLineAmount = 0.75; targetERate = 0.006; break;
        case "thinking":
          targetRadius = 14; targetSpeed = 0.34; targetBright = 0.75; targetSize = 0.32;
          targetLineAmount = 1.0; targetERate = 0.02; break;
        case "speaking":
          targetRadius = 16; targetSpeed = 0.22; targetBright = 0.78; targetSize = 0.44;
          targetLineAmount = 0.85; targetERate = 0.006; break;
      }

      curRadius += (targetRadius - curRadius) * 0.02;
      curSpeed += (targetSpeed - curSpeed) * 0.02;
      curBright += (targetBright - curBright) * 0.02;
      curSize += (targetSize - curSize) * 0.02;
      lineAmount += (targetLineAmount - lineAmount) * 0.02;
      eRate += (targetERate - eRate) * 0.02;

      // A state change gives the cloud a gentle tumble; it reads as the thing
      // reacting rather than a value being interpolated.
      if (s !== lastState) { transitionEnergy = 1; lastState = s; }
      transitionEnergy *= 0.992;
      if (transitionEnergy > 0.05 && !prefersReduced) {
        spinX += transitionEnergy * 0.004 * Math.sin(t * 1.7);
        spinY += transitionEnergy * 0.005;
        spinZ += transitionEnergy * 0.003 * Math.cos(t * 1.3);
      }
      spinY += prefersReduced ? 0 : 0.00035; // a slow drift, not a spin

      /* ------------------------------ audio ---------------------------- */

      let bass = 0, mid = 0;
      const out = outRef.current?.();
      if (out) {
        (out as any).getByteFrequencyData(freq);
        let b = 0, m = 0;
        for (let i = 0; i < 8; i++) b += freq[i];
        for (let i = 8; i < 24; i++) m += freq[i];
        bass = b / (8 * 255); mid = m / (16 * 255);
      }

      // Your voice drives it too, so the cloud is alive while you talk.
      const mic = inRef.current?.();
      if (mic) {
        (mic as any).getByteFrequencyData(micFreq);
        let b = 0, m = 0;
        for (let i = 0; i < 8; i++) b += micFreq[i];
        for (let i = 8; i < 24; i++) m += micFreq[i];
        bass = Math.max(bass, b / (8 * 255));
        mid = Math.max(mid, m / (16 * 255));
      }

      // ~0.5s time constant: responsive enough to feel connected to the
      // voice, far too slow to flicker.
      sBass += (bass - sBass) * 0.035;
      sMid += (mid - sMid) * 0.035;
      if (prefersReduced) { sBass *= 0.25; sMid *= 0.25; }
      bass = sBass;
      mid = sMid;

      let zTarget = Math.sin(t * 0.12) * 8;
      if (s === "thinking") zTarget = Math.sin(t * 0.14) * 9;
      else if (s === "speaking") zTarget = Math.sin(t * 0.1) * 5 - bass * 5;
      cloudZVel += (zTarget - cloudZ) * 0.008;
      cloudZVel *= 0.94;
      cloudZ += cloudZVel;

      points.rotation.set(spinX, spinY, spinZ);
      lines.rotation.set(spinX, spinY, spinZ);
      electrons.rotation.set(spinX, spinY, spinZ);
      points.position.z = lines.position.z = electrons.position.z = cloudZ;

      // Shallow modulation depth, with a floor: the cloud never blinks out.
      mat.opacity = Math.min(0.95, curBright + 0.18 + bass * 0.12);
      mat.size = curSize + mid * 0.12;
      // Thin additive lines need near-full alpha to register against black;
      // visual weight is controlled by density, not opacity.
      lineMat.opacity = Math.min(0.9, lineAmount * (1.1 + bass * 0.18));

      /* --------------------------- particles --------------------------- */

      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const a = attr.array as Float32Array;

      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const x = a[i3], y = a[i3 + 1], z = a[i3 + 2];
        const px = phase[i];

        vel[i3] += Math.sin(t * 0.05 + px) * 0.001 * curSpeed;
        vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * 0.001 * curSpeed;
        vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * 0.001 * curSpeed;
        vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * 0.0008 * curSpeed;
        vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * 0.0008 * curSpeed;
        vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * 0.0008 * curSpeed;

        const dist = Math.sqrt(x * x + y * y + z * z) || 0.01;
        const pull = Math.max(0, dist - curRadius) * 0.002 + 0.0003;
        vel[i3] -= (x / dist) * pull;
        vel[i3 + 1] -= (y / dist) * pull;
        vel[i3 + 2] -= (z / dist) * pull;

        if (bass > 0.05) {
          const k = bass * 0.009;
          vel[i3] += (x / dist) * k;
          vel[i3 + 1] += (y / dist) * k;
          vel[i3 + 2] += (z / dist) * k;
        }
        if (mid > 0.1) {
          const pulse = Math.sin(t * 2.2 + px) * mid * 0.006;
          vel[i3] += (x / dist) * pulse;
          vel[i3 + 1] += (y / dist) * pulse;
        }

        vel[i3] *= 0.992; vel[i3 + 1] *= 0.992; vel[i3 + 2] *= 0.992;
        a[i3] += vel[i3]; a[i3 + 1] += vel[i3 + 1]; a[i3 + 2] += vel[i3 + 2];
      }
      attr.needsUpdate = true;

      /* ----------------------------- lines ----------------------------- */

      if (lineAmount > 0.01) {
        const lAttrPos = lineGeo.getAttribute("position") as THREE.BufferAttribute;
        const la = lAttrPos.array as Float32Array;
        let count = 0;
        connections = [];

        const maxDist = 6.4 * (1 + bass * 0.5);
        const maxSq = maxDist * maxDist;
        // Sampling every Nth particle keeps this O(430^2) rather than
        // O(2200^2) — the visual difference is nil, the cost difference isn't.
        const step = Math.max(1, Math.floor(N / 430));

        for (let i = 0; i < N && count < MAX_LINES; i += step) {
          const i3 = i * 3;
          const x1 = a[i3], y1 = a[i3 + 1], z1 = a[i3 + 2];
          for (let j = i + step; j < N && count < MAX_LINES; j += step) {
            const j3 = j * 3;
            const dx = a[j3] - x1, dy = a[j3 + 1] - y1, dz = a[j3 + 2] - z1;
            if (dx * dx + dy * dy + dz * dz < maxSq) {
              const idx = count * 6;
              la[idx] = x1; la[idx + 1] = y1; la[idx + 2] = z1;
              la[idx + 3] = a[j3]; la[idx + 4] = a[j3 + 1]; la[idx + 5] = a[j3 + 2];
              if (connections.length < 400) {
                connections.push([x1, y1, z1, a[j3], a[j3 + 1], a[j3 + 2]]);
              }
              count++;
            }
          }
        }
        lAttrPos.needsUpdate = true;
        lineGeo.setDrawRange(0, count * 2);
      } else {
        lineGeo.setDrawRange(0, 0);
      }

      /* --------------------------- electrons --------------------------- */

      if (eRate > 0.0005 && connections.length && active.length < MAX_ELECTRONS) {
        if (Math.random() < eRate * (prefersReduced ? 0 : 6)) {
          const c = connections[Math.floor(Math.random() * connections.length)];
          active.push({
            sx: c[0], sy: c[1], sz: c[2],
            ex: c[3], ey: c[4], ez: c[5],
            t: 0, speed: 0.006 + Math.random() * 0.012,
          });
        }
      }

      let eCount = 0;
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        e.t += e.speed;
        if (e.t >= 1) { active.splice(i, 1); continue; }
        const k = eCount * 3;
        ePos[k] = e.sx + (e.ex - e.sx) * e.t;
        ePos[k + 1] = e.sy + (e.ey - e.sy) * e.t;
        ePos[k + 2] = e.sz + (e.ez - e.sz) * e.t;
        eCount++;
        if (eCount >= MAX_ELECTRONS) break;
      }
      (eGeo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      eGeo.setDrawRange(0, eCount);

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      geo.dispose(); mat.dispose();
      lineGeo.dispose(); lineMat.dispose();
      eGeo.dispose(); eMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="orb-canvas" aria-hidden="true" />;
}
