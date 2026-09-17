import { DirectorObject, DirectorState } from "../domain/schema";
import { objectBottom, restingHeightAt } from "./ground";
import { locomotionOf } from "./locomotion";
import { stairPathOf, stairSlopeDeg } from "./stair";

/**
 * 「让这个演员走这条楼梯」的**规划**：把楼梯自己的路径变成他的路线。
 *
 * 楼梯的路径与演员走的路**本来是同一件事**（docs/3d/00 §9.15：楼梯 = 路径 + 高度），
 * 所以这里不做任何"贴到楼梯上"的拟合、也没有第二份几何 —— 直接把 `stair.path` 拿过来
 * 当路线（向下走就把它倒过来），再在**起点那一端**接一小段接近段。
 *
 * ## 为什么必须把 `startY` 写进演员的层高
 *
 * 落脚剖面（`pathHeightAt` → `progressiveGroundAt`）是"沿路线从**起点层**逐点滚"的：
 * `h_{k+1} = supportUnder(…, fromY = h_k, maxStep)`，而链条的**第一点**高度取自
 * `standingHeightFor`，它用 `object.baseY` 当查询起点层。
 *
 * 于是：**路线起点的层高必须由路线自己说了算**，否则
 * - 向上走时它恰好是 0（地面），所以以前不写也对 —— 这是巧合，不是设计；
 * - 向下走时起点在楼顶（2 m），`baseY` 若还是 0 ⇒ 链条从地面起步 ⇒ **人从地面开始走、
 *   整段穿过楼梯**（几何在降、人贴在地上）；
 * - 同理，**向上走"抬高的楼梯"**（坡脚在 3 m、人站在地面）也走不上去，那不是 bug 而是
 *   物理：一步迈不上 3 m —— 所以那种情况直接拒绝并说清。
 *
 * 所以 `startY` 是这个模块的第二个输出，与 `points` 同等重要 —— 调用方必须把它写进
 * 演员的 `baseY`（"他站在哪一层"），这也是本项目"摆放只有一个权威"的一贯做法。
 *
 * ## 拒绝的三种
 *
 * 坡度（超他自己的能力表）、宽度（装不下他的宽度）、以及**向上走时坡脚够不着**
 * （抬高的楼梯 —— 从地面一步迈不上坡脚）。都与连台阶同源：用**他自己的**能力表判，
 * 所以同一条楼梯对不同主体结论可能不同。
 */

/** 向上走的接近段长度（米）：取楼梯宽度，并夹在这个区间里。 */
const LEAD_MIN = 1;
const LEAD_MAX = 6;

export type StairWalkDirection = "up" | "down";

export interface StairWalkPlan {
  /** 演员的完整路线（接近段 + 楼梯路径；向下走时路径倒序）。 */
  points: Array<{ x: number; z: number }>;
  /**
   * 路线**起点处的落脚面高度**（米）。调用方必须把它写成演员的层高（`baseY`）——
   * 理由见模块说明：锚错了整条落脚链条会从地面开始。
   */
  startY: number;
  /** 楼梯的派生坡度（度）与走廊宽度 —— 文案、Inspector 与守卫都读它。 */
  slopeDeg: number;
  width: number;
  /** 他走的那条楼梯（落库后便于追溯"这条路是哪条楼梯来的"）。 */
  stairId: string;
  direction: StairWalkDirection;
}

export type StairWalkResult = { ok: true; plan: StairWalkPlan } | { ok: false; text: string };

/** 文案里的数字统一一位小数。 */
const r1 = (value: number) => Math.round(value * 10) / 10;

export function planStairWalk(
  state: DirectorState,
  stair: DirectorObject,
  actor: DirectorObject,
  direction: StairWalkDirection = "up",
): StairWalkResult {
  if (stair.topShape !== "stair") return { ok: false, text: "这个对象不是楼梯" };

  const loco = locomotionOf(state, actor);
  const slopeDeg = stairSlopeDeg(stair);
  if (slopeDeg > loco.maxSlopeDeg + 1e-6) {
    return {
      ok: false,
      text: `楼梯 ${Math.round(slopeDeg)}° 超过它的能力表 ${loco.maxSlopeDeg}° · 上不去`,
    };
  }

  const width = stair.footprint.w;
  if (width < actor.footprint.w - 1e-6) {
    return {
      ok: false,
      text: `楼梯宽 ${r1(width)} m 装不下它 ${r1(actor.footprint.w)} m 的宽度 · 会卡在边上`,
    };
  }

  // 用**作者画的那条线**（不是圆角后的离散走线）：圆角把每个急转切成十几段，
  // 用它能得到几十个点的路线 —— 看起来乱，而且这些点会盖住时间轴两端拖拽时长的把手。
  // 圆角只是几何观感；路线贴着作者画的折线走即可（转折点仍在梯段内，见 `filletPath`）。
  const path = stairPathOf(stair);
  if (path.length < 2) return { ok: false, text: "这条楼梯没有可走的路径" };

  // 接近段接在**起点那一端之外**：
  // - 向上走 = 坡脚再往外退一段（站在楼梯外的地面上，好有个起步）；
  // - 向下走 = 坡顶再往里一小段（站在到达平台上，先走一步再下）。
  //   往里只退半个梯宽：到达平台正好是"再往外一个梯宽"，这样起点始终落在平台内。
  const bottom = path[0];
  const top = path[path.length - 1];
  const anchor = direction === "up" ? bottom : top;
  const inward = direction === "up" ? path[1] : path[path.length - 2];
  const lead =
    direction === "up" ? Math.min(LEAD_MAX, Math.max(LEAD_MIN, width)) : Math.min(width / 2, LEAD_MAX);
  const dx = anchor.x - inward.x;
  const dz = anchor.z - inward.z;
  const len = Math.hypot(dx, dz);
  const start =
    len <= 1e-6
      ? { x: anchor.x, z: anchor.z }
      : { x: anchor.x + (dx / len) * lead, z: anchor.z + (dz / len) * lead };

  const walk = direction === "up" ? path : [...path].reverse();
  const points = [start, ...walk];

  // 起点处的落脚面 = 他一开始站在哪儿（地面 / 到达平台 / 别的几何上）。
  const startY = restingHeightAt(state, start.x, start.z);

  // 向上走还要求**坡脚够得着**：抬高的楼梯（坡脚悬在 3 m）从地面一步迈不上去。
  if (direction === "up") {
    const footY = objectBottom(stair);
    if (footY - startY > loco.maxStep + 1e-6) {
      return {
        ok: false,
        text:
          `坡脚在 ${r1(footY)} m 高处、起点面只有 ${r1(startY)} m · 一步迈不上去` +
          `（先把它摆到那一层，或从坡顶走下来）`,
      };
    }
  }

  return {
    ok: true,
    plan: { points, startY, slopeDeg, width, stairId: stair.id, direction },
  };
}
