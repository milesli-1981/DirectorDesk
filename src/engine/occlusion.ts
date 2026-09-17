import { DirectorObject, DirectorState, Vec2 } from "../domain/schema";
import { objectBottom, objectTop } from "./ground";
import { stairRect } from "./stair";
import { worldModeOf } from "./worldMode";

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** 3D 空间点（遮挡判定需要 y）。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function assetRect(asset: DirectorObject): Rect {
  // 抽象楼梯的水平占用面由**实际梯跑**反推（拐弯楼梯的 AABB 与 footprint 无关）。
  if (asset.topShape === "stair") return stairRect(asset);
  return { x: asset.x, z: asset.z, w: asset.footprint.w, d: asset.footprint.d };
}

function pointInRect(p: Vec2, r: Rect): boolean {
  return Math.abs(p.x - r.x) <= r.w / 2 && Math.abs(p.z - r.z) <= r.d / 2;
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function segIntersectsSeg(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * 线段与轴对齐矩形是否相交（含"线从矩形上方/下方掠过"的 2D 情形）。
 * 保留给纯 2D 场景（planar / 无高度信息）使用。
 */
export function segIntersectsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const minX = r.x - r.w / 2;
  const maxX = r.x + r.w / 2;
  const minZ = r.z - r.d / 2;
  const maxZ = r.z + r.d / 2;
  return (
    segIntersectsSeg(a, b, { x: minX, z: minZ }, { x: maxX, z: minZ }) ||
    segIntersectsSeg(a, b, { x: maxX, z: minZ }, { x: maxX, z: maxZ }) ||
    segIntersectsSeg(a, b, { x: maxX, z: maxZ }, { x: minX, z: maxZ }) ||
    segIntersectsSeg(a, b, { x: minX, z: maxZ }, { x: minX, z: minZ })
  );
}

/**
 * 线段与**轴对齐盒**是否相交（3D slab / Liang–Barsky）。
 *
 * 与 2D 版的区别就是多了 y 这一轴：从高处俯拍时视线从矮墙**上方掠过** →
 * 不再误判为遮挡；桥下看对面 → 视线从桥体**下方穿过** → 不判遮挡。
 * 这两件事在纯 2D 判定里都是必然误报。
 *
 * 入参 `y` 缺省为 0（= 退化回 2D 语义），所以旧的 2D 调用点可以平滑迁移。
 */
export function segIntersectsBox(
  a: Vec3,
  b: Vec3,
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): boolean {
  let tMin = 0;
  let tMax = 1;
  // 逐轴收窄参数区间 [tMin, tMax]；某一轴上区间为空即不相交。
  const axes: Array<[number, number, number, number]> = [
    [b.x - a.x, box.minX, box.maxX, a.x],
    [b.y - a.y, box.minY, box.maxY, a.y],
    [b.z - a.z, box.minZ, box.maxZ, a.z],
  ];
  for (const [d, lo, hi, o] of axes) {
    if (Math.abs(d) < 1e-9) {
      // 该轴上线段平行：起点不在板内就直接不相交。
      if (o < lo || o > hi) return false;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

/** 对象的实体盒（3D）。`bottom`/`baseY` 给出上下沿，与渲染同源。 */
export function objectBox(o: DirectorObject): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  const hw = o.footprint.w / 2;
  const hd = o.footprint.d / 2;
  return {
    minX: o.x - hw,
    minY: objectBottom(o),
    minZ: o.z - hd,
    maxX: o.x + hw,
    maxY: objectTop(o),
    maxZ: o.z + hd,
  };
}

/**
 * 相机机位 → 目标 连线被哪些 set 资产（遮挡体）挡住。
 *
 * 3D 化后按**实体盒**判定 —— 高机位不再被矮墙误判，桥下视线不再被桥体误判。
 * planar 世界下所有对象都在 y=0 起、身高 ≤ 3，与 2D 判定等价（`fromY = 0` 不改变结论）。
 *
 * @param camPos / targetPos 带 y 的 3D 点。缺 y 时按 0 处理（等价于旧的 2D 行为）。
 */
export function blockingAssets(
  state: DirectorState,
  camPos: Vec3 | Vec2,
  targetPos: Vec3 | Vec2,
): DirectorObject[] {
  const cam = withY(camPos);
  const target = withY(targetPos);
  return state.objects.filter(
    (o) => o.role === "set" && o.occluding !== false && segIntersectsBox(cam, target, objectBox(o)),
  );
}

/** 补齐 y（缺省 0），让旧的 2D 调用点仍能工作。 */
function withY(p: Vec3 | Vec2): Vec3 {
  return "y" in p && typeof p.y === "number" ? p : { x: p.x, y: 0, z: p.z };
}

/** 所有静态环境资产的包围矩形（用于绕障）。 */
export function setRects(state: DirectorState): Rect[] {
  return state.objects.filter((o) => o.role === "set").map(assetRect);
}
