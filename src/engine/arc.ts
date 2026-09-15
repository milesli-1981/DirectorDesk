import { Locomotion, VerticalArc } from "../domain/schema";

/**
 * 垂直弧线：把「沿路径走」的**归一化里程**映射到高度。
 *
 * ## 关键设计：apex 由作者定，可达性由包络校验
 *
 * 这是本方案与"真物理"最重要的分歧点（docs/3d/02 §4）：
 *
 * **不做** —— 给定 `vy0` 和 `vh` 自动算出轨迹（物理正确，但导演无法控制"跳多高"）。
 * **要做** —— 把**顶点高度 `apex` 作为作者旋钮**（UI 上直接拖弧线顶点），
 *           系统只做可行性校验（见 `engine/jump.ts` 的 `checkJumpArc`）。
 *
 * 于是轨迹退化成 `s` 的**闭式函数**，与水平速度完全解耦 ——
 * 路径的 `ease` / `speedKeys` 不需要为跳跃做任何改动，跳跃自动跟着路径走向走。
 *
 * ## 时间无关（缓存稳定性的同一根红线）
 *
 * 这些函数**只读弧线自身的参数**（`mode` / `apex` / `climbSeconds`）
 * 与传入的起止高度，**不读 `currentTime`、不读 `state`**。
 * 所以对一条固定弧线，`arcHeightAt` 是纯函数 —— 正反向擦洗一致，可按 revision 缓存，
 * 与 `routeHeightFor`（avoidance.ts）遵守同一条不变量。
 */

/** 弧线起跳 / 落地的提前量（米，沿路径里程折算）—— 见 docs/3d/02 §6。 */
export const RUNUP_MARGIN = 0.25;

/**
 * 弧线高度。`s` ∈ [0, 1] 是**弧线区间内**的归一化里程（`s=0` 起跳、`s=1` 落地）。
 *
 * - `parabola`：`groundAtStart + apex · 4s(1−s)`，标准抛物线，`s=0.5` 达顶点。
 *               注意顶点高度是 `apex`（相对起跳点地面），不是 `Δh`。
 * - `fall`    ：`y0 + (y1 − y0) · s²`（加速下坠）。用 `s²` 而非线性 ——
 *               线性会像"电梯下坠"，`s²` 才有重力加速感，且同样是闭式函数。
 * - `climb`   ：三段 L 形贴墙 —— 水平靠近段高度不变 → 竖直上移 → 水平落到面。
 *               竖直段占中间 40% 的时间（`[0.3, 0.7]`），其余是两段水平。
 *
 * @param arc           弧线定义
 * @param s             弧线区间内归一化里程 0..1
 * @param groundAtStart 起跳点地面高度
 * @param y1            落点面高度（仅 `fall` / `climb` 用）
 */
export function arcHeightAt(
  arc: VerticalArc,
  s: number,
  groundAtStart: number,
  y1: number,
): number {
  const t = Math.max(0, Math.min(1, s));
  switch (arc.mode) {
    case "parabola": {
      const apex = arc.apex ?? 0;
      return groundAtStart + apex * 4 * t * (1 - t);
    }
    case "fall": {
      const d = y1 - groundAtStart;
      return groundAtStart + d * t * t;
    }
    case "climb": {
      const d = y1 - groundAtStart;
      // 竖直上移发生在 [0.3, 0.7]（含缓入缓出），两端是水平靠近 / 落面。
      const V0 = 0.3;
      const V1 = 0.7;
      if (t <= V0) return groundAtStart;
      if (t >= V1) return y1;
      const k = (t - V0) / (V1 - V0);
      // 竖直段用 smoothstep，避免速度突变（视觉上更贴合"引体 / 跨上"）。
      const e = k * k * (3 - 2 * k);
      return groundAtStart + d * e;
    }
    default:
      return groundAtStart;
  }
}

/**
 * 弧线的竖直速度方向（符号 + 相对大小），供姿态（Phase 7）与轨迹采样用。
 * 用中心差分求导，步长 0.01 —— 与 `solver.ts` 既有求瞬时速度的差分同源思路。
 */
export function arcVerticalSpeed(
  arc: VerticalArc,
  s: number,
  groundAtStart: number,
  y1: number,
): number {
  const h = 0.01;
  const a = Math.max(0, s - h);
  const b = Math.min(1, s + h);
  if (b === a) return 0;
  return (arcHeightAt(arc, b, groundAtStart, y1) - arcHeightAt(arc, a, groundAtStart, y1)) / (b - a);
}

/**
 * 弧线区间 [from, to] 内的统一取值器：
 * 传**整条路径**的归一化里程 `u`，落在区间外按端点夹取。
 *
 * `from` / `to` 缺省即整段路径（0 → 1）。
 */
export function arcAtU(
  arc: VerticalArc,
  u: number,
  groundAtStart: number,
  y1: number,
): number {
  const from = arc.from ?? 0;
  const to = arc.to ?? 1;
  if (to <= from) return arcHeightAt(arc, 0, groundAtStart, y1);
  const s = (u - from) / (to - from);
  return arcHeightAt(arc, s, groundAtStart, y1);
}

/**
 * 起跳点是否需要"贴着边缘"提前抬起。
 *
 * 真实 bug（3D 游戏里很常见）：若起跳点恰等于起跳面边缘里程，人会**先踏空再起跳** ——
 * 脚在面外、身体才开始上升，看起来像"从悬崖上掉起来"。
 *
 * 规则：起跳点应**早于**边缘 `margin`，落点应**晚于**落点面边缘 `margin`。
 * `marginU` = `RUNUP_MARGIN / 总里程`，由调用方按几何算出（Path 总长已知）。
 *
 * 返回**收窄后**的 `{ from, to }`（仍是路径归一化里程）。
 */
export function runupAdjusted(
  arc: VerticalArc,
  marginU: number,
): { from: number; to: number } {
  const from = arc.from ?? 0;
  const to = arc.to ?? 1;
  const f = Math.min(from + marginU, (from + to) / 2);
  const t = Math.max(to - marginU, (from + to) / 2);
  return { from: f, to: t };
}

/**
 * 本弧线适用的默认水平缓动：**准线性**。
 *
 * 默认 cubic-bezier 在 `u = 0` 处斜率为 0（见 ease.ts），而跳跃的 `from` 通常就落在段起点附近 ——
 * 结果是水平速度为零、人在原地弹起原地落下，看起来完全不像跳跃。
 * 解决：跳跃段内覆盖 ease 为准线性，保证起跳瞬间有水平速度（docs/3d/02 §5）。
 */
export const JUMP_EASE = [0.15, 0.15, 0.85, 0.85] as const;

/* ------------------------------------------------------- 与路径几何的桥接 */

/**
 * 弧线起跳 / 落点面的边缘里程半径（转成归一化里程）。
 * @param totalLen 该段路径总里程（米）
 */
export function runupMarginU(totalLen: number): number {
  return totalLen > 1e-6 ? RUNUP_MARGIN / totalLen : 0;
}

/**
 * 一段弧线是否"根本不产生垂直运动" —— 用于 planar 退化与省算。
 * 例如 `parabola` 且 `apex ≈ 0`，或 `fall` 且起落同高。
 */
export function arcIsFlat(arc: VerticalArc, groundAtStart: number, y1: number): boolean {
  if (arc.mode === "parabola") return Math.abs(arc.apex ?? 0) < 1e-6;
  if (Math.abs(y1 - groundAtStart) < 1e-6) return true;
  return false;
}

/**
 * 顶点拖拽专用（时间轴 mini 弓形把手 → 改 `apex`，见 `docs/3d/03-UI可达性提示.md` §12）：
 * **只改写 `apex`，保留 `mode` 与弧线其它字段**，返回新对象、不就地修改。
 *
 * 这是 `setSegmentArcApex` 的全部逻辑搬进纯函数 —— 目的是让"拖顶点不会顺手改掉作者
 * 手感（ease 在 segment 层、本就不在 `arc` 里，但重写必须保证连 `arc` 其它字段都不动）"
 * 这条契约能被 `scripts/check-3d.ts` §31 直接钉死，而不必把整个 zustand store 拉进 node 自检
 * （store 用了 `import.meta.glob`，esbuild 打不出来）。
 *
 * 注意：`apex` 下限钳到 0 —— 作者把顶点拖到地面以下没有物理意义。
 */
export function rewriteArcApex(arc: VerticalArc, apex: number): VerticalArc {
  return { ...arc, apex: Math.max(0, apex) };
}

/**
 * 按能力自动挑选垂直弧线的档案（导演没显式给时用）。
 * 阈值全在 `loco` 上 —— 见 `engine/jump.ts` 的 `classifyGap`。
 */
export function suggestArcMode(kind: "step" | "drop" | "jump" | "climb" | "flat", loco: Locomotion): VerticalArc["mode"] | null {
  switch (kind) {
    case "jump":
      return "parabola";
    case "drop":
      return "fall";
    case "climb":
      return loco.maxClimbHeight > 0 ? "climb" : null;
    default:
      return null; // flat / step：直接走过，不需弧线
  }
}
