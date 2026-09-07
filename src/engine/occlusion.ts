import { DirectorObject, DirectorState, Vec2 } from "../domain/schema";

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export function assetRect(asset: DirectorObject): Rect {
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

/** 线段（轴对齐矩形，含内部）相交检测。 */
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

/** 相机机位 → 目标 连线被哪些 set 资产（遮挡体）挡住。 */
export function blockingAssets(state: DirectorState, camPos: Vec2, targetPos: Vec2): DirectorObject[] {
  return state.objects.filter(
    (o) => o.role === "set" && segIntersectsRect(camPos, targetPos, assetRect(o)),
  );
}

/** 所有静态环境资产的包围矩形（用于绕障）。 */
export function setRects(state: DirectorState): Rect[] {
  return state.objects.filter((o) => o.role === "set").map(assetRect);
}
