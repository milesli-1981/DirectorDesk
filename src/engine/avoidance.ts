import { DirectorState, DirectorObject, MoveSegment, Locomotion } from "../domain/schema";
import { objectBottom, objectTop, topAt, coversXZ, supportUnder } from "./ground";
import { stairSlopeDeg } from "./stair";
import { locomotionOfId } from "./locomotion";
import { assetRect, setRects, Rect } from "./occlusion";
import { worldModeOf } from "./worldMode";

/**
 * 障碍集合的「可达性过滤」—— 3D 化避障的**唯一支点**。
 *
 * ## 为什么只需改"喂进去的障碍集合"
 *
 * 现有避障是一条五层链：`routeObstaclesFor` → 可达性过滤 → `canStraddle` → 可见图/Dijkstra
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
 *
 * **例外（已落地）**：上面那条误差里最要紧的一种情形**不能等** —— **路线终点落在高台顶上**
 * （楼顶 / 到达平台）。按最低处分类会把那座高台当成墙，于是**作者画的终点根本走不到**：
 * 路线被**截在楼前**（而不是绕行），而且高度仍按作者进度取 ⇒ 脚底读数与站位还不同源。
 * 现在由 `blockingRectsForSegment` 用"端点在它顶上 + 他确实上得去"把它剔掉；
 * **中段穿越的保守性一点没动**（`routeHeightFor` 那条 v1 取舍仍然保留）。
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
    const top = topAt(o, x, z);
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
 * | `prefer === "walk-around"` | **全部保留** | 作者显式要求绕行（docs/3d/04 §3 的逃生口） |
 * | `top ≤ fromY + maxStep` | 排除 | 直接迈上去，不构成水平阻挡 |
 * | `top ≤ fromY + maxJumpHeight` 且跨度在包络内 | 排除 | 跳过去（默认走直线是导演意图） |
 * | `bottom ≥ fromY + 身高 + 净空` | 排除 | 可从下方穿行（桥 / 雨棚 / 拱洞） |
 * | `topShape === "ramp"` 且坡度 > `maxSlopeDeg` | **保留** | 太陡 → 等同墙 |
 * | 其他 | 保留 | 真阻挡 |
 *
 * ## "跳过去"这一条为什么现在才有
 *
 * 注释原本写着"等 Phase 4 落地跳跃弧线后在这里加一行即可" —— Phase 4 的弧线已经落地，
 * 于是这一步到站了。它也是 Phase 5 可达性 UI 的**前提**：不把跳得过的障碍剔掉，
 * 路径永远绕开它们，`segmentSpans` 就永远报不出"需跳跃 / 需攀爬"，UI 成了死代码。
 *
 * 代价是作者不补弧线时会**穿模**。这是刻意的：与"拖拽不硬阻止"同一条原则
 * （docs/3d/03 §6）—— 系统负责**持续标红**并给出一键修复，不替作者偷偷改路线。
 *
 * ## planar 不变性（自动满足，不是特判）
 *
 * planar 的能力表里 `maxStep = maxJumpHeight = 0`，两条排除条件都退化成 `top ≤ 0`；
 * 现实中不存在高度为 0 的 set（预设最小 0.3），所以 **planar 下仍恒等于 `setRects`**。
 * §17 把这个恒等式钉成了回归守卫。
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
  // 作者显式要求绕行 → 任何"迈得上 / 跳得过 / 穿得下"的豁免一律作废。
  if (o.prefer === "walk-around") return false;
  const bottom = objectBottom(o);
  const top = objectTop(o);
  // ① 迈得上去（台阶 / 矮箱）；坡面与楼梯看**坡脚**。太陡的坡不享受这个豁免 —— 它等同墙。
  //
  // 为什么坡面/楼梯不能拿 `top` 去比：一座 1.8m 高的楼梯，`top` 恒为 1.8，
  // 远高于 `fromY + maxStep` ⇒ 判成墙 ⇒ **演员会绕过整座楼梯而不是走上去**
  // （之前只能靠逐块标 `blocking: false` 绕开）。而能不能走上去取决于**入口**：
  // 坡脚够得着、坡度在能力表内，就上得去。
  const sloped = o.topShape === "ramp" || o.topShape === "stair";
  const tooSteep = sloped && slopeDegOf(o) > loco.maxSlopeDeg;
  const entry = sloped ? bottom : top;
  if (!tooSteep && entry <= fromY + loco.maxStep + 1e-6) return true;
  // ①′ 跳得过去：高度在跳跃能力内，且整个 footprint 的**对角线**在跳远能力内。
  //     用对角线是**保守方向** —— 沿任意方向跨过它都不会超过包络。
  if (
    !tooSteep &&
    loco.maxJumpHeight > 0 &&
    top <= fromY + loco.maxJumpHeight + 1e-6 &&
    Math.hypot(o.footprint.w, o.footprint.d) <= loco.maxJumpReach + 1e-6
  ) {
    return true;
  }
  // ② 从下方穿行（桥 / 雨棚）：整个身高 + 净空都在底面之下。
  if (bottom >= fromY + loco.height + HEAD_CLEARANCE) return true;
  return false;
}

function slopeDegOf(o: DirectorObject): number {
  // 抽象楼梯：坡度是作者的显式参数，不由 h/d 反推（拐弯楼梯的 d 没有意义）。
  if (o.topShape === "stair") return stairSlopeDeg(o);
  const h = objectTop(o) - objectBottom(o);
  if (o.footprint.d <= 1e-6) return 90;
  return (Math.atan2(h, o.footprint.d) * 180) / Math.PI;
}

/** 便捷形式：直接从对象推出 `fromY` 与能力表。 */
export function blockingRectsFor(state: DirectorState, objectId: string): Rect[] {
  return blockingRects(state, objectId, routeHeightFor(state, objectId), locomotionOfId(state, objectId));
}

/* ------------------------------------------- 端点层高：把"按高度切子段"缩成一条判据 */

/** 累进采样步长（米）。与 `pathHeight.ts` 的 `PROFILE_STEP` 同量级：
 *  必须 ≤ `maxStep / tan(maxSlopeDeg)`，否则链条会在半途断掉（够不到下一个面）。 */
const LAYER_STEP = 0.3;

/**
 * 沿**直连线**从 `from`（高度 `fromY`）按能力表累进，看能不能走到 `targetY` 那一层。
 *
 * 与 `pathHeight.ts` 的累进剖面**同一手法**（`h_{k+1} = supportUnder(…, fromY = h_k, maxStep)`），
 * 但只用 `ground.ts` —— 本模块被 `solver.ts` 引用，引入 `path.ts` 会成环
 * （`routeHeightFor` 的说明里已经记过这条约束）。
 */
function chordCanReach(
  state: DirectorState,
  from: { x: number; z: number },
  fromY: number,
  to: { x: number; z: number },
  loco: Locomotion,
  targetY: number,
  selfId: string,
): boolean {
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(dist / LAYER_STEP));
  let y = fromY;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    y = supportUnder(
      state,
      from.x + (to.x - from.x) * t,
      from.z + (to.z - from.z) * t,
      y,
      loco.maxStep,
      selfId,
    ).y;
  }
  return Math.abs(y - targetY) <= loco.maxStep + 1e-6;
}

/**
 * 这个障碍**拦不住**这一段吗？—— "他的路线端点就落在它顶上，而且他确实上得去"。
 *
 * 这是把 `routeHeightFor` 那条已知误差（"一段内从地面爬到高处时，低处的分类会让它绕开
 * 本可越过的低障碍"）在**最要紧的那一种情形**上补掉：**终点设在高台顶上**
 * （楼顶 / 到达平台）—— 那里本来是"他在上面走"，却因为整段按最低处分类而被判成墙，
 * 于是路线被**截在楼前**（而不是绕行），作者画的终点根本走不到。
 *
 * 判据三条，缺一不可：
 * 1. 该段的**一端**落在这个障碍的水平投影内；
 * 2. 那一端的层高 ≥ 它的顶面（"他就在它上面"，不是被别的东西盖在更高处）；
 * 3. 从**另一端**沿直连线按能力表累进，够得到那一层 —— 也就是"他是走上来的"。
 *
 * 第 3 条是关键：它把"人站在楼顶"与"人把路线终点画在墙里"分开 —— 后者够不到那个高度
 * （楼顶离地 3 m，一步迈不上），于是障碍照旧保留、照旧把他绕开，**不会因为豁免而穿墙**。
 *
 * 只读 `state.objects` / `state.segments`，与时间无关，所以缓存语义不变。
 */
function endpointOnTopExempts(
  state: DirectorState,
  seg: MoveSegment,
  obstacle: DirectorObject,
  loco: Locomotion,
): boolean {
  const ends = [
    { x: seg.startX, z: seg.startZ },
    { x: seg.endX, z: seg.endZ },
  ];
  const top = objectTop(obstacle);
  for (let i = 0; i < 2; i += 1) {
    const here = ends[i];
    if (!coversXZ(obstacle, here.x, here.z)) continue;
    const layer = standingTopAt(state, here.x, here.z);
    if (layer < top - 1e-3) continue;
    const other = ends[1 - i];
    const otherY = standingTopAt(state, other.x, other.z);
    if (chordCanReach(state, other, otherY, here, loco, layer, seg.object)) return true;
  }
  return false;
}

/**
 * 一段**自己**的障碍集合（= `blockingRects` 的"按段"版本）。
 *
 * 与 `blockingRectsFor`（按演员、取全部段的**最小**起始高度）只差一处：**逐个障碍**先问
 * 上面那条端点判据；其余障碍沿用旧的保守判法，原地不动 —— 所以这次改动**只会让障碍变少，
 * 而且只少"端点在它顶上且他确实上得去"那一种**。
 *
 * 为什么不能干脆把 `fromY` 从"最小"改成"最大"：那是把保守方向反过来，会让人在低处
 * **穿墙**（`routeHeightFor` 的说明里选"最小"正是为了"绝不会穿模"）。按段 + 端点判据
 * 才能同时满足"不穿模"与"终点落在高台上走得到"。
 */
export function blockingRectsForSegment(state: DirectorState, seg: MoveSegment): Rect[] {
  const object = state.objects.find((o) => o.id === seg.object);
  // planar / 找不到主体：回到旧判法（planar 下 fromY 恒 0、maxStep = 0，与扩展前逐值一致）。
  if (!object || worldModeOf(state) !== "terrain") return blockingRectsFor(state, seg.object);
  const loco = locomotionOfId(state, seg.object);
  const fallback = routeHeightFor(state, seg.object);
  return state.objects
    .filter((o) => o.role === "set" && !o.hidden && o.id !== seg.object)
    .filter((o) => {
      if (endpointOnTopExempts(state, seg, o, loco)) return false;
      return !isPassable(o, fallback, loco);
    })
    .map(assetRect);
}
