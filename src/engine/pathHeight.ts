import { DirectorObject, DirectorState, MoveSegment } from "../domain/schema";
import { arcAtU, arcIsFlat } from "./arc";
import { objectBottom, standingHeightFor, supportUnder } from "./ground";
import { locomotionOf } from "./locomotion";
import { curveVal, normalizeEase } from "./ease";
import { worldModeOf } from "./worldMode";
import { samplePath } from "./path";

/**
 * 「这个对象此刻该被画在多高」的**唯一权威**。
 *
 * 在 Phase 4 之前，高度 = `standingHeightFor(state, object, x, z)` —— 由脚下几何派生
 * （站到够得着的最高的面上），落差是**瞬时垂直对齐**：走出平台边缘会直接落到地面。
 *
 * Phase 4 引入垂直弧线后，高度多了一个来源：**段上的弧线**。本模块负责把两者合并，
 * 并且是合并规则的**唯一定义处** —— 渲染 / 相机 / 路径标记 / 遮挡都只能走这里，
 * 否则又会出现"屏幕上看在那里、却怎么都点不中"（见 ground.ts `pathGroundAt` 的教训）。
 *
 * ## 优先级（从高到低）
 *
 * 1. **弧线**（仅当该段有 `arc` 且（terrain 世界 或 段上标了 `arcAlways`））。
 *    弧线高度是 `u`（归一化里程）的纯函数，与脚下几何无关 —— 这才是"跳起来"。
 * 2. **瞬时对齐**（`standingHeightFor`）：没有弧线时的老路径，与扩展前逐像素一致。
 *
 * ## planar 不变性
 *
 * planar 下段默认没有 `arc`（UI 也不会生成），于是永远走第 2 条，
 * 而 planar 的 `maxStep = 0` 使 `standingHeightFor` 恒等于 `object.baseY ?? 0`
 * —— 与 Phase 0 之前逐像素一致。§22 是这条的回归守卫。
 */

/**
 * 某时刻该对象在段上的**归一化里程** `u` ∈ [0,1]（按缓动后的实际进度，非时间线性）。
 * 段外夹到端点。
 */
export function segmentProgressAt(seg: MoveSegment, time: number): number {
  if (time <= seg.timeStart) return 0;
  if (time >= seg.timeEnd) return 1;
  const span = seg.timeEnd - seg.timeStart || 1;
  const u = (time - seg.timeStart) / span;
  // 与求解器同一套：已走里程 = curveVal(ease, u) × 总里程。
  return curveVal(normalizeEase(seg.ease), seg.speedKeys, u);
}

/** 该对象在某时刻正在跑的段（含端点）。无则 null。 */
export function activeSegmentAt(
  state: DirectorState,
  objectId: string,
  time: number,
): MoveSegment | null {
  for (const seg of state.segments) {
    if (seg.object !== objectId) continue;
    if (time >= seg.timeStart && time <= seg.timeEnd) return seg;
  }
  return null;
}

/** 该段的弧线是否此刻生效（terrain 或显式 `arcAlways`）。 */
export function arcActive(state: DirectorState, seg: MoveSegment): boolean {
  if (!seg.arc) return false;
  return worldModeOf(state) === "terrain" || seg.arcAlways === true;
}

/**
 * 段起点 / 终点处的**地面高度**（弧线的基准）。
 *
 * 起跳点地面 = 起始里程处脚下可站立的最高面（用起点 `(x,z)`，**不受 maxStep 限制** ——
 * 跳跃本来就是"够不着才要跳"，所以这里用与摆放一致的最高面语义）。
 */
function groundAtStart(state: DirectorState, object: DirectorObject, seg: MoveSegment): number {
  return standingTopUnbounded(state, object, seg.startX, seg.startZ);
}

/** 落点面高度：终点 `(x,z)` 处够得着的最高面。 */
function groundAtEnd(state: DirectorState, object: DirectorObject, seg: MoveSegment): number {
  return standingTopUnbounded(state, object, seg.endX, seg.endZ);
}

/**
 * (x,z) 处最高的可站立顶面（**不考虑 maxStep**）。
 *
 * 与 `ground.ts` 的 `restingHeightAt` 同义，但排除自身，且不短路 planar ——
 * 因为弧线的起跳 / 落点面本来就是"它要去的那一层"，与它现在站哪无关。
 */
function standingTopUnbounded(state: DirectorState, object: DirectorObject, x: number, z: number): number {
  const loco = locomotionOf(state, object);
  // 用 +∞ 起点、maxStep=0：取所有覆盖此处的面里最高的那个（排除自身）。
  return supportUnder(state, x, z, Number.POSITIVE_INFINITY, 0, object.id).y;
}

/**
 * 对象此刻的渲染 / 相机高度。**这是唯一入口。**
 *
 * @param time 当前时刻（弧线需要它来求 `u`；无弧线时被忽略）
 */
export function pathHeightAt(
  state: DirectorState,
  object: DirectorObject,
  x: number,
  z: number,
  time: number,
): number {
  if (object.role === "set") return objectBottom(object);

  const seg = activeSegmentAt(state, object.id, time);
  if (seg && arcActive(state, seg)) {
    const u = segmentProgressAt(seg, time);
    const y0 = groundAtStart(state, object, seg);
    const y1 = groundAtEnd(state, object, seg);
    if (!arcIsFlat(seg.arc!, y0, y1)) {
      return arcAtU(seg.arc!, u, y0, y1);
    }
  }

  // 老路径：瞬时垂直对齐（无弧线 / planar / 弧线为空）。
  return standingHeightFor(state, object, x, z);
}

/**
 * 段的**起跳面 / 落点面**高度（弧线的基准）。
 *
 * 对外暴露是为了让可达性分档（`engine/reach.ts`）与渲染吃同一份起落面 ——
 * 各自算一遍就会出现"线画在 1.2m、包络图按 0.9m 判"的分叉。
 * 对象不存在 → null。
 */
export function arcEndHeights(
  state: DirectorState,
  segment: MoveSegment,
): { y0: number; y1: number } | null {
  const object = state.objects.find((o) => o.id === segment.object);
  if (!object) return null;
  return { y0: groundAtStart(state, object, segment), y1: groundAtEnd(state, object, segment) };
}

/**
 * 便捷：按 id 取高度（`pathGroundAt` 的弧线感知版本）。找不到对象 → 0。
 */
export function pathHeightOfId(
  state: DirectorState,
  objectId: string,
  x: number,
  z: number,
  time: number,
): number {
  const object = state.objects.find((o) => o.id === objectId);
  return object ? pathHeightAt(state, object, x, z, time) : 0;
}

/**
 * 段的**弧线感知**路径折线（用于把跳跃轨迹画成一条弓形线）。
 *
 * 与 `pick.ts` 的 `pathPolyline` 的区别：那条只按 (x,z) 取地面高度，画不出"跳起来"；
 * 这条按**归一化里程**取弧线高度，于是轨迹线会跟着弧线鼓起来。
 *
 * 采样点与运动求解共用 `samplePath`（同一份水平路径），y 由弧线派生 —— 与决策 4 一致：
 * **路径决定 x/z，几何（弧线）决定 y。**
 *
 * @param state    场景
 * @param segment  段
 * @param objectId 主体 id（取能力表 / 起落面用）
 * @param lift     离地抬升（默认沿用路径标记的抬升，让线贴在标记下方一点）
 */
export function arcPolyline(
  state: DirectorState,
  segment: MoveSegment,
  objectId: string,
  lift = 0,
): Array<[number, number, number]> {
  const object = state.objects.find((o) => o.id === objectId);
  const pts = samplePath(segment);
  if (!object || !arcActive(state, segment)) {
    // 没有弧线：保持与 pathPolyline 一致（地面高度）。
    return pts.map((p) => [
      p.x,
      (object ? standingHeightFor(state, object, p.x, p.z) : 0) + lift,
      p.z,
    ] as [number, number, number]);
  }

  // 累计弧长 → 每个采样点的归一化里程 u。
  const lens = new Array<number>(pts.length).fill(0);
  for (let i = 1; i < pts.length; i += 1) {
    lens[i] = lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  const total = lens[lens.length - 1] || 1;
  const y0 = groundAtStart(state, object, segment);
  const y1 = groundAtEnd(state, object, segment);
  const flat = arcIsFlat(segment.arc!, y0, y1);
  return pts.map((p, i) => {
    const u = lens[i] / total;
    const y = flat ? standingHeightFor(state, object, p.x, p.z) : arcAtU(segment.arc!, u, y0, y1);
    return [p.x, y + lift, p.z] as [number, number, number];
  });
}
