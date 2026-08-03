"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Where the focused branch sits on screen, reported every frame so the HTML
 * result card can ride the projection. Text stays in the DOM — crisp at any
 * zoom, selectable, visible to screen readers — while the glowing socket it
 * appears to sit on lives in the scene.
 */
export type BranchAnchor = { x: number; y: number; scale: number; visible: boolean };

/**
 * CARVIS — neural-net particle cloud.
 *
 * Faithful to the original macOS build, because the thing that makes it read
 * as a *brain* is not the particles, it's the connection lines drawn between
 * nearby ones — and the electrons that run along them while it thinks. A
 * hollow shell of points looks like a planet; a filled volume with edges looks
 * like a mind.
 *
 * Reacts to both voices: the assistant's output and, when granted, your
 * microphone — so it's alive while you speak, not only while it answers.
 */
export default function Orb({
  state,
  getOutputAnalyser,
  getInputAnalyser,
  focusId = null,
  onAnchor,
}: {
  state: OrbState;
  getOutputAnalyser: () => AnalyserNode | null;
  getInputAnalyser?: () => AnalyserNode | null;
  /**
   * Non-null while a task's result should live on a branch: the camera
   * dollies toward a branch chosen from this id, and onAnchor reports where
   * it lands on screen. Null flies home. A new id picks a new branch.
   */
  focusId?: number | null;
  onAnchor?: (a: BranchAnchor) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const outRef = useRef(getOutputAnalyser);
  const inRef = useRef(getInputAnalyser);
  const focusRef = useRef(focusId);
  const anchorCbRef = useRef(onAnchor);

  stateRef.current = state;
  outRef.current = getOutputAnalyser;
  inRef.current = getInputAnalyser;
  focusRef.current = focusId;
  anchorCbRef.current = onAnchor;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      // No MSAA: additive round points and hairlines gain nothing from it,
      // and it is the single biggest fill-rate cost on mobile GPUs.
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    } catch {
      return; // No WebGL — the rest of the app still works.
    }

    /**
     * Phones get a lighter cloud. Half the particles and a sparser line pass
     * read identically at 6" while cutting the per-frame CPU work ~4x — the
     * difference between a warm pocket and a dead battery on mid-tier Android.
     */
    const small =
      Math.min(window.screen.width, window.screen.height) < 768 ||
      (navigator.hardwareConcurrency ?? 8) <= 4;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 1000);
    // Closer than the original's 80: the cloud should dominate the screen.
    camera.position.z = 40;

    const N = small ? 1200 : 2200;
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
    points.frustumCulled = false;
    scene.add(points);

    /* ------------------------- connection lines ------------------------ */

    const MAX_LINES = small ? 4500 : 9000;
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

    type Electron = { sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; t: number; speed: number };
    const active: Electron[] = [];
    let connections: number[][] = [];

    /* ------------------------- branch focus ----------------------------- */

    // The socket the result card appears to sit on: a faint additive quad,
    // parented to the cloud so it tumbles and drifts with everything else.
    const socketGeo = new THREE.PlaneGeometry(2.2, 2.2);
    const socketMat = new THREE.MeshBasicMaterial({
      color: 0x5fc6ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.visible = false;
    points.add(socket);

    let lastFocus: number | null = null;
    let socketOpacity = 0;
    const camHome = new THREE.Vector3(0, 0, 40);
    const camGoal = new THREE.Vector3(0, 0, 40);
    const lookCur = new THREE.Vector3(0, 0, 0);
    const lookGoal = new THREE.Vector3(0, 0, 0);
    const worldAnchor = new THREE.Vector3();
    const projected = new THREE.Vector3();

    /**
     * A branch per task, spread by the golden angle so consecutive tasks land
     * on visibly different parts of the cortex. Deterministic from the id: a
     * re-render never teleports the card.
     */
    const pickBranch = (id: number) => {
      const theta = id * 2.399963;
      const phi = Math.acos(1 - 2 * ((id * 0.6180339) % 1)) * 0.8 + 0.35;
      const r = BASE_R * 0.52;
      socket.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    };

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
    let frameNo = 0;

    // A hidden tab burns battery for nobody. Browsers throttle rAF when
    // hidden, but suspending outright is free and certain.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        clock.getDelta(); // swallow the gap so physics doesn't leap
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      // Normalise physics to a 60Hz step: a 120Hz ProMotion iPhone was
      // integrating twice as fast, doubling every speed we tuned.
      const dtF = Math.min(clock.getDelta() * 60, 3);
      frameNo++;
      const t = clock.getElapsedTime();
      const s = stateRef.current;

      switch (s) {
        case "idle":
          targetRadius = 21; targetSpeed = 0.1; targetBright = 0.5; targetSize = 0.36;
          targetLineAmount = 0.55; targetERate = 0.002; break;
        case "listening":
          targetRadius = 18; targetSpeed = 0.12; targetBright = 0.68; targetSize = 0.42;
          targetLineAmount = 0.75; targetERate = 0.006; break;
        case "thinking":
          targetRadius = 14; targetSpeed = 0.17; targetBright = 0.75; targetSize = 0.32;
          targetLineAmount = 1.0; targetERate = 0.02; break;
        case "speaking":
          targetRadius = 16; targetSpeed = 0.11; targetBright = 0.78; targetSize = 0.44;
          targetLineAmount = 0.85; targetERate = 0.006; break;
      }

      const ease = 1 - Math.pow(0.98, dtF);
      curRadius += (targetRadius - curRadius) * ease;
      curSpeed += (targetSpeed - curSpeed) * ease;
      curBright += (targetBright - curBright) * ease;
      curSize += (targetSize - curSize) * ease;
      lineAmount += (targetLineAmount - lineAmount) * ease;
      eRate += (targetERate - eRate) * ease;

      // A state change throws the whole cloud into a slow tumble; it reads as
      // the thing physically reacting rather than a value being interpolated.
      if (s !== lastState) { transitionEnergy = 1; lastState = s; }
      transitionEnergy *= Math.pow(0.992, dtF);
      if (transitionEnergy > 0.05 && !prefersReduced) {
        spinX += transitionEnergy * 0.002 * Math.sin(t * 1.7) * dtF;
        spinY += transitionEnergy * 0.0025 * dtF;
        spinZ += transitionEnergy * 0.0015 * Math.cos(t * 1.3) * dtF;
      }
      spinY += prefersReduced ? 0 : 0.000175 * dtF; // a slow drift, not a spin

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
      const audioEase = 1 - Math.pow(0.965, dtF);
      sBass += (bass - sBass) * audioEase;
      sMid += (mid - sMid) * audioEase;
      if (prefersReduced) { sBass *= 0.25; sMid *= 0.25; }
      bass = sBass;
      mid = sMid;

      let zTarget = Math.sin(t * 0.06) * 4;
      if (s === "thinking") zTarget = Math.sin(t * 0.07) * 4.5;
      else if (s === "speaking") zTarget = Math.sin(t * 0.05) * 2.5 - bass * 2.5;
      cloudZVel += (zTarget - cloudZ) * 0.004 * dtF;
      cloudZVel *= Math.pow(0.94, dtF);
      cloudZ += cloudZVel * dtF;

      points.rotation.set(spinX, spinY, spinZ);
      lines.rotation.set(spinX, spinY, spinZ);
      electrons.rotation.set(spinX, spinY, spinZ);
      points.position.z = lines.position.z = electrons.position.z = cloudZ;

      // Additive blending saturates into a white blob once the camera is
      // inside the cloud — dim with proximity so a zoomed branch stays a
      // structure instead of a floodlight. Squared for the lines: the dense
      // centre's line stack is where the burn-out actually comes from.
      const proximity = Math.max(0.45, Math.min(1, camera.position.length() / 40));
      mat.opacity = Math.min(0.95, curBright + 0.18 + bass * 0.12) * proximity;
      mat.size = curSize + mid * 0.12;
      lineMat.opacity = Math.min(0.9, lineAmount * (1.1 + bass * 0.18)) * proximity * proximity;

      /* --------------------------- particles --------------------------- */

      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const a = attr.array as Float32Array;

      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const x = a[i3], y = a[i3 + 1], z = a[i3 + 2];
        const px = phase[i];

        const drive = curSpeed * dtF;
        vel[i3] += Math.sin(t * 0.05 + px) * 0.001 * drive;
        vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * 0.001 * drive;
        vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * 0.001 * drive;
        vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * 0.0008 * drive;
        vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * 0.0008 * drive;
        vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * 0.0008 * drive;

        const dist = Math.sqrt(x * x + y * y + z * z) || 0.01;
        const pull = (Math.max(0, dist - curRadius) * 0.002 + 0.0003) * dtF;
        vel[i3] -= (x / dist) * pull;
        vel[i3 + 1] -= (y / dist) * pull;
        vel[i3 + 2] -= (z / dist) * pull;

        if (bass > 0.05) {
          const k = bass * 0.0045 * dtF;
          vel[i3] += (x / dist) * k;
          vel[i3 + 1] += (y / dist) * k;
          vel[i3 + 2] += (z / dist) * k;
        }
        if (mid > 0.1) {
          const pulse = Math.sin(t * 1.4 + px) * mid * 0.003 * dtF;
          vel[i3] += (x / dist) * pulse;
          vel[i3 + 1] += (y / dist) * pulse;
        }

        const damp = Math.pow(0.992, dtF);
        vel[i3] *= damp; vel[i3 + 1] *= damp; vel[i3 + 2] *= damp;
        a[i3] += vel[i3] * dtF; a[i3 + 1] += vel[i3 + 1] * dtF; a[i3 + 2] += vel[i3 + 2] * dtF;
      }
      attr.needsUpdate = true;

      /* ----------------------------- lines ----------------------------- */

      // The web is rebuilt every other frame on phones — lines persist
      // between rebuilds, so nothing visibly changes except the CPU bill.
      if (lineAmount > 0.01 && (!small || frameNo % 2 === 0)) {
        const lAttrPos = lineGeo.getAttribute("position") as THREE.BufferAttribute;
        const la = lAttrPos.array as Float32Array;
        let count = 0;
        connections = [];

        const maxDist = 6.4 * (1 + bass * 0.5);
        const maxSq = maxDist * maxDist;
        // Sampling every Nth particle keeps this O(600^2) rather than
        // O(2200^2) — the visual difference is nil, the cost difference isn't.
        const step = Math.max(1, Math.floor(N / (small ? 300 : 430)));

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
      } else if (lineAmount <= 0.01) {
        lineGeo.setDrawRange(0, 0);
      }

      /* --------------------------- electrons --------------------------- */

      if (eRate > 0.0005 && connections.length && active.length < MAX_ELECTRONS) {
        if (Math.random() < eRate * (prefersReduced ? 0 : 3)) {
          const c = connections[Math.floor(Math.random() * connections.length)];
          active.push({
            sx: c[0], sy: c[1], sz: c[2],
            ex: c[3], ey: c[4], ez: c[5],
            t: 0, speed: 0.003 + Math.random() * 0.006,
          });
        }
      }

      let eCount = 0;
      for (let i = active.length - 1; i >= 0; i--) {
        const e = active[i];
        e.t += e.speed * dtF;
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

      /* --------------------------- branch focus ------------------------- */

      const focus = focusRef.current;
      if (focus !== lastFocus) {
        if (focus != null) {
          pickBranch(focus);
          socket.visible = true;
        }
        lastFocus = focus;
      }

      const focusing = focus != null;
      if (focusing) {
        socket.getWorldPosition(worldAnchor);
        // Dolly along the ray from the core through the branch, so the branch
        // fills the view with the rest of the mind still alive behind it.
        // Reduced motion keeps the camera home; the card simply fades in.
        if (!prefersReduced) {
          camGoal.copy(worldAnchor).multiplyScalar(1 + 13 / Math.max(worldAnchor.length(), 4));
          lookGoal.copy(worldAnchor);
        }
      } else {
        camGoal.copy(camHome);
        lookGoal.set(0, 0, 0);
      }
      // ~1.5s glide — deliberate, seizure-safe, and slow enough to read as
      // attention shifting rather than a cut.
      const camEase = 1 - Math.pow(0.975, dtF);
      camera.position.lerp(camGoal, camEase);
      lookCur.lerp(lookGoal, camEase);
      camera.lookAt(lookCur);
      socket.lookAt(camera.position);

      socketOpacity += ((focusing ? 0.55 : 0) - socketOpacity) * camEase;
      socketMat.opacity = socketOpacity * (0.8 + Math.sin(t * 1.1) * 0.08);
      if (!focusing && socketOpacity < 0.01) socket.visible = false;

      const cb = anchorCbRef.current;
      if (cb) {
        socket.getWorldPosition(worldAnchor);
        projected.copy(worldAnchor).project(camera);
        const dist = camera.position.distanceTo(worldAnchor);
        cb({
          x: (projected.x * 0.5 + 0.5) * mount.clientWidth,
          y: (-projected.y * 0.5 + 0.5) * mount.clientHeight,
          scale: Math.max(0.55, Math.min(1.25, 30 / Math.max(dist, 1))),
          visible: focusing && projected.z < 1 && socketOpacity > 0.05,
        });
      }

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      geo.dispose(); mat.dispose();
      lineGeo.dispose(); lineMat.dispose();
      eGeo.dispose(); eMat.dispose();
      socketGeo.dispose(); socketMat.dispose();
      renderer.dispose();
      // dispose() alone keeps the GL context alive until GC; phones have a
      // hard context limit and Safari kills the oldest without asking.
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className="orb-canvas" aria-hidden="true" />;
}
