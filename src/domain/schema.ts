export type ObjectKind = "actor" | "landmark" | "prop";

export type PathPointShape = "LINE" | "ARC";

/** cubic-bezier(x1, y1, x2, y2) — 与 CSS 缓动一致。 */
export type EaseCurve = [number, number, number, number];

export interface Vec2 {
  x: number;
  z: number;
}

export type Vec3 = [number, number, number];

/**
 * Director World 中的对象。V1 使用平面世界（WORLD MODE = PLANAR），
 * 因此对象只保存 x / z，高度由 Proxy 语义决定。
 */
export interface DirectorObject {
  id: string;
  type: ObjectKind;
  x: number;
  z: number;
  color: string;
}

/** Path Point = 路径控制点。ARC 点是控制点，路径不一定穿过它。 */
export interface PathPoint {
  id: string;
  type: "path";
  shape: PathPointShape;
  x: number;
  z: number;
}

/**
 * MOVE Segment = When + How to travel。
 * Segment 是唯一的时间/空间运动来源（Single Source）。
 */
export interface MoveSegment {
  id: string;
  type: "MOVE";
  object: string;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  points: PathPoint[];
  timeStart: number;
  timeEnd: number;
  ease: EaseCurve;
}

export type ConstraintType = "FOLLOW" | "LOOK_AT";

/** Constraint = 持续的导演意图（不是一次性 Action）。 */
export interface Constraint {
  id: string;
  type: ConstraintType;
  subject: string;
  target: string;
  timeStart: number;
  timeEnd: number;
}

/* ------------------------------------------------------------- Camera */

/** 导演语言，不直接映射成固定 Lens。 */
export type CameraFraming = "extreme_wide" | "wide" | "medium" | "close_up";

export type CameraView = "eye_level" | "low" | "high" | "ground" | "overhead";

export type CameraSide = "front" | "front_3_4" | "side" | "back_3_4" | "back";

export type CameraMotionType = "STATIC" | "FOLLOW" | "ORBIT" | "DOLLY" | "CRANE";

/** Camera 是真正的独立 3D Object：FRAMING / VIEW / LENS / MOTION / TARGET。 */
export interface CameraObject {
  id: string;
  name: string;
  color: string;
  targetId: string;
  framing: CameraFraming;
  view: CameraView;
  side: CameraSide;
  lensMm: number;
  /** 没有 Camera Move Clip 时使用的默认运镜。 */
  motion: CameraMotionType;
}

/**
 * Camera Move = 一台相机在时间轴上的一段运镜。
 * 每台相机拥有自己的 Camera Track，但共享 World 与 Timeline。
 */
export interface CameraMove {
  id: string;
  camera: string;
  type: CameraMotionType;
  timeStart: number;
  timeEnd: number;
  /** 覆盖该段的目标（为空则沿用相机自身 Target）。 */
  targetId?: string;
  /** ORBIT：本段内绕目标转过的角度。 */
  orbitDeg: number;
  /** DOLLY：结束时的距离系数（1 = 保持基准取景距离）。 */
  dollyScale: number;
  /** CRANE：结束时相对基准机位的附加高度（米）。 */
  craneHeight: number;
  ease: EaseCurve;
}

export type AspectRatio = "16:9" | "2.39:1" | "1.85:1" | "4:3" | "9:16";

/* ------------------------------------------------------ Director State */

/**
 * Director State = 导演意图的唯一来源。
 * Timeline 只是它的一个视图；Playback 读取同一份状态。
 */
export interface DirectorState {
  revision: number;
  duration: number;
  /** 项目级 Master Ratio，Shot 可覆盖。 */
  aspectRatio: AspectRatio;
  objects: DirectorObject[];
  segments: MoveSegment[];
  constraints: Constraint[];
  cameras: CameraObject[];
  cameraMoves: CameraMove[];
}

export type TimelineKind = "segment" | "constraint" | "camera";

export interface TimelineItem {
  id: string;
  track: string;
  source: string;
  kind: TimelineKind;
  label: string;
}

export type IntentAction =
  | "MOVE"
  | "LOOK AT"
  | "FOLLOW"
  | "ACTION"
  | "STOP"
  | "CHANGE PATH"
  | "ADD ACTION"
  | "TARGET";

export type ViewMode = "director" | "camera";

/* ------------------------------------------------------------- Labels */

export const FRAMING_LABELS: Record<CameraFraming, string> = {
  extreme_wide: "Extreme Wide",
  wide: "Wide",
  medium: "Medium",
  close_up: "Close Up",
};

export const VIEW_LABELS: Record<CameraView, string> = {
  eye_level: "Eye Level",
  low: "Low",
  high: "High",
  ground: "Ground",
  overhead: "Overhead",
};

export const SIDE_LABELS: Record<CameraSide, string> = {
  front: "Front",
  front_3_4: "3/4 Front",
  side: "Side",
  back_3_4: "3/4 Back",
  back: "Back",
};

export const MOTION_LABELS: Record<CameraMotionType, string> = {
  STATIC: "STATIC",
  FOLLOW: "FOLLOW",
  ORBIT: "ORBIT",
  DOLLY: "DOLLY",
  CRANE: "CRANE",
};

export const MOTION_HINTS: Record<CameraMotionType, string> = {
  STATIC: "锁死机位：以片段开始时刻的构图固定不动。",
  FOLLOW: "跟随目标，持续保持取景与机位关系。",
  ORBIT: "跟随并绕目标旋转。",
  DOLLY: "推拉：改变与目标的距离。",
  CRANE: "升降：改变机位高度。",
};

export const LENS_OPTIONS = [24, 35, 50, 85];

export const ASPECT_OPTIONS: Array<{ label: AspectRatio; value: number }> = [
  { label: "16:9", value: 16 / 9 },
  { label: "2.39:1", value: 2.39 },
  { label: "1.85:1", value: 1.85 },
  { label: "4:3", value: 4 / 3 },
  { label: "9:16", value: 9 / 16 },
];

export function aspectValue(ratio: AspectRatio): number {
  return ASPECT_OPTIONS.find((item) => item.label === ratio)?.value ?? 16 / 9;
}
