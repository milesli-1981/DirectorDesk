import { DirectorState } from "../domain/schema";
import { separateSetAsset } from "./collision";
import { restingHeightAt } from "./ground";
import { effectiveState, worldModeOf } from "./worldMode";

/**
 * 落位：把对象放到 (x, z)，给出它最终该在的位置与层高。
 *
 * 这是「摆放」这件事的**唯一权威实现** —— 拖拽已有对象（`moveObject`）、
 * 从面板拖入新资产（`addAsset`）、Inspector 改坐标 / 改体块（`updateAsset`）
 * 三条路径全部走这里，避免同一个不变量被抄三遍、然后各自跑偏。
 *
 * ## 唯一的实质内容：顺序
 *
 * 必须先定层高、再用「带着新层高的几何」做水平分离。
 *
 * 反过来的话（先分离、后定高），正在抬升的盒子会拿着**旧 baseY** 去和平台比垂直相交：
 * 同层时两者的垂直区间必然重叠，于是刚拖到平台正上方就被沿最小穿透轴推开 ——
 * 「叠上去」这一步永远走不到，表现为"盒子一靠近平台就自己滑到旁边"。
 * 这个 bug 在扩展前的 2D 世界里不存在（那时没有高度），是引入 baseY 之后才出现的。
 *
 * ## planar 必须逐像素不变
 *
 * `baseY === undefined` 只可能出现在非 terrain 模式，此时直接走扩展前的分离路径，
 * 一行新逻辑都不碰。这是回归保护的落点：老场景在扩展后必须完全一致。
 */

export interface Placement {
  x: number;
  z: number;
  /** 需要写入的 `baseY`；`undefined` = 不改动该字段（非 terrain 模式）。 */
  baseY?: number;
}

/**
 * 落点处该写入的 `baseY`。
 *
 * @param layerY 调用方从射线拾取到的「指针正指着的那一层」。给了就以它为准。
 *
 * 为什么 layerY 优先于按 (x, z) 反查：水平落点走的是 y=0 平面投影，
 * 与射线实际打到的面**不是同一个点**（差 `h / tan(俯角)`）。低机位下把指针压在
 * 3m 平台的顶面上时，平面投影会落到平台**后面**的地上，反查得到 0 ——
 * 「明明指着平台，东西却掉到地上」。以射线命中的面为准就没有这个偏差。
 *
 * @returns 需要写入的 baseY；非 terrain 模式返回 undefined（表示不改动该字段）。
 */
export function restingBaseY(
  state: DirectorState,
  x: number,
  z: number,
  excludeId?: string,
  layerY?: number,
  forceTerrain?: boolean,
): number | undefined {
  const s = effectiveState(state, forceTerrain);
  if (worldModeOf(s) !== "terrain") return undefined;
  if (layerY !== undefined) return layerY;
  // 没给 layerY（例如 Inspector 敲坐标）就退回按 (x, z) 反查最高可站立面。
  return restingHeightAt(s, x, z, excludeId);
}

/**
 * 把一个对象落到 (x, z)：定层高 → 按该层高做水平分离。
 *
 * @param state 世界状态。对象必须已经在 `state.objects` 里（`addAsset` 需先把新资产并进去）。
 * @param id 被放置的对象 id。
 * @param x / z 期望落点（拖拽目标 / 输入坐标，可能未经分离）。
 * @param layerY 射线拾取到的层高（可选，见 `restingBaseY`）。
 * @param forceTerrain 本次交互是否强制按 3D 语义走（按住 Shift）。见 `worldMode.ts`。
 */
export function placeObject(
  state: DirectorState,
  id: string,
  x: number,
  z: number,
  layerY?: number,
  forceTerrain?: boolean,
): Placement {
  const s = effectiveState(state, forceTerrain);
  const self = s.objects.find((o) => o.id === id);
  if (!self) return { x, z };

  const baseY = restingBaseY(s, x, z, id, layerY);

  // 只有 set 参与水平分离；演员 / 相机 / 载具可自由摆放。
  if (self.role !== "set") return { x, z, baseY };

  // 非 terrain：没有高度语义，原样走扩展前的分离路径。
  if (baseY === undefined) {
    const sep = separateSetAsset(s.objects, id, x, z);
    return { x: sep.x, z: sep.z };
  }

  // 关键顺序：先把新层高装进一份探针数组，再拿它去判垂直相交。
  // 这样"已经抬到平台顶面"的盒子与平台**垂直不相交**（相切），分离自然跳过它，
  // 盒子就稳稳落在平台上而不是被推到旁边。
  const probe = s.objects.map((o) => (o.id === id ? { ...o, baseY } : o));
  const sep = separateSetAsset(probe, id, x, z);
  if (sep.x === x && sep.z === z) return { x, z, baseY };

  // 确实被推开了 → 落点变了，层高得按新落点重算一次。
  // 注意此时**不再传 layerY**：那个高度是在原落点头顶上量的，挪到旁边就不作数了。
  // 只做这一趟修正，不做定点迭代 —— 分离本身跑 8 轮解链式重叠，再叠一层外层迭代
  // 既难收敛也难解释，而"推开一格后落点变了"在实践里一趟就够了。
  return { x: sep.x, z: sep.z, baseY: restingBaseY(s, sep.x, sep.z, id) };
}
