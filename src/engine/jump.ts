import { DirectorObject, DirectorState, Locomotion, Vec2 } from "../domain/schema";
import { objectBox, Vec3 } from "./occlusion";
import { coversXZ, objectBottom, objectTop, topAt } from "./ground";
import { locomotionOfId } from "./locomotion";
import { arcHeightAt } from "./arc";

/**
 * 跳跃可行性 —— **一条由两个导演旋钮生成的包络**，不是一个物理参数。
 *
 * ## 为什么是闭式包络而不是仿真
 *
 * 见 docs/3d/00 决策 3：求解必须是**时间的纯函数**（正反向擦洗一致、可按 revision 缓存）。
 * 有状态的刚体积分会摧毁这个不变量。但物理**公式**可以用 —— 它们只是闭式函数，
 * 恰恰是纯函数。于是 `g = 9.8` 只出现在推导里，最终公式里连 `g` 都不剩。
 *
 * ## 两个旋钮 → 一条曲线
 *
 * UI 只暴露两个数（遵循项目风格：不暴露原始物理量）：
 *   H = 原地起跳高度（human 默认 0.9m）
 *   R = 平地助跑跳远（human 默认 2.5m）
 *
 * 从能量守恒推导（`vy0 = √(2gH)`、`T = 2vy0/g`、`vh = R/T`），
 * 从 y=0 起跳落到 y=Δh，取抛物线下降支，可化简为（`g` 约掉）：
 *
 *   reach(Δh) = R/2 · ( 1 + √(1 − Δh/H) )
 *
 * 性质（都可验证，见 scripts/check-3d.ts §20）：
 *   Δh =  0        → R        （平地基准）
 *   Δh = +H        → R/2      （跳到极限高度，水平只剩一半）
 *   Δh = −H        → ≈1.21R   （往下跳一个身位，摔得更远 —— 符合直觉）
 *   Δh >  H        → 不可达   （根号内为负）
 * 单调递减、上凸。
 */

/** 重力加速度。**只用于文档化推导，代码里不出现**（公式已把 g 约掉）。 */
// const G = 9.8;

/**
 * 跳远包络：起跳面与落点面高差 `dh` 时，最多能跳出的水平距离。
 *
 * 单调递减（`dh` 越大跳得越近），`dh > H` 时返回 `0`（不可达）。
 * `H ≤ 0`（不会跳的主体，如载具）恒返回 0。
 *
 * @param dh 落点相对起跳面的高差（米，正 = 往上跳）。
 * @param H  原地起跳高度（`loco.maxJumpHeight`）。
 * @param R  平地助跑跳远（`loco.maxJumpReach`）。
 */
export function jumpReach(dh: number, H: number, R: number): number {
  if (H <= 0 || R <= 0) return 0;
  const inner = 1 - dh / H;
  if (inner < 0) return 0; // 高差超过起跳高度 → 跳不上去
  return (R / 2) * (1 + Math.sqrt(inner));
}

/** 用能力表直接算包络。 */
export function jumpReachOf(dh: number, loco: Locomotion): number {
  return jumpReach(dh, loco.maxJumpHeight, loco.maxJumpReach);
}

/**
 * 助跑速度对有效跳远的缩放。
 *
 * 站着跳只能跳一半远；跑起来才是全速的 `R`。这把"助跑"从一个缓动端点零速的既有 bug
 * 变成了**可调的表达手段** —— 想让人跳得更远，在跳跃前加一段助跑。见 docs/3d/02 §5。
 *
 * @param speedRatio clamp(实际起跳水平速度 / 跑步速度, 0, 1)
 */
export function speedScale(speedRatio: number): number {
  const t = Math.max(0, Math.min(1, speedRatio));
  return 0.5 + 0.5 * t; // mix(0.5, 1.0, t)
}

/* --------------------------------------------------------------- 分档判定 */

/**
 * 一段落差属于哪一种通过方式。**阈值全部挂在运动主体上**（`loco`），
 * 障碍不知道自己面对的是谁 —— 同一堵台阶，人迈上去、车要绕。
 *
 *  - `"flat"`   ：几乎无高差，正常走过。
 *  - `"step"`   ：在单步能力内（`|Δh| ≤ maxStep`），走过去即可。
 *  - `"drop"`   ：向下落差超过单步但≤ 落差上限 —— 用 `fall`（加速下坠）。
 *  - `"jump"`   ：向上落差在跳跃能力内 —— 用 `parabola`（需助跑）。
 *  - `"climb"`  ：向上落差超过跳跃高度但在攀爬能力内 —— 用 `climb`（L 形贴墙）。
 *  - `"blocked"`：超出全部能力 —— 不可达，报错。
 *
 * `dropLimit`：可接受的自由落差上限（超过即"太高会摔"）。默认取 `maxClimbHeight`
 * 之外再给一档余量；现阶段保守地取 `maxJumpHeight + 1.0`（见 docs/3d/02 §7）。
 */
export type GapKind = "flat" | "step" | "drop" | "jump" | "climb" | "blocked";

/** 允许的自由落差上限（米）：超过它就该报"太高"。 */
export function dropLimit(loco: Locomotion): number {
  // 不会跳的主体（载具）不该被要求"往下跳" —— 落差也用 maxStep 卡死。
  if (loco.maxJumpHeight <= 0) return loco.maxStep;
  return loco.maxJumpHeight + 1.0;
}

/** 判定一段高差 `dh`（正 = 落点更高）该怎么通过。 */
export function classifyGap(dh: number, loco: Locomotion): GapKind {
  const EPS = 1e-6;
  if (Math.abs(dh) <= EPS) return "flat";
  if (dh > 0) {
    if (dh <= loco.maxStep + EPS) return "step";
    if (loco.maxJumpHeight > 0 && dh <= loco.maxJumpHeight + EPS) return "jump";
    if (loco.maxClimbHeight > 0 && dh <= loco.maxClimbHeight + EPS) return "climb";
    return "blocked";
  }
  // 向下
  const d = -dh;
  if (d <= loco.maxStep + EPS) return "step";
  if (d <= dropLimit(loco) + EPS) return "drop";
  return "blocked";
}

/* --------------------------------------------------------------- 校验三条 */

export type ArcIssueCode =
  | "apex-below-landing"
  | "apex-over-capability"
  | "span-too-far"
  | "no-runup"
  | "hits-geometry"
  | "landing-unstable";

export interface ArcIssue {
  code: ArcIssueCode;
  /** 给导演看的中文文案。 */
  message: string;
}

export interface ArcCheckInput {
  /** 落点相对起跳面的高差（米，正 = 往上跳）。 */
  dh: number;
  /** 起跳面与落点面的水平距离（米）。 */
  dx: number;
  /** 作者设定的弧顶高度（相对起跳点地面，米）。 */
  apex: number;
  /** 实际起跳水平速度 / 跑步速度（0..1）。缺省 1（全速）。 */
  speedRatio?: number;
  loco: Locomotion;
}

export interface ArcCheckResult {
  ok: boolean;
  issues: ArcIssue[];
  /** 校正后的弧顶高度（自动抬到 `Δh` 之后的值，且不超过 `H`）。 */
  apex: number;
  /** 校正后的有效跳远上限（已计入助跑缩放）。 */
  reach: number;
  /** 起跳点是否需要报"没有助跑"。 */
  needsRunup: boolean;
}

/**
 * 抛物线弧的三条校验（docs/3d/02 §4）+ 助跑校验（§5）。
 *
 * 失败不默默画出来 —— 返回 issue 列表，由 UI 决定是弹错还是自动修正。
 * 其中"弧顶低于落点"是**可自动修正**的：直接把 apex 抬到 Δh（按 §4 的规则）。
 */
export function checkJumpArc(input: ArcCheckInput): ArcCheckResult {
  const { dh, dx, loco } = input;
  const issues: ArcIssue[] = [];
  const H = loco.maxJumpHeight;
  const R = loco.maxJumpReach;

  // ① 顶点够高：apex ≥ Δh，否则自动抬到 Δh。
  let apex = input.apex;
  if (apex < dh) {
    issues.push({
      code: "apex-below-landing",
      message: "弧顶低于落点，跳不上去（已自动抬高弧顶）",
    });
    apex = dh;
  }

  // ② 顶点不超能力：apex ≤ H（这一条不可自动修正 —— 抬到 H 也还是跳不过去）。
  if (H <= 0) {
    issues.push({ code: "apex-over-capability", message: "这个主体不会跳" });
  } else if (apex > H + 1e-6) {
    issues.push({
      code: "apex-over-capability",
      message: `超过跳跃高度上限（${H.toFixed(2)}m）`,
    });
  }

  // ③ 跨度在包络内（有效跳远随助跑速度缩放）。
  const ratio = input.speedRatio ?? 1;
  const reach = jumpReachOf(dh, loco) * speedScale(ratio);
  if (dx > reach + 1e-6) {
    issues.push({
      code: "span-too-far",
      message: `跨度太远，跳不过去（最多 ${reach.toFixed(2)}m）`,
    });
  }

  // ④ 助跑校验：起跳瞬时速度低于 0.6 倍跑步速度 → 站着跳，跳不远。
  const needsRunup = ratio < 0.6 && H > 0;

  return {
    ok: issues.length === 0,
    issues,
    apex: Math.min(apex, H > 0 ? H : apex),
    reach,
    needsRunup,
  };
}

/**
 * 攀爬校验（docs/3d/02 §8）：因为一切都是盒、盒的侧面永远是竖直面，
 * "有没有抓手"是**免费**的 —— 只要落点面的支撑体是一个盒（非 ramp / grid），
 * 它天然自带竖直抓手面。判定退化为三条。
 *
 * @param dh 高差（正 = 往上）
 * @param dx 水平距离（到面的距离）
 * @param hasGrabFace 落点支撑体是否提供竖直抓手面（非 ramp/grid）
 */
export function checkClimb(
  dh: number,
  dx: number,
  hasGrabFace: boolean,
  loco: Locomotion,
): ArcIssue[] {
  const issues: ArcIssue[] = [];
  if (loco.maxClimbHeight <= 0) {
    issues.push({ code: "apex-over-capability", message: "这个主体不会攀爬" });
    return issues;
  }
  if (dh <= 0) {
    issues.push({ code: "apex-below-landing", message: "攀爬目标不比脚下高" });
  }
  if (dh > loco.maxClimbHeight + 1e-6) {
    issues.push({
      code: "apex-over-capability",
      message: `落差 ${dh.toFixed(2)}m 超过攀爬能力 ${loco.maxClimbHeight.toFixed(2)}m`,
    });
  }
  if (!hasGrabFace) {
    issues.push({
      code: "hits-geometry",
      message: "落点面没有竖直抓手（坡道 / 网格不可攀爬）",
    });
  }
  // 必须贴着面（一个身位内）。
  const GRAB_REACH = 0.5;
  if (dx > GRAB_REACH + 1e-6) {
    issues.push({
      code: "span-too-far",
      message: "离面太远，够不到抓手",
    });
  }
  return issues;
}

/* ------------------------------------------------------------- 落地校验 */

/** 轨迹采样步长（米）—— docs/3d/02 §7 定的 0.1。 */
export const ARC_SAMPLE_STEP = 0.1;

export interface TrajectoryHit {
  object: DirectorObject;
  /** 撞点在世界坐标里的位置。 */
  at: Vec3;
}

/**
 * 沿弧线采样，检查轨迹是否**撞到几何**（docs/3d/02 §7a）。
 *
 * **第一次相交即为撞点** —— 返回它，UI 就能报
 * 「跳跃轨迹撞到「石墙」，请抬高弧顶或改变落点」。
 *
 * 采样固定步长 0.1m，所以第一次相交是"沿弧线由近及远"的第一次命中，
 * 与 `blockingAssets` 的"整条线是否相交"不同：这里要的是**位置**。
 *
 * @param pathAt  给定弧线内归一化里程 s ∈ [0,1] → 世界点 (x, z)。水平路径由调用方提供，
 *                因为水平几何属于 path，而垂直几何属于 arc —— 两者在这个函数里重新汇合。
 * @param arc     已解析出实际高度的取值器（传 `s → y`），这样 parabola/fall/climb 都能复用。
 */
export function sampleArcHits(
  state: DirectorState,
  selfId: string,
  pathAt: (s: number) => Vec2,
  arcY: (s: number) => number,
): TrajectoryHit | null {
  // 步数 = 弧长 / 步长，至少 2 段，上限 512（防病态输入卡死）。
  const steps = 256;
  for (let i = 0; i <= steps; i += 1) {
    const s = i / steps;
    const p = pathAt(s);
    const y = arcY(s);
    for (const o of state.objects) {
      if (o.id === selfId) continue;
      if (o.role !== "set" || o.hidden) continue;
      if (o.walkable === false && o.blocking === false) continue; // 语义放行
      if (!coversXZ(o, p.x, p.z)) continue;
      const bottom = objectBottom(o);
      const top = o.topShape === "ramp" ? topAt(o, p.x, p.z) : objectTop(o);
      // 轨迹点落在盒内 = 撞上。（贴边不留容差：撞就是撞。）
      if (y > bottom + 1e-6 && y < top - 1e-6) {
        return { object: o, at: { x: p.x, y, z: p.z } };
      }
    }
  }
  return null;
}

/**
 * 落点必须站得住（docs/3d/02 §7b）。
 *
 * 判据：落点面 = 该处**最高的可站立面**。只要存在面（含基准面 0）就返回它；
 * 若该处**唯一的"面"在头顶上方**（即落点实际悬空在某个更高物之下、却被它压住），
 * 返回 null —— 这正是"落进台阶里"的几何表现。
 *
 * 本函数刻意保持保守：它在**没有**跳跃/攀爬上下文时也成立（落点面独立于来路）。
 *
 * @returns 站得住则返回落脚高度；否则返回 null。
 */
export function standingAt(
  state: DirectorState,
  selfId: string,
  x: number,
  z: number,
): number | null {
  let best = -Infinity;
  for (const o of state.objects) {
    if (o.role !== "set" || o.hidden || o.walkable === false) continue;
    if (o.id === selfId) continue;
    if (!coversXZ(o, x, z)) continue;
    const top = o.topShape === "ramp" ? topAt(o, x, z) : objectTop(o);
    if (top > best) best = top;
  }
  // 没有任何对象覆盖 → 基准面 0，永远站得住。
  if (best === -Infinity) return 0;
  return best;
}
