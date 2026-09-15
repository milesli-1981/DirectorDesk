import { DirectorObject, DirectorState, MoveSegment, Vec2 } from "../domain/schema";
import { arcAtU, arcIsFlat } from "./arc";
import { objectBottom, standingHeightFor, supportUnder } from "./ground";
import { locomotionOf } from "./locomotion";
import { curveVal, normalizeEase } from "./ease";
import { worldModeOf } from "./worldMode";
import { samplePath } from "./path";
import { objectPosition } from "./solver";

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

  // 老路径：瞬时垂直对齐（无弧线 / planar / 弧线为空）—— 但**台阶的落差要做 y 低通**，
  // 否则目标每上一级台阶身体会瞬跳一级（0.3m），跟镜也一起弹。
  return steppedGroundAt(state, object, x, z, time);
}

/**
 * 台阶 y 低通的时间窗（秒）与采样步长。
 *
 * 0.15s ≈ 人上一级台阶所用时间的 1/4：短到读起来仍是"迈上去"而不是"飘上去"，
 * 又长到足以把整级落差摊成一段连续短坡（实测单帧高度跳变 0.30m → 0.055m）。
 * 步长 0.015 是精度/开销的折中：窗内 ≈11 点，单点跨过台阶只贡献 0.3/11 ≈ 0.027m。
 */
const STEP_Y_WINDOW = 0.15;
const STEP_Y_STEP = 0.015;

/* ------------------------------------------------------------------ 累进剖面 */

/**
 * 累进采样的步长（米）。
 *
 * 必须 ≤ `maxStep / tan(maxSlopeDeg)`，否则"上一点的高度 + 一步"够不到下一个采样点的面、
 * 链条会在半途断掉（人卡在坡中间）。最陡 45° 时该值是 `0.35 / 1 = 0.35`，取 0.3 留余量。
 */
const PROFILE_STEP = 0.3;

/** 每对象缓存一份累进高度表。`revision` 变了（几何被改）就重算 —— 见 `progressiveGroundAt`。 */
const profileMemo = new Map<string, { revision: number; pts: Vec2[]; ys: number[] }>();

/** MOVE 段的折线（段首 → 路径点 → 段尾），与路径标记同源。 */
function segmentPolyline(seg: MoveSegment): Vec2[] {
  const pts: Vec2[] = [{ x: seg.startX, z: seg.startZ }];
  for (const p of seg.points ?? []) pts.push({ x: p.x, z: p.z });
  pts.push({ x: seg.endX, z: seg.endZ });
  return pts;
}

/** 按 `step` 等距重采样折线（首尾必留）。 */
function resamplePolyline(route: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [{ x: route[0].x, z: route[0].z }];
  let carry = 0;
  for (let i = 1; i < route.length; i += 1) {
    let ax = route[i - 1].x;
    let az = route[i - 1].z;
    const bx = route[i].x;
    const bz = route[i].z;
    let len = Math.hypot(bx - ax, bz - az);
    while (carry + len >= step) {
      const need = step - carry;
      const f = need / len;
      const nx = ax + (bx - ax) * f;
      const nz = az + (bz - az) * f;
      out.push({ x: nx, z: nz });
      ax = nx;
      az = nz;
      len -= need;
      carry = 0;
    }
    carry += len;
  }
  const tail = route[route.length - 1];
  const last = out[out.length - 1];
  if (Math.hypot(tail.x - last.x, tail.z - last.z) > 1e-6) out.push({ x: tail.x, z: tail.z });
  return out;
}

/**
 * 该对象此刻**最近**的段：段内直接返回；段外取时间上最近的（走完了就用最后一段，
 * 还没开始就用第一段）。`null` = 这个对象根本没有段（纯摆位，靠 `baseY` 定层高）。
 *
 * 为什么需要它：**路线终点设在楼梯中间**时，走完之后就没有"活跃段"了 ——
 * 若此时退回"以 `baseY` 封顶"的老规则，演员会当场掉回地面（`baseY` 缺省 = 0 时
 * 上限只有 `maxStep`）。终点的高度应该"停在哪就是哪"，所以段外继续沿用最近那段的剖面。
 */
function segmentNear(state: DirectorState, objectId: string, time: number): MoveSegment | null {
  let best: MoveSegment | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const seg of state.segments) {
    if (seg.object !== objectId) continue;
    const gap =
      time < seg.timeStart ? seg.timeStart - time : time > seg.timeEnd ? time - seg.timeEnd : 0;
    if (gap < bestGap) {
      bestGap = gap;
      best = seg;
    }
  }
  return best;
}

/**
 * **沿活跃段从段首累进**求脚下地面高度。
 *
 * ## 为什么不能只看 `(x, z)`
 *
 * 老规则（`standingHeightFor`）每点独立：取"顶面 ≤ `baseY + maxStep` 的最高面"。
 * 对**连续坡面**（楼梯 / 斜坡）这等于给演员钉了一个天花板 —— `baseY` 缺省是 0 时上限
 * 只有 `maxStep = 0.35`，于是演员在楼梯上永远升不过 0.35：**几何在升、人不动，看起来
 * 就是"穿过台阶"**（作者得手动把 `baseY` 填成楼梯顶面才行，见 docs/3d/00 §9.15 ④）。
 *
 * 对**叠层**几何更糟：螺旋楼梯的顶层正压在底层上方，同一个 `(x, z)` 有 0.0 与 2.4 两个面，
 * 单看 `(x,z)` 根本无从选择（`topAt` 取最高 ⇒ 会直接跳到顶层）。
 *
 * 高度本质上取决于**你怎么上来**，所以从段首开始一步一步滚：
 * `h_{k+1} = supportUnder(…, fromY = h_k, maxStep)` —— 与 `reach.ts` 的 `profileAlong`
 * 同一手法（天花板随上一点滚动），只是落脚判据用 `supportUnder`（坡面按坡脚 / 坡度判，
 * 与 `avoidance.isPassable` 同源）。段首高度仍取作者摆放的层高 `baseY`。
 *
 * ## 缓存
 *
 * 逐点累进是 O(采样数 × 物体数)，而 `pathHeightAt` 每帧被调用很多次 —— 所以按
 * `(对象, 段)` 缓存整条剖面，`revision` 一变就重算（它只依赖几何与路线，与时间无关）。
 */
function progressiveGroundAt(
  state: DirectorState,
  object: DirectorObject,
  seg: MoveSegment | null,
  time: number,
  x: number,
  z: number,
): number {
  if (!seg || worldModeOf(state) !== "terrain") return standingHeightFor(state, object, x, z);
  const pts = resamplePolyline(segmentPolyline(seg), PROFILE_STEP);
  if (pts.length < 2) return standingHeightFor(state, object, x, z);

  const key = `${object.id}|${seg.id}`;
  const loco = locomotionOf(state, object);
  let memo = profileMemo.get(key);
  if (!memo || memo.revision !== state.revision || memo.pts.length !== pts.length) {
    const ys: number[] = [standingHeightFor(state, object, pts[0].x, pts[0].z)];
    for (let i = 1; i < pts.length; i += 1) {
      ys.push(supportUnder(state, pts[i].x, pts[i].z, ys[i - 1], loco.maxStep, object.id).y);
    }
    memo = { revision: state.revision, pts, ys };
    profileMemo.set(key, memo);
  }

  // 取哪一段剖面**必须按段内进度**，不能按"离谁近"：螺旋楼梯的路径在 XZ 上自我重叠
  // （顶层正压在底层上方），就近查会取到顶层，人一上楼梯就跳到顶（实测轨迹 0.89 → 0.45 → …）。
  // 逐点累进本身就是"沿路径从段首走来"的语义，进度才是唯一的定位参数。
  const idx = Math.min(
    memo.ys.length - 1,
    Math.max(0, Math.round(segmentProgressAt(seg, time) * (memo.ys.length - 1))),
  );
  return memo.ys[idx];
}

/**
 * 脚下地面的**台阶 y 低通**：把「走过台阶边缘时地面整跳一级」抹成一小段短坡。
 *
 * ## 为什么放在这里
 *
 * `pathHeightAt` 是高度的唯一权威（渲染 / 相机 / 姿态共用）。在**源头**抹平一次，
 * 身体与镜头就自动同拍；只平滑其中一方，两者必然错拍（相机侧踩过这个坑：
 * 只平滑机位不平滑瞄准点，镜头会在每级台阶处先仰后俯，比不平滑还难看）。
 *
 * ## 采样的是"对象自己走过的位置"
 *
 * 不是"同一 (x,z) 处随时间变化的地面" —— 后者恒为常数、没有意义。所以沿它自己的
 * 路径回溯采样（`objectPosition`，与求解器同源：含绕障折线 / 编队位移 / 约束）。
 * 窗内**最新一点用调用方给的 (x,z)**，保证与当前帧连续（调用方传的就是求解器算出的位置）。
 *
 * ## 边界
 *
 * - **planar 短路**：地面恒 0，平均还是 0 ⇒ 逐像素不变（§22 / §28 同一守卫）。
 * - **不跨越段边界**：下界钳到当前段起点，与相机侧防抖同一条约定。
 * - 只作用于**无弧线**的老路径；弧线（跳跃 / 攀爬）是作者显式编排的高度，必须逐值原样。
 */
function steppedGroundAt(
  state: DirectorState,
  object: DirectorObject,
  x: number,
  z: number,
  time: number,
): number {
  // 段外也取最近的那段（见 `segmentNear`）：**终点设在楼梯中间**时，走完停住不能掉回地面。
  const seg = segmentNear(state, object.id, time);
  // 落脚高度走**沿路径从段首累进**的剖面（见 `progressiveGroundAt`）：
  // 每点独立、以 baseY 当上限的老规则会让 baseY=0 的演员在楼梯上永远升不过 maxStep。
  const raw = progressiveGroundAt(state, object, seg, time, x, z);
  if (worldModeOf(state) !== "terrain") return raw;
  const lo = Math.max(seg ? seg.timeStart : 0, time - STEP_Y_WINDOW);
  const span = time - lo;
  if (span < 1e-3) return raw;

  const samples = Math.max(2, Math.round(span / STEP_Y_STEP) + 1);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples; i += 1) {
    const tk = lo + (span * i) / (samples - 1);
    const p = i === samples - 1 ? { x, z } : objectPosition(state, object.id, tk);
    sum += progressiveGroundAt(state, object, seg, tk, p.x, p.z);
    count += 1;
  }
  return count ? sum / count : raw;
}

/**
 * **离地量**（米）：只在「该段有生效弧线」时才可能非零。
 *
 * 无弧线时高度是"瞬时垂直对齐"——身体永远贴着脚下地面。**台阶 y 低通不改变这条**：
 * 它抹平的是地面本身，身体仍贴在那个被抹平的地面上，所以离地量恒为 0。
 * 这里必须**显式**返回 0，否则低通之后「刚下台阶」的那一瞬会被误判成离地，
 * 于是跟跳防抖会锁住机位高度、跳跃姿势与时间轴底纹也会误报。
 *
 * 判据的唯一出处：`stance.airborneOf`（跳跃姿势 / 时间轴底纹）与
 * `cameraSolver` 的跟跳防抖都调这里。
 */
export function airborneLiftAt(
  state: DirectorState,
  object: DirectorObject,
  x: number,
  z: number,
  time: number,
): number {
  if (object.role === "set") return 0;
  const seg = activeSegmentAt(state, object.id, time);
  if (!seg || !arcActive(state, seg)) return 0;
  return pathHeightAt(state, object, x, z, time) - standingHeightFor(state, object, x, z);
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
