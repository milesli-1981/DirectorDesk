import { Vec2 } from "../domain/schema";
import { Rect, segIntersectsRect } from "./occlusion";

/**
 * 障碍感知路径：若原始折线穿过静态环境（set 资产）的包围盒，
 * 则用「可见图 + Dijkstra」在障碍拐角上求出一条真正的绕行折线。
 *
 * 与旧的「把顶点推出盒子」不同，这里会对**穿越障碍中部**的路径沿拐角绕行，
 * 而不是把左右两半分别推到两侧、中间仍留一条穿过楼体的直线。
 *
 * 该结果同时用于**可视化与真实行走求解**（见 path.ts segmentPosition），两者始终一致。
 */

/** 允许贴边通过：绕行节点本就位于 margin 之外，收缩一点避免被误判为相交。 */
const GRAZE = 0.06;

function shrink(r: Rect, by: number): Rect {
  return { x: r.x, z: r.z, w: Math.max(0.02, r.w - by * 2), d: Math.max(0.02, r.d - by * 2) };
}

function expand(r: Rect, by: number): Rect {
  return { x: r.x, z: r.z, w: r.w + by * 2, d: r.d + by * 2 };
}

function inside(p: Vec2, r: Rect): boolean {
  return Math.abs(p.x - r.x) <= r.w / 2 && Math.abs(p.z - r.z) <= r.d / 2;
}

/** 两点连线是否不与任何障碍相交。 */
function clear(a: Vec2, b: Vec2, rects: Rect[]): boolean {
  for (const r of rects) {
    if (segIntersectsRect(a, b, shrink(r, GRAZE))) return false;
  }
  return true;
}

/** 把点沿最小穿透轴推出矩形（含 margin）。不在其中则原样返回。 */
export function pushOut(p: Vec2, r: Rect, margin: number): Vec2 {
  const e = expand(r, margin);
  if (!inside(p, e)) return p;
  const dl = p.x - (e.x - e.w / 2);
  const dr = e.x + e.w / 2 - p.x;
  const dt = p.z - (e.z - e.d / 2);
  const db = e.z + e.d / 2 - p.z;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: e.x - e.w / 2, z: p.z };
  if (m === dr) return { x: e.x + e.w / 2, z: p.z };
  if (m === dt) return { x: p.x, z: e.z - e.d / 2 };
  return { x: p.x, z: e.z + e.d / 2 };
}

function pushOutAll(p: Vec2, rects: Rect[], margin: number): Vec2 {
  let q: Vec2 = { ...p };
  for (let i = 0; i < 4; i += 1) {
    let moved = false;
    for (const r of rects) {
      const n = pushOut(q, r, margin);
      if (n.x !== q.x || n.z !== q.z) {
        q = n;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return q;
}

/** 折线是否被任一障碍阻挡。 */
export function polylineBlocked(points: Vec2[], rects: Rect[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (!clear(points[i - 1], points[i], rects)) return true;
  }
  return false;
}

/**
 * 可见图 + Dijkstra：以各障碍（外扩 margin 后）的四个拐角为中转节点，
 * 求 start → end 的最短无碰撞折线。节点数很小（4 × 障碍数 + 2）。
 */
export function routeAround(start: Vec2, end: Vec2, rects: Rect[], margin: number): Vec2[] {
  if (!rects.length) return [start, end];

  // 起终点若落在障碍内（例如把端点放在楼里），先推到最近的外边缘。
  const s = pushOutAll(start, rects, margin);
  const e = pushOutAll(end, rects, margin);
  if (clear(s, e, rects)) return [s, e];

  const nodes: Vec2[] = [s, e];
  for (const r of rects) {
    const ex = expand(r, margin);
    const hw = ex.w / 2;
    const hd = ex.d / 2;
    nodes.push({ x: ex.x - hw, z: ex.z - hd });
    nodes.push({ x: ex.x + hw, z: ex.z - hd });
    nodes.push({ x: ex.x + hw, z: ex.z + hd });
    nodes.push({ x: ex.x - hw, z: ex.z + hd });
  }

  const n = nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;

  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    // 弹出终点时距离已是最短；u < 0 表示剩余节点不可达。
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v += 1) {
      if (done[v]) continue;
      if (!clear(nodes[u], nodes[v], rects)) continue;
      const w = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
      if (dist[u] + w < dist[v]) {
        dist[v] = dist[u] + w;
        prev[v] = u;
      }
    }
  }

  // 完全被封死时退回「推到边缘后的直达」，保持可预测行为。
  if (!Number.isFinite(dist[1])) return [s, e];

  const out: Vec2[] = [];
  for (let cur = 1; cur >= 0; cur = prev[cur]) out.push(nodes[cur]);
  out.reverse();
  return out;
}

/** 折线绕障：畅通则原样返回；被挡则按端点重路由（会丢失中间的曲线造型）。 */
export function avoidObstacles(points: Vec2[], rects: Rect[], margin = 0.6): Vec2[] {
  if (points.length < 2 || !rects.length) return points;
  if (!polylineBlocked(points, rects)) return points;
  return routeAround(points[0], points[points.length - 1], rects, margin);
}
