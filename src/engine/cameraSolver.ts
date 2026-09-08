import {
  aspectValue,
  CameraFraming,
  CameraMove,
  CameraObject,
  CameraSide,
  CameraView,
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
  /** 段级覆盖（framing/view/side/lens），为空沿用 CameraObject 默认。 */
  framing?: CameraFraming;
  view?: CameraView;
  side?: CameraSide;
  lensMm?: number;
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
  const target = focusPoint(state, targetId, time);
  const facing = objectFacing(state, targetId, time);

  // 过肩镜头（OTS）：机位置于前景演员 A 的斜后方，越过其肩膀拍主体 B。
  // 两人各自移动时机位自动跟随，始终保持过肩关系（肩在前景一侧、不挡住主体）。
  const isOts = options.ots ?? camera.motion === "OTS";
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
      // 右向量 = cross(前向, up) 在 XZ 平面上的投影 → (-fz, 0, fx)
      const rx = -fz;
      const rz = fx;
      const sign: number = (options.otsSide ?? camera.otsSide ?? "R") === "R" ? 1 : -1;
      // 退到 A 身后的距离 / 横向拉开的距离都随两人间距自适应：
      // 贴得够近、偏得够开，前景才会被视差推到画面一侧，而不是糊在主体脸上。
      const back = Math.min(2.4, Math.max(0.95, distAB * 0.38));
      const lateral = Math.min(1.6, Math.max(0.8, distAB * 0.4)) * sign;
      const eye = 1.55; // 前景演员的肩 / 眼高
      const cx = a.x - fx * back + rx * lateral;
      const cz = a.z - fz * back + rz * lateral;

      // 错位构图：注视点朝「远离前景」的一侧横向偏开，把主体推到画面另一侧，
      // 前景因此只露出一部分肩膀——这正是过肩区别于「正对双人」的关键。
      const vx = b.x - cx;
      const vz = b.z - cz;
      const vLen = Math.hypot(vx, vz) || 1;
      // 视线右向量（XZ 平面），注视点沿它偏移。
      const rgx = -vz / vLen;
      const rgz = vx / vLen;
      const lens = options.lensMm ?? camera.lensMm;
      // 该距离上的画面半宽（由焦距与画幅决定），把「比例」换算成世界距离。
      const halfWidthTan =
        Math.tan((lensFovDeg(lens) * Math.PI) / 360) * aspectValue(state.aspectRatio);
      const offset = options.otsOffset ?? camera.otsOffset ?? 0.35;
      // 主体落在画面的 +sign 侧（与前景相反），故注视点朝 -sign 侧偏。
      const shift = -sign * offset * vLen * halfWidthTan;

      return {
        position: [cx, eye, cz],
        target: [b.x + rgx * shift, 1.55, b.z + rgz * shift],
      };
    }
  }

  const baseDistance = FRAMING_DISTANCE[framing] * (options.distanceScale ?? 1);
  const yaw = facing + ((SIDE_ANGLE[side] + (options.orbitDeg ?? 0)) * Math.PI) / 180;

  const droneLift = camera.kind === "drone" ? DRONE_BASE_ALTITUDE : 0;
  let horizontal = baseDistance;
  let height = VIEW_HEIGHT[view] + droneLift + (options.craneHeight ?? 0);
  if (view === "overhead") {
    horizontal = baseDistance * 0.3;
    height = baseDistance + 4 + droneLift + (options.craneHeight ?? 0);
  }

  const position: Vec3 = [
    target[0] + Math.sin(yaw) * horizontal,
    target[1] + height,
    target[2] + Math.cos(yaw) * horizontal,
  ];
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
    const { position, target } = placeCamera(state, camera, time, {});
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
