import * as THREE from "three";
import { CameraPathPoint, PathPointShape, Vec3 } from "../domain/schema";

/**
 * 相机 PATH 的 3D 路径系统：与人物 move 的 `engine/path.ts` 同一套规则
 * （首尾是端点、中间点可 LINE/ARC、三角形/贝塞尔采样、按弧长取值），
 * 只是把 2D 的 (x,z) 升级成 3D 的 (x,y,z)。
 */

export interface CamPathNode {
  x: number;
  y: number;
  z: number;
  type: "endpoint" | "path";
  shape: PathPointShape;
  id?: string;
}

/** 首尾是端点（START / END），中间是控制点（可 LINE / ARC）。 */
export function camPathChain(points: CameraPathPoint[]): CamPathNode[] {
  const last = points.length - 1;
  return points.map((p, i) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    type: i === 0 || i === last ? "endpoint" : "path",
    shape: p.shape ?? "LINE",
    id: p.id,
  }));
}

/** 采样成 3D 折线：ARC 控制点把前后两点合并成一条二次贝塞尔（与人物路径同一规则）。 */
export function sampleCamPolyline(points: CameraPathPoint[]): Vec3[] {
  const ch = camPathChain(points);
  const out: Vec3[] = [];
  if (ch.length === 0) return out;
  if (ch.length < 2) return ch.map((n) => [n.x, n.y, n.z] as Vec3);

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
        out.push([
          v * v * a.x + 2 * v * u * b.x + u * u * n.x,
          v * v * a.y + 2 * v * u * b.y + u * u * n.y,
          v * v * a.z + 2 * v * u * b.z + u * u * n.z,
        ]);
      }
      i += 2;
      continue;
    }
    const steps = 16;
    for (let j = 0; j < steps; j += 1) {
      const u = j / steps;
      out.push([a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u]);
    }
    i += 1;
  }
  const last = ch[ch.length - 1];
  out.push([last.x, last.y, last.z]);
  return out;
}

/** 沿折线按弧长均匀取点（progress 0..1），端点外推，避免首尾退化。 */
function polylineAt(pts: Vec3[], progress: number): Vec3 {
  if (pts.length === 0) return [0, 1.5, 0];
  if (pts.length === 1) return pts[0];
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    cum[i] = cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const total = cum[cum.length - 1] || 1;
  const t = Math.min(1, Math.max(0, progress)) * total;
  let i = 1;
  while (i < cum.length && cum[i] < t) i += 1;
  if (i >= cum.length) {
    const a = pts[pts.length - 2] ?? pts[0];
    const b = pts[pts.length - 1];
    const seg = total - cum[cum.length - 2] || 1;
    const f = 1 + (t - total) / seg;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  const f = (t - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  const a = pts[i - 1];
  const b = pts[i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** 相机沿 PATH 在归一化进度 progress 上的机位（含 ARC 曲线 + 弧长均匀）。 */
export function sampleCamPath(points: CameraPathPoint[], progress: number): Vec3 {
  return polylineAt(sampleCamPolyline(points), progress);
}

/** 射线到 3D 线段的最短距离。 */
function raySegmentDistance(ray: THREE.Ray, a: Vec3, b: Vec3): number {
  const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const v = ray.direction;
  const w0 = new THREE.Vector3(a[0] - ray.origin.x, a[1] - ray.origin.y, a[2] - ray.origin.z);
  const A = u.dot(u);
  const B = u.dot(v);
  const C = v.dot(v);
  const D = u.dot(w0);
  const E = v.dot(w0);
  const denom = A * C - B * B;
  let s = Math.abs(denom) < 1e-8 ? 0 : (B * E - C * D) / denom;
  s = Math.max(0, Math.min(1, s));
  const px = a[0] + u.x * s;
  const py = a[1] + u.y * s;
  const pz = a[2] + u.z * s;
  const t = Math.max(
    0,
    (px - ray.origin.x) * v.x + (py - ray.origin.y) * v.y + (pz - ray.origin.z) * v.z,
  );
  const ox = ray.origin.x + v.x * t;
  const oy = ray.origin.y + v.y * t;
  const oz = ray.origin.z + v.z * t;
  return Math.hypot(px - ox, py - oy, pz - oz);
}

/** 射线命中的相机路径最近点 + 插入位置（用于「按住路径拖动加点」）。 */
export function nearestOnCamPath(
  points: CameraPathPoint[],
  ray: THREE.Ray,
): { x: number; y: number; z: number; insertAt: number; distance: number } | null {
  if (points.length < 2) return null;
  let best: { x: number; y: number; z: number; insertAt: number; distance: number } | null = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const d = raySegmentDistance(ray, [a.x, a.y, a.z], [b.x, b.y, b.z]);
    if (!best || d < best.distance) {
      // 命中点取线段中点（高度也取中点，保证新点落在路径高度上）。
      best = {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        z: (a.z + b.z) / 2,
        insertAt: i + 1,
        distance: d,
      };
    }
  }
  return best;
}

/** 规范化 ARC：首尾恒 LINE，且任何两个相邻控制点不能同时是 ARC。 */
export function normalizeCamPathShapes(points: CameraPathPoint[]): CameraPathPoint[] {
  const last = points.length - 1;
  return points.map((p, i, arr) => {
    const wantArc = p.shape === "ARC";
    if (!wantArc || i === 0 || i === last) return { ...p, shape: "LINE" };
    const prevArc = arr[i - 1]?.shape === "ARC";
    const nextArc = arr[i + 1]?.shape === "ARC";
    if (prevArc || nextArc) return { ...p, shape: "LINE" };
    return { ...p, shape: "ARC" };
  });
}

/** 中间点能否转曲线（首尾端点、与 ARC 相邻的不可）。 */
export function camCurveEligible(points: CameraPathPoint[], index: number): boolean {
  if (index <= 0 || index >= points.length - 1) return false;
  const p = points[index];
  if (!p) return false;
  if (p.shape === "ARC") return true;
  return points[index - 1]?.shape !== "ARC" && points[index + 1]?.shape !== "ARC";
}
