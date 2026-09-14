import { DirectorState, DirectorObject, MoveSegment, Locomotion } from "../domain/schema";
import { objectBottom, objectTop, topAt, coversXZ } from "./ground";
import { locomotionOfId } from "./locomotion";
import { assetRect, setRects, Rect } from "./occlusion";
import { worldModeOf } from "./worldMode";

/**
 * 障碍集合的「可达性过滤」—— 3D 化避障的**唯一支点**。
 *
 * ## 为什么只需改"喂进去的障碍集合"
 *
 * 现有避障是一条五层链：`routeObstacles` → 可达性过滤 → `canStraddle` → 可见图/Dijkstra
 * → `groupInfluenceOffset` 的侧让 / 二次兜底。其中**核心算法一行都不用改** ——
 * 关键在于：行走本来就是近似 2D 的，y 由地面派生。
 *
 * 于是 3D 化只剩下一个动作：**把"其实拦不住它"的障碍从集合里剔掉。**
 * 台阶该迈上去、桥下该穿过去、草丛不该挡路 —— 它们都不该掰弯整条路径。
 *
 * 而现有代码**已经有完全同构的先例**：`solver.ts` 的 `canStraddle` 就是"把某些障碍剔掉"
 * （让编队骑得过去的小障碍不参与锚点的全局绕障）。我们只是增加新的剔除判据，
 * 而且顺序必须排在 `canStraddle` **之前** —— `canStraddle` 问的是"编队横向跨度够不够骑过这个障碍"，
 * 这个问题的前提是"它本来就是个障碍"。已经因"迈得上"被排除的，再判一次纯属浪费。
 *
 * ## planar 必须逐值不变
 *
 * `planar` 下 `fromY` 恒为 0（见 `routeHeightFor`）、`maxStep = 0`，
 * 于是过滤条件退化成「只排除 `top ≤ 0` 的对象」。实践中不存在高度为 0 的 set
 * （预设最小 0.3），所以 **`blockingRects` 在 planar 下恒等于 `setRects`**。
 * §17 把这个恒等式钉成了回归守卫。注意这里**不是**靠 `if (planar)` 短路 ——
 * 那样一旦将来有人改 `maxStep` 就会静默分叉；靠"能力表退化"自然收敛才是对的。
 */

/** 桥下穿行所需的头顶净空余量。低于此净空的桥拱必须绕行。 */
const HEAD_CLEARANCE = 0.15;

/**
 * 某对象做路径规划时应采用的「出发点高度」。
 *
 * ## 为什么取该对象全部段的**最小起始落脚高度**（而不是当前时刻那一处）
 *
 * 三点理由，按重要性排序：
 *
 * 1. **缓存稳定性（决定性）。** `fromY` 若随时间和位置变化，障碍集合就变成逐帧变量，
 *    `objectRouteCache` 的 key 退化成"每个时刻一份" → **缓存全废，每帧重跑可见图 + Dijkstra**。
 *    本函数**只读 `state.objects` 与 `state.segments`**，与 `time` 完全无关；
 *    而 store 每次改动都会 `revision + 1`（那个 revision 也进了 `objectRouteCache` 的 key），
 *    所以缓存在整条时间轴上都能命中 —— **不需要额外把 fromY 量化进 key**，
 *    因为它在一次 revision 内是常量。这一点是刻意设计的，改动本函数时务必保持：
 *    **不要让它读 `currentTime` 或任何随时间变化的量。**
 * 2. **保守方向。** 取最小 → 判断的是"在最低处能被什么挡住" → 更多障碍被判为阻挡 →
 *    路径更保守 → **绝不会穿模**。误差方向是安全的（代价只是可能多绕一段）。
 * 3. **planar 恒 0。** 非 terrain 时直接返回 0，不触碰任何高度字段 —— 这就是"退化"的落点。
 *
 * 已确认的误差：一段内从地面爬到高处时，低处的分类会让它绕开本可越过的低障碍。
 * 这是保守方向的误差，可接受。**v1 不做"按高度分段切子段"**（见 04 §4）。
 */
export function routeHeightFor(state: DirectorState, objectId: string): number {
  if (worldModeOf(state) !== "terrain") return 0;
  const segs = state.segments
    .filter((s) => s.object === objectId)
    .sort((a, b) => a.timeStart - b.timeStart);
  // 没有段（静止对象）：它本来就站在某层上，用那个高度。
  if (segs.length === 0) {
    const obj = state.objects.find((o) => o.id === objectId);
    return obj ? objectBottom(obj) : 0;
  }
  let minY = Infinity;
  for (const seg of segs) {
    const y = segmentStartHeight(state, seg);
    if (y < minY) minY = y;
  }
  return Number.isFinite(minY) ? minY : 0;
}

/**
 * 一段开始时脚下的高度。
 *
 * 取 `startX/startZ` 处的最高可站立面。**不引入 `path.ts`** 是为了避免依赖环
 * （`path.ts → ground.ts → locomotion.ts`，而本模块被 `solver.ts` 引用）。
 */
function segmentStartHeight(state: DirectorState, seg: MoveSegment): number {
  return standingTopAt(state, seg.startX, seg.startZ);
}

/**
 * (x, z) 处最高的可站立顶面。
 *
 * 与 `ground.ts` 的 `restingHeightAt` 不同：这里**不限 `fromY + maxStep`** ——
 * 障碍物站在哪个面它就是站在那里，不需要问它"上不上得去"。
 */
function standingTopAt(state: DirectorState, x: number, z: number): number {
  let best = 0;
  for (const o of state.objects) {
    if (o.role !== "set" || o.hidden) continue;
    if (o.walkable === false) continue;
    if (!coversXZ(o, x, z)) continue;
    const top = o.topShape === "ramp" ? topAt(o, x, z) : objectTop(o);
    if (top > best) best = top;
  }
  return best;
}

/**
 * 真正「拦得住」该对象的障碍子集。
 *
 * | 条件 | 判定 | 理由 |
 * |---|---|---|
 * | `blocking === false` | 排除 | 语义开关（草丛、水面） |
 * | `top ≤ fromY + maxStep` | 排除 | 直接迈上去，不构成水平阻挡 |
 * | `bottom ≥ fromY + 身高 + 净空` | 排除 | 可从下方穿行（桥 / 雨棚 / 拱洞） |
 * | `topShape === "ramp"` 且坡度 > `maxSlopeDeg` | **保留** | 太陡 → 等同墙 |
 * | 其他 | 保留 | 真阻挡 |
 *
 * 注意**没有"跳过去"这一条**：`maxJumpHeight` / 跳跃包络属 Phase 4。
 * 现在把"跳得过"的障碍剔掉会让路径直穿过去、而人又还不会跳 —— 那是穿模。
 * 等 Phase 4 落地跳跃弧线后在这里加一行即可（这正是"只改集合"设计的收益）。
 *
 * @param fromY 出发点高度。务必来自 `routeHeightFor`（时间无关），否则缓存会退化。
 */
export function blockingRects(
  state: DirectorState,
  objectId: string,
  fromY: number,
  loco: Locomotion,
): Rect[] {
  return state.objects
    .filter((o) => o.role === "set" && !o.hidden && o.id !== objectId)
    .filter((o) => !isPassable(o, fromY, loco))
    .map(assetRect);
}

/** 该对象是否"拦不住"出发点在 `fromY` 的主体。 */
function isPassable(o: DirectorObject, fromY: number, loco: Locomotion): boolean {
  if (o.blocking === false) return true; // 语义开关：草丛 / 水面
  const bottom = objectBottom(o);
  const top = objectTop(o);
  // ① 迈得上去（台阶 / 矮箱）。太陡的坡不享受这个豁免 —— 它等同墙。
  const tooSteep = o.topShape === "ramp" && slopeDegOf(o) > loco.maxSlopeDeg;
  if (!tooSteep && top <= fromY + loco.maxStep + 1e-6) return true;
  // ② 从下方穿行（桥 / 雨棚）：整个身高 + 净空都在底面之下。
  if (bottom >= fromY + loco.height + HEAD_CLEARANCE) return true;
  return false;
}

function slopeDegOf(o: DirectorObject): number {
  const h = objectTop(o) - objectBottom(o);
  if (o.footprint.d <= 1e-6) return 90;
  return (Math.atan2(h, o.footprint.d) * 180) / Math.PI;
}

/** 便捷形式：直接从对象推出 `fromY` 与能力表。 */
export function blockingRectsFor(state: DirectorState, objectId: string): Rect[] {
  return blockingRects(state, objectId, routeHeightFor(state, objectId), locomotionOfId(state, objectId));
}
