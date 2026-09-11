import {
  aspectValue,
  CameraFraming,
  CameraMove,
  CameraObject,
  CameraSide,
  CameraView,
  DirectorObject,
  DirectorState,
  CameraStyle,
  OtsSide,
  CameraTargetType,
  STYLE_PRESETS,
  StyleParams,
  Vec3,
} from "../domain/schema";
import { curveVal, normalizeEase } from "./ease";
import { baseHeading, objectFacing, objectPosition, travelHeading } from "./solver";

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

// 取景距离只由「景别」决定，与镜头焦距无关：换镜头即真实变焦——长焦主体变大、背景压缩，
// 广角主体变小、容纳更多环境，符合摄影直觉。只有 DOLLY_ZOOM 段会用 distanceScale 同步补偿
// 距离（镜头拉长 + 距离拉远），从而「主体大小不变、只变透视」，实现希区柯克式变焦。
function framingDistance(framing: CameraFraming, distanceScale = 1): number {
  return FRAMING_DISTANCE[framing] * distanceScale;
}

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

/** 解析当前生效的稳定方式（风格轴）：段级覆盖 > 相机默认 > 旧场景 motion:"HANDHELD" 兼容 > 默认锁定。 */
function styleOf(camera: CameraObject, options: Placement): CameraStyle {
  return options.style ?? camera.style ?? (camera.motion === "HANDHELD" ? "handheld" : "locked");
}

/** 无人机机位自带云台增稳，稳定方式恒为「无抖动」，忽略 style 选择（避免「无人机 + 手持」矛盾组合）。 */
function shakePreset(camera: CameraObject, style: CameraStyle): StyleParams {
  return camera.kind === "drone" ? STYLE_PRESETS.locked : STYLE_PRESETS[style];
}

/** 风格轴带来的滚转漂移（度），叠加到相机 roll 上（位置抖动在 placeCamera 内处理）。 */
function styleRollDrift(sp: StyleParams, time: number): number {
  return sp.rollDrift ? Math.sin(time * (sp.rollFreq + 0.7) + 0.5) * sp.rollDrift : 0;
}

interface Placement {
  targetId?: string;
  /** OTS：本段所越过的前景演员。 */
  shoulderId?: string;
  /** OTS：越过前景演员的哪一侧肩膀。 */
  otsSide?: OtsSide;
  /** OTS：错位量（主体偏离画面中心的比例）。 */
  otsOffset?: number;
  /** 取景关系（为空则沿用相机级 targetType）；为 OTS 时启用过肩。 */
  targetType?: CameraTargetType;
  orbitDeg?: number;
  distanceScale?: number;
  craneHeight?: number;
  /** PAN：原地水平旋转角度（度）。 */
  panDeg?: number;
  /** TILT：原地俯仰角度（度）。 */
  tiltDeg?: number;
  /** TRUCK：横向平移距离（米，正负=左右）。 */
  truckDist?: number;
  /** 风格轴：稳定方式覆盖（为空沿用相机默认）。 */
  style?: CameraStyle;
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
  const baseDistance = framingDistance(framing, options.distanceScale ?? 1);
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
  } else if (targetType === "GROUP") {
    // GROUP：框住一组对象（双人同框 / 群像）；机位锚到群体质心，距离按群体跨度自适应放大。
    // 优先用 camera.groupId 直接引用一个组（成员实时参与取景），否则用 camera.groupIds。
    const groupMemberIds = camera.groupId
      ? (state.groups ?? []).find((g) => g.id === camera.groupId)?.members ?? []
      : (camera.groupIds ?? []);
    const members = groupMemberIds
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
      const baseDistance = framingDistance(framing, options.distanceScale ?? 1);
      const horizontal = Math.max(baseDistance, fitDist);
      // 队伍朝向用锚点（members[0]）的行进方向，而非 targetId（可能是组 id，非对象）。
      const anchorId = groupMemberIds[0];
      const facing =
        anchorId && state.objects.some((o) => o.id === anchorId)
          ? baseHeading(state, anchorId, time)
          : objectFacing(state, targetId, time);
      // facing 是弧度、SIDE_ANGLE 是角度，必须各自换算后再相加（不可整体当角度换算）。
      const yaw = facing + (SIDE_ANGLE[side] * Math.PI) / 180;
      const groupTarget: Vec3 = [cx, 1.3, cz];
      if (view === "overhead") {
        const h = framingDistance(framing) + 4 + droneLift + altitude + (options.craneHeight ?? 0);
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
      // 取景朝向用「行进方向」而非瞬时朝向：后者含编队弹簧 / 绕障让位，会带着镜头乱转。
      const facing = travelHeading(state, targetId, time);
      ({ position, target } = placeStandard(
        state, camera, options, framing, view, side, t, facing, droneLift, altitude,
      ));
    }
  } else {
    const t = targetType === "LOCATION" ? sceneCenter(state) : focusPoint(state, targetId, time);
    // 同上：整队方向没变时，绕障的横向让位不该让机位转向。
    const facing = targetType === "LOCATION" ? 0 : travelHeading(state, targetId, time);

    // 过肩镜头（OTS）：机位置于前景演员 A 的斜后方，越过其肩膀拍主体 B。
    // 两人各自移动时机位自动跟随，始终保持过肩关系（肩在前景一侧、不挡住主体）。
    const shoulderId = options.shoulderId ?? camera.shoulderId;
    const effTargetType = options.targetType ?? camera.targetType;
    const isOts =
      effTargetType === "OTS" && !!shoulderId && !!targetId && shoulderId !== targetId;
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
        // 横向偏移决定肩在画面里的左右位置；过大会把肩推出画框（50mm 水平半视场约 23°，
        // 旧值 distAB*0.4 让肩偏轴 ~46° 而完全出框）。这里压到 ~0.16 倍间距，
        // 使肩稳定落在画框边缘（约 16° 偏轴），既可见又不挡主体。
        const lateral = Math.min(0.9, Math.max(0.4, distAB * 0.16)) * sign;
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

  // ---- 风格轴（Style）：稳定方式 / 手持设备质感 ----
  // 与 motion 正交：motion 是「怎么动」，style 是「什么质感」。locked/drone 无抖动；
  // gimbal 极轻漂浮；handheld 有机微晃 + 滚转漂移；vlog 走拍 bob。滚转漂移在
  // solveCamera/resolveMove 里叠加到 roll，这里只处理位置抖动。
  const style = styleOf(camera, options);
  const sp = shakePreset(camera, style);
  if (sp.shakeAmp > 0 || sp.bobAmp > 0) {
    const a = sp.shakeAmp;
    const jx = Math.sin(time * (sp.shakeFreq + 1.3)) * a + Math.sin(time * (sp.shakeFreq * 0.42 + 3.1)) * a * 0.6;
    const jy = Math.sin(time * (sp.bobFreq + 1.3)) * sp.bobAmp + Math.sin(time * (sp.bobFreq * 0.4)) * sp.bobAmp * 0.4;
    const jz = Math.cos(time * (sp.shakeFreq + 1.4)) * a + Math.sin(time * (sp.shakeFreq * 0.4 + 2.7)) * a * 0.5;
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
  const style = move.style ?? camera.style ?? (camera.motion === "HANDHELD" ? "handheld" : "locked");
  const sp = shakePreset(camera, style);

  if (move.type === "STATIC") {
    // 锁死机位：用片段开始时刻的构图，之后不再改变。
    const { position, target } = placeCamera(state, camera, move.timeStart, {
      targetId: move.targetId,
      targetType: move.targetType,
      shoulderId: move.shoulderId,
      otsSide: move.otsSide,
      otsOffset: move.otsOffset,
      framing: move.framing,
      view: move.view,
      side: move.side,
      lensMm: move.lensMm,
      style,
    });
    return { position, target, lensMm: baseLens, fovDeg: lensFovDeg(baseLens), roll: roll + styleRollDrift(sp, move.timeStart), move };
  }

  const span = move.timeEnd - move.timeStart || 1;
  const progress = curveVal(normalizeEase(move.ease), move.speedKeys, clamp((time - move.timeStart) / span, 0, 1));

  // 滑动变焦：机位推近的同时焦距等比变化，使主体成像大小不变、只有背景透视发生畸变。
  const isZoom = move.type === "DOLLY_ZOOM";
  const dollyNow =
    move.type === "DOLLY" || isZoom || move.type === "DRONE"
      ? 1 + (move.dollyScale - 1) * progress
      : 1;
  const lensMm = isZoom ? baseLens * dollyNow : baseLens;

  const { position, target } = placeCamera(state, camera, time, {
    targetId: move.targetId,
    targetType: move.targetType,
    shoulderId: move.shoulderId,
    otsSide: move.otsSide,
    otsOffset: move.otsOffset,
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
    style,
  });

  return { position, target, lensMm, fovDeg: lensFovDeg(lensMm), roll: roll + styleRollDrift(sp, time), move };
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
    const style = camera.style ?? (camera.motion === "HANDHELD" ? "handheld" : "locked");
    const { position, target } = placeCamera(state, camera, time, { style });
    return {
      position,
      target,
      lensMm: camera.lensMm,
      fovDeg: lensFovDeg(camera.lensMm),
      roll: (camera.roll ?? 0) + styleRollDrift(shakePreset(camera, style), time),
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
