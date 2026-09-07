import {
  CameraFraming,
  CameraMove,
  CameraObject,
  CameraSide,
  CameraView,
  DirectorState,
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
  /** 命中该时刻的运镜片段。 */
  move?: CameraMove;
}

const FRAMING_DISTANCE: Record<CameraFraming, number> = {
  extreme_wide: 18,
  wide: 10,
  medium: 6,
  close_up: 3.2,
};

const VIEW_HEIGHT: Record<CameraView, number> = {
  ground: 0.35,
  low: 0.9,
  eye_level: 1.7,
  high: 4.5,
  overhead: 0,
};

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
  orbitDeg?: number;
  distanceScale?: number;
  craneHeight?: number;
}

function placeCamera(
  state: DirectorState,
  camera: CameraObject,
  time: number,
  options: Placement,
): { position: Vec3; target: Vec3 } {
  const targetId = options.targetId ?? camera.targetId;
  const target = focusPoint(state, targetId, time);
  const facing = objectFacing(state, targetId, time);

  const baseDistance = FRAMING_DISTANCE[camera.framing] * (options.distanceScale ?? 1);
  const yaw = facing + ((SIDE_ANGLE[camera.side] + (options.orbitDeg ?? 0)) * Math.PI) / 180;

  let horizontal = baseDistance;
  let height = VIEW_HEIGHT[camera.view] + (options.craneHeight ?? 0);
  if (camera.view === "overhead") {
    horizontal = baseDistance * 0.3;
    height = baseDistance + 4 + (options.craneHeight ?? 0);
  }

  const position: Vec3 = [
    target[0] + Math.sin(yaw) * horizontal,
    target[1] + height,
    target[2] + Math.cos(yaw) * horizontal,
  ];
  return { position, target };
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
  const fovDeg = lensFovDeg(camera.lensMm);

  if (!move) {
    const { position, target } = placeCamera(state, camera, time, {});
    return { position, target, lensMm: camera.lensMm, fovDeg };
  }

  if (move.type === "STATIC") {
    // 锁死机位：用片段开始时刻的构图，之后不再改变。
    const { position, target } = placeCamera(state, camera, move.timeStart, {
      targetId: move.targetId,
    });
    return { position, target, lensMm: camera.lensMm, fovDeg, move };
  }

  const span = move.timeEnd - move.timeStart || 1;
  const progress = easeVal(normalizeEase(move.ease), clamp((time - move.timeStart) / span, 0, 1));

  const { position, target } = placeCamera(state, camera, time, {
    targetId: move.targetId,
    orbitDeg: move.type === "ORBIT" ? move.orbitDeg * progress : 0,
    distanceScale: move.type === "DOLLY" ? 1 + (move.dollyScale - 1) * progress : 1,
    craneHeight: move.type === "CRANE" ? move.craneHeight * progress : 0,
  });

  return { position, target, lensMm: camera.lensMm, fovDeg, move };
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
