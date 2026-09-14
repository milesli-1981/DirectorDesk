import { DirectorObject } from "../domain/schema";
import { assetRect } from "./occlusion";
import { objectBottom, objectTop } from "./ground";

/**
 * 仅针对静态环境资产（role === "set"）之间的摆放重叠。
 * 与遮挡判定共用 footprint（轴对齐包围盒，x/z 平面）。
 *
 * 3D 扩展后本文件承担两件事：
 *  1. 水平分离（原逻辑）—— 但加入垂直过滤，见下。
 *  2. 垂直相交判定 —— 供堆叠、净空（桥下穿行）、头部空间复用。
 */

const SEPARATION_EPS = 0.05;

/**
 * 浮点容差。**这个常量是"相切"与"相交"的分水岭**，别随手调大：
 * 堆叠时上层底面 == 下层顶面（精确相等），若用 `<=` 判相交，两个盒子会被判为重叠，
 * 于是"把盒子拖到平台上"会被水平推开 —— 这正是扩展前就存在的那个 bug。
 * 用严格 `<` 且留极小容差，则相切稳定地判为不相交。
 */
const TANGENT_EPS = 1e-6;

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
 * 两个资产在 y 轴上的实体区间是否**真正**相交（开区间，相切不算）。
 *
 * 用严格小于而非 `<=`：底 == 顶（精确堆叠）判为不相交，这是堆叠能成立的前提。
 * 同理，`bottom` 悬空的桥/雨棚，其下方空间在此判为不相交 → 允许从下面走过。
 */
export function verticalOverlap(a: DirectorObject, b: DirectorObject): boolean {
  const aBottom = objectBottom(a);
  const aTop = objectTop(a);
  const bBottom = objectBottom(b);
  const bTop = objectTop(b);
  return aBottom < bTop - TANGENT_EPS && bBottom < aTop - TANGENT_EPS;
}

/** 真·3D 实心相交：水平重叠 **且** 垂直重叠。 */
export function solidOverlap(a: DirectorObject, b: DirectorObject): boolean {
  return footprintsOverlap(a, b) && verticalOverlap(a, b);
}

/**
 * 把一个 set 资产沿最小穿透轴推开到与所有其它 set 资产刚好不碰。
 * 返回分离后的新坐标；非 set 资产原样返回起算坐标。
 *
 * 垂直方向不相交的对（上下堆叠、桥下穿行）**跳过**，不参与水平推开 ——
 * 这是本函数相较 2D 版本的唯一语义变化。
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
      // 上下分层（堆叠 / 桥下净空）：垂直不相交则水平方向自由。
      if (!verticalOverlap(self, other)) continue;
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
