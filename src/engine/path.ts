import {
  EaseCurve,
  MoveSegment,
  PathPoint,
  PathPointShape,
  Vec2,
} from "../domain/schema";
import { easeVal, normalizeEase } from "./ease";

export interface ChainNode extends Vec2 {
  type: "endpoint" | "path";
  shape: PathPointShape;
  id?: string;
}

/** Start → points → End 的有序节点链。Start/End 是端点，不是控制点。 */
export function pathChain(s: MoveSegment): ChainNode[] {
  const pts = Array.isArray(s.points) ? s.points : [];
  return [
    { x: s.startX, z: s.startZ, type: "endpoint", shape: "LINE" },
    ...pts.map((p) => ({ x: p.x, z: p.z, type: "path" as const, shape: p.shape, id: p.id })),
    { x: s.endX, z: s.endZ, type: "endpoint", shape: "LINE" },
  ];
}

/**
 * 采样成折线。ARC 控制点会把前后两个节点合并成一条二次贝塞尔，
 * 其后紧随的直线段不会重复输出。
 */
export function samplePath(s: MoveSegment): Vec2[] {
  const ch = pathChain(s);
  const out: Vec2[] = [];
  if (ch.length < 2) return ch.map((n) => ({ x: n.x, z: n.z }));

  let i = 0;
  while (i < ch.length - 1) {
    const a = ch[i];
    const b = ch[i + 1];

    if (b.type === "path" && b.shape === "ARC" && i + 2 < ch.length) {
      const n = ch[i + 2];
      const steps = 32;
      for (let j = 0; j < steps; j += 1) {
        const u = j / steps;
        const v = 1 - u;
        out.push({
          x: v * v * a.x + 2 * v * u * b.x + u * u * n.x,
          z: v * v * a.z + 2 * v * u * b.z + u * u * n.z,
        });
      }
      i += 2;
      continue;
    }

    const steps = 16;
    for (let j = 0; j < steps; j += 1) {
      const u = j / steps;
      out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
    }
    i += 1;
  }

  out.push({ x: ch[ch.length - 1].x, z: ch[ch.length - 1].z });
  return out;
}

/** Segment 在某一时刻的世界位置：先跑速度曲线，再换算成路径里程。 */
export function segmentPosition(s: MoveSegment, time: number): Vec2 {
  if (time <= s.timeStart) return { x: s.startX, z: s.startZ };
  if (time >= s.timeEnd) return { x: s.endX, z: s.endZ };

  const p = samplePath(s);
  const lens: number[] = [0];
  for (let i = 1; i < p.length; i += 1) {
    lens[i] = lens[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
  }
  const total = lens[lens.length - 1] || 1;
  const span = s.timeEnd - s.timeStart || 1;
  const u = (time - s.timeStart) / span;
  const target = easeVal(normalizeEase(s.ease), u) * total;

  let i = 1;
  while (i < lens.length && lens[i] < target) i += 1;

  // 缓动值可能超出 [0,1]（overshoot / anticipation），末端按最后一段外推。
  if (i >= lens.length) {
    const n = p.length;
    const a = p[n - 2] ?? p[0];
    const b = p[n - 1];
    const st = lens[n - 1] - lens[n - 2] || 1;
    const f = 1 + (target - lens[n - 1]) / st;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  }

  const f = (target - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
  const a = p[i - 1];
  const b = p[i];
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/** 新点必须插入最近的局部路径区间，而不是简单 append。 */
export function pathInsertIndex(s: MoveSegment, x: number, z: number): number {
  const ch = pathChain(s);
  let best: { d: number; i: number } | null = null;
  for (let i = 0; i < ch.length - 1; i += 1) {
    const a = ch[i];
    const b = ch[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const den = vx * vx + vz * vz || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / den));
    const qx = a.x + u * vx;
    const qz = a.z + u * vz;
    const d = Math.hypot(x - qx, z - qz);
    if (!best || d < best.d) best = { d, i };
  }
  if (!best) return 0;
  return Math.max(0, Math.min((s.points ?? []).length, best.i));
}

/** INV-001：任何两个相邻控制点不能同时是 ARC。 */
export function normalizePathPointModes(points: PathPoint[]): PathPoint[] {
  return points.map((p, i, arr) => {
    const shape = p.shape === "ARC" || p.shape === "LINE" ? p.shape : "LINE";
    if (shape !== "ARC") return { ...p, shape: "LINE" as PathPointShape };
    const prevArc = arr[i - 1]?.shape === "ARC";
    const nextArc = arr[i + 1]?.shape === "ARC";
    if (prevArc || nextArc) return { ...p, shape: "LINE" as PathPointShape };
    return { ...p, shape };
  });
}

/** 只有中间点能切换；与 ARC 相邻的 LINE 点不可切换（UI 上直接不出现按钮）。 */
export function curveToggleEligible(points: PathPoint[], index: number): boolean {
  const p = points[index];
  if (!p) return false;
  if (p.shape === "ARC") return true;
  return points[index - 1]?.shape !== "ARC" && points[index + 1]?.shape !== "ARC";
}

/** 距离路径最近的采样点，用于「贴着路径拖出新控制点」。 */
export function nearestOnPath(
  s: MoveSegment,
  x: number,
  z: number,
): { x: number; z: number; distance: number } {
  const pts = samplePath(s);
  let best: { x: number; z: number; distance: number } | null = null;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const den = vx * vx + vz * vz || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / den));
    const qx = a.x + u * vx;
    const qz = a.z + u * vz;
    const d = Math.hypot(x - qx, z - qz);
    if (!best || d < best.distance) best = { x: qx, z: qz, distance: d };
  }
  if (!best) {
    const first = pts[0] ?? { x: s.startX, z: s.startZ };
    return { x: first.x, z: first.z, distance: Number.POSITIVE_INFINITY };
  }
  return best;
}

export function segmentEase(s: MoveSegment): EaseCurve {
  return normalizeEase(s.ease);
}
