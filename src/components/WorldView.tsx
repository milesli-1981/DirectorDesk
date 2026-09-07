import { useEffect, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useDirectorStore } from "../state/directorStore";
import { HandoffMode, MoveSegment, PathPoint, Vec2 } from "../domain/schema";
import { curveToggleEligible, pathChain } from "../engine/path";
import {
  hitCameraRay,
  hitEndpoint,
  hitObjectRay,
  hitPath,
  hitPathPoint,
  pathPolyline,
} from "../engine/pick";
import { objectFacing, objectPosition } from "../engine/solver";
import {
  activeCameraMove,
  computeFrame,
  lensFovDeg,
  sampleCameraPath,
  solveCamera,
} from "../engine/cameraSolver";
import { blockingAssets, setRects } from "../engine/occlusion";
import { segmentRoutePoints } from "../engine/path";
import { aspectValue, FRAMING_LABELS, MOTION_LABELS, SIDE_LABELS, VIEW_LABELS } from "../domain/schema";
import { RadialRing } from "./RadialRing";

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const TARGET = new THREE.Vector3(0, 0, 0);
const BASE_DISTANCE = 26;
const DIRECTOR_FOV = 40;
/** 径向意图环暂未匹配到合适的操作，暂时关闭（置 true 即可恢复点击对象弹出）。 */
const RING_ENABLED = false;

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
  const isSelected = useDirectorStore(
    (s) => s.selectedKind === "object" && s.selectedId === objectId,
  );
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const phaseRef = useRef(0);
  const facingRef = useRef(0);

  useFrame((_, delta) => {
    if (!object) return;
    const { state, currentTime } = useDirectorStore.getState();

    // 静态环境资产：固定在摆放位置与朝向上，无运动。
    if (object.role === "set") {
      if (groupRef.current) {
        groupRef.current.position.set(object.x, 0, object.z);
        groupRef.current.rotation.y = (object.rotation * Math.PI) / 180;
      }
      return;
    }

    // 可运动资产：位置由 segment 求解，朝向跟随速度方向。
    const position = objectPosition(state, objectId, currentTime);
    const previous = objectPosition(
      state,
      objectId,
      Math.max(0, currentTime - Math.max(delta, 0.001)),
    );
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
    if (bodyRef.current) {
      bodyRef.current.position.y = Math.abs(Math.sin(phaseRef.current)) * 0.05 * intensity;
    }
  });

  if (!object) return null;
  const color = object.color;
  const { w, d, h } = object.footprint;
  const ringR = Math.max(w, d) * 0.7 + 0.16;

  return (
    <group ref={groupRef}>
      <group ref={bodyRef}>
        {object.category === "human" ? (
          <HumanoidFigure w={w} d={d} h={h} color={color} />
        ) : (
          <mesh position={[0, h / 2, 0]}>
            <boxGeometry args={[w, h, d]} />
            <meshStandardMaterial
              color={color}
              roughness={0.7}
              metalness={0.05}
              transparent={object.role === "set"}
              opacity={object.role === "set" ? 0.82 : 1}
            />
          </mesh>
        )}
      </group>

      {showHelpers ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <planeGeometry args={[w, d]} />
          <meshBasicMaterial
            color={isSelected ? "#ffffff" : object.role === "set" ? "#f0a35a" : "#55d88a"}
            wireframe
            transparent
            opacity={0.5}
          />
        </mesh>
      ) : null}

      {isSelected && showHelpers ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[ringR - 0.16, ringR, 44]} />
          <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} transparent opacity={0.9} />
        </mesh>
      ) : null}

      {showHelpers ? (
        <Html
          position={[0, h + 0.4, 0]}
          center
          style={{ pointerEvents: "none" }}
          zIndexRange={[20, 0]}
        >
          <span className="obj-label" style={{ color: isSelected ? "#ffffff" : "#cdd8e2" }}>
            {objectId}
          </span>
        </Html>
      ) : null}

      {object.locked && showHelpers ? (
        <Html
          position={[0, h + 0.95, 0]}
          center
          style={{ pointerEvents: "none" }}
          zIndexRange={[20, 0]}
        >
          <span className="lock-badge">LOCKED</span>
        </Html>
      ) : null}
    </group>
  );
}

/**
 * 人形体块：human 类资产用「头 + 躯干 + 双臂 + 双腿」的组合体表示，
 * 与建筑 / 家具等纯方盒资产在视觉上区分开。尺寸全部由 footprint 推导。
 */
function HumanoidFigure({
  w,
  d,
  h,
  color,
}: {
  w: number;
  d: number;
  h: number;
  color: string;
}) {
  const legH = h * 0.44;
  const torsoH = h * 0.34;
  const headR = h * 0.096;
  const legW = w * 0.3;
  const legD = d * 0.3;
  const legX = w * 0.22;
  const torsoW = w * 0.85;
  const torsoD = d * 0.5;
  const armW = w * 0.16;
  const armD = d * 0.16;
  const armH = torsoH * 0.9;
  const armX = torsoW / 2 + armW / 2;

  return (
    <group>
      <mesh position={[-legX, legH / 2, 0]}>
        <boxGeometry args={[legW, legH, legD]} />
        <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[legX, legH / 2, 0]}>
        <boxGeometry args={[legW, legH, legD]} />
        <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[0, legH + torsoH / 2, 0]}>
        <boxGeometry args={[torsoW, torsoH, torsoD]} />
        <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[-armX, legH + torsoH * 0.55, 0]}>
        <boxGeometry args={[armW, armH, armD]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
      </mesh>
      <mesh position={[armX, legH + torsoH * 0.55, 0]}>
        <boxGeometry args={[armW, armH, armD]} />
        <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
      </mesh>
      <mesh position={[0, legH + torsoH + headR, 0]}>
        <sphereGeometry args={[headR, 18, 14]} />
        <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} />
      </mesh>
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
  const selectedObjectId = useDirectorStore((s) =>
    s.selectedKind === "object" ? s.selectedId : null,
  );
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  const state = useDirectorStore((s) => s.state);

  if (!showHelpers) return null;

  return (
    <>
      {segments.map((segment) => {
        const active = segment.object === selectedObjectId;
        // 停留腿（stub 拖回起点）：退化为零长度，用 HOLD 环表示，不画线（文档 §7.2）。
        const degenerate =
          (segment.points ?? []).length === 0 &&
          Math.hypot(segment.endX - segment.startX, segment.endZ - segment.startZ) < 0.05;
        if (degenerate) {
          const x = segment.startX;
          const z = segment.startZ;
          return (
            <group key={segment.id}>
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.06, z]}>
                <ringGeometry args={[0.32, 0.5, 32]} />
                <meshBasicMaterial color={active ? "#67a7ff" : "#35505f"} side={THREE.DoubleSide} />
              </mesh>
              <Html
                position={[x, 0.72, z]}
                center
                style={{ pointerEvents: "none" }}
                zIndexRange={[25, 0]}
              >
                <span className="node-label" style={{ color: active ? "#67a7ff" : "#35505f" }}>
                  HOLD
                </span>
              </Html>
            </group>
          );
        }
        const points = pathPolyline(segment);
        if (points.length < 2) return null;
        // 障碍感知「导航层」：环境（set 资产）如何重塑该 segment 的行动路线（橙色虚线）。
        // 与运动求解共用 segmentRoutePoints，因此这条线就是 agent 真正走的路线。
        const rects = setRects(state);
        const route = segmentRoutePoints(segment, rects);
        const routePoints = route.map((p) => [p.x, 0.13, p.z] as [number, number, number]);
        return (
          <group key={segment.id}>
            <Line points={points} color={active ? "#67a7ff" : "#35505f"} lineWidth={active ? 3 : 1.5} />
            {rects.length > 0 ? (
              <Line points={routePoints} color="#f0a35a" dashed dashSize={0.35} gapSize={0.25} lineWidth={1.5} />
            ) : null}
          </group>
        );
      })}
    </>
  );
}

function OcclusionHighlights() {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  if (!activeCameraId || !showHelpers) return null;
  const camera = state.cameras.find((c) => c.id === activeCameraId);
  if (!camera) return null;
  const resolved = solveCamera(state, activeCameraId, currentTime);
  if (!resolved) return null;
  const targetId = resolved.move?.targetId ?? camera.targetId;
  if (!targetId) return null;
  const tgt = objectPosition(state, targetId, currentTime);
  const camPos = { x: resolved.position[0], z: resolved.position[2] };
  const targetPos = { x: tgt.x, z: tgt.z };
  const blockers = blockingAssets(state, camPos, targetPos);
  const occluded = blockers.length > 0;
  const sightColor = occluded ? "#ff5a6a" : "#5fd0c0";
  return (
    <>
      {/* 相机 → 目标 视线：被挡变红，通畅为淡青 */}
      <Line
        points={[
          [resolved.position[0], resolved.position[1], resolved.position[2]],
          [resolved.target[0], resolved.target[1], resolved.target[2]],
        ]}
        color={sightColor}
        lineWidth={2}
        dashed={occluded}
        dashSize={0.4}
        gapSize={0.25}
      />
      {blockers.map((b) => (
        <group key={`occ_${b.id}`} position={[b.x, 0, b.z]}>
          <mesh position={[0, b.footprint.h / 2, 0]}>
            <boxGeometry args={[b.footprint.w, b.footprint.h, b.footprint.d]} />
            <meshBasicMaterial color="#ff5a6a" wireframe />
          </mesh>
          <Html position={[0, b.footprint.h + 0.4, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[30, 0]}>
            <span className="node-label" style={{ color: "#ff7b91" }}>BLOCKED</span>
          </Html>
        </group>
      ))}
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
  const deletePoint = useDirectorStore((s) => s.deletePoint);
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
        <meshBasicMaterial color={isSelected ? "#ffffff" : "#55d88a"} side={THREE.DoubleSide} />
      </mesh>

      <Html position={[point.x, 0.42, point.z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
        <span className="node-label">{point.id}</span>
      </Html>

      {/* 选中中间点时给出操作入口：删除始终可用；ARC/LINE 切换在不合法时不渲染（而非 disabled）。 */}
      {isSelected ? (
        <Html
          position={[point.x, 0.6, point.z]}
          center
          style={{ pointerEvents: "auto" }}
          zIndexRange={[40, 0]}
        >
          <div className="point-tools">
            <button
              type="button"
              className="point-delete"
              title="Delete this path point"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => deletePoint(segment.id, point.id)}
            >
              ✕ DEL
            </button>
            {eligible ? (
              <button
                type="button"
                className="curve-toggle"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => toggleCurve(segment.id, point.id)}
              >
                {isArc ? "━ LINE" : "⌒ CURVE"}
              </button>
            ) : null}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

function PathHandles() {
  const segments = useDirectorStore((s) => s.state.segments);
  const selectedObjectId = useDirectorStore((s) =>
    s.selectedKind === "object" ? s.selectedId : null,
  );
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");

  if (!showHelpers || !selectedObjectId) return null;
  const visible = segments.filter((segment) => segment.object === selectedObjectId);

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

function HandoffMarkers() {
  const handoffs = useDirectorStore((s) => s.state.handoffs);
  const segments = useDirectorStore((s) => s.state.segments);
  const setHandoffMode = useDirectorStore((s) => s.setHandoffMode);
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  if (!showHelpers) return null;
  return (
    <>
      {handoffs.map((handoff) => {
        const prev = segments.find((segment) => segment.id === handoff.prevSeg);
        if (!prev) return null;
        const x = prev.endX;
        const z = prev.endZ;
        const color =
          handoff.mode === "cut" ? "#ff7b91" : handoff.mode === "smooth" ? "#67a7ff" : "#f0a35a";
        const glyph = handoff.mode === "cut" ? "✕" : handoff.mode === "smooth" ? "◉" : "■";
        return (
          <Html
            key={handoff.id}
            position={[x, 1.05, z]}
            center
            style={{ pointerEvents: "auto" }}
            zIndexRange={[45, 0]}
          >
            <button
              type="button"
              className="handoff-badge"
              title={`Handoff: ${handoff.mode} — click to cycle stop/smooth/cut`}
              style={{ borderColor: color, color }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                const order: HandoffMode[] = ["stop", "smooth", "cut"];
                const nextMode = order[(order.indexOf(handoff.mode) + 1) % order.length];
                setHandoffMode(handoff.id, nextMode);
              }}
            >
              {glyph}
            </button>
          </Html>
        );
      })}
    </>
  );
}

function FollowLinks() {
  const constraints = useDirectorStore((s) => s.state.constraints);
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  const refs = useRef<Record<string, any>>({});

  useFrame(() => {
    if (!showHelpers) return;
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

  if (!showHelpers) return null;

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

/* ----------------------------------------------------------------- Cameras */

/**
 * 视锥：从相机本体出发，按 Lens 的垂直 FOV 与画幅比生成金字塔。
 *
 * 注意朝向约定：Object3D.lookAt() 对普通对象（非 Camera / Light）把本地
 * **+Z** 指向目标，而 THREE.Camera 是 **-Z** 指向目标。相机代理是普通
 * <group>，所以这里视锥沿 +Z 展开。
 */
function CameraFrustum({ cameraId }: { cameraId: string }) {
  const cameras = useDirectorStore((s) => s.state.cameras);
  const aspectRatio = useDirectorStore((s) => s.state.aspectRatio);
  const camera = cameras.find((item) => item.id === cameraId);
  if (!camera) return null;

  const distance = 4.5;
  const halfHeight = Math.tan((lensFovDeg(camera.lensMm) * Math.PI) / 360) * distance;
  const halfWidth = halfHeight * aspectValue(aspectRatio);

  const origin: [number, number, number] = [0, 0, 0];
  const topLeft: [number, number, number] = [-halfWidth, halfHeight, distance];
  const topRight: [number, number, number] = [halfWidth, halfHeight, distance];
  const bottomRight: [number, number, number] = [halfWidth, -halfHeight, distance];
  const bottomLeft: [number, number, number] = [-halfWidth, -halfHeight, distance];

  return (
    <Line
      segments
      points={[
        origin,
        topLeft,
        origin,
        topRight,
        origin,
        bottomRight,
        origin,
        bottomLeft,
        topLeft,
        topRight,
        topRight,
        bottomRight,
        bottomRight,
        bottomLeft,
        bottomLeft,
        topLeft,
      ]}
      color={camera.color}
      lineWidth={1.2}
      transparent
      opacity={0.7}
    />
  );
}

function DroneRig({
  color,
  selected,
  active,
  onSelect,
}: {
  color: string;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const rotors: Array<[number, number, number]> = [
    [0.34, 0.12, 0.34],
    [0.34, 0.12, -0.34],
    [-0.34, 0.12, 0.34],
    [-0.34, 0.12, -0.34],
  ];
  return (
    <group>
      <mesh
        onPointerDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <boxGeometry args={[0.3, 0.16, 0.3]} />
        <meshStandardMaterial
          color={selected ? "#ffffff" : color}
          emissive={color}
          emissiveIntensity={active ? 0.35 : 0.12}
        />
      </mesh>
      {rotors.map((pos, index) => (
        <group key={index} position={pos}>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.02, 0.02, 0.5, 8]} />
            <meshStandardMaterial color="#3a4654" />
          </mesh>
          <mesh position={[0, 0.08, 0]}>
            <cylinderGeometry args={[0.13, 0.13, 0.04, 12]} />
            <meshStandardMaterial color="#cfd8e3" />
          </mesh>
        </group>
      ))}
      {/* 飞行高度指示环 */}
      <mesh position={[0, -0.35, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.46, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} />
      </mesh>
    </group>
  );
}

function CameraProxy({ cameraId }: { cameraId: string }) {
  const camera = useDirectorStore((s) => s.state.cameras.find((c) => c.id === cameraId));
  const isSelected = useDirectorStore(
    (s) => s.selectedKind === "camera" && s.selectedId === cameraId,
  );
  const isActive = useDirectorStore((s) => s.activeCameraId === cameraId);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const { state, currentTime } = useDirectorStore.getState();
    const resolved = solveCamera(state, cameraId, currentTime);
    if (!resolved || !groupRef.current) return;
    groupRef.current.position.set(
      resolved.position[0],
      resolved.position[1],
      resolved.position[2],
    );
    groupRef.current.lookAt(resolved.target[0], resolved.target[1], resolved.target[2]);
  });

  if (!camera) return null;

  return (
    <group ref={groupRef}>
      {camera.kind === "drone" ? (
        <DroneRig
          color={camera.color}
          selected={isSelected}
          active={isActive}
          onSelect={() => selectCamera(cameraId)}
        />
      ) : (
        <>
          <mesh
            onPointerDown={(event) => {
              event.stopPropagation();
              selectCamera(cameraId);
            }}
          >
            <boxGeometry args={[0.55, 0.38, 0.72]} />
            <meshStandardMaterial
              color={isSelected ? "#ffffff" : camera.color}
              emissive={camera.color}
              emissiveIntensity={isActive ? 0.35 : 0.12}
            />
          </mesh>
          {/* 镜头朝向本地 +Z（普通对象的 lookAt 约定） */}
          <mesh position={[0, 0, 0.52]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.17, 0.21, 0.34, 16]} />
            <meshStandardMaterial color="#1b2531" roughness={0.4} metalness={0.4} />
          </mesh>
        </>
      )}
      <CameraFrustum cameraId={cameraId} />
      <Html position={[0, 0.62, 0]} center style={{ pointerEvents: "none" }} zIndexRange={[22, 0]}>
        <span className="obj-label" style={{ color: camera.color }}>
          {camera.name}
          {isActive ? " ●" : ""}
        </span>
      </Html>
    </group>
  );
}

function CameraProxies() {
  const cameras = useDirectorStore((s) => s.state.cameras);
  const viewMode = useDirectorStore((s) => s.viewMode);

  // 相机视图＝透过当前机位看画面。任何机位代理都不该入画——
  // 既包括当前机位自身，也包括其它相机（对这台相机来说它们不可见）。
  if (viewMode === "camera") return null;

  return (
    <>
      {cameras.map((camera) => (
        <CameraProxy key={camera.id} cameraId={camera.id} />
      ))}
    </>
  );
}

function CameraPaths() {
  const state = useDirectorStore((s) => s.state);
  const viewMode = useDirectorStore((s) => s.viewMode);

  if (viewMode === "camera") return null;

  return (
    <>
      {state.cameras.map((camera) => {
        const points = sampleCameraPath(state, camera.id, 0.3);
        if (points.length < 2) return null;
        return (
          <Line
            key={`path_${camera.id}`}
            points={points}
            color={camera.color}
            lineWidth={1.2}
            dashed
            dashSize={0.35}
            gapSize={0.28}
            transparent
            opacity={0.55}
          />
        );
      })}
    </>
  );
}

/** 相机视图：把渲染相机驱动到导演相机的解算结果上。 */
function CameraRig() {
  const { camera, size } = useThree();

  useFrame(() => {
    const { state, currentTime, viewMode, activeCameraId } = useDirectorStore.getState();
    const perspective = camera as THREE.PerspectiveCamera;
    if (typeof perspective.fov !== "number") return;

    if (viewMode !== "camera" || !activeCameraId) {
      if (Math.abs(perspective.fov - DIRECTOR_FOV) > 0.01) {
        perspective.fov = DIRECTOR_FOV;
        perspective.aspect = size.width / size.height;
        perspective.updateProjectionMatrix();
      }
      return;
    }

    const resolved = solveCamera(state, activeCameraId, currentTime);
    if (!resolved) return;

    camera.position.set(resolved.position[0], resolved.position[1], resolved.position[2]);
    camera.lookAt(resolved.target[0], resolved.target[1], resolved.target[2]);

    const frame = computeFrame(aspectValue(state.aspectRatio), size.width, size.height);
    if (frame.height <= 0 || frame.width <= 0) return;
    const ratio = size.height / frame.height;
    const fov =
      (2 * Math.atan(Math.tan((resolved.fovDeg * Math.PI) / 360) * ratio) * 180) / Math.PI;

    if (
      Math.abs(perspective.fov - fov) > 0.01 ||
      perspective.aspect !== size.width / size.height
    ) {
      perspective.fov = fov;
      perspective.aspect = size.width / size.height;
      perspective.updateProjectionMatrix();
    }
  });

  return null;
}

/* ------------------------------------------------------------ Interaction */

function Interaction() {
  const dragRef = useRef<DragState | null>(null);
  const [ghost, setGhost] = useState<Vec2 | null>(null);
  const controls = useThree((state) => state.controls) as { enabled: boolean } | null;

  // 拖拽对象 / 路径点时临时接管 OrbitControls，避免编辑路径同时把视角转走。
  const beginDrag = (drag: DragState) => {
    dragRef.current = drag;
    useDirectorStore.getState().setDragging(true);
    if (controls) controls.enabled = false;
  };

  const endDrag = () => {
    const store = useDirectorStore.getState();
    if (!dragRef.current) return;
    dragRef.current = null;
    store.setDragging(false);
    if (controls) controls.enabled = store.viewMode === "director" && !store.viewLocked;
  };

  useEffect(() => {
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const store = useDirectorStore.getState();
      if (drag.kind === "object" && !drag.moved) {
        if (RING_ENABLED) store.openRing(drag.id);
      } else if (drag.kind === "new") {
        const moved =
          Math.hypot(drag.current.x - drag.origin.x, drag.current.z - drag.origin.z) > 0.12;
        if (moved) store.addPathPoint(drag.segmentId, drag.current.x, drag.current.z);
      }
      endDrag();
      setGhost(null);
    };
    window.addEventListener("pointerup", finish);
    return () => window.removeEventListener("pointerup", finish);
  });

  const handleDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    const point = groundPoint(event);
    if (!point) return;

    const store = useDirectorStore.getState();
    if (store.viewMode !== "director") return;
    if (store.radialObjectId) {
      store.closeRing();
      return;
    }

    const tolerance = 1 / store.zoom;
    const selectedObjectId = store.selectedKind === "object" ? store.selectedId : null;

    const cameraHit = hitCameraRay(store.state, store.currentTime, event.ray, 0.9 * tolerance);
    const objectHit = hitObjectRay(store.state, store.currentTime, event.ray, 0.7 * tolerance);

    if (cameraHit && (!objectHit || cameraHit.distance <= objectHit.distance)) {
      store.selectCamera(cameraHit.camera.id);
      return;
    }

    // 选中对象的路径点 / 端点优先于「抓取资产」：set 资产（建筑等）的抓取范围
    // 按 footprint 外扩，可能盖住落在其中的路径点，否则这些点会点不到。
    if (selectedObjectId) {
      const pointHit = hitPathPoint(store.state, selectedObjectId, point, 0.45 * tolerance);
      if (pointHit) {
        store.selectItem(pointHit.segment.id);
        store.selectPoint(pointHit.point.id);
        beginDrag({
          kind: "point",
          segmentId: pointHit.segment.id,
          pointId: pointHit.point.id,
        });
        capturePointer(event);
        return;
      }

      const endpointHit = hitEndpoint(store.state, selectedObjectId, point, 0.45 * tolerance);
      if (endpointHit) {
        store.selectItem(endpointHit.segment.id);
        store.selectPoint(null);
        beginDrag({
          kind: "endpoint",
          segmentId: endpointHit.segment.id,
          which: endpointHit.which,
        });
        capturePointer(event);
        return;
      }
    }

    if (objectHit) {
      store.selectObject(objectHit.object.id);
      // 锁定对象：可点选（便于解锁），但不接管拖拽、也不挡相机轨道。
      if (objectHit.object.locked) return;
      store.selectItem(null);
      store.selectPoint(null);
      beginDrag({
        kind: "object",
        id: objectHit.object.id,
        moved: false,
        origin: point,
      });
      capturePointer(event);
      return;
    }

    if (!selectedObjectId) return;

    const pathHit = hitPath(store.state, selectedObjectId, point, 0.6 * tolerance);
    if (pathHit) {
      beginDrag({
        kind: "new",
        segmentId: pathHit.segment.id,
        origin: { x: pathHit.x, z: pathHit.z },
        current: { x: pathHit.x, z: pathHit.z },
      });
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
      // 锁定对象即使在拖拽中也绝不移动位置。
      const obj = store.state.objects.find((o) => o.id === drag.id);
      if (obj?.locked) return;
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
      <mesh rotation={[-Math.PI / 2, 0, 0]} onPointerDown={handleDown} onPointerMove={handleMove}>
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
  const viewMode = useDirectorStore((s) => s.viewMode);
  const { camera } = useThree();
  const applied = useRef(zoom);

  useEffect(() => {
    if (viewMode !== "director") return;
    const direction = camera.position.clone().sub(TARGET);
    if (direction.lengthSq() < 1e-6) direction.set(0, 20.5, 16);
    direction.setLength(BASE_DISTANCE / zoom);
    camera.position.copy(TARGET).add(direction);
    camera.lookAt(TARGET);
    applied.current = zoom;
  }, [camera, zoom, viewMode]);

  useFrame(() => {
    if (viewMode !== "director") return;
    const distance = camera.position.distanceTo(TARGET);
    const next = Math.min(
      2,
      Math.max(0.5, Math.round((BASE_DISTANCE / Math.max(distance, 0.001)) * 10) / 10),
    );
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
  const viewMode = useDirectorStore((s) => s.viewMode);
  if (!radialObjectId || viewMode !== "director") return null;
  return <RingAnchor objectId={radialObjectId} />;
}

/* ------------------------------------------------------------- World view */

function WorldScene() {
  const viewMode = useDirectorStore((s) => s.viewMode);
  const viewLocked = useDirectorStore((s) => s.viewLocked);
  const dragging = useDirectorStore((s) => s.dragging);

  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[0, 20.5, 16]}
        fov={DIRECTOR_FOV}
        near={0.1}
        far={400}
      />
      <CameraZoom />
      <CameraRig />
      <ambientLight intensity={0.8} />
      <directionalLight position={[14, 24, 10]} intensity={1.1} />
      <Interaction />
      <SegmentPaths />
      <PathHandles />
      <HandoffMarkers />
      <FollowLinks />
      <Actors />
      <OcclusionHighlights />
      <CameraPaths />
      <CameraProxies />
      <RadialLayer />
      <OrbitControls
        makeDefault
        target={[0, 0, 0]}
        enablePan={false}
        enableDamping={false}
        enabled={viewMode === "director" && !viewLocked && !dragging}
      />
    </>
  );
}

function CameraHud() {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const camera = state.cameras.find((item) => item.id === activeCameraId);
  if (!camera) return null;

  const move = activeCameraMove(state, camera.id, currentTime);
  const moveCount = state.cameraMoves.filter((item) => item.camera === camera.id).length;
  const resolved = solveCamera(state, camera.id, currentTime);
  const blockers =
    resolved && (resolved.move?.targetId ?? camera.targetId)
      ? blockingAssets(
          state,
          { x: resolved.position[0], z: resolved.position[2] },
          (() => {
            const tid = resolved.move?.targetId ?? camera.targetId!;
            const p = objectPosition(state, tid, currentTime);
            return { x: p.x, z: p.z };
          })(),
        )
      : [];

  return (
    <div className="cam-hud">
      <strong>{camera.name}</strong>
      <span>
        {FRAMING_LABELS[camera.framing]} · {SIDE_LABELS[camera.side]} · {VIEW_LABELS[camera.view]} ·{" "}
        {camera.lensMm}mm
      </span>
      <span>TARGET {move?.targetId ?? camera.targetId}</span>
      <span>
        {MOTION_LABELS[move?.type ?? camera.motion]}
        {move ? " · move" : " · default"} · {moveCount} move{moveCount === 1 ? "" : "s"}
      </span>
      {blockers.length > 0 ? (
        <span className="occ-warn">⚠ OCCLUDED · {blockers.map((b) => b.id).join(", ")}</span>
      ) : null}
      <span>{state.aspectRatio}</span>
    </div>
  );
}

function FramingOverlay() {
  const state = useDirectorStore((s) => s.state);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const update = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const frame = computeFrame(aspectValue(state.aspectRatio), size.width, size.height);

  return (
    <div className="framing-overlay" ref={wrapRef}>
      <div className="mask-bar mask-top" style={{ height: frame.top }} />
      <div className="mask-bar mask-bottom" style={{ height: frame.top }} />
      <div className="mask-bar mask-left" style={{ width: frame.left }} />
      <div className="mask-bar mask-right" style={{ width: frame.left }} />
      <div
        className="frame-box"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <div className="ot-line ot-v-1" />
        <div className="ot-line ot-v-2" />
        <div className="ot-line ot-h-1" />
        <div className="ot-line ot-h-2" />
        <div className="center-cross v" />
        <div className="center-cross h" />
        <div className="safe-box action" />
        <div className="safe-box title" />
      </div>
      <CameraHud />
    </div>
  );
}

export function WorldView() {
  const zoom = useDirectorStore((s) => s.zoom);
  const setZoom = useDirectorStore((s) => s.setZoom);
  const viewMode = useDirectorStore((s) => s.viewMode);
  const setViewMode = useDirectorStore((s) => s.setViewMode);
  const cameras = useDirectorStore((s) => s.state.cameras);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const setActiveCamera = useDirectorStore((s) => s.setActiveCamera);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const viewLocked = useDirectorStore((s) => s.viewLocked);
  const toggleViewLocked = useDirectorStore((s) => s.toggleViewLocked);

  return (
    <main>
      <div className="viewbar">
        <div>
          <b>{viewMode === "director" ? "DIRECTOR VIEW" : "CAMERA VIEW"}</b>
          <small id="mode">{selectedPoint ? "PATH EDIT" : "SELECT"}</small>
          <small>{selectedId}</small>
          {viewLocked ? <small className="lock-flag">VIEW LOCKED</small> : null}
        </div>
        <div className="view-tools">
          <button
            type="button"
            className={`lock-btn ${viewLocked ? "active" : ""}`}
            title="Lock View (L)：锁定后拖拽不再改变视角，方便编辑路径"
            onClick={toggleViewLocked}
          >
            {viewLocked ? "🔒 Locked" : "🔓 Lock View"}
          </button>
          <div className="view-mode-toggle" role="tablist" aria-label="View Mode">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "director"}
              className={`view-tab ${viewMode === "director" ? "active" : ""}`}
              onClick={() => setViewMode("director")}
            >
              Director
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "camera"}
              className={`view-tab ${viewMode === "camera" ? "active" : ""}`}
              onClick={() => setViewMode("camera")}
              disabled={cameras.length === 0}
            >
              Camera
            </button>
          </div>
          <select
            className="camera-select"
            value={activeCameraId ?? ""}
            onChange={(event) => setActiveCamera(event.target.value)}
            disabled={cameras.length === 0}
          >
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </select>
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
      </div>
      <div className="canvasWrap">
        <Canvas dpr={[1, 2]} gl={{ antialias: true }}>
          <color attach="background" args={["#0a1016"]} />
          <WorldScene />
        </Canvas>
        {viewMode === "camera" ? <FramingOverlay /> : null}
      </div>
    </main>
  );
}
