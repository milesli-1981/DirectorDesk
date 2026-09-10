import {
  EaseCurve,
  MoveSegment,
  PathPoint,
  PathPointShape,
  Vec2,
} from "../domain/schema";
import { easeVal, normalizeEase } from "./ease";
import { Rect } from "./occlusion";
import { avoidObstacles } from "./pathfinding";

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

/** 点到线段的垂直距离（投影夹在段内）。 */
function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/**
 * Ramer–Douglas–Peucker 抽稀：在给定容差内，用最少的关键点还原折线形状。
 *
 * 手绘路径是逐帧采样的（几厘米一个点），直接存下来会让画布上冒出几十个可拖控制点，
 * 既看不清也更难编辑。抽稀后只保留"真正拐弯"的点，首尾两点恒定保留
 * （它们决定路径的起点 / 终点）。
 */
export function simplifyPath(points: Vec2[], epsilon = 0.35): Vec2[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last <= first + 1) continue;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = pointSegmentDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > epsilon && index > 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
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

const routeCache = new Map<string, Vec2[]>();

function segmentSignature(s: MoveSegment, rects: Rect[]): string {
  const pts = s.points.map((p) => `${p.x},${p.z},${p.shape}`).join(":");
  const obs = rects.map((r) => `${r.x},${r.z},${r.w},${r.d}`).join(";");
  return `${s.id}|${s.startX},${s.startZ},${s.endX},${s.endZ}|${pts}|${obs}`;
}

/**
 * Segment 的**实际行走折线**：畅通时为原始路径，被环境（set 资产）阻挡时为绕行折线。
 * 可视化与运动求解共用此函数，保证「看到的橙色导航层」就是 agent 真正走的路线。
 */
export function segmentRoutePoints(s: MoveSegment, rects: Rect[] = []): Vec2[] {
  if (!rects.length) return samplePath(s);
  const key = segmentSignature(s, rects);
  const cached = routeCache.get(key);
  if (cached) return cached;
  const route = avoidObstacles(samplePath(s), rects);
  if (routeCache.size > 256) routeCache.clear();
  routeCache.set(key, route);
  return route;
}

/** Segment 在某一时刻的世界位置：先跑速度曲线，再换算成路径里程。 */
export function segmentPosition(s: MoveSegment, time: number, rects: Rect[] = []): Vec2 {
  // 用绕行后的折线取端点：端点若落在楼里，agent 会停在楼外边缘而不是走进楼内。
  const p = segmentRoutePoints(s, rects);
  const first = p[0] ?? { x: s.startX, z: s.startZ };
  const last = p[p.length - 1] ?? { x: s.endX, z: s.endZ };
  if (time <= s.timeStart) return { x: first.x, z: first.z };
  if (time >= s.timeEnd) return { x: last.x, z: last.z };

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

/** 折线的弧长查找表：cum[i] = 第 i 个点处的累计弧长（cum[0] = 0）。 */
export interface ArcLut {
  pts: Vec2[];
  cum: number[];
  total: number;
}

/** 由折线构造弧长前缀和，供「按弧长采样」复用，避免每帧重复累加。 */
export function buildArcLut(pts: Vec2[]): ArcLut {
  const cum: number[] = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (i === 0) {
      cum.push(0);
      continue;
    }
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    cum.push(cum[i - 1] + d);
  }
  return { pts, cum, total: cum.length ? cum[cum.length - 1] : 0 };
}

/**
 * 给定弧长 s 取折线上的点，超出首尾时沿首/末段方向外推（s<0 往后延、s>total 往前延）。
 *
 * 这是「路径相对编队」的基石：队员 i 取 s = s_anchor - i*spacing，就永远落在这条折线上，
 * 过弯时自然贴着路径走（蛇形跟随），而不再像世界空间刚性偏移那样被甩离或坍缩到节点。
 */
export function pointAtArcLength(lut: ArcLut, s: number): Vec2 {
  const { pts: p, cum: lens, total } = lut;
  if (p.length === 0) return { x: 0, z: 0 };
  if (p.length === 1) return { x: p[0].x, z: p[0].z };

  if (s <= 0) {
    const a = p[0];
    const b = p[1];
    const st = lens[1] - lens[0] || 1;
    const f = s / st;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  }
  if (s >= total) {
    const n = p.length;
    const a = p[n - 2] ?? p[0];
    const b = p[n - 1];
    const st = lens[n - 1] - lens[n - 2] || 1;
    const f = 1 + (s - total) / st;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  }

  let i = 1;
  while (i < lens.length && lens[i] < s) i += 1;
  const f = (s - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
  const a = p[i - 1];
  const b = p[i];
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/**
 * 弧长 s 处的路径切线朝向（atan2(dx, dz)，与 solver 的 forward=(sin,cos) 约定一致）。
 *
 * 在 s 两侧小窗口各采一点求方向：折点/拐角处自然得到角平分线，且**不受缓动端点零速
 * 影响**——瞬时速度差分在 waypoint 处会退化（速度为 0）并回落到默认值，这里不会。
 */
export function tangentAtArcLength(lut: ArcLut, s: number): number {
  const a = pointAtArcLength(lut, s - 0.05);
  const b = pointAtArcLength(lut, s + 0.05);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-6) return Math.atan2(dx, dz);
  return 0;
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
