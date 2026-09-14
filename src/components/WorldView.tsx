import { Suspense, useEffect, useMemo, MutableRefObject, useRef, useState } from "react";
import { Canvas, ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { setCaptureCanvas } from "../engine/videoExport";
import { Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { MarkerHover, useDirectorStore } from "../state/directorStore";
import { AssetCategory, DirectorState, HandoffMode, JointName, MoveSegment, PathPoint, Pose, Vec2 } from "../domain/schema";
import { pathChain } from "../engine/path";
import {
  hitCameraRay,
  hitCameraPathPointScreen,
  hitEndpointScreen,
  hitObjectRay,
  hitPath,
  hitPathPointScreen,
  pathPolyline,
} from "../engine/pick";
import { nearestOnCamPath } from "../engine/cameraPath";
import { baseHeading, formationForwardShift, formationSlotOf, objectFacing, objectPosition, routeObstacles } from "../engine/solver";
import { actionPoseAt, staticPoseWeight } from "../engine/actionPose";
import { MODEL_CONFIG } from "../engine/modelConfig";
import { HumanoidGLB, ModelBoundary } from "./HumanoidModel";
import { animalModelOf } from "../engine/animalModels";
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
import { RadialRing, PointRadialRing, CameraPointRadialRing } from "./RadialRing";
import { LockBadge } from "./LockBadge";

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const TARGET = new THREE.Vector3(0, 0, 0);
const BASE_DISTANCE = 26;
const DIRECTOR_FOV = 40;
/** 径向意图环暂未匹配到合适的操作，暂时关闭（置 true 即可恢复点击对象弹出）。 */
const RING_ENABLED = false;
/** 路径标记（转折点 / 起终点把手）的屏幕命中半径：比图形本身大一圈，鼠标不必精确压在标记上。
 *  按像素而非世界单位给，缩放与移机都不会改变手感；端点是公认最难点的那个，故单独放大。 */
const POINT_PICK_PX = 24;
const ENDPOINT_PICK_PX = 26;
/** 相机 PATH 路径点（含首尾端点）的屏幕命中半径（px）。 */
const CAM_POINT_PICK_PX = 26;

/** 悬停标记是否已经是同一个：省掉每次 pointermove 都写一遍 store。 */
function sameMarker(a: MarkerHover | null, b: MarkerHover | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.segmentId === b.segmentId && a.id === b.id;
}

type DragState =
  // start = 按下瞬间「真正会被移动的那个对象」的位置快照（团队成员时是锚点）。
  // 拖动一律按 start + 累计位移计算，绝不能拿上一帧的位置再叠加（那会指数级漂移）。
  | { kind: "object"; id: string; moved: boolean; origin: Vec2; start: Vec2 }
  // moved / origin 用于区分「轻点」与「拖动」：轻点唤起环形菜单，拖动则正常搬点。
  | { kind: "point"; segmentId: string; pointId: string; moved: boolean; origin: Vec2 }
  | { kind: "endpoint"; segmentId: string; which: "start" | "end" }
  | { kind: "new"; segmentId: string; origin: Vec2; current: Vec2 }
  | { kind: "draw"; objectId: string }
  | { kind: "camerapoint"; moveId: string; pointId: string; moved: boolean; origin: Vec2 }
  // 按住相机路径线拖动加点：insertAt = 插入位置，y = 落点高度（取被按线段中点高度）。
  | {
      kind: "cameraNew";
      moveId: string;
      insertAt: number;
      y: number;
      moved: boolean;
      origin: Vec2;
      current: Vec2;
    };

function groundPoint(event: ThreeEvent<PointerEvent>): Vec2 | null {
  if (event.ray) {
    const hit = new THREE.Vector3();
    if (event.ray.intersectPlane(GROUND_PLANE, hit)) return { x: hit.x, z: hit.z };
  }
  // event.point 同样是射线与地面平面的交点，只有射线几乎平行于地面时两者才都取不到。
  const onPlane = event.point as { x: number; z: number } | undefined;
  return onPlane ? { x: onPlane.x, z: onPlane.z } : null;
}

/** 射线与「高度 y = h 的水平面」的交点：用于拖拽悬在空中的把手（相机路径点）。
 *  投到地面（y=0）会让把手整体偏出光标，看着像漂移 / 不跟手。 */
function planePointAtHeight(event: ThreeEvent<PointerEvent>, h: number): Vec2 | null {
  if (!event.ray) return null;
  const hit = new THREE.Vector3();
  if (!event.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), hit)) return null;
  return { x: hit.x, z: hit.z };
}

/** 地面交点的最大可信距离（世界单位）。
 *  相机压到接近水平时，视线与地面的交点在极远处（上千甚至上万单位），
 *  拿它当拖拽目标就会把物体瞬间甩到画布外沿。超过此距离的点一律丢弃，
 *  让物体留在上一次有效位置 —— 宁可「这一帧拖不动」，也不要「飞出去」。 */
const GROUND_HIT_MAX = 300;

/** 地面交点是否可信：按到相机的距离判定，挡掉近水平射线产生的极远交点。 */
function groundHitUsable(event: ThreeEvent<PointerEvent>, point: Vec2): boolean {
  const ray = event.ray;
  if (!ray) return true;
  return Math.hypot(point.x - ray.origin.x, point.z - ray.origin.z) <= GROUND_HIT_MAX;
}

/**
 * 光标射线是否正压在某相机的 PATH 路径点上。
 * 播放头在第一帧时，相机解算位置正好等于路径起点，相机代理（机身 / 无人机）会盖住蓝点并抢走点击；
 * 这里让代理让路（不 stopPropagation），把事件继续交给地面把手去拾取路径点。
 */
function cameraPathPointUnder(event: ThreeEvent<PointerEvent>, cameraId: string): boolean {
  const ray = event.ray;
  if (!ray) return false;
  const v = new THREE.Vector3();
  for (const m of useDirectorStore.getState().state.cameraMoves) {
    if (m.camera !== cameraId || m.type !== "PATH") continue;
    for (const p of m.pathPoints ?? []) {
      if (ray.distanceToPoint(v.set(p.x, p.y, p.z)) < 0.8) return true;
    }
  }
  return false;
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
  const isSelected = useDirectorStore((s) => {
    if (s.selectedKind !== "object" || !s.selectedId) return false;
    if (s.selectedId === objectId) return true;
    // 团队作为一个 unit：选中其中任一成员（通常是锚点）时整队一起高亮。
    // 否则点队伍里任何一个人都只有那一个人亮，看着仍像"选中个体"。
    const team = (s.state.groups ?? []).find(
      (g) => g.dynamics && g.members.length >= 2 && g.members.includes(objectId),
    );
    return !!team && team.members.includes(s.selectedId);
  });
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
    const useGlb =
      (object.category === "human" && !!MODEL_CONFIG.human) ||
      (object.category === "animal" && !!animalModelOf(object.species));
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

  // 配置了 GLB 模型的类别（human / 带物种的动物）→ 骨骼动画；
  // 加载中 / 失败都回退到方块简模。动物无物种或未配置模型时仍是方块。
  const modelConfig =
    object.category === "human"
      ? MODEL_CONFIG.human
      : object.category === "animal"
        ? animalModelOf(object.species)?.config
        : undefined;
  const body =
    modelConfig ? (
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
      {objects.map((object) =>
        object.hidden ? null : <ActorView key={object.id} objectId={object.id} />,
      )}
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
        // 隐藏对象连同其行动路径一起隐藏，便于在画布上聚焦当前编辑内容。
        if (state.objects.find((o) => o.id === segment.object)?.hidden) return null;
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
  const hovered = useDirectorStore(
    (s) =>
      s.hoverMarker?.kind === "endpoint" &&
      s.hoverMarker.segmentId === segment.id &&
      s.hoverMarker.id === which,
  );
  const x = which === "start" ? segment.startX : segment.endX;
  const z = which === "start" ? segment.startZ : segment.endZ;
  const color = which === "start" ? "#67a7ff" : "#f0a35a";
  // 悬停色保持原有色相（端点没有「选中」态的白色语义，变白反而会和路径点混淆），只提亮、放大。
  const hoverColor = which === "start" ? "#a9cdff" : "#ffc79a";

  return (
    <group>
      <mesh position={[x, 0.26, z]} scale={hovered ? 1.35 : 1}>
        <sphereGeometry args={[0.24, 20, 14]} />
        <meshStandardMaterial
          color={hovered ? hoverColor : color}
          emissive={color}
          emissiveIntensity={hovered ? 1.1 : 0.4}
        />
      </mesh>
      <Html position={[x, 0.78, z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
        <span className="node-label" style={{ color: hovered ? hoverColor : color }}>
          {which === "start" ? "START" : "END"}
          {hovered ? " · 拖动移动" : ""}
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
  const hovered = useDirectorStore(
    (s) =>
      s.hoverMarker?.kind === "point" &&
      s.hoverMarker.segmentId === segment.id &&
      s.hoverMarker.id === point.id,
  );
  const isArc = point.shape === "ARC";
  const chain = pathChain(segment);
  const previous = chain[index];
  const next = chain[index + 2];

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

      {/* 悬停放大 + 变亮：命中半径比图形本身大一圈（见 POINT_PICK_PX），
          这里让「已经对准，松手就能选中 / 拖动」这件事看得见。 */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[point.x, 0.09, point.z]}
        scale={hovered ? 1.35 : 1}
      >
        {isArc ? <ringGeometry args={[0.2, 0.34, 28]} /> : <circleGeometry args={[0.24, 26]} />}
        <meshBasicMaterial
          color={isSelected ? "#ffffff" : hovered ? "#b9ffd6" : "#55d88a"}
          side={THREE.DoubleSide}
        />
      </mesh>

      {isSelected || hovered ? (
        <Html position={[point.x, 0.42, point.z]} center style={{ pointerEvents: "none" }} zIndexRange={[25, 0]}>
          <span className="node-label">
            #{index + 1}
            {hovered ? " · 拖动移动 · 点按出菜单" : ""}
          </span>
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
  cameraId,
  onSelect,
}: {
  color: string;
  selected: boolean;
  active: boolean;
  cameraId: string;
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
          if (cameraPathPointUnder(event, cameraId)) return;
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
          cameraId={cameraId}
          onSelect={() => selectCamera(cameraId)}
        />
      ) : (
        <>
          <mesh
            onPointerDown={(event) => {
              // 机位与 PATH 路径点重合时（首帧相机 = 起点）让路，交给地面把手拾取路径点。
              if (cameraPathPointUnder(event, cameraId)) return;
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

/** 相机 PATH 把手：首尾标 START/END（球 + 标签），中间是控制点（折线圆盘 / 曲线圆环），全部可拖拽。 */
function CameraPathHandles() {
  const selCamId = useDirectorStore((s) =>
    s.selectedKind === "camera" ? s.selectedId : s.activeCameraId,
  );
  const viewMode = useDirectorStore((s) => s.viewMode);
  const moves = useDirectorStore((s) => s.state.cameraMoves);
  if (viewMode !== "director" || !selCamId) return null;
  const pathMoves = moves.filter(
    (m) => m.camera === selCamId && m.type === "PATH" && (m.pathPoints?.length ?? 0) >= 2,
  );
  return (
    <>
      {pathMoves.map((m) =>
        (m.pathPoints ?? []).map((p, i, arr) => {
          const isStart = i === 0;
          const isEnd = i === arr.length - 1;
          if (isStart || isEnd) {
            const color = isStart ? "#67a7ff" : "#f0a35a";
            return (
              <group key={p.id} position={[p.x, p.y, p.z]}>
                <mesh>
                  <sphereGeometry args={[0.22, 20, 14]} />
                  <meshBasicMaterial color={color} />
                </mesh>
                <Html
                  center
                  position={[0, 0.5, 0]}
                  style={{ pointerEvents: "none" }}
                  zIndexRange={[25, 0]}
                >
                  <span className="node-label" style={{ color }}>
                    {isStart ? "START" : "END"}
                  </span>
                </Html>
              </group>
            );
          }
          const isArc = p.shape === "ARC";
          return (
            <mesh key={p.id} position={[p.x, p.y, p.z]} rotation={[-Math.PI / 2, 0, 0]}>
              {isArc ? (
                <ringGeometry args={[0.18, 0.3, 26]} />
              ) : (
                <circleGeometry args={[0.24, 26]} />
              )}
              <meshBasicMaterial color="#7ad7ff" side={THREE.DoubleSide} />
            </mesh>
          );
        }),
      )}
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

    liveShot.lensMm = resolved.lensMm;

    // ---- 自动对焦（供景深后处理）----
    // ① 有意图主体（targetId）时沿用镜头 target：过肩时那是远处主体，前景肩膀因此自然虚化。
    // ② 无意图主体时（自由 PATH 的「固定方向 / 沿轨迹」、LOCATION 等），镜头 target 只是机位前方
    //    1m 的虚拟点，拿它对焦会让整画面虚掉 —— 改为自动对焦到画面内最靠近构图中心的演员；
    //    画面里一个演员都没有时退到较深的对焦距离，避免糊成一片。
    const camObj = state.cameras.find((c) => c.id === activeCameraId);
    const activeMove = activeCameraMove(state, activeCameraId, currentTime);
    const intendedTargetId = activeMove?.targetId ?? camObj?.targetId;
    const camX = resolved.position[0];
    const camY = resolved.position[1];
    const camZ = resolved.position[2];
    let focusPoint: [number, number, number] = [resolved.target[0], resolved.target[1], resolved.target[2]];
    let focusDistance = Math.hypot(
      resolved.target[0] - camX,
      resolved.target[1] - camY,
      resolved.target[2] - camZ,
    );
    if (!intendedTargetId) {
      const tanV = Math.tan((resolved.fovDeg * Math.PI) / 360);
      const tanH = tanV * aspectValue(state.aspectRatio);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      let best: { point: [number, number, number]; dist: number; center: number } | null = null;
      for (const obj of state.objects) {
        if (obj.type !== "actor") continue;
        const op = objectPosition(state, obj.id, currentTime);
        const rx = op.x - camX;
        const ry = 1.5 - camY; // 对焦到演员胸口 / 面部高度
        const rz = op.z - camZ;
        const depth = rx * fwd.x + ry * fwd.y + rz * fwd.z;
        if (depth <= 0.5) continue;
        const cx = rx * right.x + ry * right.y + rz * right.z;
        const cy = rx * up.x + ry * up.y + rz * up.z;
        // 容许略微出框（1.15 倍）：人物刚进画就对上焦，避免虚焦后再切。
        if (Math.abs(cy) > depth * tanV * 1.15 || Math.abs(cx) > depth * tanH * 1.15) continue;
        const center = Math.hypot(cx / (depth * tanH || 1e-6), cy / (depth * tanV || 1e-6));
        const dist = Math.hypot(rx, ry, rz);
        if (!best || center < best.center) best = { point: [op.x, 1.5, op.z], dist, center };
      }
      if (best) {
        focusPoint = best.point;
        focusDistance = best.dist;
      } else {
        // 画面内没有演员：退到较深对焦距离，保证整场景不糊。
        focusDistance = Math.max(8, focusDistance);
        focusPoint = [camX + fwd.x * focusDistance, camY + fwd.y * focusDistance, camZ + fwd.z * focusDistance];
      }
    }
    liveShot.focusPoint[0] = focusPoint[0];
    liveShot.focusPoint[1] = focusPoint[1];
    liveShot.focusPoint[2] = focusPoint[2];
    liveShot.focusDistance = focusDistance;

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
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

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

  /**
   * 光标下的路径标记：转折点与起终点把手共用同一套屏幕命中（见 engine/pick 的 markerScore）。
   * 取更准的那个；两者重合时（手绘路径的首尾正好压在起终点上）优先起终点——
   * 转折点还能从环形菜单另找入口，端点没有别的地方可以抓。
   */
  const markerUnder = (
    event: ThreeEvent<PointerEvent>,
    state: DirectorState,
    objectId: string,
  ): MarkerHover | null => {
    const fov = (camera as THREE.PerspectiveCamera).fov || DIRECTOR_FOV;
    const focalPx = size.height / (2 * Math.tan((fov * Math.PI) / 360));
    const endpoint = hitEndpointScreen(state, objectId, event.ray, ENDPOINT_PICK_PX, focalPx);
    const point = hitPathPointScreen(state, objectId, event.ray, POINT_PICK_PX, focalPx);
    if (endpoint && (!point || endpoint.score <= point.score)) {
      return { kind: "endpoint", segmentId: endpoint.segment.id, id: endpoint.which };
    }
    if (point) return { kind: "point", segmentId: point.segment.id, id: point.point.id };
    return null;
  };

  useEffect(() => {
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const store = useDirectorStore.getState();
      if (drag.kind === "object" && !drag.moved) {
        if (RING_ENABLED) store.openRing(drag.id);
      } else if (drag.kind === "point" && !drag.moved) {
        // 轻点路径点（按下未拖动）：唤起环形菜单做 Line/Curve 切换或删除。
        // 这里刻意不受 RING_ENABLED 约束：那是旧的对象菜单开关且当前为 false，
        // 若一并套用，路径点在移除内联按钮后就没有操作入口了。
        store.openPointRing(drag.pointId);
      } else if (drag.kind === "camerapoint" && !drag.moved) {
        // 轻点相机 PATH 中间点：唤起环形菜单（CURVE / DEL）；首尾端点不弹菜单。
        const pts = store.state.cameraMoves.find((m) => m.id === drag.moveId)?.pathPoints ?? [];
        const idx = pts.findIndex((p) => p.id === drag.pointId);
        if (idx > 0 && idx < pts.length - 1) store.openCameraPointRing(drag.pointId);
      } else if (drag.kind === "cameraNew") {
        if (drag.moved) {
          store.insertCameraPathPoint(
            drag.moveId,
            drag.current.x,
            drag.y,
            drag.current.z,
            drag.insertAt,
          );
        }
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
    const store = useDirectorStore.getState();
    if (store.viewMode !== "director") return;
    if (store.radialTarget) {
      store.closeRing();
      return;
    }

    const selectedObjectId = store.selectedKind === "object" ? store.selectedId : null;

    // 路径标记先于其他一切判定：它们是浮在地面之上的几何体，只有直接拿射线才判得准
    //（拿射线与地面的交点去比距离，会随俯角整体错位：低机位下端点怎么点都不中），
    // 而且不再依赖地面交点是否存在。与 handleMove 的悬停反馈共用同一套判定，
    // 于是「亮起来」的把手一定点得中。
    if (selectedObjectId && !store.pathDrawMode) {
      const marker = markerUnder(event, store.state, selectedObjectId);
      if (marker) {
        store.selectItem(marker.segmentId);
        if (marker.kind === "point") {
          store.selectPoint(marker.id);
          beginDrag({
            kind: "point",
            segmentId: marker.segmentId,
            pointId: marker.id,
            moved: false,
            origin: point ?? { x: 0, z: 0 },
          });
        } else {
          store.selectPoint(null);
          beginDrag({ kind: "endpoint", segmentId: marker.segmentId, which: marker.id });
        }
        capturePointer(event);
        return;
      }
    }

    if (!point) return;

    // 相机 PATH：选中相机时，路径点 / 端点（屏幕命中）可拖拽；按住路径线拖动可加点。
    const selCamId = store.selectedKind === "camera" ? store.selectedId : store.activeCameraId;
    if (selCamId && !store.pathDrawMode) {
      const fovPx = (camera as THREE.PerspectiveCamera).fov || DIRECTOR_FOV;
      const focalPx = size.height / (2 * Math.tan((fovPx * Math.PI) / 360));
      const ptHit = hitCameraPathPointScreen(
        store.state,
        selCamId,
        event.ray,
        CAM_POINT_PICK_PX,
        focalPx,
      );
      if (ptHit) {
        store.selectCamera(selCamId);
        store.selectItem(ptHit.moveId);
        beginDrag({
          kind: "camerapoint",
          moveId: ptHit.moveId,
          pointId: ptHit.point.id,
          moved: false,
          origin: planePointAtHeight(event, ptHit.point.y) ?? point ?? { x: 0, z: 0 },
        });
        capturePointer(event);
        return;
      }
      const camMove = store.state.cameraMoves.find(
        (m) => m.camera === selCamId && m.type === "PATH" && (m.pathPoints?.length ?? 0) >= 2,
      );
      if (camMove) {
        const near = nearestOnCamPath(camMove.pathPoints ?? [], event.ray);
        if (near && near.distance < 0.45) {
          store.selectCamera(selCamId);
          store.selectItem(camMove.id);
          beginDrag({
            kind: "cameraNew",
            moveId: camMove.id,
            insertAt: near.insertAt,
            y: near.y,
            moved: false,
            origin: planePointAtHeight(event, near.y) ?? point ?? { x: 0, z: 0 },
            current: { x: near.x, z: near.z },
          });
          capturePointer(event);
          return;
        }
      }
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

    const cameraHit = hitCameraRay(store.state, store.currentTime, event.ray, 0.9 * tolerance);
    const objectHit = hitObjectRay(store.state, store.currentTime, event.ray, 0.7 * tolerance);

    if (cameraHit && (!objectHit || cameraHit.distance <= objectHit.distance)) {
      store.selectCamera(cameraHit.camera.id);
      return;
    }

    if (objectHit) {
      // 团队作为一个 unit：点任一队员都选中整队（整队配置由锚点 members[0] 承载），
      // 不提供个体选择——否则选中单个队员后，路线 / 编队仍属于整队，语义会打架。
      const hitTeam = (store.state.groups ?? []).find(
        (g) => g.dynamics && g.members.length >= 2 && g.members.includes(objectHit.object.id),
      );
      store.selectObject(hitTeam ? hitTeam.members[0] : objectHit.object.id);
      // 锁定对象 / 锁定整队：可点选（便于解锁），但不接管拖拽、也不挡相机轨道。
      if (objectHit.object.locked || hitTeam?.locked) return;
      store.selectItem(null);
      store.selectPoint(null);
      // 团队成员拖任一人都移动整队，所以位移快照取「真正会被移动的对象」= 锚点。
      const movingId = hitTeam ? hitTeam.members[0] : objectHit.object.id;
      const moving = store.state.objects.find((o) => o.id === movingId);
      const start = { x: moving?.x ?? objectHit.object.x, z: moving?.z ?? objectHit.object.z };
      beginDrag({
        kind: "object",
        id: objectHit.object.id,
        moved: false,
        // 按下点若不可信（近水平射线），退回对象自身位置，免得第一帧就产生巨大位移。
        origin: groundHitUsable(event, point) ? point : start,
        start,
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
    const store = useDirectorStore.getState();

    if (!drag) {
      // 空闲时维持悬停反馈：把手能不能被选中，得先让用户看得见（高亮 + 放大 + 光标变抓握）。
      // 手绘路径模式下不提示——那时画布上一切都归「画路径」，标记点了也不作数。
      const objectId = store.selectedKind === "object" ? store.selectedId : null;
      const next =
        objectId && !store.pathDrawMode ? markerUnder(event, store.state, objectId) : null;
      if (!sameMarker(next, store.hoverMarker)) store.setHoverMarker(next);
      return;
    }

    const point = groundPoint(event);
    if (!point) return;
    // 近水平射线给出的极远交点不能用来拖动（会把物体甩到画布外沿），丢弃这一帧。
    if (!groundHitUsable(event, point)) return;

    if (drag.kind === "object") {
      // 团队成员：拖任何一个都是整队平移（位置由锚点承载），保持"队作为一个 unit"。
      const team = (store.state.groups ?? []).find(
        (g) => g.dynamics && g.members.length >= 2 && g.members.includes(drag.id),
      );
      // 锁定对象 / 锁定整队，即使在拖拽中也绝不移动位置。
      const obj = store.state.objects.find((o) => o.id === drag.id);
      if (obj?.locked || team?.locked) return;
      if (Math.hypot(point.x - drag.origin.x, point.z - drag.origin.z) > 0.15) drag.moved = true;
      // 位移 = 按下时的快照 + 本次拖拽的累计位移（drag.start 见 beginDrag）。
      // 这里千万别读「当前 anchor 位置」再叠加位移：pointermove 每帧都会执行，
      // 那样会把之前每一帧的位移重复累加一遍，物体呈指数级加速飞出画布。
      const nx = drag.start.x + (point.x - drag.origin.x);
      const nz = drag.start.z + (point.z - drag.origin.z);
      store.moveObject(team && team.members[0] !== drag.id ? team.members[0] : drag.id, nx, nz);
    } else if (drag.kind === "point") {
      // 超过阈值才算「拖动」，抬手时不区分例外就不会误弹环形菜单。
      if (Math.hypot(point.x - drag.origin.x, point.z - drag.origin.z) > 0.15) drag.moved = true;
      store.movePathPoint(drag.segmentId, drag.pointId, point.x, point.z);
    } else if (drag.kind === "endpoint") {
      store.moveEndpoint(drag.segmentId, drag.which, point.x, point.z);
    } else if (drag.kind === "camerapoint") {
      // 只改 XZ，Y 保持把手原有高度；光标投到「把手所在高度的水平面」，把手才贴住光标。
      const mv = store.state.cameraMoves.find((m) => m.id === drag.moveId);
      const py = mv?.pathPoints?.find((p) => p.id === drag.pointId)?.y ?? 1.6;
      const onPlane = planePointAtHeight(event, py);
      const nx = onPlane ? onPlane.x : point.x;
      const nz = onPlane ? onPlane.z : point.z;
      if (Math.hypot(nx - drag.origin.x, nz - drag.origin.z) > 0.15) drag.moved = true;
      store.moveCameraPathPoint(drag.moveId, drag.pointId, nx, py, nz);
    } else if (drag.kind === "cameraNew") {
      // 在落点高度平面上跟随光标；拖动超过阈值才算「加点」，避免误触。
      const onPlane = planePointAtHeight(event, drag.y);
      const nx = onPlane ? onPlane.x : point.x;
      const nz = onPlane ? onPlane.z : point.z;
      if (Math.hypot(nx - drag.origin.x, nz - drag.origin.z) > 0.15) drag.moved = true;
      drag.current = { x: nx, z: nz };
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
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerOut={() => {
          // 空闲时移出地面要清掉悬停反馈；拖拽中保留，免得把手在拖动途中忽明忽暗。
          if (!dragRef.current) useDirectorStore.getState().setHoverMarker(null);
        }}
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

function PointRingAnchor({ pointId }: { pointId: string }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const { state } = useDirectorStore.getState();
    // 坐标写在所属 segment 的 points 上，每帧同步：播放或拖动后窗口不会掉在原地。
    for (const segment of state.segments) {
      const hit = (segment.points ?? []).find((p) => p.id === pointId);
      if (hit) {
        groupRef.current?.position.set(hit.x, 0, hit.z);
        return;
      }
    }
  });

  return (
    <group ref={groupRef}>
      <Html center style={{ pointerEvents: "auto" }} zIndexRange={[90, 0]}>
        <PointRadialRing pointId={pointId} />
      </Html>
    </group>
  );
}

function CameraPointRingAnchor({ pointId }: { pointId: string }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const { state } = useDirectorStore.getState();
    // 相机路径点带高度（y）：窗口挂在点的 3D 位置上，而非地面。
    for (const move of state.cameraMoves) {
      const hit = (move.pathPoints ?? []).find((p) => p.id === pointId);
      if (hit) {
        groupRef.current?.position.set(hit.x, hit.y, hit.z);
        return;
      }
    }
  });

  return (
    <group ref={groupRef}>
      <Html center style={{ pointerEvents: "auto" }} zIndexRange={[90, 0]}>
        <CameraPointRadialRing pointId={pointId} />
      </Html>
    </group>
  );
}

function RadialLayer() {
  const radialTarget = useDirectorStore((s) => s.radialTarget);
  const viewMode = useDirectorStore((s) => s.viewMode);
  if (!radialTarget || viewMode !== "director") return null;
  if (radialTarget.kind === "object") return <RingAnchor objectId={radialTarget.id} />;
  if (radialTarget.kind === "point") return <PointRingAnchor pointId={radialTarget.id} />;
  return <CameraPointRingAnchor pointId={radialTarget.id} />;
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
      <CameraPathHandles />
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
        {move?.targetType === "OTS" ? "OTS 过肩" : MOTION_LABELS[move?.type ?? camera.motion]}
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
  // 光标是否停在路径标记上（转折点 / 起终点把手）：命中与否由画布内的判定决定，
  // 这里只负责把它翻译成「抓握」光标与文字提示。只认当前选中对象的标记——
  // 换选中对象后旧悬停立即失效，不会留下一个抓握光标指向看不见的把手。
  const hoverMarker = useDirectorStore((s) => {
    const marker = s.hoverMarker;
    if (!marker || s.selectedKind !== "object" || !s.selectedId) return null;
    const segment = s.state.segments.find((item) => item.id === marker.segmentId);
    return segment && segment.object === s.selectedId ? marker : null;
  });
  const dragging = useDirectorStore((s) => s.dragging);
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
        className={`canvasWrap${pathDrawMode ? " is-drawing" : ""}${
          hoverMarker ? " is-handle" : ""
        }${hoverMarker && dragging ? " is-handle-drag" : ""}`}
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
          {/* 分段控件：Director / Camera 是同一枚开关的两档，滑块在其中滑动。 */}
          <div
            className={`vf-switch${viewMode === "camera" ? " is-camera" : ""}`}
            role="radiogroup"
            aria-label="View Mode"
          >
            <span className="vf-thumb" aria-hidden="true" />
            <button
              type="button"
              role="radio"
              aria-checked={viewMode === "director"}
              className={`vf-opt ${viewMode === "director" ? "active" : ""}`}
              onClick={() => setViewMode("director")}
              title="导演视角：自由观察全场、编辑路径"
            >
              Director
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={viewMode === "camera"}
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
                {pathDrawMode ? "✏️ 绘制中" : "✏️ Path"}
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
