import {
  aspectValue,
  CameraFraming,
  CameraKey,
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
import {
  CAMERA_CHANNELS,
  CameraChannel,
  ChannelPoint,
  channelVal,
  curveVal,
  normalizeEase,
} from "./ease";
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
  // 段级 targetType 覆盖必须参与分支判定，否则「某段单独设成 GROUP / POV」会被相机级类型盖掉。
  const targetType = options.targetType ?? camera.targetType ?? "OBJECT";
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
      // orbitDeg 与 OBJECT 分支一致地叠加到 yaw 上，否则整队目标无法环绕（关键帧「环绕」/原生 ORBIT 都会失效）。
      const yaw = facing + ((SIDE_ANGLE[side] + (options.orbitDeg ?? 0)) * Math.PI) / 180;
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
      // 绕相机「右轴」做真正的俯仰：右轴 = normalize(d × up)，与 d 正交且单位化，
      // 旋转用 Rodrigues（k⊥d 时 d' = d·cos + (k×d)·sin），保证视线长度不变、只改俯仰。
      // 旧实现直接用未归一化的右向量做仿射：水平视线时会退化成偏航（与 pan 混淆），
      // 且会压缩视线长度（顺带改了距离）。
      const a = (tiltDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const h = Math.hypot(dx, dz);
      if (h > 1e-4) {
        const crossX = (-dx * dy) / h; // (k × d).x
        const crossY = h; // (k × d).y
        const crossZ = (-dz * dy) / h; // (k × d).z
        const nx = dx * c + crossX * s;
        const ny = dy * c + crossY * s;
        const nz = dz * c + crossZ * s;
        dx = nx;
        dy = ny;
        dz = nz;
      }
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

/* ---------------------------------------------------- 运镜通道 / 关键帧求值 */

/** 一条运镜在某时刻的九个可定制通道（关键帧缺省的通道由运镜基元给出）。 */
export interface MoveChannels {
  orbitDeg: number;
  craneHeight: number;
  dollyScale: number;
  panDeg: number;
  tiltDeg: number;
  truckDist: number;
  lensMm: number;
  roll: number;
  otsOffset: number;
}

/** 运镜基元在归一化进度 progress 上的默认通道值（= 没有关键帧时的行为）。 */
function primitiveChannels(move: CameraMove, camera: CameraObject, progress: number): MoveChannels {
  const baseLens = move.lensMm ?? camera.lensMm;
  // 滑动变焦：机位推近的同时焦距等比变化，使主体成像大小不变、只有背景透视发生畸变。
  const isZoom = move.type === "DOLLY_ZOOM";
  const dollyNow =
    move.type === "DOLLY" || isZoom || move.type === "DRONE" ? 1 + (move.dollyScale - 1) * progress : 1;
  return {
    orbitDeg: move.type === "ORBIT" || move.type === "DRONE" ? move.orbitDeg * progress : 0,
    craneHeight: move.type === "CRANE" || move.type === "DRONE" ? move.craneHeight * progress : 0,
    dollyScale: dollyNow,
    panDeg: move.type === "PAN" ? (move.panDeg ?? 0) * progress : 0,
    tiltDeg: move.type === "TILT" ? (move.tiltDeg ?? 0) * progress : 0,
    truckDist: move.type === "TRUCK" ? (move.truckDist ?? 0) * progress : 0,
    lensMm: isZoom ? baseLens * dollyNow : baseLens,
    roll: move.roll ?? camera.roll ?? 0,
    otsOffset: move.otsOffset ?? camera.otsOffset ?? 0.35,
  };
}

/**
 * 把关键帧按通道摊平成「每通道一条曲线」。未定义该通道的帧被跳过。
 *
 * 关键：若某通道的第一个关键帧不在段首，会自动在 t=0 **锚定该通道的基元原值**。
 * 于是「只在中间加一帧」不会把整段（含帧之前）都变成新值，
 * 而是从段首的原值线性过渡到该帧的新值，之后再保持（末帧之后可再加帧打断）。
 */
function buildChannelTracks(move: CameraMove, camera: CameraObject): Map<CameraChannel, ChannelPoint[]> {
  const tracks = new Map<CameraChannel, ChannelPoint[]>();
  const keys = move.keys;
  if (!keys || !keys.length) return tracks;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const startPrimitive = primitiveChannels(move, camera, 0);
  for (const channel of CAMERA_CHANNELS) {
    const points: ChannelPoint[] = [];
    for (const key of sorted) {
      const value = key[channel];
      if (typeof value === "number" && Number.isFinite(value)) {
        points.push({ t: key.t, v: value, ease: normalizeEase(key.ease) });
      }
    }
    if (!points.length) continue;
    if (points[0].t > 1e-4) {
      points.unshift({ t: 0, v: startPrimitive[channel], ease: normalizeEase(move.ease) });
    }
    tracks.set(channel, points);
  }
  return tracks;
}

/** 取某通道在归一化时刻 u 的关键帧值；该通道无关键帧则返回 undefined（回落到基元）。 */
function keyedChannel(
  tracks: Map<CameraChannel, ChannelPoint[]>,
  channel: CameraChannel,
  u: number,
): number | undefined {
  const points = tracks.get(channel);
  return points ? channelVal(points, u) : undefined;
}

/**
 * 求某条运镜在某一时刻**实际生效**的通道值（关键帧 > 基元）。
 * 供「插入关键帧时快照当前轨迹」使用，保证插帧不改变画面。
 */
export function moveChannelsAt(
  state: DirectorState,
  cameraId: string,
  move: CameraMove,
  time: number,
): MoveChannels | null {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return null;
  const span = move.timeEnd - move.timeStart || 1;
  const u = clamp((time - move.timeStart) / span, 0, 1);
  const progress = curveVal(normalizeEase(move.ease), move.speedKeys, u);
  const base = primitiveChannels(move, camera, progress);
  const tracks = buildChannelTracks(move, camera);
  const pick = (channel: CameraChannel) => keyedChannel(tracks, channel, u) ?? base[channel];
  return {
    orbitDeg: pick("orbitDeg"),
    craneHeight: pick("craneHeight"),
    dollyScale: pick("dollyScale"),
    panDeg: pick("panDeg"),
    tiltDeg: pick("tiltDeg"),
    truckDist: pick("truckDist"),
    lensMm: pick("lensMm"),
    roll: pick("roll"),
    otsOffset: pick("otsOffset"),
  };
}

/** 解析单条 CameraMove 在某时刻的机位（不含边界插值）。 */
function resolveMove(
  state: DirectorState,
  camera: CameraObject,
  move: CameraMove,
  time: number,
): ResolvedCamera {
  const style = move.style ?? camera.style ?? (camera.motion === "HANDHELD" ? "handheld" : "locked");
  const sp = shakePreset(camera, style);
  const hasKeys = !!move.keys && move.keys.length > 0;

  if (move.type === "STATIC" && !hasKeys) {
    // 锁死机位：用片段开始时刻的构图，之后不再改变。（打了关键帧则按关键帧动。）
    const base = primitiveChannels(move, camera, 0);
    const { position, target } = placeCamera(state, camera, move.timeStart, {
      targetId: move.targetId,
      targetType: move.targetType,
      shoulderId: move.shoulderId,
      otsSide: move.otsSide,
      otsOffset: base.otsOffset,
      framing: move.framing,
      view: move.view,
      side: move.side,
      lensMm: move.lensMm,
      style,
    });
    return {
      position,
      target,
      lensMm: base.lensMm,
      fovDeg: lensFovDeg(base.lensMm),
      roll: base.roll + styleRollDrift(sp, move.timeStart),
      move,
    };
  }

  const span = move.timeEnd - move.timeStart || 1;
  const u = clamp((time - move.timeStart) / span, 0, 1);
  const progress = curveVal(normalizeEase(move.ease), move.speedKeys, u);

  // 通道 = 关键帧覆盖 ?? 运镜基元：未打帧的通道完全保持原行为，打帧的通道走关键帧曲线。
  const base = primitiveChannels(move, camera, progress);
  const tracks = buildChannelTracks(move, camera);
  const pick = (channel: CameraChannel) => keyedChannel(tracks, channel, u) ?? base[channel];
  const keyedLens = keyedChannel(tracks, "lensMm", u);
  const outLens = keyedLens ?? base.lensMm;

  const { position, target } = placeCamera(state, camera, time, {
    targetId: move.targetId,
    targetType: move.targetType,
    shoulderId: move.shoulderId,
    otsSide: move.otsSide,
    otsOffset: pick("otsOffset"),
    framing: move.framing,
    view: move.view,
    side: move.side,
    // 打帧的焦距同时作用于取景几何；未打帧时沿用原值（保持 DOLLY_ZOOM 的距离补偿不被改写）。
    lensMm: keyedLens ?? move.lensMm,
    orbitDeg: pick("orbitDeg"),
    distanceScale: pick("dollyScale"),
    craneHeight: pick("craneHeight"),
    panDeg: pick("panDeg"),
    tiltDeg: pick("tiltDeg"),
    truckDist: pick("truckDist"),
    style,
  });

  return {
    position,
    target,
    lensMm: outLens,
    fovDeg: lensFovDeg(outLens),
    roll: pick("roll") + styleRollDrift(sp, time),
    move,
  };
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 解析某台相机在某一时刻的原始机位（不含防抖低通）。
 * 保留为纯函数、可随机访问，供 solveCamera 的防抖采样在任意历史时刻复用。
 */
function solveCameraRaw(
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

/* -------------------------------------------------------------- 防抖 Stabilization */

/** 防抖最强档对应的滞后时间窗（秒）。0 档 = 关闭，越大越「拖」。 */
const STABILIZE_MAX_WINDOW = 0.5;
/** 时间窗内采样步长（秒）与采样数上限：步长越细越平滑，但每帧要多次求解原始机位。 */
const STABILIZE_SAMPLE_STEP = 0.05;
const STABILIZE_MAX_SAMPLES = 14;

/**
 * 解析某台相机在某一时刻的实际机位（含防抖）。
 *
 * 防抖 = 对「过去一小段时间窗」内的原始机位 / 注视点做滑动平均（按需重算、可确定性复算，无逐帧状态）：
 * - 相机响应因此滞后一点点，目标快速扭动 / 绕障让位带来的瞬变被平滑掉；
 * - 瞬变若在窗口内自行消失，其扰动会被平均抵消，相机基本不跟着动 —— 类似软件电子防抖；
 * - 窗口下界钳到当前运镜段起点，绝不把上一镜的姿态混进来，避免破坏刻意的硬切。
 *
 * 强度取「段级覆盖 > 相机默认」，两者都为 0（或未设）时等价于原始机位。
 */
export function solveCamera(
  state: DirectorState,
  cameraId: string,
  time: number,
): ResolvedCamera | null {
  const raw = solveCameraRaw(state, cameraId, time);
  if (!raw) return null;

  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return raw;
  const move = activeCameraMove(state, cameraId, time);
  const strength = clamp(move?.stabilize ?? camera.stabilize ?? 0, 0, 1);
  if (strength <= 0) return raw;

  const window = strength * STABILIZE_MAX_WINDOW;
  // 不跨越运镜 / 切镜边界采样：下界钳到当前段起点（无段则为 0）。
  const lo = Math.max(move ? move.timeStart : 0, time - window);
  const span = time - lo;
  if (span < 1e-3) return raw;

  const samples = Math.max(
    2,
    Math.min(STABILIZE_MAX_SAMPLES, Math.round(span / STABILIZE_SAMPLE_STEP) + 1),
  );
  let px = 0;
  let py = 0;
  let pz = 0;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  let count = 0;
  for (let i = 0; i < samples; i += 1) {
    const tk = lo + (span * i) / (samples - 1);
    const r = solveCameraRaw(state, cameraId, tk);
    if (!r) continue;
    px += r.position[0];
    py += r.position[1];
    pz += r.position[2];
    tx += r.target[0];
    ty += r.target[1];
    tz += r.target[2];
    count += 1;
  }
  if (!count) return raw;
  return {
    position: [px / count, py / count, pz / count],
    target: [tx / count, ty / count, tz / count],
    // 镜头 / 滚转沿用当前时刻：变焦与荷兰角是刻意的运镜表达，不该被防抖拖慢。
    lensMm: raw.lensMm,
    fovDeg: raw.fovDeg,
    roll: raw.roll,
    move: raw.move,
  };
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
