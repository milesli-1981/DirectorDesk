import { useEffect, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useDirectorStore } from "../state/directorStore";
import { MoveSegment, PathPoint, Vec2 } from "../domain/schema";
import { curveToggleEligible, pathChain } from "../engine/path";
import { hitEndpoint, hitObject, hitPath, hitPathPoint, pathPolyline } from "../engine/pick";
import { objectFacing, objectPosition } from "../engine/solver";
import { RadialRing } from "./RadialRing";

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const TARGET = new THREE.Vector3(0, 0, 0);
const BASE_DISTANCE = 26;

type DragState =
  | { kind: "object"; id: string; moved: boolean; origin: Vec2 }
  | { kind: "point"; segmentId: string; pointId: string }
  | { kind: "endpoint"; segmentId: string; which: "start" | "end" }
  | { kind: "new"; segmentId: string; origin: Vec2; current: Vec2 };

function groundPoint(event: ThreeEvent<PointerEvent>): Vec2 | null {
  if (event.ray) {
    const hit = new THREE.Vector3();
    if (event.ray.intersectPlane(GROUND_PLANE, hit)) return { x: hit.x, z: hit.z };
  }
  return { x: event.point.x, z: event.point.z };
}

function capturePointer(event: ThreeEvent<PointerEvent>) {
  const native = event.nativeEvent;
  const element = native.target as (Element & { setPointerCapture?: (id: number) => void }) | null;
  element?.setPointerCapture?.(native.pointerId);
}

/* ------------------------------------------------------------------ Actors */

function ActorView({ objectId }: { objectId: string }) {
  const object = useDirectorStore((s) => s.state.objects.find((o) => o.id === objectId));
  const isSelected = useDirectorStore((s) => s.selectedObj === objectId);
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const legLRef = useRef<THREE.Group>(null);
  const legRRef = useRef<THREE.Group>(null);
  const armLRef = useRef<THREE.Group>(null);
  const armRRef = useRef<THREE.Group>(null);
  const phaseRef = useRef(0);
  const facingRef = useRef(0);

  useFrame((_, delta) => {
    if (!object) return;
    const { state, currentTime } = useDirectorStore.getState();
    const position = objectPosition(state, objectId, currentTime);
    const previous = objectPosition(state, objectId, Math.max(0, currentTime - Math.max(delta, 0.001)));
    const dx = position.x - previous.x;
    const dz = position.z - previous.z;
    const distance = Math.hypot(dx, dz);
    const speed = distance / Math.max(delta, 0.001);

    if (groupRef.current) {
      groupRef.current.position.set(position.x, 0, position.z);
      const target =
        distance > 1e-4 ? Math.atan2(dx, dz) : objectFacing(state, objectId, currentTime);
      let diff = target - facingRef.current;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      facingRef.current += diff * Math.min(1, delta * 12);
      groupRef.current.rotation.y = facingRef.current;
    }

    // Body Motion 与整体位移分离：Cycle 由速度驱动，位置由 Motion Curve 驱动。
    phaseRef.current += delta * speed * 2.6;
    const intensity = Math.min(1, speed / 2.6);
    const swing = Math.sin(phaseRef.current) * intensity * 0.75;
    if (legLRef.current) legLRef.current.rotation.x = swing;
    if (legRRef.current) legRRef.current.rotation.x = -swing;
    if (armLRef.current) armLRef.current.rotation.x = -swing * 0.8;
    if (armRRef.current) armRRef.current.rotation.x = swing * 0.8;
    if (bodyRef.current) {
      bodyRef.current.position.y = Math.abs(Math.sin(phaseRef.current)) * 0.05 * intensity;
    }
  });

  if (!object) return null;
  const color = object.color;

  return (
    <group ref={groupRef}>
      {object.type === "actor" ? (
        <>
          <group ref={bodyRef}>
            <mesh position={[0, 1.12, 0]}>
              <capsuleGeometry args={[0.26, 0.6, 6, 14]} />
              <meshStandardMaterial color={color} roughness={0.5} metalness={0.05} />
            </mesh>
            <mesh position={[0, 1.68, 0]}>
              <sphereGeometry args={[0.2, 20, 14]} />
              <meshStandardMaterial color={color} roughness={0.45} />
            </mesh>
            <group ref={armLRef} position={[-0.32, 1.42, 0]}>
              <mesh position={[0, -0.28, 0]}>
                <boxGeometry args={[0.12, 0.58, 0.12]} />
                <meshStandardMaterial color={color} roughness={0.6} />
              </mesh>
            </group>
            <group ref={armRRef} position={[0.32, 1.42, 0]}>
              <mesh position={[0, -0.28, 0]}>
                <boxGeometry args={[0.12, 0.58, 0.12]} />
                <meshStandardMaterial color={color} roughness={0.6} />
              </mesh>
            </group>
          </group>
          <group ref={legLRef} position={[-0.14, 0.84, 0]}>
            <mesh position={[0, -0.42, 0]}>
              <boxGeometry args={[0.15, 0.84, 0.15]} />
              <meshStandardMaterial color="#2b3a4c" roughness={0.7} />
            </mesh>
          </group>
          <group ref={legRRef} position={[0.14, 0.84, 0]}>
            <mesh position={[0, -0.42, 0]}>
              <boxGeometry args={[0.15, 0.84, 0.15]} />
              <meshStandardMaterial color="#2b3a4c" roughness={0.7} />
            </mesh>
          </group>
        </>
      ) : (
        <mesh position={[0, 0.85, 0]}>
          <boxGeometry args={[0.9, 1.7, 0.9]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
      )}

      {isSelected ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.62, 0.78, 44]} />
          <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} transparent opacity={0.9} />
        </mesh>
      ) : null}

      <Html position={[0, 2.15, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[20, 0]}>
        <span className="obj-label" style={{ color: isSelected ? "#ffffff" : "#cdd8e2" }}>
          {objectId}
        </span>
      </Html>
    </group>
  );
}

function Actors() {
  const objects = useDirectorStore((s) => s.state.objects);
  return (
    <>
      {objects.map((object) => (
        <ActorView key={object.id} objectId={object.id} />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------- Paths */

function SegmentPaths() {
  const segments = useDirectorStore((s) => s.state.segments);
  const selectedObj = useDirectorStore((s) => s.selectedObj);

  return (
    <>
      {segments.map((segment) => {
        const points = pathPolyline(segment);
        if (points.length < 2) return null;
        const active = segment.object === selectedObj;
        return (
          <Line
            key={segment.id}
            points={points}
            color={active ? "#67a7ff" : "#35505f"}
            lineWidth={active ? 3 : 1.5}
          />
        );
      })}
    </>
  );
}

function EndpointMarker({ segment, which }: { segment: MoveSegment; which: "start" | "end" }) {
  const x = which === "start" ? segment.startX : segment.endX;
  const z = which === "start" ? segment.startZ : segment.endZ;
  const color = which === "start" ? "#67a7ff" : "#f0a35a";

  return (
    <group>
      <mesh position={[x, 0.26, z]}>
        <sphereGeometry args={[0.24, 20, 14]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </mesh>
      <Html position={[x, 0.78, z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
        <span className="node-label" style={{ color }}>
          {which === "start" ? "START" : "END"}
        </span>
      </Html>
    </group>
  );
}

function PointMarker({
  segment,
  point,
  index,
}: {
  segment: MoveSegment;
  point: PathPoint;
  index: number;
}) {
  const isSelected = useDirectorStore((s) => s.selectedPoint === point.id);
  const toggleCurve = useDirectorStore((s) => s.toggleCurve);
  const isArc = point.shape === "ARC";
  const chain = pathChain(segment);
  const previous = chain[index];
  const next = chain[index + 2];
  const eligible = curveToggleEligible(segment.points ?? [], index);

  return (
    <group>
      {isArc && previous && next ? (
        <>
          <Line
            points={[
              [previous.x, 0.07, previous.z],
              [point.x, 0.07, point.z],
            ]}
            color="#63d39b"
            dashed
            dashSize={0.4}
            gapSize={0.3}
            lineWidth={1}
          />
          <Line
            points={[
              [point.x, 0.07, point.z],
              [next.x, 0.07, next.z],
            ]}
            color="#63d39b"
            dashed
            dashSize={0.4}
            gapSize={0.3}
            lineWidth={1}
          />
        </>
      ) : null}

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[point.x, 0.09, point.z]}>
        {isArc ? <ringGeometry args={[0.2, 0.34, 28]} /> : <circleGeometry args={[0.24, 26]} />}
        <meshBasicMaterial
          color={isSelected ? "#ffffff" : "#55d88a"}
          side={THREE.DoubleSide}
        />
      </mesh>

      <Html position={[point.x, 0.42, point.z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
        <span className="node-label">{point.id}</span>
      </Html>

      {/* 不合法时不渲染按钮，而不是渲染成 disabled。 */}
      {isSelected && eligible ? (
        <Html
          position={[point.x, 0.6, point.z]}
          center
          style={{ pointerEvents: "auto" }}
          zIndexRange={[40, 0]}
        >
          <button
            type="button"
            className="curve-toggle"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => toggleCurve(segment.id, point.id)}
          >
            {isArc ? "━ LINE" : "⌒ CURVE"}
          </button>
        </Html>
      ) : null}
    </group>
  );
}

function PathHandles() {
  const segments = useDirectorStore((s) => s.state.segments);
  const selectedObj = useDirectorStore((s) => s.selectedObj);
  const visible = segments.filter((segment) => segment.object === selectedObj);

  return (
    <>
      {visible.map((segment) => (
        <group key={segment.id}>
          <EndpointMarker segment={segment} which="start" />
          <EndpointMarker segment={segment} which="end" />
          {segment.points.map((point, index) => (
            <PointMarker key={point.id} segment={segment} point={point} index={index} />
          ))}
        </group>
      ))}
    </>
  );
}

function FollowLinks() {
  const constraints = useDirectorStore((s) => s.state.constraints);
  const refs = useRef<Record<string, any>>({});

  useFrame(() => {
    const { state, currentTime } = useDirectorStore.getState();
    state.constraints.forEach((constraint) => {
      const line = refs.current[constraint.id];
      if (!line) return;
      const inside = currentTime >= constraint.timeStart && currentTime <= constraint.timeEnd;
      line.visible = inside;
      if (!inside) return;
      const a = objectPosition(state, constraint.subject, currentTime);
      const b = objectPosition(state, constraint.target, currentTime);
      line.geometry.setPositions([a.x, 0.1, a.z, b.x, 0.1, b.z]);
    });
  });

  return (
    <>
      {constraints.map((constraint) => (
        <Line
          key={constraint.id}
          ref={(instance) => {
            refs.current[constraint.id] = instance;
          }}
          points={[
            [0, 0.1, 0],
            [0, 0.1, 0],
          ]}
          color={constraint.type === "FOLLOW" ? "#63d39b" : "#f0a35a"}
          dashed
          dashSize={0.42}
          gapSize={0.3}
          lineWidth={2}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------ Interaction */

function Interaction() {
  const dragRef = useRef<DragState | null>(null);
  const [ghost, setGhost] = useState<Vec2 | null>(null);

  useEffect(() => {
    const finish = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      const store = useDirectorStore.getState();
      if (drag.kind === "object" && !drag.moved) {
        store.openRing(drag.id);
      } else if (drag.kind === "new") {
        const moved =
          Math.hypot(drag.current.x - drag.origin.x, drag.current.z - drag.origin.z) > 0.12;
        if (moved) store.addPathPoint(drag.segmentId, drag.current.x, drag.current.z);
      }
      setGhost(null);
    };
    window.addEventListener("pointerup", finish);
    return () => window.removeEventListener("pointerup", finish);
  }, []);

  const handleDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    const point = groundPoint(event);
    if (!point) return;

    const store = useDirectorStore.getState();
    if (store.radialObjectId) {
      store.closeRing();
      return;
    }

    const tolerance = 1 / store.zoom;

    const objectHit = hitObject(store.state, store.currentTime, point, 0.8 * tolerance);
    if (objectHit) {
      store.selectObject(objectHit.object.id);
      store.selectItem(null);
      store.selectPoint(null);
      dragRef.current = {
        kind: "object",
        id: objectHit.object.id,
        moved: false,
        origin: point,
      };
      capturePointer(event);
      return;
    }

    const pointHit = hitPathPoint(store.state, store.selectedObj, point, 0.45 * tolerance);
    if (pointHit) {
      store.selectItem(pointHit.segment.id);
      store.selectPoint(pointHit.point.id);
      dragRef.current = {
        kind: "point",
        segmentId: pointHit.segment.id,
        pointId: pointHit.point.id,
      };
      capturePointer(event);
      return;
    }

    const endpointHit = hitEndpoint(store.state, store.selectedObj, point, 0.45 * tolerance);
    if (endpointHit) {
      store.selectItem(endpointHit.segment.id);
      store.selectPoint(null);
      dragRef.current = {
        kind: "endpoint",
        segmentId: endpointHit.segment.id,
        which: endpointHit.which,
      };
      capturePointer(event);
      return;
    }

    const pathHit = hitPath(store.state, store.selectedObj, point, 0.6 * tolerance);
    if (pathHit) {
      dragRef.current = {
        kind: "new",
        segmentId: pathHit.segment.id,
        origin: { x: pathHit.x, z: pathHit.z },
        current: { x: pathHit.x, z: pathHit.z },
      };
      setGhost({ x: pathHit.x, z: pathHit.z });
      capturePointer(event);
    }
  };

  const handleMove = (event: ThreeEvent<PointerEvent>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = groundPoint(event);
    if (!point) return;
    const store = useDirectorStore.getState();

    if (drag.kind === "object") {
      if (Math.hypot(point.x - drag.origin.x, point.z - drag.origin.z) > 0.15) drag.moved = true;
      store.moveObject(drag.id, point.x, point.z);
    } else if (drag.kind === "point") {
      store.movePathPoint(drag.segmentId, drag.pointId, point.x, point.z);
    } else if (drag.kind === "endpoint") {
      store.moveEndpoint(drag.segmentId, drag.which, point.x, point.z);
    } else {
      drag.current = point;
      setGhost(point);
    }
  };

  return (
    <>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
      >
        <planeGeometry args={[140, 140]} />
        <meshStandardMaterial color="#101725" roughness={0.95} />
      </mesh>
      <gridHelper args={[40, 40, "#2f3d57", "#182132"]} position={[0, 0.01, 0]} />

      {ghost ? (
        <group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ghost.x, 0.08, ghost.z]}>
            <ringGeometry args={[0.3, 0.44, 32]} />
            <meshBasicMaterial color="#55d88a" side={THREE.DoubleSide} />
          </mesh>
          <Html
            position={[ghost.x, 0.5, ghost.z]}
            center
            style={{ pointerEvents: "none" }}
            zIndexRange={[35, 0]}
          >
            <span className="node-label ghost-label">NEW POINT</span>
          </Html>
        </group>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- Camera rig */

function CameraZoom() {
  const zoom = useDirectorStore((s) => s.zoom);
  const setZoom = useDirectorStore((s) => s.setZoom);
  const { camera } = useThree();
  const applied = useRef(zoom);

  useEffect(() => {
    const direction = camera.position.clone().sub(TARGET);
    if (direction.lengthSq() < 1e-6) direction.set(0, 20.5, 16);
    direction.setLength(BASE_DISTANCE / zoom);
    camera.position.copy(TARGET).add(direction);
    camera.lookAt(TARGET);
    applied.current = zoom;
  }, [camera, zoom]);

  useFrame(() => {
    const distance = camera.position.distanceTo(TARGET);
    const next = Math.min(2, Math.max(0.5, Math.round((BASE_DISTANCE / Math.max(distance, 0.001)) * 10) / 10));
    if (Math.abs(next - applied.current) > 0.001) {
      applied.current = next;
      setZoom(next);
    }
  });

  return null;
}

/* ----------------------------------------------------------- Radial layer */

function RingAnchor({ objectId }: { objectId: string }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const { state, currentTime } = useDirectorStore.getState();
    const position = objectPosition(state, objectId, currentTime);
    groupRef.current?.position.set(position.x, 0, position.z);
  });

  return (
    <group ref={groupRef}>
      <Html center style={{ pointerEvents: "auto" }} zIndexRange={[90, 0]}>
        <RadialRing objectId={objectId} />
      </Html>
    </group>
  );
}

function RadialLayer() {
  const radialObjectId = useDirectorStore((s) => s.radialObjectId);
  if (!radialObjectId) return null;
  return <RingAnchor objectId={radialObjectId} />;
}

/* ------------------------------------------------------------- World view */

function WorldScene() {
  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 20.5, 16]} fov={40} near={0.1} far={400} />
      <CameraZoom />
      <ambientLight intensity={0.8} />
      <directionalLight position={[14, 24, 10]} intensity={1.1} />
      <Interaction />
      <SegmentPaths />
      <PathHandles />
      <FollowLinks />
      <Actors />
      <RadialLayer />
      <OrbitControls makeDefault target={[0, 0, 0]} enablePan={false} enableDamping={false} />
    </>
  );
}

export function WorldView() {
  const zoom = useDirectorStore((s) => s.zoom);
  const setZoom = useDirectorStore((s) => s.setZoom);
  const selectedObj = useDirectorStore((s) => s.selectedObj);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);

  return (
    <main>
      <div className="viewbar">
        <div>
          <b>DIRECTOR VIEW</b>
          <small id="mode">{selectedPoint ? "PATH EDIT" : "SELECT"}</small>
          <small>{selectedObj}</small>
        </div>
        <div className="zoomctl">
          <button type="button" id="zout" title="Zoom out" onClick={() => setZoom(zoom - 0.1)}>
            −
          </button>
          <button type="button" id="zr" title="Reset to 100%" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" id="zin" title="Zoom in" onClick={() => setZoom(zoom + 0.1)}>
            +
          </button>
        </div>
      </div>
      <div className="canvasWrap">
        <Canvas dpr={[1, 2]} gl={{ antialias: true }}>
          <color attach="background" args={["#0a1016"]} />
          <WorldScene />
        </Canvas>
      </div>
    </main>
  );
}
