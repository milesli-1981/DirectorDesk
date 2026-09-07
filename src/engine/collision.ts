import { DirectorObject } from "../domain/schema";
import { assetRect } from "./occlusion";

/**
 * 仅针对静态环境资产（role === "set"）之间的摆放重叠。
 * 与遮挡判定共用 footprint（轴对齐包围盒，x/z 平面）。
 */

const SEPARATION_EPS = 0.05;

/** 两个资产的 footprint 是否在 x/z 平面重叠（轴对齐包围盒）。 */
export function footprintsOverlap(a: DirectorObject, b: DirectorObject): boolean {
  const ra = assetRect(a);
  const rb = assetRect(b);
  return (
    Math.abs(ra.x - rb.x) < (ra.w + rb.w) / 2 &&
    Math.abs(ra.z - rb.z) < (ra.d + rb.d) / 2
  );
}

/**
 * 把一个 set 资产沿最小穿透轴推开到与所有其它 set 资产刚好不碰。
 * 返回分离后的新坐标；非 set 资产原样返回起算坐标。
 *
 * @param startX / startZ 起算坐标（落点 / 拖拽目标），缺省用资产当前坐标。
 */
export function separateSetAsset(
  objects: DirectorObject[],
  id: string,
  startX?: number,
  startZ?: number,
): { x: number; z: number } {
  const self = objects.find((o) => o.id === id);
  if (!self || self.role !== "set") {
    return { x: startX ?? self?.x ?? 0, z: startZ ?? self?.z ?? 0 };
  }
  let x = startX ?? self.x;
  let z = startZ ?? self.z;
  const hw = self.footprint.w / 2;
  const hd = self.footprint.d / 2;
  // 多轮迭代以解开链式重叠（A 推开 B，B 又压到 C …）。
  for (let iter = 0; iter < 8; iter += 1) {
    let moved = false;
    for (const other of objects) {
      if (other.id === id || other.role !== "set") continue;
      const ohw = other.footprint.w / 2;
      const ohd = other.footprint.d / 2;
      const overlapX = hw + ohw - Math.abs(x - other.x);
      const overlapZ = hd + ohd - Math.abs(z - other.z);
      if (overlapX > 0 && overlapZ > 0) {
        if (overlapX < overlapZ) {
          const dir = x >= other.x ? 1 : -1;
          x = other.x + dir * (hw + ohw + SEPARATION_EPS);
        } else {
          const dir = z >= other.z ? 1 : -1;
          z = other.z + dir * (hd + ohd + SEPARATION_EPS);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, z };
}
