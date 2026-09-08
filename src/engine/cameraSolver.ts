import {
  aspectValue,
  CameraFraming,
  CameraMove,
  CameraObject,
  CameraSide,
  CameraView,
  DirectorObject,
  DirectorState,
  OtsSide,
  Vec3,
} from "../domain/schema";
import { easeVal, normalizeEase } from "./ease";
import { objectFacing, objectPosition } from "./solver";

export interface ResolvedCamera {
  position: Vec3;
  target: Vec3;
  lensMm: number;
  /** 基于 24mm 片门高度的垂直 FOV（画幅内）。 */
  fovDeg: number;
  /** 荷兰角：画面滚转角度（度），正值顺时针。 */
  roll: number;
  /** 命中该时刻的运镜片段。 */
  move?: CameraMove;
}

const FRAMING_DISTANCE: Record<CameraFraming, number> = {
  extreme_wide: 18,
  wide: 10,
  medium: 6,
  two_shot: 8.5,
  close_up: 3.2,
  extreme_close_up: 1.4,
};

const VIEW_HEIGHT: Record<CameraView, number> = {
  ground: 0.35,
  low: 0.9,
  // 胸高：略低于眼平（眼平 1.7 / 演员视线 1.55），是最常用的「自然电影感」跟拍高度。
  chest: 1.35,
  eye_level: 1.7,
  high: 4.5,
  overhead: 0,
};

/** 无人机平台相对基准机位叠加的基础飞行高度（米）。 */
const DRONE_BASE_ALTITUDE = 6;

/** 相对目标朝向的机位方位角：0 = 正前方，180 = 正后方。 */
const SIDE_ANGLE: Record<CameraSide, number> = {
  front: 0,
  front_3_4: 45,
  side: 90,
  back_3_4: 135,
  back: 180,
};

const SENSOR_HEIGHT_MM = 24;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function lensFovDeg(lensMm: number): number {
  return (2 * Math.atan(SENSOR_HEIGHT_MM / (2 * lensMm)) * 180) / Math.PI;
}

export function activeCameraMove(
  state: DirectorState,
  cameraId: string,
  time: number,
): CameraMove | undefined {
  // 各相机运镜段相互独立、互不重叠，因此覆盖当前时间的那一条即生效。
  return state.cameraMoves.find(
    (move) => move.camera === cameraId && time >= move.timeStart && time <= move.timeEnd,
  );
}

function focusPoint(state: DirectorState, targetId: string, time: number): Vec3 {
  const object = state.objects.find((item) => item.id === targetId);
  const position = objectPosition(state, targetId, time);
  const height = object?.type === "actor" ? 1.55 : 1;
  return [position.x, height, position.z];
}

/** 场景中心（所有对象的质心），供 LOCATION 固定环境机位作锚点。 */
function sceneCenter(state: DirectorState): Vec3 {
  if (!state.objects.length) return [0, 1.3, 0];
  const cx = state.objects.reduce((sum, object) => sum + object.x, 0) / state.objects.length;
  const cz = state.objects.reduce((sum, object) => sum + object.z, 0) / state.objects.length;
  return [cx, 1.3, cz];
}

interface Placement {
  targetId?: string;
  /** OTS：本段所越过的前景演员。 */
  shoulderId?: string;
  /** OTS：越过前景演员的哪一侧肩膀。 */
  otsSide?: OtsSide;
  /** OTS：错位量（主体偏离画面中心的比例）。 */
  otsOffset?: number;
  /** 是否按过肩求解（为空时沿用相机默认运镜是否为 OTS）。 */
  ots?: boolean;
  orbitDeg?: number;
  distanceScale?: number;
  craneHeight?: number;
  /** PAN：原地水平旋转角度（度）。 */
  panDeg?: number;
  /** TILT：原地俯仰角度（度）。 */
  tiltDeg?: number;
  /** TRUCK：横向平移距离（米，正负=左右）。 */
  truckDist?: number;
  /** HANDHELD：叠加手持微晃。 */
  handheld?: boolean;
  /** 段级覆盖（framing/view/side/lens），为空沿用 CameraObject 默认。 */
  framing?: CameraFraming;
  view?: CameraView;
  side?: CameraSide;
  lensMm?: number;
}

/** 基础机位：由「目标 + 方位 + 景别 + 绕飞/推拉/升降」反推（不含 PAN/TILT/TRUCK/HANDHELD）。 */
function placeStandard(
  state: DirectorState,
  camera: CameraObject,
  options: Placement,
  framing: CameraFraming,
  view: CameraView,
  side: CameraSide,
  target: Vec3,
  facing: number,
  droneLift: number,
  altitude: number,
): { position: Vec3; target: Vec3 } {
  const baseDistance = FRAMING_DISTANCE[framing] * (options.distanceScale ?? 1);
  const yaw = facing + ((SIDE_ANGLE[side] + (options.orbitDeg ?? 0)) * Math.PI) / 180;
  let horizontal = baseDistance;
  let height = VIEW_HEIGHT[view] + droneLift + altitude + (options.craneHeight ?? 0);
  if (view === "overhead") {
    horizontal = baseDistance * 0.3;
    height = baseDistance + 4 + droneLift + altitude + (options.craneHeight ?? 0);
  }
  const position: Vec3 = [
    target[0] + Math.sin(yaw) * horizontal,
    target[1] + height,
    target[2] + Math.cos(yaw) * horizontal,
  ];
  return { position, target };
}

function placeCamera(
  state: DirectorState,
  camera: CameraObject,
  time: number,
  options: Placement,
): { position: Vec3; target: Vec3 } {
  const targetId = options.targetId ?? camera.targetId;
  const framing = options.framing ?? camera.framing;
  const view = options.view ?? camera.view;
  const side = options.side ?? camera.side;
  const targetType = camera.targetType ?? "OBJECT";
  const droneLift = camera.kind === "drone" ? DRONE_BASE_ALTITUDE : 0;
  const altitude = camera.altitude ?? 0;

  let position: Vec3;
  let target: Vec3;

  // ---- 多参照取景：POV / GROUP ----
  // POV：机位 = 某角色的视线（眼高），看向其朝向正前方。
  if (targetType === "POV" && targetId) {
    const p = objectPosition(state, targetId, time);
    const yaw = (objectFacing(state, targetId, time) * Math.PI) / 180;
    const eye = 1.55;
    const look = 6;
    position = [p.x, eye, p.z];
    target = [p.x + Math.sin(yaw) * look, eye, p.z + Math.cos(yaw) * look];
  } else if (targetType === "GROUP" && camera.groupIds?.length) {
    // GROUP：框住一组对象（双人同框 / 群像）；机位锚到群体质心，距离按群体跨度自适应放大。
    const members = camera.groupIds
      .map((id) => state.objects.find((object) => object.id === id))
      .filter((object): object is DirectorObject => !!object)
      .map((object) => objectPosition(state, object.id, time));
    if (members.length) {
      const cx = members.reduce((sum, point) => sum + point.x, 0) / members.length;
      const cz = members.reduce((sum, point) => sum + point.z, 0) / members.length;
      const radius = Math.max(1, ...members.map((point) => Math.hypot(point.x - cx, point.z - cz)));
      const lens = options.lensMm ?? camera.lensMm;
      const vfov = (lensFovDeg(lens) * Math.PI) / 180;
      const hfovH = 2 * Math.atan(Math.tan(vfov / 2) * aspectValue(state.aspectRatio));
      const fitDist = (radius + 2) / Math.tan(hfovH / 2);
      const baseDistance = FRAMING_DISTANCE[framing] * (options.distanceScale ?? 1);
      const horizontal = Math.max(baseDistance, fitDist);
      const yaw = ((objectFacing(state, targetId, time) + SIDE_ANGLE[side]) * Math.PI) / 180;
      const groupTarget: Vec3 = [cx, 1.3, cz];
      if (view === "overhead") {
        const h = FRAMING_DISTANCE[framing] + 4 + droneLift + altitude + (options.craneHeight ?? 0);
        position = [cx, h, cz + 0.001];
        target = groupTarget;
      } else {
        const height = VIEW_HEIGHT[view] + droneLift + altitude + (options.craneHeight ?? 0);
        position = [
          groupTarget[0] + Math.sin(yaw) * horizontal,
          groupTarget[1] + height,
          groupTarget[2] + Math.cos(yaw) * horizontal,
        ];
        target = groupTarget;
      }
    } else {
      const t = focusPoint(state, targetId, time);
      const facing = objectFacing(state, targetId, time);
      ({ position, target } = placeStandard(
        state, camera, options, framing, view, side, t, facing, droneLift, altitude,
      ));
    }
  } else {
    const t = targetType === "LOCATION" ? sceneCenter(state) : focusPoint(state, targetId, time);
    const facing = targetType === "LOCATION" ? 0 : objectFacing(state, targetId, time);

    // 过肩镜头（OTS）：机位置于前景演员 A 的斜后方，越过其肩膀拍主体 B。
    // 两人各自移动时机位自动跟随，始终保持过肩关系（肩在前景一侧、不挡住主体）。
    const isOts = options.ots ?? (camera.targetType === "OTS" || camera.motion === "OTS");
    const shoulderId = options.shoulderId ?? camera.shoulderId;
    if (isOts && shoulderId && targetId && shoulderId !== targetId) {
      const a = objectPosition(state, shoulderId, time);
      const b = objectPosition(state, targetId, time);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distAB = Math.hypot(dx, dz);
      if (distAB > 1e-3) {
        const fx = dx / distAB;
        const fz = dz / distAB;
        const rx = -fz;
        const rz = fx;
        const sign: number = (options.otsSide ?? camera.otsSide ?? "R") === "R" ? 1 : -1;
        const back = Math.min(2.4, Math.max(0.95, distAB * 0.38));
        const lateral = Math.min(1.6, Math.max(0.8, distAB * 0.4)) * sign;
        const eye = 1.55;
        const cx = a.x - fx * back + rx * lateral;
        const cz = a.z - fz * back + rz * lateral;

        const vx = b.x - cx;
        const vz = b.z - cz;
        const vLen = Math.hypot(vx, vz) || 1;
        const rgx = -vz / vLen;
        const rgz = vx / vLen;
        const lens = options.lensMm ?? camera.lensMm;
        const halfWidthTan =
          Math.tan((lensFovDeg(lens) * Math.PI) / 360) * aspectValue(state.aspectRatio);
        const offset = options.otsOffset ?? camera.otsOffset ?? 0.35;
        const shift = -sign * offset * vLen * halfWidthTan;

        position = [cx, eye, cz];
        target = [b.x + rgx * shift, 1.55, b.z + rgz * shift];
      } else {
        ({ position, target } = placeStandard(
          state, camera, options, framing, view, side, t, facing, droneLift, altitude,
        ));
      }
    } else {
      ({ position, target } = placeStandard(
        state, camera, options, framing, view, side, t, facing, droneLift, altitude,
      ));
    }
  }

  // ---- PAN / TILT / TRUCK：原地旋转 / 横移（相对基础机位）----
  const panDeg = options.panDeg ?? camera.panDeg ?? 0;
  const tiltDeg = options.tiltDeg ?? camera.tiltDeg ?? 0;
  const truckDist = options.truckDist ?? camera.truckDist ?? 0;
  if (panDeg || tiltDeg) {
    const ox = position[0];
    const oy = position[1];
    const oz = position[2];
    let dx = target[0] - ox;
    let dy = target[1] - oy;
    let dz = target[2] - oz;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist;
    dy /= dist;
    dz /= dist;
    if (panDeg) {
      const a = (panDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const nx = dx * c + dz * s;
      const nz = -dx * s + dz * c;
      dx = nx;
      dz = nz;
    }
    if (tiltDeg) {
      const a = (tiltDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = -dz;
      const ry = 0;
      const rz = dx;
      dx = dx * c + rx * s;
      dy = dy * c + ry * s;
      dz = dz * c + rz * s;
    }
    target = [ox + dx * dist, oy + dy * dist, oz + dz * dist];
  }
  if (truckDist) {
    // 沿视线右向量平行横移机位与目标，保持相对几何（= 轨道横移）。
    let fdx = target[0] - position[0];
    let fdz = target[2] - position[2];
    const fl = Math.hypot(fdx, fdz) || 1;
    fdx /= fl;
    fdz /= fl;
    const rx = -fdz;
    const rz = fdx;
    position = [position[0] + rx * truckDist, position[1], position[2] + rz * truckDist];
    target = [target[0] + rx * truckDist, target[1], target[2] + rz * truckDist];
  }

  // ---- HANDHELD：手持微晃（叠加细微正弦抖动）----
  const isHandheld = options.handheld ?? camera.motion === "HANDHELD";
  if (isHandheld) {
    const jx = Math.sin(time * 7.3) * 0.06 + Math.sin(time * 3.1) * 0.04;
    const jy = Math.sin(time * 5.7 + 1.3) * 0.05;
    const jz = Math.cos(time * 6.1) * 0.06 + Math.sin(time * 2.7) * 0.03;
    position = [position[0] + jx, position[1] + jy, position[2] + jz];
  }

  return { position, target };
}

/** 解析单条 CameraMove 在某时刻的机位（不含边界插值）。 */
function resolveMove(
  state: DirectorState,
  camera: CameraObject,
  move: CameraMove,
  time: number,
): ResolvedCamera {
  const baseLens = move.lensMm ?? camera.lensMm;
  const roll = move.roll ?? camera.roll ?? 0;
  // OTS 更像「人物关系」而非单纯运动：本段显式越肩（类型为 OTS 或指定了前景演员）时启用，
  // 否则沿用相机默认是否为过肩——避免给过肩相机加一条 FOLLOW 段就丢掉过肩关系。
  const otsWanted = move.type === "OTS" || !!move.shoulderId ? true : undefined;

  if (move.type === "STATIC") {
    // 锁死机位：用片段开始时刻的构图，之后不再改变。
    const { position, target } = placeCamera(state, camera, move.timeStart, {
      targetId: move.targetId,
      shoulderId: move.shoulderId,
      otsSide: move.otsSide,
      otsOffset: move.otsOffset,
      ots: otsWanted,
      framing: move.framing,
      view: move.view,
      side: move.side,
      lensMm: move.lensMm,
    });
    return { position, target, lensMm: baseLens, fovDeg: lensFovDeg(baseLens), roll, move };
  }

  const span = move.timeEnd - move.timeStart || 1;
  const progress = easeVal(normalizeEase(move.ease), clamp((time - move.timeStart) / span, 0, 1));

  // 滑动变焦：机位推近的同时焦距等比变化，使主体成像大小不变、只有背景透视发生畸变。
  const isZoom = move.type === "DOLLY_ZOOM";
  const dollyNow =
    move.type === "DOLLY" || isZoom || move.type === "DRONE"
      ? 1 + (move.dollyScale - 1) * progress
      : 1;
  const lensMm = isZoom ? baseLens * dollyNow : baseLens;

  const { position, target } = placeCamera(state, camera, time, {
    targetId: move.targetId,
    shoulderId: move.shoulderId,
    otsSide: move.otsSide,
    otsOffset: move.otsOffset,
    ots: otsWanted,
    framing: move.framing,
    view: move.view,
    side: move.side,
    lensMm: move.lensMm,
    orbitDeg: move.type === "ORBIT" || move.type === "DRONE" ? move.orbitDeg * progress : 0,
    distanceScale: dollyNow,
    craneHeight: move.type === "CRANE" || move.type === "DRONE" ? move.craneHeight * progress : 0,
    panDeg: move.type === "PAN" ? (move.panDeg ?? 0) * progress : 0,
    tiltDeg: move.type === "TILT" ? (move.tiltDeg ?? 0) * progress : 0,
    truckDist: move.type === "TRUCK" ? (move.truckDist ?? 0) * progress : 0,
    handheld: move.type === "HANDHELD",
  });

  return { position, target, lensMm, fovDeg: lensFovDeg(lensMm), roll, move };
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 解析某台相机在某一时刻的实际机位。 */
export function solveCamera(
  state: DirectorState,
  cameraId: string,
  time: number,
): ResolvedCamera | null {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return null;

  const move = activeCameraMove(state, cameraId, time);
  if (!move) {
    const { position, target } = placeCamera(state, camera, time, {
      handheld: camera.motion === "HANDHELD",
    });
    return {
      position,
      target,
      lensMm: camera.lensMm,
      fovDeg: lensFovDeg(camera.lensMm),
      roll: camera.roll ?? 0,
    };
  }

  const base = resolveMove(state, camera, move, time);

  // 一镜到底：smooth 模式下，在 CameraMove 边界处把前后两段机位插值，避免硬切跳变。
  const junction = state.cameraJunctions.find(
    (j) => j.prevMove === move.id || j.nextMove === move.id,
  );
  if (junction && junction.mode === "smooth") {
    const prevMove = state.cameraMoves.find((m) => m.id === junction.prevMove);
    const nextMove = state.cameraMoves.find((m) => m.id === junction.nextMove);
    if (prevMove && nextMove) {
      const tb = prevMove.timeEnd;
      const w = Math.min(
        0.5,
        Math.max(0.15, Math.min(prevMove.timeEnd - prevMove.timeStart, nextMove.timeEnd - nextMove.timeStart) / 4),
      );
      if (time >= tb - w && time <= tb + w) {
        const f = clamp((time - (tb - w)) / (2 * w), 0, 1);
        const before = resolveMove(state, camera, prevMove, tb - w);
        const after = resolveMove(state, camera, nextMove, tb + w);
        return {
          position: lerp3(before.position, after.position, f),
          target: lerp3(before.target, after.target, f),
          lensMm: before.lensMm + (after.lensMm - before.lensMm) * f,
          fovDeg: before.fovDeg + (after.fovDeg - before.fovDeg) * f,
          roll: before.roll + (after.roll - before.roll) * f,
          move,
        };
      }
    }
  }

  return base;
}

/** 采样一台相机整段时间的机位轨迹，用于 Director View 可视化运镜。 */
export function sampleCameraPath(
  state: DirectorState,
  cameraId: string,
  step = 0.25,
): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  for (let time = 0; time <= state.duration + 1e-6; time += step) {
    const resolved = solveCamera(state, cameraId, time);
    if (resolved) points.push(resolved.position);
  }
  return points;
}

/** 计算画幅在给定容器中的信箱/立柱区域。 */
export function computeFrame(
  aspect: number,
  width: number,
  height: number,
): { width: number; height: number; left: number; top: number } {
  let frameWidth = width;
  let frameHeight = width / aspect;
  if (frameHeight > height) {
    frameHeight = height;
    frameWidth = height * aspect;
  }
  return {
    width: frameWidth,
    height: frameHeight,
    left: (width - frameWidth) / 2,
    top: (height - frameHeight) / 2,
  };
}
