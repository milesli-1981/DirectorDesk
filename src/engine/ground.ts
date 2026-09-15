import { DirectorObject, DirectorState } from "../domain/schema";
import { locomotionOf } from "./locomotion";
import { stairCoversXZ, stairHalfExtents, stairHitAt, stairPathOf } from "./stair";

/**
 * 地面查询：**整个 3D 扩展的唯一支点。**
 *
 * 语义：在所有覆盖 (x, z) 的静态对象里，取「顶面 ≤ fromY + maxStep」的那些，返回其中最高的顶面；
 * 一个都没有 → 0（基准面）。
 *
 * 这一个函数 + 既有的 2D 障碍测试，就覆盖了台阶 / 高低差 / 堆叠 / 桥下穿行 / 跳跃的全部几何前提，
 * 不需要为它们各自特判：
 *  - 台阶：0.3m 的盒，0.3 ≤ 0 + 0.35 → 可达 → 走上去
 *  - 高低差：3m 的盒，3 > 0.35 → 不可达 → 留在地面（同时仍被水平障碍测试挡住 → 绕行）
 *  - 堆叠：上层的 baseY 就是下层的顶面
 *  - 桥：bottom 给出下方净空
 *  - 跳跃：站上 3m 平台时 fromY = 3，该盒突然可达
 *
 * 「我在几层」的歧义正是由 fromY + maxStep 这个上限解决的：一栋 h=24 的实心建筑，从地面查询时
 * 顶面不可达 → 人绕圈走、不会跑到屋顶；从屋顶查询时才可达 → 站得稳。
 * 这就是标准角色控制器的 step up / step down 查询。
 *
 * 性能约束（必须守住）：纯函数、无状态、零分配。它每帧被调用几十到上百次
 * （求解 ×2/演员 + 相机解算的多点采样 + 遮挡 + 景深 + 组动力学的 11 次低通重采样）。
 * 因此静态几何走按 revision 缓存的桶索引 —— 每帧只重建一次，之后每次查询 O(1)。
 */

/** 桶边长（米）。太大则每个桶里对象多，太小则建索引的循环次数涨。4m 对建筑/道具比例合适。 */
const CELL = 4;

/**
 * 对象的水平外接盒半尺寸（**已考虑 rotation**）。
 *
 * 旋转矩形 w×d 转 θ 后的外接盒半宽/半深就是标准的 OBB→AABB：
 * `hx = |w/2·cosθ| + |d/2·sinθ|`、`hz = |w/2·sinθ| + |d/2·cosθ|`。
 * 桶索引与射线拾取的包围范围都用它 —— 它必须是**真**超集，否则查询会漏对象。
 */
export function objectHalfExtents(object: DirectorObject): { hx: number; hz: number } {
  // 抽象楼梯的外接盒由**实际梯跑**反推（拐弯楼梯的 AABB 未必等于 footprint）。
  if (object.topShape === "stair") return stairHalfExtents(object);
  const hw = object.footprint.w / 2;
  const hd = object.footprint.d / 2;
  if (!object.rotation) return { hx: hw, hz: hd };
  const theta = (object.rotation * Math.PI) / 180;
  const s = Math.abs(Math.sin(theta));
  const c = Math.abs(Math.cos(theta));
  return { hx: hw * c + hd * s, hz: hw * s + hd * c };
}

/** 浮点容差：让"相切"稳定地判为相切，而不是概率性地滑进/滑出相交。 */
const EPS = 1e-6;

/** 对象的实体底面高度（默认 0）。 */
export function objectBottom(object: DirectorObject): number {
  const base = object.baseY ?? 0;
  return object.bottom ?? base;
}

/** 对象的顶面高度。 */
export function objectTop(object: DirectorObject): number {
  return (object.baseY ?? 0) + object.footprint.h;
}

/**
 * 点是否落在对象的水平占用面内（含边界）。
 *
 * **按局部坐标判定，因此 `rotation` 是生效的。** 早先这里是裸的轴对齐 AABB 比较，
 * 与 `collision.ts` / `occlusion.ts` 一样忽略 rotation —— 但渲染是转的，于是
 * "把 10×1 的墙转 90°，视觉转了、判定没转"，横着的墙在纵向上仍被当成障碍。
 * 判定链的每一处都必须用同一份几何，所以这里先修正。
 *
 * 桶索引按 AABB 分桶（旋转矩形的外接盒），是这里的**超集**，所以索引侧无需改动。
 */
export function coversXZ(object: DirectorObject, x: number, z: number): boolean {
  // 楼梯是折线，水平占用面不是矩形 —— 逐段判定（见 engine/stair.ts）。
  if (object.topShape === "stair") return stairCoversXZ(object, x, z);
  const hw = object.footprint.w / 2 + EPS;
  const hd = object.footprint.d / 2 + EPS;
  const dx = x - object.x;
  const dz = z - object.z;
  if (!object.rotation) {
    return Math.abs(dx) <= hw && Math.abs(dz) <= hd;
  }
  const theta = (object.rotation * Math.PI) / 180;
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  // 世界 → 局部：R_y(θ) 的逆。与 topAt 的换算同源（three 的 rotation.y 约定）。
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= hw && Math.abs(lz) <= hd;
}

/**
 * 对象在 (x, z) 处的顶面高度。
 *
 * flat 恒为顶面；ramp 在物体局部坐标里沿 +Z 从 bottom 线性升到 top。
 *
 * 局部坐标换算的依据与渲染一致：three 的 rotation.y = θ 把局部 +Z 映射到世界 (sinθ, cosθ)，
 * 也就是 solver 里 forward = (sin, cos) 的约定。所以世界 → 局部是它的逆旋转：
 *   lx = dx·cosθ − dz·sinθ
 *   lz = dx·sinθ + dz·cosθ
 */
export function topAt(object: DirectorObject, x: number, z: number): number {
  const bottom = objectBottom(object);
  const top = objectTop(object);
  // 抽象楼梯：折线坡面（转弯处为平台）。不在任何梯段上时退回顶面高度 ——
  // 调用方一律先过 `coversXZ`，所以这一支只在退化情形（未摆好 / 探针落在缝里）兜底。
  if (object.topShape === "stair") {
    const y = stairHitAt(object, x, z);
    return Number.isNaN(y) ? top : y;
  }
  if (object.topShape !== "ramp" || object.footprint.d <= EPS) return top;

  const theta = (object.rotation * Math.PI) / 180;
  const dx = x - object.x;
  const dz = z - object.z;
  const lz = dx * Math.sin(theta) + dz * Math.cos(theta);
  // lz ∈ [−d/2, +d/2] → t ∈ [0, 1]，0 在坡脚、1 在坡顶。
  const t = Math.min(1, Math.max(0, (lz + object.footprint.d / 2) / object.footprint.d));
  return bottom + (top - bottom) * t;
}

/* ------------------------------------------------------------ 桶索引 */

interface GroundIndex {
  /**
   * 缓存 key = **objects 数组的引用本身**，不是 revision。
   *
   * 这里踩过一次坑：最初用 `revision` 做 key，看着够用 —— 每次改动 revision 都 +1。
   * 但 revision 只在**单个场景内**单调，跨场景不唯一：切场景页 / 撤销重做 / 导入一份
   * revision 相同的存档，都会让另一份几何命中同一份旧缓存，地面高度静默算错。
   * 数组引用天然没有这个问题（store 每次都产新数组），且判断成本为 0。
   */
  objects: DirectorObject[];
  /** worldMode 切换时不换 objects 数组（`{...state, worldMode}`），所以必须单独进 key。 */
  worldMode: string;
  cells: Map<string, DirectorObject[]>;
}

let indexCache: GroundIndex | null = null;

function cellKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}

/**
 * 按 objects 引用缓存的静态几何桶索引。
 * 静态几何只在 objects 换数组时改变，因此每帧最多重建一次。
 */
function groundIndex(state: DirectorState): GroundIndex {
  const mode = state.worldMode ?? "planar";
  if (indexCache && indexCache.objects === state.objects && indexCache.worldMode === mode) {
    return indexCache;
  }
  const cells = new Map<string, DirectorObject[]>();
  for (const object of state.objects) {
    // 只有静态环境（set）能作为落脚面；agent 不做别人的地面（不能站在人头上）。
    if (object.role !== "set") continue;
    if (object.walkable === false) continue;
    // **必须按旋转后的外接盒分桶**。曾经这里用未旋转的 footprint 半宽，
    // 心想"外接盒是旋转矩形的超集"—— 那是错的：30° 左右的斜置矩形，其外接盒在
    // 两个轴上都会比原 footprint 更大。把一个 10×1 的墙转 90°，它实际铺在 z∈[-5,5]，
    // 而按原 footprint 分桶只覆盖 z∈[-0.5,0.5] —— 查询后半截直接查不到对象，
    // 表现为"墙转过之后人能从它中间穿过去"。
    const { hx, hz } = objectHalfExtents(object);
    const ix0 = Math.floor((object.x - hx) / CELL);
    const ix1 = Math.floor((object.x + hx) / CELL);
    const iz0 = Math.floor((object.z - hz) / CELL);
    const iz1 = Math.floor((object.z + hz) / CELL);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iz = iz0; iz <= iz1; iz += 1) {
        const key = cellKey(ix, iz);
        const bucket = cells.get(key);
        if (bucket) bucket.push(object);
        else cells.set(key, [object]);
      }
    }
  }
  indexCache = { objects: state.objects, worldMode: mode, cells };
  return indexCache;
}

/** 覆盖 (x, z) 所在桶的对象（超集，调用方仍需精确判定 footprint）。 */
function candidatesAt(state: DirectorState, x: number, z: number): DirectorObject[] {
  const index = groundIndex(state);
  return index.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
}

/* ------------------------------------------------------- 地面查询 */

export interface SupportHit {
  /** 可落脚面高度。 */
  y: number;
  /** 支撑它的对象 id；null = 基准面（y = 0）。 */
  supportId: string | null;
}

/**
 * 取 (x, z) 处「够得着」的最高可落脚面。
 *
 * @param fromY  查询起点高度（通常 = 该对象当前 y / 它的 baseY）。只考虑 top ≤ fromY + maxStep 的面。
 * @param maxStep 单步最大落差。传 0 即"只能踩在与起点同一高度或更低的面"。
 * @param excludeId 排除自身（拖拽时对象不该成为自己的支撑）。
 */
export function supportUnder(
  state: DirectorState,
  x: number,
  z: number,
  fromY: number,
  maxStep: number,
  excludeId?: string,
): SupportHit {
  const ceiling = fromY + maxStep + EPS;
  let best = -Infinity;
  let bestId: string | null = null;
  for (const object of candidatesAt(state, x, z)) {
    if (object.id === excludeId) continue;
    if (!coversXZ(object, x, z)) continue;
    const top = topAt(object, x, z);
    if (top > ceiling) continue;
    if (top > best) {
      best = top;
      bestId = object.id;
    }
  }
  if (best === -Infinity) return { y: 0, supportId: null };
  return { y: best, supportId: bestId };
}

/** 只要高度的便捷形式。 */
export function groundHeightAt(
  state: DirectorState,
  x: number,
  z: number,
  fromY: number,
  maxStep: number,
  excludeId?: string,
): number {
  return supportUnder(state, x, z, fromY, maxStep, excludeId).y;
}

/**
 * 摆放 / 堆叠用的落点高度：取 (x, z) 处**最高的可站立面**（不受 maxStep 限制）。
 *
 * 与 supportUnder 的区别：supportUnder 回答"从这里能不能迈上去"（受落差限制），
 * 这里回答"把这个东西放到这儿，它该落在多高的面上" —— 放下一个新盒子时，
 * 它自然应该叠在当前最高面的顶上，而不是被落差挡住。
 *
 * planar 世界直接返回 0：没有堆叠这回事，一切落在基准面上。
 * （engine/place 的 restingBaseY 还会再加一道"planar 不写 baseY"的闸，双重保险。）
 */
export function restingHeightAt(
  state: DirectorState,
  x: number,
  z: number,
  excludeId?: string,
): number {
  if ((state.worldMode ?? "planar") === "planar") return 0;
  return supportUnder(state, x, z, Number.POSITIVE_INFINITY, 0, excludeId).y;
}

/**
 * 可达性或几何变化后需要清索引缓存时才用。
 * 正常情况下 revision 变化会自动失效，无需手工调用。
 */
export function invalidateGroundIndex(): void {
  indexCache = null;
}

/**
 * 标高吸附：把 `target` 吸到附近的"整数层"上。
 *
 * 候选 = 基准面 0 + 其它 set 对象的顶面。取绝对值距离最近且在 `threshold` 内的那个。
 * 手拖高度时没有吸附几乎不可能正好对齐到另一个盒子的顶面（差 1cm 就是"穿模"或"悬空"），
 * 于是"叠起来"这件事就只能靠落点自动吸附去做，手工微调反而做不到。
 *
 * @param threshold 吸附半径（世界米）。给 0 即不吸附。
 */
export function snapElevation(
  state: DirectorState,
  target: number,
  threshold: number,
  excludeId?: string,
): number {
  if (threshold <= 0) return target;
  let best = 0;
  let bestDelta = Math.abs(target);
  for (const object of state.objects) {
    if (object.role !== "set" || object.id === excludeId) continue;
    const top = objectTop(object);
    const delta = Math.abs(top - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = top;
    }
  }
  return bestDelta <= threshold ? best : target;
}

/* -------------------------------------------------- 路径标记的贴地基准面 */

/** 路径线 / 转折点圆盘离脚下地面多高（米）。 */
export const POINT_MARKER_LIFT = 0.09;
/** 起终点把手球心离脚下地面多高（米）。 */
export const ENDPOINT_MARKER_LIFT = 0.26;
/** 交接徽标（HOLD / CUT / SMOOTH）离脚下地面多高（米）。 */
export const HANDOFF_BADGE_LIFT = 1.05;
/** FOLLOW 关系连线离脚下地面多高（米）。 */
export const FOLLOW_LINK_LIFT = 0.1;

/**
 * 路径标记（线 / 转折点 / 起终点把手）在 (x, z) 处该浮在多高。
 *
 * **渲染与拾取必须都调这一个函数。** 这两边一旦用各自写死的高度，就会出现
 * "屏幕上看在那里、却怎么都点不中" —— 这正是旧代码里 `POINT_MARKER_Y` 注释记录过的坑
 * （当时的原因是固定容差遇上浮空标记）。地形一进来，"浮空量"从常量变成了随地面变化的量，
 * 于是同源这件事从"好习惯"升级成"必须"。
 *
 * planar 下恒为 0 ⇒ 与扩展前逐像素一致。
 */
export function pathGroundAt(
  state: DirectorState,
  objectId: string,
  x: number,
  z: number,
): number {
  const object = state.objects.find((o) => o.id === objectId);
  return object ? standingHeightFor(state, object, x, z) : 0;
}

/**
 * 楼梯「连接两个平面」用法的**高差**：终点处支撑面顶面 − 起点处支撑面顶面。
 *
 * 与"手填 H"是同一件事的两种来源 —— 作者不必自己去量两层楼差多少，点一下即可。
 * 排除楼梯自身（否则会量到自己头上）；某一头没有支撑面就记 0（基准面）。
 *
 * 这是**一次性取数**（由调用方写进 `footprint.h`），不是持续跟随：支撑面之后被挪动，
 * 楼梯不会偷偷改高 —— 与"摆放只有一个权威（`baseY` 存绝对值）"同一条原则。
 */
export function stairHeightFromPlanes(state: DirectorState, object: DirectorObject): number {
  const pts = stairPathOf(object);
  if (pts.length < 2) return 0;
  const topUnder = (x: number, z: number): number => {
    let best = 0;
    for (const o of state.objects) {
      if (o.id === object.id || o.role !== "set" || o.hidden || o.walkable === false) continue;
      if (!coversXZ(o, x, z)) continue;
      const t = topAt(o, x, z);
      if (t > best) best = t;
    }
    return best;
  };
  const a = pts[0];
  const b = pts[pts.length - 1];
  return topUnder(b.x, b.z) - topUnder(a.x, a.z);
}

/* ------------------------------------------------- 渲染 / 相机共用的落脚高度 */

/**
 * 一个对象在 (x, z) 处**应该被画在多高**。
 *
 * - `role: "set"`：静态几何，就是它自己的底面（堆叠的上层因此浮在下层顶上）。
 * - 其它（演员 / 相机 / 载具）：站到脚下够得着的最高面上。
 *   查询起点用对象自身的 `baseY`（= 作者把它的 ORIGIN 放在哪一层），
 *   所以"把演员拖到平台上"就等于把它放到那一层，之后沿路径走时始终站在同一层系里。
 *
 * 注意：落差目前是**瞬时垂直对齐**，不走弧线 —— 弧线是 Phase 4 的内容。
 * 现在走出平台边缘会直接落到地面，不会出现抛物线，这是预期内的中间态。
 */
export function standingHeightFor(
  state: DirectorState,
  object: DirectorObject,
  x: number,
  z: number,
): number {
  if (object.role === "set") return objectBottom(object);
  const loco = locomotionOf(state, object);
  const fromY = object.baseY ?? 0;
  return supportUnder(state, x, z, fromY, loco.maxStep, object.id).y;
}
