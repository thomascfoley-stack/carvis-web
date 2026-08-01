"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const STATE_INDEX: Record<OrbState, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
};

/* Ashima's simplex noise — the standard compact GLSL implementation. */
const NOISE_GLSL = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

const VERTEX = `
uniform float uTime;
uniform float uAudio;
uniform float uState;
uniform float uPixelRatio;

varying float vGlow;
varying float vRadius;

${NOISE_GLSL}

void main() {
  vec3 dir = normalize(position);

  // Two octaves of noise: a slow swell plus a finer shimmer.
  float slow = snoise(dir * 1.1 + vec3(0.0, 0.0, uTime * 0.16));
  float fine = snoise(dir * 3.4 - vec3(uTime * 0.28, 0.0, 0.0));

  // Idle breathes gently; speaking is driven hard by the audio envelope.
  float calm = 0.045 + 0.02 * sin(uTime * 0.9);
  float drive = mix(calm, 0.10 + uAudio * 0.42, step(2.5, uState));

  // Listening pulls the shell inward and tightens it — visibly "attentive".
  float listening = step(0.5, uState) * (1.0 - step(1.5, uState));
  float thinking  = step(1.5, uState) * (1.0 - step(2.5, uState));

  float displacement = slow * drive + fine * drive * 0.45;
  displacement -= listening * 0.06;
  displacement += thinking * 0.05 * sin(uTime * 3.0 + dir.y * 6.0);

  float radius = 1.0 + displacement;
  vec3 displaced = dir * radius;

  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mv;

  vRadius = displacement;
  // Rim brightening: points facing away from the camera glow more.
  vGlow = pow(1.0 - abs(normalize(mv.xyz).z), 2.0);

  // Keep sprites genuinely small. Additive blending accumulates, so oversized
  // points stack into a solid white disc instead of reading as a particle field.
  float size = 1.0 + uAudio * 0.9 + thinking * 0.3;
  gl_PointSize = clamp(size * uPixelRatio * (7.0 / -mv.z), 1.0, 5.0);
}
`;

const FRAGMENT = `
uniform vec3 uColorCore;
uniform vec3 uColorEdge;
uniform float uAudio;

varying float vGlow;
varying float vRadius;

void main() {
  // Procedural round sprite — avoids shipping a texture.
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  float alpha = smoothstep(0.5, 0.1, d);
  vec3 color = mix(uColorCore, uColorEdge, clamp(vGlow + vRadius * 2.2, 0.0, 1.0));
  color += uAudio * 0.18;

  // Low per-particle alpha is what lets 20k additive sprites read as a shell
  // with depth rather than a blown-out highlight.
  gl_FragColor = vec4(color, alpha * (0.085 + vGlow * 0.26 + uAudio * 0.08));
}
`;

export default function Orb({
  state,
  level,
}: {
  state: OrbState;
  /** Called each frame; returns current audio level 0..1. */
  level: () => number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);

  stateRef.current = state;
  levelRef.current = level;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 3.4;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // No WebGL — the rest of the app still works.
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    // Fibonacci sphere gives a far more even distribution than random points.
    const COUNT = 26000;
    const positions = new Float32Array(COUNT * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < COUNT; i++) {
      const y = 1 - (i / (COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(theta) * r;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const uniforms = {
      uTime: { value: 0 },
      uAudio: { value: 0 },
      uState: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uColorCore: { value: new THREE.Color("#7ff0ff") },
      uColorEdge: { value: new THREE.Color("#1b6cff") },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const PALETTE: Record<OrbState, [string, string]> = {
      idle: ["#6fe8ff", "#1149c8"],
      listening: ["#8affd6", "#0f9d76"],
      thinking: ["#c9a6ff", "#5b21b6"],
      speaking: ["#bff4ff", "#1b8cff"],
    };

    const coreTarget = new THREE.Color(PALETTE.idle[0]);
    const edgeTarget = new THREE.Color(PALETTE.idle[1]);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (!w || !h) return;
      // updateStyle must stay on: without it the canvas keeps its raw buffer
      // dimensions (2x at devicePixelRatio 2) and overflows the container.
      renderer.setSize(w, h, true);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    // Subtle parallax so the orb feels like an object in space.
    let pointerX = 0;
    let pointerY = 0;
    const onPointer = (e: PointerEvent) => {
      pointerX = (e.clientX / window.innerWidth - 0.5) * 2;
      pointerY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onPointer);

    const clock = new THREE.Clock();
    let raf = 0;
    let smoothed = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const t = clock.getElapsedTime();
      const raw = levelRef.current?.() ?? 0;
      smoothed += (raw - smoothed) * 0.25;

      uniforms.uTime.value = t;
      uniforms.uAudio.value = smoothed;
      uniforms.uState.value = STATE_INDEX[stateRef.current] ?? 0;

      const [core, edge] = PALETTE[stateRef.current] ?? PALETTE.idle;
      coreTarget.set(core);
      edgeTarget.set(edge);
      uniforms.uColorCore.value.lerp(coreTarget, 0.06);
      uniforms.uColorEdge.value.lerp(edgeTarget, 0.06);

      points.rotation.y = t * 0.05;
      points.rotation.x = Math.sin(t * 0.12) * 0.12;

      camera.position.x += (pointerX * 0.28 - camera.position.x) * 0.04;
      camera.position.y += (-pointerY * 0.22 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointer);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={mountRef} className="orb-canvas" aria-hidden="true" />;
}
