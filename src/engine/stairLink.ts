import { DirectorObject, DirectorState } from "../domain/schema";
import { objectTop, restingHeightAt } from "./ground";
import { LOCOMOTION } from "./locomotion";

/**
 * 「高台连台阶」的**规划**（环形菜单「台阶」→ 点目标 → 预览确认）。
 *
 * ## 哪一头是坡顶：由两端的**面高**决定，不由"谁被选中"决定
 *
 * 这是最容易搞反的一步。作者的心智是"给这座高台连一段上去的台阶"，所以他会先在
 * 高台上点「台阶」、再点地面 —— 如果按"源 = 坡脚"来连，就会得到"从地面连到地面"
 * （高差 0，拒绝）。所以这里的规则是：**谁高谁当坡顶**，另一端当坡脚。
 * 于是三种点法都成立：
 * - 点高台 → 点地面：台阶从地面爬上来（"给这座楼连一段上楼的台阶"）；
 * - 点高台 → 点另一个更高的高台：从低台顶面爬到高台顶面；
 * - 点高台 → 点一个矮台：反过来，从矮台爬上来。
 *
 * 模型只会**向上**（见 docs/3d/00 §9.15 的已知取舍），这条规则正好让"向上"成为
 * 唯一可能的朝向 —— 而作者不需要知道这件事。
 *
 * ## 折线：预览线与最终 `stair.path` 是**同一份**
 *
 * `plan.points` 既拿去画虚线预览，也原样写进 `stair.path` —— 于是"看到的线"与
 * "生成的楼梯"不可能分叉（这是本项目反复踩过的坑：同一样东西有两个出处）。
 * `points[i].y` 是按里程线性插值的**预期表面高**，只用于把预览线画在该在的高度上；
 * 真实几何的高度仍由楼梯自己按总高均摊（含转角平台扣除）。
 *
 * ## 为什么单独一个纯函数
 *
 * 这段几何有几个容易悄悄错的地方，且都只在画面上看得出来：坡脚必须落在**墙外 / 另一端的
 * 顶面上**（否则一段实心台阶从楼里长出来）、总高必须是**两端实测高差**（否则"填了 1.8
 * 却连到 0.3 的台上"）、`run` 必须是**折线长**而不是两端直线距离（否则加了转折点、坡度
 * 读数却不变）。放进 engine 是为了它**能被守卫**（`scripts/check-3d` §33）：
 * store 只负责把结果落库，数学与拒绝文案都在这里。
 *
 * ## 拒绝不是失败
 *
 * 拒绝返回**带数字的人话**（"太陡：水平 15.1 m 要爬 24 m ⇒ 58°（上限 45°）· 水平距离
 * 至少 24 m 才行"），而且**几何仍然给出来**（`plan`）—— 预览线照画，作者往远处点一个
 * 转折点就能看着读数变绿。与 `engine/reach.ts` 的文案同一路子。
 */

/** 边界求交用的极小量：让"正好在墙上"的点明确算在某一侧。 */
const EDGE_EPS = 1e-3;
/** 两端锚点相对墙面的偏移（米）：一端在墙外、一端在墙内，各贴住一堵墙。 */
const ANCHOR_INSET = 0.05;

/**
 * 连台阶的默认宽度（米）。**宽度是"人能不能通过"的基本条件**，所以它是创建时的输入项
 * （预览徽标里可调），不是硬编码 —— 这里只是一个够用的默认值。
 */
export const DEFAULT_STAIR_WIDTH = 1.8;

/**
 * 折线整体横向偏移（**只用于预览**画走廊的两条边界）。
 *
 * 每个点取"相邻两段的平均切向"再转 90°：直线段上就是精确的 `±宽度/2`，拐角处是近似的
 * （真正的 miter 要算交点，不值得为一条预览线引入那套几何）。所以它**不参与任何判定**，
 * 只是让"这条台阶有多宽、人过得去吗"在画布上看得见。
 */
export function offsetPolyline(
  points: ReadonlyArray<{ x: number; z: number; y: number }>,
  lateral: number,
): Array<{ x: number; z: number; y: number }> {
  return points.map((p, index) => {
    const prev = points[index - 1] ?? p;
    const next = points[index + 1] ?? p;
    const tx = next.x - prev.x;
    const tz = next.z - prev.z;
    const len = Math.hypot(tx, tz);
    // 退化（单点 / 全重合）：给一个横向，别产生 NaN。
    if (len <= 1e-9) return { x: p.x + lateral, z: p.z, y: p.y };
    // 法线 = 切向在 XZ 平面内转 90°。
    return { x: p.x + (tz / len) * lateral, z: p.z - (tx / len) * lateral, y: p.y };
  });
}

/** 文案里的数字统一一位小数（与 Inspector 的显示一致）。 */
const r1 = (value: number) => Math.round(value * 10) / 10;

/** 折线上的一个点。`y` 只用于预览画线（见模块说明）。 */
export interface StairLinkPoint {
  x: number;
  z: number;
  y: number;
}

export interface StairLinkPlan {
  /** 坡脚：低端的落点（在低处顶面上，或地面上的点击处）。 */
  start: { x: number; z: number };
  /** 坡顶：高端的落点（在高处物体的顶面之内）。 */
  end: { x: number; z: number };
  startY: number;
  endY: number;
  /** 两端锚点 + 作者加的转折点，**顺序即为楼梯路径顺序**。 */
  points: StairLinkPoint[];
  /** 走廊宽度（米）= 落库时的 `footprint.w`。**人能通过的基本条件**，创建时可调。 */
  width: number;
  /** 走廊的两条边界折线（`±宽度/2`，仅用于预览，见 `offsetPolyline`）。 */
  edges: [StairLinkPoint[], StairLinkPoint[]];
  /** 水平折线长（不是两端直线距离）与总高差（= 楼梯的总高，派生量）。 */
  run: number;
  rise: number;
  /** 派生坡度（度）= `atan(高差 / 折线长)` —— 与 `stairSlopeDeg` 同一口径。 */
  slopeDeg: number;
}

/** 拒绝理由：挂在哪一处、说什么。 */
export interface StairLinkProblem {
  at: [number, number, number];
  text: string;
}

export type StairLinkResult =
  | { ok: true; plan: StairLinkPlan; problem: null }
  /** 几何不合法：`plan` 仍然给出（预览照画），只是不能生成。 */
  | { ok: false; plan: StairLinkPlan; problem: StairLinkProblem }
  /** 语义不合法（目标是自己 / 可运动资产 / 已是楼梯）：没有可画的折线。 */
  | { ok: false; plan: null; problem: StairLinkProblem };

/**
 * 从对象中心朝 `(tx, tz)` 走到 footprint 边界上的点，再沿该方向外推 `offset` 米（负数 = 内收）。
 *
 * 旋转走与 `coversXZ` / `StairMesh` 同源的局部坐标换算（世界 → 局部 → 世界）。
 */
export function edgePoint(
  object: DirectorObject,
  tx: number,
  tz: number,
  offset: number,
): { x: number; z: number } {
  const rad = (object.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = (tx - object.x) * cos - (tz - object.z) * sin;
  const lz = (tx - object.x) * sin + (tz - object.z) * cos;
  const len = Math.hypot(lx, lz);
  if (len <= 1e-6) return { x: object.x, z: object.z };
  const ux = lx / len;
  const uz = lz / len;
  const hw = Math.max(object.footprint.w, 1e-6) / 2 + EDGE_EPS;
  const hd = Math.max(object.footprint.d, 1e-6) / 2 + EDGE_EPS;
  // 射线与矩形的最近交点：分别与 x 侧、z 侧求交，取更近的那个。
  const t = Math.min(
    Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Number.POSITIVE_INFINITY,
    Math.abs(uz) > 1e-9 ? hd / Math.abs(uz) : Number.POSITIVE_INFINITY,
  );
  const ex = ux * t + ux * offset;
  const ez = uz * t + uz * offset;
  return { x: object.x + ex * cos + ez * sin, z: object.z - ex * sin + ez * cos };
}

/**
 * 规划一段台阶：`target` 非空 = 连到那个高台，空 = 连到地面上的 `(x, z)`。
 * `bends` 是作者在预览里加的转折点（世界 x/z，按点击顺序）。
 *
 * 坡度上限取**人的能力表**（`LOCOMOTION.human`）：连台阶是"给会走的人走"的默认意图，
 * 逐主体的判定仍由 `avoidance.isPassable` 在运行时按各自的能力表做。
 */
export function planStairLink(
  state: DirectorState,
  source: DirectorObject,
  target: DirectorObject | undefined,
  x: number,
  z: number,
  bends: ReadonlyArray<{ x: number; z: number }> = [],
  width: number = DEFAULT_STAIR_WIDTH,
): StairLinkResult {
  if (target?.id === source.id) {
    return {
      ok: false,
      plan: null,
      problem: {
        at: [source.x, objectTop(source), source.z],
        text: "目标就是起点自己 · 点另一个高台或地面",
      },
    };
  }
  if (target && target.role !== "set") {
    return {
      ok: false,
      plan: null,
      problem: {
        at: [target.x, objectTop(target), target.z],
        text: "目标是可运动资产 · 只能连高台或地面",
      },
    };
  }
  if (target?.topShape === "stair") {
    return {
      ok: false,
      plan: null,
      problem: {
        at: [target.x, objectTop(target), target.z],
        text: "目标已经是楼梯 · 点高台或地面",
      },
    };
  }

  const sourceY = objectTop(source);
  const targetY = target ? objectTop(target) : restingHeightAt(state, x, z);
  // 谁高谁当坡顶（见模块说明）—— 于是"先点高台再点地面"也能连对。
  const sourceHigher = sourceY >= targetY;
  const lowObject = sourceHigher ? target : source;
  const highObject = sourceHigher ? source : target;
  const startY = Math.min(sourceY, targetY);
  const endY = Math.max(sourceY, targetY);

  // 锚点：对象 → 朝另一端、**墙内 0.05**（落在自己的顶面上，不从楼里长出来）；
  //       地面 → 就是点击处（地形起伏也照样对）。
  const towardSource = { x: source.x, z: source.z };
  const towardTarget = target ? { x: target.x, z: target.z } : { x, z };
  const click = { x, z };
  const anchor = (object: DirectorObject | undefined, toward: { x: number; z: number }) =>
    object ? edgePoint(object, toward.x, toward.z, -ANCHOR_INSET) : click;
  const start = anchor(lowObject, sourceHigher ? towardSource : towardTarget);
  const end = anchor(highObject, sourceHigher ? towardTarget : towardSource);

  const flat = [start, ...bends, end];
  const run = flat.reduce(
    (sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p.x - flat[i - 1].x, p.z - flat[i - 1].z)),
    0,
  );
  const rise = endY - startY;
  const slopeDeg = run > 0 ? (Math.atan2(rise, run) * 180) / Math.PI : 89;

  // 预览线的 y：按里程线性插值（见模块说明）—— 于是线就是"坡该在的位置"。
  let walked = 0;
  const points: StairLinkPoint[] = flat.map((p, i) => {
    if (i > 0) walked += Math.hypot(p.x - flat[i - 1].x, p.z - flat[i - 1].z);
    return { x: p.x, z: p.z, y: startY + (run > 0 ? (rise * walked) / run : 0) };
  });
  const plan: StairLinkPlan = {
    start,
    end,
    startY,
    endY,
    points,
    width,
    edges: [offsetPolyline(points, width / 2), offsetPolyline(points, -width / 2)],
    run,
    rise,
    slopeDeg,
  };
  // 拒绝时把理由挂在**出问题的那一处**（默认是坡顶；宽度问题挂在折线中点 —— 它不是端点的事）。
  const fail = (text: string, at?: [number, number, number]): StairLinkResult => ({
    ok: false,
    plan,
    problem: { at: at ?? [end.x, endY, end.z], text },
  });

  if (run <= 0.2) return fail("两端几乎在同一处 · 把落点挪远一点");
  if (rise <= 0.05) {
    return fail(`两侧面几乎等高（${r1(startY)} m / ${r1(endY)} m）· 台阶要有高差`);
  }
  // 宽度：比人的脚宽还窄就走不上去 —— "人能不能通过"的硬条件，与坡度同级。
  const minWidth = LOCOMOTION.human?.foot.w ?? 0.6;
  if (width < minWidth) {
    const middle = points[Math.floor(points.length / 2)];
    return fail(
      `宽度 ${r1(width)} m 比人的脚宽 ${r1(minWidth)} m 还窄 · 人过不去`,
      [middle.x, middle.y, middle.z],
    );
  }
  const maxSlope = LOCOMOTION.human?.maxSlopeDeg ?? 45;
  if (slopeDeg > maxSlope) {
    const needRun = r1(rise / Math.tan((maxSlope * Math.PI) / 180));
    return fail(
      `太陡：折线长 ${r1(run)} m 要爬 ${r1(rise)} m ⇒ ${Math.round(slopeDeg)}°` +
        `（上限 ${maxSlope}°）· 折线长至少 ${needRun} m 才行 —— 往旁边加个转折点拉长它`,
    );
  }
  return { ok: true, plan, problem: null };
}

/**
 * 把一个转折点插进折线：插在**离它最近的那一段**之后（与 `engine/path` 的
 * `addPathPoint` 同一套"点线上加点"的手感）。
 *
 * 返回新的 `bends` 数组（不含两端锚点）。只在预览状态下用得到 —— 落库时折线是
 * 一次性写进 `stair.path` 的。
 */
export function insertBend(
  plan: StairLinkPlan,
  bend: { x: number; z: number },
): Array<{ x: number; z: number }> {
  // 采样折线（去掉两端锚点 = bends 本身），找最近的一段，插在它后面。
  const mid = plan.points.slice(1, -1).map((p) => ({ x: p.x, z: p.z }));
  if (plan.points.length < 2) return [...mid, bend];
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 1; i < plan.points.length; i += 1) {
    const a = plan.points[i - 1];
    const b = plan.points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((bend.x - a.x) * dx + (bend.z - a.z) * dz) / len2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const distance = Math.hypot(bend.x - px, bend.z - pz);
    if (distance < bestDistance) {
      bestDistance = distance;
      // 插入位置：这一段在第 i-1 与第 i 点之间 ⇒ bends 里的下标是 i-1。
      bestIndex = i - 1;
    }
  }
  const next = [...mid];
  next.splice(bestIndex, 0, bend);
  return next;
}
