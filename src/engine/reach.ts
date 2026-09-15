import { DirectorState, Locomotion, MoveSegment, Vec2, VerticalArc } from "../domain/schema";
import { arcHeightAt, arcIsFlat, suggestArcMode } from "./arc";
import {
  classifyGap,
  dropLimit,
  GapKind,
  GRAB_REACH,
  jumpReachOf,
  speedScale,
} from "./jump";
import { coversXZ, objectBottom, objectTop, topAt } from "./ground";
import { locomotionOf, RUN_SPEED } from "./locomotion";
import { segmentRoutePoints } from "./path";
import { arcActive, arcEndHeights } from "./pathHeight";
import { curveVal, normalizeEase } from "./ease";
import { routeObstaclesFor } from "./solver";
import { worldModeOf } from "./worldMode";

/**
 * 可达性分档 —— 把「这条路走不走得过去」变成 UI 能直接消费的东西。
 *
 * ## 为什么单独开一个模块
 *
 * 分档要同时喂给三处：画布的路径着色、Inspector 的可达性面板、全局体检。
 * 三处各写一遍判定的话，必然出现"线是红的、面板说可走"这类不可调试的分叉
 * （项目已经在 `pathGroundAt` / `segmentRoutePoints` 上踩过两次同样的坑）。
 * 所以判定只在**这里**发生，其它地方只消费 `ReachSpan` / `ReachFinding`。
 *
 * ## 纯函数（红线 10）
 *
 * 本模块**只读静态几何**（`state.objects` / `state.segments`），不读 `currentTime`。
 * 于是同 revision 内结果恒定，可以安全地放进 `useMemo` 与缓存；
 * 一旦有人让它读时间，所有调用方都会退化成逐帧重算。
 *
 * ## planar 不变性
 *
 * `worldModeOf(state) !== "terrain"` 时 `segmentSpans` 直接返回空数组 ——
 * 没有可达性问题这回事，画布上也就不会多出任何一条新线。
 * 这不是 `if (planar)` 特判，而是"能力表退化"的另一半：planar 下
 * `maxStep = maxJump = maxClimb = 0`，地面恒为 0，判定本就恒等于"可走"。
 */

/** 导航层路线离脚下的抬升（米）。沿用既有写死的 0.13，保持视觉不变。 */
export const ROUTE_LINE_LIFT = 0.13;

/** 弧顶相对落点的安全余量（米）—— docs/3d/03 §5「生成弧线」的规则。 */
export const APEX_MARGIN = 0.15;

/** 头顶净空余量（米）。与 `avoidance.ts` 的 `HEAD_CLEARANCE` 同义。 */
const HEAD_ROOM = 0.15;

/**
 * 带弧线的 span 至少切成这么多段。
 *
 * 必要性：一次上下台阶的落差往往**只跨一个采样点**（16 点/腿，约 0.6m 一格），
 * 而抛物线 `4t(1−t)` 在 t=0 与 t=1 都是 0 —— 只画两个端点的话，
 * 弓形**完全不可见**，等于没画。这里按弧长重采样，形状才出得来。
 */
const ARC_SPAN_STEPS = 16;

/* ------------------------------------------------------------------ 分档 */

/** 可达性档位。定义见 docs/3d/03 §1（4 / 5 两档保留位，暂不判定）。 */
export type ReachTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ReachStyle {
  /** 线色。全部取自项目现有色板，没有新造颜色。 */
  color: string;
  /** 线宽。分档本身也是"不靠颜色也能读"的手段之一。 */
  width: number;
  dashed: boolean;
  dashSize: number;
  gapSize: number;
  /** 面板文案。 */
  label: string;
  /** 徽标字形。 */
  glyph: string;
}

/**
 * 档位 → 视觉。
 *
 * 0 档刻意保持既有的 `#f0a35a` 虚线 —— 现有场景的视觉零变化是硬要求。
 * 色盲可读性靠**线型 + 字形 + 线宽**三重冗余，不单靠颜色。
 */
export const REACH_STYLES: Record<ReachTier, ReachStyle> = {
  0: { color: "#f0a35a", width: 1.5, dashed: true, dashSize: 0.35, gapSize: 0.25, label: "可走", glyph: "" },
  1: { color: "#ff9f0a", width: 2, dashed: false, dashSize: 0, gapSize: 0, label: "需跳跃", glyph: "⌒" },
  2: { color: "#bf5af2", width: 2, dashed: true, dashSize: 0.12, gapSize: 0.18, label: "需攀爬", glyph: "⌐" },
  3: { color: "#ff453a", width: 2.5, dashed: true, dashSize: 0.15, gapSize: 0.15, label: "不可达", glyph: "✕" },
  4: { color: "#8e8e93", width: 1.5, dashed: true, dashSize: 0.3, gapSize: 0.2, label: "站不稳", glyph: "≈" },
  5: { color: "#8e8e93", width: 1.5, dashed: true, dashSize: 0.3, gapSize: 0.2, label: "站不直", glyph: "" },
  6: { color: "#ff9f0a", width: 2, dashed: false, dashSize: 0, gapSize: 0, label: "落差", glyph: "⤓" },
};

/**
 * 一段高差该怎么通过 → 档位。
 *
 * `classifyGap` 只按 `dh` 分（"这一步属于哪一类动作"），
 * 而**跨度**是第二个独立判据 —— 跳得上去但差 3 米，一样是过不去。
 * 所以这里再叠一次 `dx` 与包络 / 够手距离的比较。
 */
export function tierOfGap(
  dh: number,
  dx: number,
  loco: Locomotion,
): { tier: ReachTier; reach: number } {
  switch (classifyGap(dh, loco)) {
    case "flat":
    case "step":
      return { tier: 0, reach: 0 };
    case "jump": {
      const reach = jumpReachOf(dh, loco) * speedScale(1);
      return { tier: dx <= reach + 1e-6 ? 1 : 3, reach };
    }
    case "climb":
      // 抓手判定（ramp / grid 没有竖直面）在**段级**才做（那里能拿到支撑体），
      // 这里只看够不够得着 —— 见 `segmentFindings`。
      return { tier: dx <= GRAB_REACH + 1e-6 ? 2 : 3, reach: GRAB_REACH };
    case "drop":
      return { tier: 6, reach: 0 };
    default:
      return { tier: 3, reach: 0 };
  }
}

/** 说人话、带数字的文案（docs/3d/03 §6）。 */
export function reachMessage(tier: ReachTier, dh: number, dx: number, reach: number, loco: Locomotion): string {
  const up = `${dh >= 0 ? "+" : "−"}${Math.abs(dh).toFixed(2)}m`;
  switch (tier) {
    case 1:
      return `需跳跃 · 高差 ${up} · 跨度 ${dx.toFixed(2)}m`;
    case 2:
      return `需攀爬 · 高差 ${up}`;
    case 6:
      return `下落 ${Math.abs(dh).toFixed(2)}m`;
    case 3:
      if (dh > 0 && dh > loco.maxClimbHeight) {
        return `这里落差 ${dh.toFixed(2)} 米，超过攀爬能力 ${loco.maxClimbHeight.toFixed(2)} 米`;
      }
      if (dh < 0) {
        return `下落 ${Math.abs(dh).toFixed(2)} 米太高，最多 ${dropLimit(loco).toFixed(2)} 米`;
      }
      if (dx > reach + 1e-6) {
        return `跨度 ${dx.toFixed(2)} 米，最远只能跳 ${reach.toFixed(2)} 米`;
      }
      return "过不去";
    default:
      return "";
  }
}

/* -------------------------------------------------------------- 地面剖面 */

/**
 * 沿路线逐点求「脚下的地面高度」。
 *
 * 与 `avoidance.ts` 的 `standingTopAt` 同族（取最高可站立面），但多一道判据：
 * **底面高过头顶的面不算脚下** —— 从桥下走过时脚下的面是地面，不是桥面。
 * 少了这道判据，任何桥下穿行都会被误报成"要爬 3 米"（§26 有回归守卫）。
 *
 * 天花板随**上一个采样点的高度**滚动，于是"先上台阶再走上桥面"能自然收敛；
 * 起步高度取作者摆放的层高 `baseY`（"我把这个演员放在哪一层"），
 * 与 Inspector 里 Δh 的无上限语义同源。
 *
 * 同时交回"是哪块几何撑起了这个高度" —— 修复动作必须能**点名对象**
 * （docs/3d/03 §5：「把「石墙」高度从 3.0m 降到 1.4m 或以下」）。
 */
function profileAlong(
  state: DirectorState,
  route: readonly Vec2[],
  selfId: string,
  baseY: number,
  loco: Locomotion,
): { ys: number[]; ids: Array<string | null> } {
  const ys: number[] = [];
  const ids: Array<string | null> = [];
  let prev = baseY;
  for (const p of route) {
    const head = prev + loco.height + HEAD_ROOM;
    let best = 0;
    let bestId: string | null = null;
    for (const o of state.objects) {
      if (o.role !== "set" || o.hidden || o.id === selfId) continue;
      if (o.walkable === false) continue;
      if (!coversXZ(o, p.x, p.z)) continue;
      if (objectBottom(o) > head) continue; // 头顶上方的面 → 桥，不是脚下
      const t = topAt(o, p.x, p.z);
      if (t > best) {
        best = t;
        bestId = o.id;
      }
    }
    ys.push(best);
    ids.push(bestId);
    prev = best;
  }
  return { ys, ids };
}

/* ------------------------------------------------------------ 段的切分 */

export interface ReachSpan {
  tier: ReachTier;
  /** 这一段属于哪一类通过方式（`blocked` = 超出能力）。 */
  kind: GapKind;
  /** 在路线折线中的下标区间 `[i0, i1]`（两端都含）。 */
  i0: number;
  i1: number;
  /** 归一化里程区间（沿整条路线，0..1）。 */
  from: number;
  to: number;
  dh: number;
  dx: number;
  /** 该档位下最远能跳 / 够到的水平距离（米）。档 0 无意义。 */
  reach: number;
  /** 世界折线。跳跃 / 落差段**带真实弧线高度**，不是平的。 */
  points: Array<[number, number, number]>;
  /** 这一段的中点（世界坐标，含高度）—— 徽标挂在这儿。 */
  mid: [number, number, number];
  /** 说人话、带数字的文案。UI 直接用，不要各处再拼一遍。 */
  message: string;
  /** 起点 / 终点的地面高度（米）—— 一键修复要按它反推"该把障碍降到多高"。 */
  fromY: number;
  toY: number;
  /**
   * 造成这个高差的那个 set 对象（撑起**较高那一端**的几何）；基准面则 null。
   * 修复动作必须能点名它（docs/3d/03 §5）。
   */
  blockerId: string | null;
}

/** `classifyGap` 的档位粗分（只按 dh，用于找切分边界）。 */
function rawTier(kind: GapKind): ReachTier {
  switch (kind) {
    case "jump":
      return 1;
    case "climb":
      return 2;
    case "drop":
      return 6;
    case "blocked":
      return 3;
    default:
      return 0;
  }
}

/** 沿 `[i0, i1]` 这段折线按弧长 `at`（绝对累计值）插值取点。 */
function pointAtLength(
  route: readonly Vec2[],
  cum: readonly number[],
  i0: number,
  i1: number,
  at: number,
): Vec2 {
  let k = i0 + 1;
  while (k < i1 && cum[k] < at) k += 1;
  if (k > i1) k = i1;
  const a = route[k - 1];
  const b = route[k];
  const f = Math.max(0, Math.min(1, (at - cum[k - 1]) / (cum[k] - cum[k - 1] || 1)));
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/**
 * 作者没给弧线时，这一段**如果按默认方式通过**会是什么形状。
 *
 * 于是"预览里看到的弓形"就是按下「生成弧线」之后真正得到的弓形 ——
 * 所见即所得，而不是另画一套示意图形。
 */
export function previewArc(kind: GapKind, dh: number, loco: Locomotion): VerticalArc | null {
  const forMode: "step" | "drop" | "jump" | "climb" | "flat" =
    kind === "blocked" ? (dh > 0 ? "climb" : "drop") : kind;
  const mode = suggestArcMode(forMode, loco);
  if (!mode) return null;
  if (mode === "parabola") {
    const H = loco.maxJumpHeight;
    // 顶点 = Δh + 余量，但不许超过能力上限 —— 弧线会在够不着的地方落下去，
    // 这正是"跳不上去"最直观的可视化。
    const apex = H <= 0 ? 0 : Math.min(dh + APEX_MARGIN, H);
    return { mode, apex };
  }
  return { mode };
}

/**
 * 把一条 MOVE 段的**实际行走路线**按可达性切成若干段。
 *
 * 折线来源与运动求解**完全共用**（`routeObstaclesFor` + `segmentRoutePoints`），
 * 所以这条线就是 agent 真正走的路线 —— 不共用就会出现
 * "线绕开了、人却直穿过去"（`WorldView` 里已注释过的约束）。
 *
 * 返回空数组 = 这条段没什么可报的（planar / 非 agent / 路线退化为一点）。
 */
export function segmentSpans(state: DirectorState, segment: MoveSegment): ReachSpan[] {
  const object = state.objects.find((o) => o.id === segment.object);
  if (!object || object.role !== "agent") return [];
  if (worldModeOf(state) !== "terrain") return [];

  const loco = locomotionOf(state, object);
  const route = segmentRoutePoints(segment, routeObstaclesFor(state, segment));
  if (route.length < 2) return [];

  const { ys, ids } = profileAlong(state, route, object.id, object.baseY ?? 0, loco);
  const cum: number[] = [0];
  for (let i = 1; i < route.length; i += 1) {
    cum[i] = cum[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
  }
  const total = cum[cum.length - 1] || 1;

  // 已有的弧线优先：作者显式设定的形状盖过自动预览。
  const arc = segment.arc && arcActive(state, segment) ? segment.arc : null;
  const ends = arc ? arcEndHeights(state, segment) : null;
  const useArc = Boolean(arc && ends && !arcIsFlat(arc, ends!.y0, ends!.y1));

  // ① 逐边粗分档 → ② 合并相邻同档边 → ③ 用合并后的 (dh, dx) 定最终档位。
  const kinds: GapKind[] = [];
  for (let i = 1; i < route.length; i += 1) kinds.push(classifyGap(ys[i] - ys[i - 1], loco));

  const spans: ReachSpan[] = [];
  let start = 0;
  while (start < kinds.length) {
    const group = rawTier(kinds[start]);
    let end = start;
    while (end + 1 < kinds.length && rawTier(kinds[end + 1]) === group) end += 1;

    const i0 = start;
    const i1 = end + 1;
    const dh = ys[i1] - ys[i0];
    const dx = cum[i1] - cum[i0];
    const kind = kinds[start];
    let { tier, reach } = tierOfGap(dh, dx, loco);
    // **连续坡面**（楼梯 / 斜坡）不是"落差"。这些边逐条都迈得上（合并的全是 flat / step），
    // 但合并后的总量会被 `tierOfGap` 拿去问"能不能攀爬" —— 一条 11m 长的楼梯因此被报成
    // "落差 1.80m 超过攀爬能力 1.60m"，画布上平白一个红叉。
    // 能不能走的判据是**坡度**（与 `avoidance.isPassable` 同一套：看坡脚 + 比 maxSlopeDeg）。
    if (
      (kind === "flat" || kind === "step") &&
      dx > 1e-6 &&
      (Math.atan2(Math.abs(dh), dx) * 180) / Math.PI <= loco.maxSlopeDeg
    ) {
      tier = 0;
      reach = 0;
    }

    const preview = useArc ? null : previewArc(kind, dh, loco);
    const spanLen = cum[i1] - cum[i0] || 1;
    const heightAt = (t: number): number =>
      useArc
        ? // 已有弧线：按**整段**的归一化里程取值（弧线的 from/to 就是整段里程）。
          arcHeightAt(arc!, (cum[i0] + t * spanLen) / total, ends!.y0, ends!.y1)
        : preview
          ? arcHeightAt(preview, t, ys[i0], ys[i1])
          : ys[i0] + (ys[i1] - ys[i0]) * t;
    const points: Array<[number, number, number]> = [];
    if (useArc || preview) {
      for (let k = 0; k <= ARC_SPAN_STEPS; k += 1) {
        const t = k / ARC_SPAN_STEPS;
        const p = pointAtLength(route, cum, i0, i1, cum[i0] + t * spanLen);
        points.push([p.x, heightAt(t) + ROUTE_LINE_LIFT, p.z]);
      }
    } else {
      for (let i = i0; i <= i1; i += 1) {
        points.push([route[i].x, ys[i] + ROUTE_LINE_LIFT, route[i].z]);
      }
    }
    const midP = pointAtLength(route, cum, i0, i1, cum[i0] + spanLen / 2);

    spans.push({
      tier,
      kind,
      i0,
      i1,
      from: cum[i0] / total,
      to: cum[i1] / total,
      dh,
      dx,
      reach,
      points,
      mid: [midP.x, heightAt(0.5) + ROUTE_LINE_LIFT, midP.z],
      message: reachMessage(tier, dh, dx, reach, loco),
      fromY: ys[i0],
      toY: ys[i1],
      // 往上 → 挡路的是落点那一块；往下 → 是要走下去的那块台子。
      blockerId: dh > 0 ? ids[i1] : ids[i0],
    });
    start = end + 1;
  }
  return spans;
}

/* -------------------------------------------------------------- 体检报告 */

export interface ReachFinding {
  segmentId: string;
  objectId: string;
  objectName: string;
  tier: ReachTier;
  message: string;
  dh: number;
  dx: number;
  timeStart: number;
  timeEnd: number;
  /** 该段在整条路线中的档位下标（同一段可能有好几处问题）。 */
  index: number;
}

/** 一条段的问题清单（只含档位 > 0 的）。 */
export function segmentFindings(state: DirectorState, segment: MoveSegment): ReachFinding[] {
  const object = state.objects.find((o) => o.id === segment.object);
  if (!object) return [];
  const loco = locomotionOf(state, object);
  return segmentSpans(state, segment)
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.tier !== 0)
    .map(({ span, index }) => ({
      segmentId: segment.id,
      objectId: object.id,
      objectName: object.name ?? object.id,
      tier: span.tier,
      message: reachMessage(span.tier, span.dh, span.dx, span.reach, loco),
      dh: span.dh,
      dx: span.dx,
      timeStart: segment.timeStart,
      timeEnd: segment.timeEnd,
      index,
    }));
}

/**
 * 全局体检：扫描全场景所有 agent 段（docs/3d/03 §9）。
 *
 * 长场景里导演不可能一段段点开看有没有标红，所以这里是刚需。
 * 结果按**开始时间**排序 —— 与 timeline 的阅读顺序一致。
 */
export function scanReachability(state: DirectorState): ReachFinding[] {
  const out: ReachFinding[] = [];
  for (const segment of state.segments) {
    out.push(...segmentFindings(state, segment));
  }
  out.sort((a, b) => a.timeStart - b.timeStart || a.objectId.localeCompare(b.objectId));
  return out;
}

/** 一堆 finding 里最严重的档位（不可达 > 攀爬 > 跳跃/落差 > 可走）。 */
const SEVERITY: Record<ReachTier, number> = { 0: 0, 6: 1, 1: 2, 2: 3, 4: 4, 5: 4, 3: 5 };

export function worstTier(tiers: readonly ReachTier[]): ReachTier {
  let worst: ReachTier = 0;
  for (const t of tiers) if (SEVERITY[t] > SEVERITY[worst]) worst = t;
  return worst;
}

/* -------------------------------------------------------------- 助跑速度 */

/** 求斜率的差分步长（归一化里程）。 */
const SLOPE_EPS = 0.004;

/**
 * 曲线在 `u` 处的斜率 d(进度)/du。
 *
 * **为什么不用 `ease.ts` 现成的 `curveSpeed`**：它用固定的中心差分
 * `(v(u+h) − v(u−h)) / 2h`，而 `u = 0` 时 `u−h` 被夹回 0 ——
 * 分子只跨了 h、分母仍是 2h，**端点斜率被系统性少算一半**。
 * 起跳点恰恰常落在段首（u = 0），于是"10m/12.5s 明明是半速"会被算成四分之一速。
 *
 * 这里把区间端点一起夹进 [0,1]，分母用**实际**区间宽度，端点处自然退化成
 * 宽度正确的一侧差分。速度条（`easeSpeed`）仍用原函数 —— 改它会动到编辑器里
 * 已调好的曲线外观，不值得。
 */
function slopeAt(
  curve: ReturnType<typeof normalizeEase>,
  keys: MoveSegment["speedKeys"],
  u: number,
): number {
  const lo = Math.max(0, Math.min(1, u - SLOPE_EPS));
  const hi = Math.max(0, Math.min(1, u + SLOPE_EPS));
  if (hi - lo < 1e-9) return 0;
  return (curveVal(curve, keys, hi) - curveVal(curve, keys, lo)) / (hi - lo);
}

/**
 * 起跳点的瞬时水平速度 / 跑步速度（0..1）—— docs/3d/02 §5 的 `speedRatio`。
 *
 * Phase 4 就把"有效跳远随速度缩放"和"没有助跑"的提示都实现了，
 * 缺的只是这个数从哪来（02 §13 记的已知边界），这里补上接线。
 *
 * **时间的纯函数**：只吃段的缓动 / 关键点 / 时长与几何长度，不读 `currentTime`，
 * 所以同 revision 内恒定，进 `useMemo` 是安全的（红线 10）。
 *
 * 速度 = d(弧长)/dt = 归一化曲线斜率 × 段长 / 段时长。
 * 段长取**求解器真正走的那条折线**（`segmentRoutePoints` + 同一份障碍集合），
 * 而不是起终点直线距离 —— 绕障会拉长路程，于是同样的时间走完就真的更快。
 *
 * 分母 `RUN_SPEED` 与步态判定共用同一个常数：否则会出现
 * "画面上明明在跑，包络却按走路算"这种说不通的结果。
 */
export function takeoffSpeedRatio(state: DirectorState, segment: MoveSegment): number {
  const duration = segment.timeEnd - segment.timeStart;
  // 零时长段：速度无从谈起。按全速处理 —— 不凭空造一条"没有助跑"的假警告。
  if (!(duration > 1e-6)) return 1;
  const route = segmentRoutePoints(segment, routeObstaclesFor(state, segment));
  let len = 0;
  for (let i = 1; i < route.length; i += 1) {
    len += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
  }
  // 起跳里程 = 弧线起点在段内的归一化位置；没有弧线时按段首（起跳发生在出发瞬间）。
  const u = segment.arc?.from ?? 0;
  const slope = slopeAt(normalizeEase(segment.ease), segment.speedKeys, u);
  return Math.max(0, Math.min(1, (slope * len) / (duration * RUN_SPEED)));
}

/* ------------------------------------------------------------ 拖拽即时反馈 */

export interface DragReachHint {
  segmentId: string;
  /**
   * 正在被拖的那个把手：端点为 `"start"` / `"end"`，路径点为它的 id。
   * 拖的是对象本体时没有把手，为 null（此时整条段都算"受影响"）。
   */
  marker: string | null;
  tier: ReachTier;
  message: string;
  /** 徽标 / tooltip 挂这儿：出问题的那一处中点（含高度）。 */
  at: [number, number, number];
}

/**
 * 拖拽途中的即时反馈（docs/3d/03 §6）。
 *
 * **只报告，不干预**：这里不写回任何几何，也不阻止落位。硬阻止会挡住
 * 「先摆好位置再调几何」的工作流，也会让导演没法故意留一个断点当待办 ——
 * 放下之后由路径着色 / 徽标 / Inspector 面板**持续标红**，那才是它的归宿。
 *
 * `segmentId` 为 null 时做全场景扫描（拖的是 set 对象：它一动，所有 agent
 * 的路都可能被改），否则只看那一条段（拖路径点 / 端点，代价恒定）。
 * 多处问题时取**最严重**的一处 —— 一次只说一件事，比并列五条红字有用。
 */
export function dragReachHint(
  state: DirectorState,
  segmentId: string | null,
  marker: string | null,
): DragReachHint | null {
  let best: DragReachHint | null = null;
  const consider = (segId: string, span: ReachSpan) => {
    if (span.tier === 0) return;
    if (best && SEVERITY[span.tier] <= SEVERITY[best.tier]) return;
    best = { segmentId: segId, marker, tier: span.tier, message: span.message, at: span.mid };
  };
  if (segmentId) {
    const segment = state.segments.find((s) => s.id === segmentId);
    if (!segment) return null;
    for (const span of segmentSpans(state, segment)) consider(segment.id, span);
  } else {
    for (const segment of state.segments) {
      for (const span of segmentSpans(state, segment)) consider(segment.id, span);
    }
  }
  return best;
}

/**
 * 编队归并：整队只有锚点（members[0]）那一条路线，
 * 所以可达性徽标**只画在锚点的段上** —— 否则一队 5 人会冒出 5 个徽标糊住画布
 * （docs/3d/03 §11）。
 */
export function isRouteAnchor(state: DirectorState, objectId: string): boolean {
  for (const group of state.groups ?? []) {
    if (!group.dynamics) continue;
    if (group.members.length < 2) continue;
    if (group.members.includes(objectId) && group.members[0] !== objectId) return false;
  }
  return true;
}
