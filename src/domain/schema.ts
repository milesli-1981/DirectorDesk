export type ObjectKind = "actor" | "landmark" | "prop";

export type PathPointShape = "LINE" | "ARC";

/** cubic-bezier(x1, y1, x2, y2) — 与 CSS 缓动一致。 */
export type EaseCurve = [number, number, number, number];

export interface Vec2 {
  x: number;
  z: number;
}

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

/**
 * Director State = 导演意图的唯一来源。
 * Timeline 只是它的一个视图；Playback 读取同一份状态。
 */
export interface DirectorState {
  revision: number;
  duration: number;
  objects: DirectorObject[];
  segments: MoveSegment[];
  constraints: Constraint[];
}

export type TimelineKind = "segment" | "constraint";

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

export interface ResolvedFrame {
  time: number;
  positions: Record<string, Vec2>;
  facings: Record<string, number>;
}
