import { Suspense, useEffect, useMemo, MutableRefObject, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { setCaptureCanvas } from "../engine/videoExport";
import { Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { useDirectorStore } from "../state/directorStore";
import { AssetCategory, HandoffMode, JointName, MoveSegment, PathPoint, Pose, Vec2 } from "../domain/schema";
import { curveToggleEligible, pathChain } from "../engine/path";
import {
  hitCameraRay,
  hitEndpoint,
  hitObjectRay,
  hitPath,
  hitPathPoint,
  pathPolyline,
} from "../engine/pick";
import { baseHeading, formationForwardShift, formationSlotOf, objectFacing, objectPosition, routeObstacles } from "../engine/solver";
import { actionPoseAt, staticPoseWeight } from "../engine/actionPose";
import { MODEL_CONFIG } from "../engine/modelConfig";
import { HumanoidGLB, ModelBoundary } from "./HumanoidModel";
import {
  activeCameraMove,
  computeFrame,
  lensFovDeg,
  sampleCameraPath,
  solveCamera,
} from "../engine/cameraSolver";
import { cameraAxis } from "../engine/axis";
import { EffectComposer, DepthOfField } from "@react-three/postprocessing";
import type { DepthOfFieldEffect } from "postprocessing";
import { bokehScaleForLens, focusRangeForLens, liveShot } from "../engine/shotFocus";
import { blockingAssets } from "../engine/occlusion";
import { segmentRoutePoints } from "../engine/path";
import { screenToGround, viewRef } from "../engine/viewBridge";
import { ASSET_ORDER, ASSET_PRESETS } from "../engine/assetPresets";
import { groupTemplatesByCategory } from "../domain/templates";
import {
  aspectValue,
  FORMATION_LABELS,
  FormationKind,
  FORMATION_MORPH_SECONDS,
  FRAMING_LABELS,
  MOTION_LABELS,
  objectDisplayName,
  SIDE_LABELS,
  VIEW_LABELS,
} from "../domain/schema";
import { RadialRing } from "./RadialRing";
import { LockBadge } from "./LockBadge";

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
  | { kind: "new"; segmentId: string; origin: Vec2; current: Vec2 }
  | { kind: "draw"; objectId: string };

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

/**
 * 头顶名牌：把名字**画进 WebGL 场景**（sprite + CanvasTexture），而不是 DOM 覆盖层。
 * 视频导出用的是 canvas.captureStream，只会录到画布内容、DOM 覆盖层录不进去，
 * 所以只有渲染进场景的名牌才会出现在导出的成片里。
 */
/** 圆角矩形路径（兼容不支持 ctx.roundRect 的环境）。 */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 头顶名牌：把名字**画进 WebGL 场景**（sprite + CanvasTexture），而不是 DOM 覆盖层。
 * 视频导出用的是 canvas.captureStream，只会录到画布内容、DOM 覆盖层录不进去，
 * 所以只有渲染进场景的名牌才会出现在导出的成片里。
 *
 * 「绝对清晰」要点：① 贴图分辨率拉到 512×128，远高于显示尺寸，避免放大发虚；
 * ② 关 mipmap + Linear 过滤，近处保持锐利；③ anisotropy 让斜看也不糊；
 * ④ 半透明深色圆角背板 + 黑描边白字，亮 / 杂背景上都读得清。
 */
function NameTag({ text, height }: { text: string; height: number }) {
  const texture = useMemo(() => {
    const w = 512;
    const h = 128;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, w, h);
      ctx.font = "bold 72px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // 背板：按文字宽度自适应，留出边距，深底保证对比度。
      const tw = ctx.measureText(text).width;
      const padX = 30;
      const padY = 20;
      const bw = Math.min(w - 8, tw + padX * 2);
      const bh = h - padY * 2;
      const bx = (w - bw) / 2;
      const by = padY;
      ctx.fillStyle = "rgba(8, 12, 18, 0.62)";
      roundRectPath(ctx, bx, by, bw, bh, 20);
      ctx.fill();
      // 黑描边白字：任何背景都看得清。
      ctx.lineJoin = "round";
      ctx.lineWidth = 10;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
      ctx.strokeText(text, w / 2, h / 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, w / 2, h / 2);
    }
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    // 关掉 mipmap：名牌在画面里通常很小，mipmap 会让文字发虚。
    map.generateMipmaps = false;
    map.minFilter = THREE.LinearFilter;
    map.magFilter = THREE.LinearFilter;
    // 各向异性过滤：相机斜看名牌时也不糊。
    map.anisotropy = 8;
    return map;
  }, [text]);

  // 文字变化会重建贴图，旧贴图需要手动释放，避免显存泄漏。
  useEffect(() => () => texture.dispose(), [texture]);

  // sprite 天然朝向相机（billboard），从任何机位看都是正的。
  return (
    <sprite position={[0, height + 0.35, 0]} scale={[1.3, 0.325, 1]}>
      {/*
        depthWrite 必须打开：景深（DOF）按深度缓冲算模糊量，若名牌不写深度，
        它会取身后背景的深度，导致人物明明在对焦上、文字却依旧被糊掉。
        alphaTest 让全透明像素被丢弃，避免整块 sprite 矩形写出深度挡住后面的物体。
        toneMapped=false 保证白字不被色调映射压灰。
      */}
      <spriteMaterial
        map={texture}
        transparent
        alphaTest={0.1}
        depthWrite
        toneMapped={false}
      />
    </sprite>
  );
}

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
  // 把当前速度共享给骨骼组件，由其按速度摆腿摆臂（Body Motion 与位移分离）。
  const speedRef = useRef(0);

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
    speedRef.current = speed;

    if (groupRef.current) {
      groupRef.current.position.set(position.x, 0, position.z);
      const target =
        distance > 1e-4 ? Math.atan2(dx, dz) : objectFacing(state, objectId, currentTime);
      let diff = target - facingRef.current;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      facingRef.current += diff * Math.min(1, delta * 12);
      groupRef.current.rotation.y = facingRef.current;
    }

    // Body Motion 与整体位移分离：方块简模自己做起伏；
    // GLB 骨骼动画自带起伏，不再叠加，避免双重弹跳。
    phaseRef.current += delta * speed * 2.6;
    const intensity = Math.min(1, speed / 2.6);
    const useGlb = object.category === "human" && !!MODEL_CONFIG.human;
    if (bodyRef.current) {
      bodyRef.current.position.y = useGlb
        ? 0
        : Math.abs(Math.sin(phaseRef.current)) * 0.05 * intensity;
    }
  });

  if (!object) return null;
  const color = object.color;
  const { w, d, h } = object.footprint;
  const ringR = Math.max(w, d) * 0.7 + 0.16;

  // 方块简模（human 用 HumanoidRig，其它类别用体块）。
  const blockBody =
    object.category === "human" ? (
      <HumanoidRig w={w} d={d} h={h} color={color} speedRef={speedRef} pose={object.pose} objectId={objectId} />
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
    );

  // human 且配置了模型 → GLB 骨骼动画；加载中 / 失败都回退到方块简模。
  const modelConfig = MODEL_CONFIG.human;
  const body =
    object.category === "human" && modelConfig ? (
      <ModelBoundary fallback={blockBody}>
        <Suspense fallback={blockBody}>
          <HumanoidGLB
            objectId={objectId}
            height={h}
            speedRef={speedRef}
            config={modelConfig}
            color={color}
          />
        </Suspense>
      </ModelBoundary>
    ) : (
      blockBody
    );

  return (
    <group ref={groupRef}>
      <group ref={bodyRef}>{body}</group>

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

      {/* 人物：名牌画进场景，导演视图与成片里都可见；其它资产沿用 DOM 标签（仅导演视图） */}
      {object.category === "human" ? (
        <NameTag text={objectDisplayName(object)} height={h} />
      ) : showHelpers ? (
        <Html
          position={[0, h + 0.4, 0]}
          center
          style={{ pointerEvents: "none" }}
          zIndexRange={[20, 0]}
        >
          <span className="obj-label" style={{ color: isSelected ? "#ffffff" : "#cdd8e2" }}>
            {objectDisplayName(object)}
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
          <span className="lock-badge" title="已锁定初始位置：编辑时不可拖拽，播放时仍按轨迹移动">
            LOCKED
          </span>
        </Html>
      ) : null}
    </group>
  );
}

/**
 * 人形骨骼：human 类资产用「头 + 躯干 + 双臂 + 双腿」的关节化组合体表示。
 * 关节按 JointName 树嵌套（髋→膝、肩→肘、脊柱→肩/颈），每个关节是一个 group，
 * mesh 作为子节点挂在关节下方。渲染层把 actor.pose 的静态基线角度与按速度
 * 驱动的走/跑摆动叠加（Body Motion 与整体位移分离，位置仍由 solver 求解）。
 * 尺寸全部由 footprint 推导；无 pose 时与旧版方盒人外观一致。
 */
function HumanoidRig({
  w,
  d,
  h,
  color,
  speedRef,
  pose,
  objectId,
}: {
  w: number;
  d: number;
  h: number;
  color: string;
  speedRef: MutableRefObject<number>;
  pose?: Pose;
  objectId: string;
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
  const shoulderY = legH + torsoH; // 肩关节 = 躯干顶端
  const thighLen = legH * 0.5;
  const shinLen = legH * 0.5;
  const upperArmLen = armH * 0.5;
  const foreArmLen = armH * 0.5;

  const hipL = useRef<THREE.Group>(null);
  const hipR = useRef<THREE.Group>(null);
  const kneeL = useRef<THREE.Group>(null);
  const kneeR = useRef<THREE.Group>(null);
  const spine = useRef<THREE.Group>(null);
  const shoulderL = useRef<THREE.Group>(null);
  const shoulderR = useRef<THREE.Group>(null);
  const elbowL = useRef<THREE.Group>(null);
  const elbowR = useRef<THREE.Group>(null);
  const neck = useRef<THREE.Group>(null);
  const phaseRef = useRef(0);

  useFrame((_, delta) => {
    const speed = speedRef.current;
    const intensity = Math.min(1, speed / 2.6); // 0=静止，1=全速

    // 静态姿势基线（pose）+ 时间轴动作片段（action）叠加；未列出的关节为 0。
    const { state, currentTime } = useDirectorStore.getState();
    const actionSample = actionPoseAt(state, objectId, currentTime);
    const aJ = actionSample.pose.joints;
    const j = pose?.joints ?? {};
    const combinedX = (n: JointName) => (j[n]?.[0] ?? 0) * sw + (aJ[n]?.[0] ?? 0);
    const loco = actionSample.locomotionScale;
    // 静态基线只对站定的角色生效：起步后随速度衰减到 0，让位给步态（见 staticPoseWeight）。
    const sw = staticPoseWeight(speed);

    // 步态：显式 walk/run 片段优先；否则按 MOVE 的速度自动判定（低速走、高速跑）。
    // 注意 MOVE 决定"去哪里"，步态只决定身体怎么动，二者互不覆盖。
    const RUN_SPEED = 1.6;
    const isRun =
      actionSample.gait === "run" || (actionSample.gait === "auto" && speed >= RUN_SPEED);
    const cadence = isRun ? 1.5 + speed * 1.9 : 1.5 + speed * 1.2;
    const legAmp = (isRun ? 0.85 : 0.6) * intensity;
    const armAmp = (isRun ? 0.7 : 0.5) * intensity;
    const lean = (isRun ? 0.25 : 0.06) * intensity * loco;
    phaseRef.current += delta * cadence;
    const legSwing = Math.sin(phaseRef.current) * legAmp;
    const armSwing = Math.sin(phaseRef.current + Math.PI) * armAmp;

    const setRot = (ref: { current: THREE.Group | null }, n: JointName) => {
      if (ref.current) {
        const v = j[n] ?? [0, 0, 0];
        const av = aJ[n] ?? [0, 0, 0];
        ref.current.rotation.set(v[0] * sw + av[0], v[1] * sw + av[1], v[2] * sw + av[2]);
      }
    };

    // 髋/肩：基线 + 动作 + 走/跑摆动（locomotionScale 在坐/蹲时为 0）。
    if (hipL.current) hipL.current.rotation.x = combinedX("hipL") + legSwing * loco;
    if (hipR.current) hipR.current.rotation.x = combinedX("hipR") - legSwing * loco;
    if (shoulderL.current) shoulderL.current.rotation.x = combinedX("shoulderL") + armSwing * loco;
    if (shoulderR.current) shoulderR.current.rotation.x = combinedX("shoulderR") - armSwing * loco;
    // 膝/肘/脊柱/颈：基线 + 动作（无摆动）。
    setRot(kneeL, "kneeL");
    setRot(kneeR, "kneeR");
    setRot(elbowL, "elbowL");
    setRot(elbowR, "elbowR");
    setRot(spine, "spine");
    // 步态前倾：跑动时明显前倾（乘 locomotionScale，坐/蹲时不前倾）。
    if (spine.current) spine.current.rotation.x += lean;
    setRot(neck, "neck");
  });

  return (
    <group>
      {/* 腿：髋 → 膝（关节嵌套），全局从髋/膝本地旋转 */}
      <group ref={hipL} position={[-legX, legH, 0]}>
        <mesh position={[0, -thighLen / 2, 0]}>
          <boxGeometry args={[legW, thighLen, legD]} />
          <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
        </mesh>
        <group ref={kneeL} position={[0, -thighLen, 0]}>
          <mesh position={[0, -shinLen / 2, 0]}>
            <boxGeometry args={[legW, shinLen, legD]} />
            <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
          </mesh>
        </group>
      </group>
      <group ref={hipR} position={[legX, legH, 0]}>
        <mesh position={[0, -thighLen / 2, 0]}>
          <boxGeometry args={[legW, thighLen, legD]} />
          <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
        </mesh>
        <group ref={kneeR} position={[0, -thighLen, 0]}>
          <mesh position={[0, -shinLen / 2, 0]}>
            <boxGeometry args={[legW, shinLen, legD]} />
            <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
          </mesh>
        </group>
      </group>
      {/* 脊柱（上半身）含躯干、双臂、颈/头，整体可前倾 */}
      <group ref={spine}>
        <mesh position={[0, legH + torsoH / 2, 0]}>
          <boxGeometry args={[torsoW, torsoH, torsoD]} />
          <meshStandardMaterial color={color} roughness={0.7} metalness={0.05} />
        </mesh>
        <group ref={shoulderL} position={[-armX, shoulderY, 0]}>
          <mesh position={[0, -upperArmLen / 2, 0]}>
            <boxGeometry args={[armW, upperArmLen, armD]} />
            <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
          </mesh>
          <group ref={elbowL} position={[0, -upperArmLen, 0]}>
            <mesh position={[0, -foreArmLen / 2, 0]}>
              <boxGeometry args={[armW, foreArmLen, armD]} />
              <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
            </mesh>
          </group>
        </group>
        <group ref={shoulderR} position={[armX, shoulderY, 0]}>
          <mesh position={[0, -upperArmLen / 2, 0]}>
            <boxGeometry args={[armW, upperArmLen, armD]} />
            <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
          </mesh>
          <group ref={elbowR} position={[0, -upperArmLen, 0]}>
            <mesh position={[0, -foreArmLen / 2, 0]}>
              <boxGeometry args={[armW, foreArmLen, armD]} />
              <meshStandardMaterial color={color} roughness={0.62} metalness={0.05} />
            </mesh>
          </group>
        </group>
        <group ref={neck} position={[0, legH + torsoH, 0]}>
          <mesh position={[0, headR, 0]}>
            <sphereGeometry args={[headR, 18, 14]} />
            <meshStandardMaterial color={color} roughness={0.6} metalness={0.05} />
          </mesh>
        </group>
      </group>
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
        // 与运动求解共用 segmentRoutePoints **与同一份障碍集合**，因此这条线就是 agent
        // 真正走的路线——群队锚点会把「编队骑得过去」的小障碍排除掉，两边必须一致，
        // 否则会看到橙色线绕行、人却直穿过去。
        const rects = routeObstacles(state, segment.object);
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

      {isSelected ? (
        <Html position={[point.x, 0.42, point.z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
          <span className="node-label">#{index + 1}</span>
        </Html>
      ) : null}

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
    // 荷兰角：代理是普通 group，lookAt 后本地 +Z 即视线方向，绕 Z 滚转即画面倾斜。
    if (resolved.roll) groupRef.current.rotateZ((resolved.roll * Math.PI) / 180);
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
/** 把渲染画布暴露给视频导出模块（供 canvas.captureStream 录制）。 */
function CaptureBridge() {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    // 画布已在 Canvas.onCreated 注册；此处仅同步可能更新的相机 / 画布引用。
    // 注意：不要在此清空 captureCanvas——本组件可能因子树下 Suspense 暂时卸载，
    // 一旦清空就会导致「渲染画布尚未就绪」的报错。
    viewRef.camera = camera;
    viewRef.canvas = gl.domElement as HTMLCanvasElement;
  }, [gl, camera]);
  return null;
}

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
    // 荷兰角：lookAt 之后再绕视线轴滚转画面（正值顺时针）。
    if (resolved.roll) camera.rotateZ((resolved.roll * Math.PI) / 180);

    // 供景深后处理使用：对焦点 = 镜头 target（过肩时是远处的主体，前景肩膀因此自然虚化）。
    liveShot.focusPoint[0] = resolved.target[0];
    liveShot.focusPoint[1] = resolved.target[1];
    liveShot.focusPoint[2] = resolved.target[2];
    liveShot.focusDistance = Math.hypot(
      resolved.target[0] - resolved.position[0],
      resolved.target[1] - resolved.position[1],
      resolved.target[2] - resolved.position[2],
    );
    liveShot.lensMm = resolved.lensMm;

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

/**
 * 景深 / 焦外虚化：只在「镜头视角」挂载，导演总览视角保持全清晰（要看清机位与轴线）。
 *
 * 对焦点跟随当前镜头的 target——过肩时那是远处的主体，前景肩膀因此自然虚化；
 * 清晰范围由焦距与对焦距离按真实光学推导（长焦 / 近距离 → 景深极浅），详见 engine/shotFocus。
 */
function CameraDepthOfField() {
  const effect = useRef<DepthOfFieldEffect>(null);

  // 每帧直接改写 effect，而不是走 props——否则更新对焦点会触发 React 重渲染。
  useFrame(() => {
    const dof = effect.current;
    if (!dof) return;
    if (!dof.target) dof.target = new THREE.Vector3();
    dof.target.set(liveShot.focusPoint[0], liveShot.focusPoint[1], liveShot.focusPoint[2]);
    // focusRange 是世界单位（米）：对焦点前后完全清晰的区间，越小景深越浅。
    dof.cocMaterial.focusRange = focusRangeForLens(liveShot.lensMm, liveShot.focusDistance);
    dof.bokehScale = bokehScaleForLens(liveShot.lensMm);
  });

  return (
    <EffectComposer>
      <DepthOfField
        ref={effect}
        target={liveShot.focusPoint}
        focusRange={focusRangeForLens(liveShot.lensMm, liveShot.focusDistance)}
        bokehScale={bokehScaleForLens(liveShot.lensMm)}
      />
    </EffectComposer>
  );
}

/* ------------------------------------------------------------ Interaction */

function Interaction() {
  const dragRef = useRef<DragState | null>(null);
  const [ghost, setGhost] = useState<Vec2 | null>(null);
  const drawingRef = useRef(false);
  const livePtsRef = useRef<Vec2[]>([]);
  const [livePts, setLivePts] = useState<Vec2[]>([]);
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
      } else if (drag.kind === "draw") {
        const pts = livePtsRef.current;
        if (pts.length >= 2) store.drawAssetPath(drag.objectId, pts);
        livePtsRef.current = [];
        setLivePts([]);
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

    // 手绘路径模式：在画布上拖拽，把轨迹写入当前选中的资产（无选中资产时不拦截，便于先点选）。
    // set 资产是静态环境 / 障碍，不参与运动，禁用对其手绘路径。
    if (store.pathDrawMode) {
      const targetId = store.selectedKind === "object" ? store.selectedId : null;
      const targetRole =
        targetId && store.selectedKind === "object"
          ? store.state.objects.find((o) => o.id === targetId)?.role
          : undefined;
      if (targetId && targetRole !== "set") {
        drawingRef.current = true;
        livePtsRef.current = [point];
        setLivePts([point]);
        beginDrag({ kind: "draw", objectId: targetId });
        capturePointer(event);
        return;
      }
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
      // 团队成员：拖任何一个都是整队平移（位置由锚点承载），保持"队作为一个 unit"。
      const team = (store.state.groups ?? []).find(
        (g) => g.dynamics && g.members.includes(drag.id),
      );
      if (team && team.members.length >= 2 && team.members[0] !== drag.id) {
        const anchor = store.state.objects.find((o) => o.id === team.members[0]);
        if (anchor) {
          store.moveObject(
            team.members[0],
            anchor.x + (point.x - drag.origin.x),
            anchor.z + (point.z - drag.origin.z),
          );
          return;
        }
      }
      store.moveObject(drag.id, point.x, point.z);
    } else if (drag.kind === "point") {
      store.movePathPoint(drag.segmentId, drag.pointId, point.x, point.z);
    } else if (drag.kind === "endpoint") {
      store.moveEndpoint(drag.segmentId, drag.which, point.x, point.z);
    } else if (drag.kind === "draw") {
      const last = livePtsRef.current[livePtsRef.current.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.z - last.z) > 0.15) {
        const next = [...livePtsRef.current, point];
        livePtsRef.current = next;
        setLivePts(next);
      }
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

      {livePts.length > 1 ? (
        <Line
          points={livePts.map((p) => [p.x, 0.07, p.z] as [number, number, number])}
          color="#55d88a"
          lineWidth={2.5}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- Camera rig */

function CameraZoom() {
  const zoom = useDirectorStore((s) => s.zoom);
  const setZoom = useDirectorStore((s) => s.setZoom);
  const viewMode = useDirectorStore((s) => s.viewMode);
  const { camera, controls } = useThree();
  const applied = useRef(zoom);
  // 以 OrbitControls 的实时 target 为锚点（WASD 平移视角后不希望被拉回原点）。
  const anchor = (): THREE.Vector3 => (controls as unknown as { target?: THREE.Vector3 } | null)?.target ?? TARGET;

  useEffect(() => {
    if (viewMode !== "director") return;
    const t = anchor();
    const direction = camera.position.clone().sub(t);
    if (direction.lengthSq() < 1e-6) direction.set(0, 20.5, 16);
    direction.setLength(BASE_DISTANCE / zoom);
    camera.position.copy(t).add(direction);
    camera.lookAt(t);
    applied.current = zoom;
  }, [camera, zoom, viewMode, anchor]);

  useFrame(() => {
    if (viewMode !== "director") return;
    const t = anchor();
    const distance = camera.position.distanceTo(t);
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

/* ----------------------------------------------------------- WASD 视角平移 */
function ViewPanControls() {
  const { camera, controls } = useThree();
  const keys = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          (el as HTMLElement).isContentEditable)
      );
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        keys.current[k] = true;
        if (k.startsWith("arrow")) e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useFrame((_, delta) => {
    const { viewMode } = useDirectorStore.getState();
    if (viewMode !== "director") return;
    const k = keys.current;
    let fwd = 0;
    let side = 0;
    if (k["w"] || k["arrowup"]) fwd += 1;
    if (k["s"] || k["arrowdown"]) fwd -= 1;
    if (k["d"] || k["arrowright"]) side += 1;
    if (k["a"] || k["arrowleft"]) side -= 1;
    if (fwd === 0 && side === 0) return;

    // 地面前向（相机视线投影到 x/z 平面）+ 右向，使 WASD 始终相对当前视角。
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();

    // 速度随相机高度缩放，远近手感一致（zoom 越小、越高 → 平移越快）。
    const speed = (camera.position.y / 20.5) * 16 * delta;
    const move = new THREE.Vector3()
      .addScaledVector(dir, fwd * speed)
      .addScaledVector(right, side * speed);

    camera.position.add(move);
    const ctrl = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    if (ctrl?.target) {
      ctrl.target.add(move);
      ctrl.update?.();
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
      <ViewPanControls />
      <CameraRig />
      <ambientLight intensity={0.8} />
      <directionalLight position={[14, 24, 10]} intensity={1.1} />
      <Interaction />
      <SegmentPaths />
      <PathHandles />
      <HandoffMarkers />
      <FollowLinks />
      <Actors />
      <GroupGraph />
      <OcclusionHighlights />
      <CameraPaths />
      <CameraProxies />
      <ActionAxisLine />
      <RadialLayer />
      {viewMode === "camera" ? <CameraDepthOfField /> : null}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping={false}
        enabled={viewMode === "director" && !viewLocked && !dragging}
      />
    </>
  );
}

/**
 * 团队标记（导演视图）：
 * - **脚下红色标记**：常驻在队首（锚点）脚下的红色圆环 + 实心点，回答"这是哪个队 / 队在哪"。
 *   取代原先立在队首的「队旗」：贴地标记不遮挡角色与机位视线，也不随编队变形。
 * - **包围大圈**：仅在整队被选中时出现，框住整队 footprint。半径来自「静止编队」槽位，
 *   不随播放 / 拖拽时的弹簧甩动而暴涨——选中圈代表队伍范围，而非瞬时形变。
 * 成员之间的连线已移除：编队形状本身一眼可见，连线只是噪音。
 */
function GroupGraph() {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  if (!showHelpers) return null;
  const groups = state.groups ?? [];
  return (
    <>
      {groups.map((g) => {
        if (g.members.length < 2 || !g.dynamics) return null;
        const anchor = objectPosition(state, g.members[0], currentTime);
        // 包围圆：以「静止编队」的质心为心、最远槽位 + 余量为半径。
        // 用编队槽位（不含弹簧偏移）计算，所以圈只随编队/间距/人数变化而变，
        // 不会因播放 / 拖拽时的弹簧甩动被撑大——选中圈代表队伍 footprint，而非瞬时形变。
        const heading = baseHeading(state, g.members[0], currentTime);
        const forward = { x: Math.sin(heading), z: Math.cos(heading) };
        const right = { x: Math.cos(heading), z: -Math.sin(heading) };
        // 选圈随编队过渡平滑变化：切换队形期间按 morphT 在旧/新阵型间插值，而非瞬变。
        const morphT =
          g.formationChangeAt == null
            ? 1
            : Math.max(0, Math.min(1, (currentTime - g.formationChangeAt) / FORMATION_MORPH_SECONDS));
        const prevForm = g.prevFormation ?? g.formation ?? "column";
        const curForm = g.formation ?? "column";
        // 与求解器一致：新阵型整体前移，使变阵期间没有任何队员向后倒退。
        const fwdShift =
          g.formationChangeAt == null
            ? 0
            : formationForwardShift(prevForm, curForm, g.spacing ?? 1.2, g.members.length);
        const slots = g.members.map((_, i) => {
          const a = formationSlotOf(prevForm, g.spacing ?? 1.2, i, g.members.length);
          const b = formationSlotOf(curForm, g.spacing ?? 1.2, i, g.members.length);
          const bFwd = b.fwd + fwdShift;
          return {
            fwd: a.fwd + (bFwd - a.fwd) * morphT,
            right: a.right + (b.right - a.right) * morphT,
          };
        });
        const rest = slots.map((s) => ({
          x: anchor.x + forward.x * s.fwd + right.x * s.right,
          z: anchor.z + forward.z * s.fwd + right.z * s.right,
        }));
        const cx = rest.reduce((sum, p) => sum + p.x, 0) / rest.length;
        const cz = rest.reduce((sum, p) => sum + p.z, 0) / rest.length;
        const radius =
          rest.reduce((max, p) => Math.max(max, Math.hypot(p.x - cx, p.z - cz)), 0) + 0.9;
        const selected = selectedKind === "object" && g.members.includes(selectedId);
        return (
          <group key={g.id}>
            {/* 队首脚下标记：红色地面圆环 + 实心点。取代原「队旗」——贴地不遮挡角色 /
                机位视线，俯视与侧视都一眼可见。 */}
            <group position={[anchor.x, 0, anchor.z]}>
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
                <ringGeometry args={[0.42, 0.55, 48]} />
                <meshBasicMaterial
                  color="#ff3b30"
                  transparent
                  opacity={0.85}
                  side={THREE.DoubleSide}
                />
              </mesh>
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
                <circleGeometry args={[0.2, 32]} />
                <meshBasicMaterial
                  color="#ff3b30"
                  transparent
                  opacity={0.95}
                  side={THREE.DoubleSide}
                />
              </mesh>
            </group>
            {selected ? (
              <mesh
                rotation={[-Math.PI / 2, 0, 0]}
                position={[cx, 0.04, cz]}
                scale={[radius, radius, 1]}
              >
                <ringGeometry args={[0.955, 1, 64]} />
                <meshBasicMaterial
                  color={g.color}
                  transparent
                  opacity={0.8}
                  side={THREE.DoubleSide}
                />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </>
  );
}

/**
 * 180° 动作轴线：把「机位必须留在其同一侧」的分界线画出来。
 * 轴线由过肩关系（前景 ↔ 主体）或互视的 LOOK_AT 约束推导；越轴时 Inspector 会给出警告。
 */
function ActionAxisLine() {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const showHelpers = useDirectorStore((s) => s.viewMode === "director");
  if (!showHelpers || !activeCameraId) return null;

  const axis = cameraAxis(state, activeCameraId, currentTime);
  if (!axis) return null;

  const dx = axis.pb.x - axis.pa.x;
  const dz = axis.pb.z - axis.pa.z;
  const len = Math.hypot(dx, dz) || 1;
  const ex = (dx / len) * 16;
  const ez = (dz / len) * 16;

  return (
    <Line
      points={
        [
          [axis.pa.x - ex, 0.06, axis.pa.z - ez],
          [axis.pb.x + ex, 0.06, axis.pb.z + ez],
        ] as Array<[number, number, number]>
      }
      color="#ffcf6a"
      lineWidth={1.5}
    />
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
  const selectedRole = useDirectorStore((s) =>
    s.selectedKind === "object"
      ? s.state.objects.find((o) => o.id === s.selectedId)?.role
      : undefined,
  );
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const viewLocked = useDirectorStore((s) => s.viewLocked);
  const toggleViewLocked = useDirectorStore((s) => s.toggleViewLocked);
  const pathDrawMode = useDirectorStore((s) => s.pathDrawMode);
  const togglePathDraw = useDirectorStore((s) => s.togglePathDraw);
  const addAsset = useDirectorStore((s) => s.addAsset);
  const addCamera = useDirectorStore((s) => s.addCamera);
  const addDroneCamera = useDirectorStore((s) => s.addDroneCamera);
  const addCameraFromTemplate = useDirectorStore((s) => s.addCameraFromTemplate);
  const addGroupAt = useDirectorStore((s) => s.addGroupAt);
  const [tplOpen, setTplOpen] = useState(false);
  // 拖入「团队」时先弹面板配置人数 / 类型 / 编队，确认后一次性生成整队。
  const [groupDraft, setGroupDraft] = useState<{
    at: { x: number; z: number };
    count: number;
    category: AssetCategory;
    formation: FormationKind;
  } | null>(null);
  const templateGroups = groupTemplatesByCategory();

  const handleDropAdd = (kind: string, point: { x: number; z: number }) => {
    if (kind === "camera") {
      addCamera();
    } else if (kind === "drone") {
      addDroneCamera();
    } else if (kind === "group") {
      setGroupDraft({ at: point, count: 4, category: "human", formation: "column" });
    } else {
      // kind 即 AssetCategory
      addAsset(kind as AssetCategory, point);
    }
  };

  return (
    <main>
      {viewMode === "director" ? (
        <div className="addbar">
          <span className="addbar-hint">拖拽到画布添加 →</span>
          {ASSET_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className="add-icon"
              draggable
              title={`拖拽到画布添加 ${ASSET_PRESETS[category].label}`}
              onDragStart={(event) => {
                event.dataTransfer.setData("application/director-add", category);
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              {ASSET_PRESETS[category].label}
            </button>
          ))}
          <button
            type="button"
            className="add-icon"
            draggable
            title="拖拽到画布添加 Camera（自动取景目标）"
            onDragStart={(event) => {
              event.dataTransfer.setData("application/director-add", "camera");
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            Camera
          </button>
          <button
            type="button"
            className="add-icon"
            draggable
            title="拖拽到画布添加 Drone（自动取景目标）"
            onDragStart={(event) => {
              event.dataTransfer.setData("application/director-add", "drone");
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            Drone
          </button>
          <button
            type="button"
            className="add-icon group-btn"
            draggable
            title="拖拽到画布添加 Group（团队：整队只画一条路线，队员按编队跟随）"
            onDragStart={(event) => {
              event.dataTransfer.setData("application/director-add", "group");
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            👥 Group
          </button>
          <button
            type="button"
            className="add-icon tpl-btn"
            title="从机位模板库新建机位"
            onClick={() => setTplOpen((open) => !open)}
          >
            🎬 模板
          </button>
          {tplOpen ? (
            <div className="tpl-picker">
              {templateGroups.map((group) => (
                <div key={group.category} className="tpl-group">
                  <div className="tpl-cat">{group.label}</div>
                  {group.templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="obj tpl-item"
                      title={template.description}
                      onClick={() => {
                        addCameraFromTemplate(template.id);
                        setTplOpen(false);
                      }}
                    >
                      {template.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 新建团队：拖入 Group 后配置人数 / 类型 / 编队 */}
      {groupDraft ? (
        <div className="modal-mask" onClick={() => setGroupDraft(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">新建团队 Group</div>
            <p className="hint">
              整队作为一个 unit：只给<b>组</b>设定一条路线，队员按编队跟随（匀速保持队形、变速变线弹簧回弹）。
            </p>

            <label className="modal-field">
              <span>类型 Type</span>
              <select
                value={groupDraft.category}
                onChange={(event) =>
                  setGroupDraft({ ...groupDraft, category: event.target.value as AssetCategory })
                }
              >
                {ASSET_ORDER.map((category) => (
                  <option key={category} value={category}>
                    {ASSET_PRESETS[category].label}
                  </option>
                ))}
              </select>
            </label>

            <label className="modal-field">
              <span>人数 Count：{groupDraft.count}</span>
              <input
                type="range"
                min={2}
                max={12}
                step={1}
                value={groupDraft.count}
                onChange={(event) =>
                  setGroupDraft({ ...groupDraft, count: Number(event.target.value) })
                }
              />
            </label>

            <label className="modal-field">
              <span>编队 Formation</span>
              <select
                value={groupDraft.formation}
                onChange={(event) =>
                  setGroupDraft({ ...groupDraft, formation: event.target.value as FormationKind })
                }
              >
                {(Object.keys(FORMATION_LABELS) as FormationKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {FORMATION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>

            <div className="modal-actions">
              <button type="button" className="obj" onClick={() => setGroupDraft(null)}>
                取消
              </button>
              <button
                type="button"
                className="obj primary"
                onClick={() => {
                  addGroupAt(
                    groupDraft.category,
                    groupDraft.count,
                    groupDraft.formation,
                    groupDraft.at,
                  );
                  setGroupDraft(null);
                }}
              >
                创建团队
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className="canvasWrap"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const kind = event.dataTransfer.getData("application/director-add");
          if (!kind) return;
          const point = screenToGround(event.clientX, event.clientY);
          if (!point) return;
          handleDropAdd(kind, point);
        }}
      >
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          onCreated={({ gl, camera }) => {
            // 渲染器一创建就注册画布：不依赖子树挂载，且不受子组件 Suspense 影响。
            setCaptureCanvas(gl.domElement as HTMLCanvasElement);
            viewRef.canvas = gl.domElement as HTMLCanvasElement;
            viewRef.camera = camera;
          }}
        >
          <color attach="background" args={["#0a0a0c"]} />
          <WorldScene />
          <CaptureBridge />
        </Canvas>

        {/* 画布内左侧悬浮工具条：视图切换 + 锁定 + 缩放 / 路径 / 相机选择，竖向排列。 */}
        <div className="view-floatbar">
          <div className="vf-switch" role="tablist" aria-label="View Mode">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "director"}
              className={`vf-opt ${viewMode === "director" ? "active" : ""}`}
              onClick={() => setViewMode("director")}
              title="导演视角：自由观察全场、编辑路径"
            >
              Director
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "camera"}
              className={`vf-opt ${viewMode === "camera" ? "active" : ""}`}
              onClick={() => setViewMode("camera")}
              disabled={cameras.length === 0}
              title="镜头视角：预览当前机位的构图画面"
            >
              Camera
            </button>
          </div>
          {viewMode === "director" ? (
            <>
              <button
                type="button"
                className={`vf-lock ${viewLocked ? "on" : ""}`}
                onClick={toggleViewLocked}
                title={
                  viewLocked
                    ? "视角已锁定（L）：拖拽不再改变视角"
                    : "锁定视角（L）：锁定后拖拽不再改变视角，方便编辑路径"
                }
              >
                {viewLocked ? "🔒" : "🔓"}
              </button>
              <div className="vf-sep" />
              <div className="vf-zoom" title="滚轮 / ± 缩放，WASD 或方向键平移视角">
                <button type="button" title="Zoom out" onClick={() => setZoom(zoom - 0.1)}>
                  −
                </button>
                <button type="button" title="Reset to 100%" onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <button type="button" title="Zoom in" onClick={() => setZoom(zoom + 0.1)}>
                  +
                </button>
              </div>
              <button
                type="button"
                className={`vf-tool ${pathDrawMode ? "on" : ""}`}
                disabled={selectedRole === "set"}
                title={
                  selectedRole === "set"
                    ? "set 为静态环境 / 障碍，不参与运动，禁用路径绘制"
                    : "手绘路径：开启后在画布上拖拽绘制选中资产的移动轨迹"
                }
                onClick={togglePathDraw}
              >
                ✏️ Path
              </button>
            </>
          ) : (
            <select
              className="vf-camera"
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
          )}
        </div>

        {viewMode === "camera" ? <FramingOverlay /> : null}
      </div>
    </main>
  );
}
