"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Edges, Float, Line } from "@react-three/drei";
import * as THREE from "three";
import { EDGES, LEAF_PATHS, LEVELS, ROOT, VAULT_PALETTE, type P3, type VaultState } from "./vaultLayout";

type Palette = (typeof VAULT_PALETTE)[VaultState];

const v = (p: P3): [number, number, number] => [p[0], p[1], p[2]];

function Pulses({ palette }: { palette: Palette }) {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const paths = useMemo(() => LEAF_PATHS.map((path) => path.map((p) => new THREE.Vector3(...p))), []);
  const segments = paths[0].length - 1;

  useFrame(({ clock }) => {
    const t0 = clock.getElapsedTime() * palette.speed;
    paths.forEach((path, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      const t = (t0 + i * 0.37) % 1;
      const s = t * segments;
      const seg = Math.min(segments - 1, Math.floor(s));
      mesh.position.lerpVectors(path[seg], path[seg + 1], s - seg);
      mesh.scale.setScalar(0.35 + 0.9 * Math.sin(Math.PI * t));
    });
  });

  return (
    <>
      {paths.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
        >
          <sphereGeometry args={[0.055, 12, 12]} />
          <meshBasicMaterial color={palette.pulse} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

function Vault({ palette }: { palette: Palette }) {
  const inner = useRef<THREE.Mesh>(null);
  const outer = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);

  useFrame(({ clock }, delta) => {
    if (inner.current) {
      inner.current.rotation.y += delta * 0.25;
      inner.current.rotation.x += delta * 0.08;
    }
    if (outer.current) outer.current.rotation.y -= delta * 0.12;
    if (core.current) {
      const beat = 1 + 0.08 * Math.sin(clock.getElapsedTime() * (1 + palette.speed * 6));
      core.current.scale.setScalar(beat);
    }
  });

  return (
    <group position={v(ROOT)}>
      <mesh ref={core}>
        <sphereGeometry args={[0.17, 24, 24]} />
        <meshBasicMaterial color={palette.root} toneMapped={false} />
      </mesh>
      <pointLight color={palette.root} intensity={4} distance={4} />
      <mesh ref={inner}>
        <icosahedronGeometry args={[0.6, 0]} />
        <meshStandardMaterial color={palette.edge} transparent opacity={0.08} flatShading depthWrite={false} />
        <Edges color={palette.edge} />
      </mesh>
      <mesh ref={outer}>
        <dodecahedronGeometry args={[0.85, 0]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        <Edges color={palette.edge} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

function Tree({ palette }: { palette: Palette }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (group.current) group.current.rotation.y = Math.sin(clock.getElapsedTime() * 0.22) * 0.38;
  });

  return (
    <group ref={group}>
      {EDGES.map(([a, b], i) => (
        <Line
          key={i}
          points={[v(a), v(b)]}
          color={palette.line}
          lineWidth={1.3}
          transparent
          opacity={0.9}
        />
      ))}
      {LEVELS.slice(1, -1).flatMap((level, d) =>
        level.map((p, i) => (
          <mesh key={`${d}-${i}`} position={v(p)}>
            <sphereGeometry args={[0.07, 16, 16]} />
            <meshStandardMaterial color="#1e2429" emissive={palette.node} emissiveIntensity={0.6} />
          </mesh>
        ))
      )}
      {LEVELS[0].map((p, i) => (
        <mesh key={`leaf-${i}`} position={v(p)} rotation={[0, 0, Math.PI / 4]}>
          <octahedronGeometry args={[0.1, 0]} />
          <meshStandardMaterial color={palette.pulse} emissive={palette.pulse} emissiveIntensity={0.5} flatShading />
        </mesh>
      ))}
      <Pulses palette={palette} />
      <Vault palette={palette} />
    </group>
  );
}

export default function MerkleVaultScene({
  state,
  active,
  onReady,
}: {
  state: VaultState;
  active: boolean;
  onReady?: () => void;
}) {
  const palette = VAULT_PALETTE[state];
  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.5]}
      camera={{ position: [0, -0.15, 5.4], fov: 42 }}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      onCreated={() => onReady?.()}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 4, 5]} intensity={0.6} />
      <Float speed={1.1} rotationIntensity={0.12} floatIntensity={0.35}>
        <Tree palette={palette} />
      </Float>
    </Canvas>
  );
}
