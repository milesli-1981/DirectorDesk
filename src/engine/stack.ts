import { DirectorObject, DirectorState, Vec2 } from "../domain/schema";
import { objectBottom, objectTop, supportUnder } from "./ground";
import { footprintsOverlap } from "./collision";

/**
 * 堆叠链的**编辑器侧**推导与传播 —— 求解器永远看不到这些。
 *
 * ## 为什么要有这个文件
 *
 * INV-3D-04 要求「`baseY` 必须等于下方支撑面顶面」。`moveObject` 只改被拖的那一个对象，
 * 于是拖走底座后，压在它上面的盒子 `baseY` 就悬在那个高度、既没跟随也没落下 ——
 * 这正是这个文件要修的两个问题：
 *
 * 1. **拖动传播**：拖堆叠的根，整塔跟着走（相对位置不变）。
 * 2. **失支撑即落**：某个对象的支撑没了，`baseY` 必须重新向下推导到新的稳固面。
 *
 * ## 为什么用「几何推导」而不是持久化 `Support` 关系记录
 *
 * 设计文档（00 §5）原本提的是 `Support { upper, lower }` 关系记录。实现时改用**纯几何推导**，
 * 因为二者等价但后者更省：
 *
 * - 「B 在 A 上」的判据完全是绝对几何：`B.bottom ≈ A.top`（相切，见 collision 的 TANGENT_EPS）
 *   **且** `footprintsOverlap(B, A)`。这就是 INV-3D-05 说的"相切 = 堆叠"。
 * - 持久化关系记录会引入**第三个真相来源**（几何、baseY、关系），三者不一致时谁赢？
 *   而几何推导只有一个来源 —— 和 `baseY` 存绝对值是同一种"少一份要同步的状态"的思路。
 * - 文档之所以要 `Support`，是为了"求解器能纯函数复算"；我们草掉了它，纯函数性质只会更强。
 * - 若将来性能需要，可以把推导结果缓存（key 挂 revision），但**不要**把它变成可编辑的持久数据。
 *
 * ## 时间无关
 *
 * 本文件的函数只读 `state.objects` 的静态字段（x/z/baseY/bottom/topShape/rotation），
 * 不读 `currentTime` —— 与 `routeHeightFor` / `arc.ts` 守同一条缓存不变量。
 */

/** 认为两个面"相切"，即 B 压在 A 上（米）。略大于浮点误差，远小于最小体块尺寸。 */
const CONTACT_EPS = 1e-3;

/** 一个对象是否「压在」另一个对象上（相切 + 水平重叠）。 */
export function restsOn(upper: DirectorObject, lower: DirectorObject): boolean {
  if (upper.id === lower.id) return false;
  // 只有 set 之间互相堆叠；演员站着不算"堆叠关系"（人不是几何的一部分）。
  if (upper.role !== "set" || lower.role !== "set") return false;
  if (!footprintsOverlap(upper, lower)) return false;
  // upper 的底面 ≈ lower 的顶面。用底部区间+顶面比较（bottom 可能是桥体下沿，
  // 但"压在上面"永远是拿 upper.bottom 比 lower.top）。
  return Math.abs(objectBottom(upper) - objectTop(lower)) <= CONTACT_EPS;
}

/**
 * 所有压在 `id` 上的对象（**直接**一层，不含更上面的）。
 *
 * 用 `objectTop` 而非 `topAt`：堆叠判定看的是"这个盒子的顶面"，坡道顶面是斜的、
 * 上面站不住一个平底的盒子，所以这里用平均顶面即可（`topAt` 只影响站在坡上的位置）。
 */
export function objectsOnTop(state: DirectorState, id: string): DirectorObject[] {
  const lower = state.objects.find((o) => o.id === id);
  if (!lower) return [];
  return state.objects.filter((o) => restsOn(o, lower));
}

/**
 * 从 `id` 出发，自顶向下（其实是自下而上）收集整条堆叠链 —— **含 `id` 自身**。
 *
 * 返回顺序：`id` 在最前，然后依次是压在它上面的各层（BFS 逐层展开）。
 * 用 visited 集合防环（手工数据里理论上不该有环，但几何判定是"相切"，两个盒子不可能互相相切）。
 */
export function stackChain(state: DirectorState, id: string): DirectorObject[] {
  const root = state.objects.find((o) => o.id === id);
  if (!root) return [];
  const visited = new Set<string>([id]);
  const out: DirectorObject[] = [root];
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const lowerId of frontier) {
      for (const upper of objectsOnTop(state, lowerId)) {
        if (visited.has(upper.id)) continue;
        visited.add(upper.id);
        out.push(upper);
        next.push(upper.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 拖动传播：把整条堆叠链按 (dx, dz) 平移。
 *
 * 只改 x/z —— **不动 baseY**：整塔一起平移时，层与层的相对高度没变，
 * 各层的 `baseY` 依然等于其下方支撑的顶面（因为支撑也跟着走了）。
 * 平移后整体是否踩空、要不要重新落底，由调用方在算完落点后另跑 `settleStack`。
 *
 * @returns 平移后的 objects 数组（未变化的对象保持原引用）。
 */
export function translateStack(
  state: DirectorState,
  id: string,
  dx: number,
  dz: number,
): DirectorObject[] {
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return state.objects;
  const chain = new Set(stackChain(state, id).map((o) => o.id));
  return state.objects.map((o) =>
    chain.has(o.id) ? { ...o, x: o.x + dx, z: o.z + dz } : o,
  );
}

/**
 * 失支撑即落：给一条链上的每个对象**从下往上**重新推导 `baseY`。
 *
 * 对每个对象：在它的中心 (x, z) 处找**不高于它当前底面**的最高支撑面，把 `baseY` 落到
 * 那个面上；没有支撑 → 落回基准面 0。这是 `restingHeightAt` / `placeObject` 的同一套
 * 支撑几何（`supportUnder`），因此"点在哪里落、塔就落在哪里"两边永远一致。
 *
 * **必须从下往上处理**：上层的落点取决于下层的最终位置。逐层自底向上，
 * 每层定完高后它就成了下一层的候选支撑（这是"顺序不变量"在垂直方向的翻版 ——
 * 与 `placeObject` 的"先定层高、再分离"同源）。
 *
 * **只向下修正，不向上抬。** 判据是"支撑面 ≤ 当前底面"：被推动/被抽走支撑的对象下落；
 * 但整塔被搬到更高的平台上时，各层不会自己"吸"上去 —— 那是 `moveObject` 先用
 * `placeObject` 定的层高（见下）。
 *
 * ## 排除规则：只排除「自己 + 链内更高的层」，**保留链内更低的层**
 *
 * 塔被整体平移后各层相对位置没变 —— A 仍在 B 正下方。若不排除自身，复审 B 时会发现
 * "A 的顶面正好接住我"，于是判定 B 不需要动；复审 C 同理，整塔踩空却谁也不落
 * （这正是回归测试抓到的那条）。
 *
 * 但**不能排除整条链**：那样 B 落定后也无法成为 C 的支撑，C 会穿过 B 落到地上
 * （另一条被回归测试抓到的错误）。正确做法是利用"自下而上"这个处理顺序：
 * 轮到 X 时，比 X 低的层**已经落到最终位置**了，它们就是 X 真实的新支撑，必须保留；
 * 而比 X 高的层还没处理、高度还是旧的，必须排除以免"上层接住下层"这种倒挂。
 *
 * 所以排除集 = `{X} ∪ {链内高于 X 的层}`。
 *
 * @param chainIds 要重算的链（顺序无所谓，函数内部会按底层到顶层排序）。
 */
export function settleStack(
  state: DirectorState,
  chainIds: readonly string[],
): DirectorObject[] {
  if (chainIds.length === 0) return state.objects;

  // 自底向上排序：按当前底面高度升序。底面的先定，成为上面的候选支撑。
  const ordered = [...chainIds]
    .map((cid) => state.objects.find((o) => o.id === cid))
    .filter((o): o is DirectorObject => !!o)
    .sort((a, b) => objectBottom(a) - objectBottom(b));
  if (ordered.length === 0) return state.objects;

  let objects = state.objects;

  for (let i = 0; i < ordered.length; i += 1) {
    const self = ordered[i];
    const cur = objects.find((o) => o.id === self.id) ?? self;
    const currentBottom = objectBottom(cur);
    // 排除「自己 + 链内更高的层」；链内更低的层（已落定）保留为真实支撑。
    const exclude = new Set<string>([cur.id]);
    for (let j = i + 1; j < ordered.length; j += 1) exclude.add(ordered[j].id);
    // supportUnder 的 maxStep 用 0 → 只接"顶面 ≤ 当前底面"的面（只降不升），
    // 与实际落体语义一致；若它已被搬到高台上，则由 placeObject 另行定高。
    const landing = settleSupport(objects, cur, currentBottom, exclude);
    // 新 baseY = 落点 + 「baseY 相对实体下沿的下探量」。
    // `bottom` 是**绝对世界高度**（schema），不是相对 baseY 的偏移，所以改 baseY 时
    // 必须把 bottom 平移同一个 Δ，否则拱洞/桥的净空会被静默改写
    // （回归测试 §23 "拱洞厚度保留" 抓的就是这条）。
    const sink = (cur.baseY ?? 0) - currentBottom; // 拱洞下探量，≥ 0；普通盒子为 0
    const nextBaseY = landing + sink;
    const nextBottom = cur.bottom === undefined ? undefined : currentBottom + (nextBaseY - (cur.baseY ?? 0));
    if (
      Math.abs((cur.baseY ?? 0) - nextBaseY) <= 1e-9 &&
      (cur.bottom === undefined || Math.abs(cur.bottom - (nextBottom as number)) <= 1e-9)
    ) {
      continue; // 已是目标值 → 不动（保持引用稳定，避免无谓的全场重渲染）
    }
    objects = objects.map((o) =>
      o.id === cur.id
        ? { ...o, baseY: nextBaseY, ...(nextBottom === undefined ? {} : { bottom: nextBottom }) }
        : o,
    );
  }

  return objects;
}

/**
 * 在排除 `exclude` 的前提下，求 `cur` 在自身 (x, z) 处能落到的高度。
 *
 * 直接借 `supportUnder` —— 它已经是"点支撑"的权威实现（`coversXZ` 按局部坐标、
 * `topAt` 认坡道），但 `excludeId` 只收一个 id，所以这里逐个排除后取**最小值**：
 * 排除得越多、可选的支撑面越低，取 min 即"在排除集全排掉后仍成立"的落点。
 *
 * 注意：`supportUnder` 的桶索引按 `state.objects` **引用**缓存，所以这里每次都用
 * 当前 `objects` 数组现构一个 state（引用不同 → 缓存自动按最新几何重建），
 * 不能跨迭代复用同一个 state 对象。
 */
function settleSupport(
  objects: readonly DirectorObject[],
  cur: DirectorObject,
  currentBottom: number,
  exclude: ReadonlySet<string>,
): number {
  // 逐成员排除取 min（excludeId 一次只能排一个）。起点 `undefined` = 只排 cur 自己，
  // 是最宽松的候选上界；每多排一个成员，可选支撑只会更低或不变。
  let landing = Number.POSITIVE_INFINITY;
  const ids: (string | undefined)[] = [undefined];
  for (const cid of exclude) if (cid !== cur.id) ids.push(cid);
  for (const ex of ids) landing = Math.min(landing, baseline(objects, cur, currentBottom, ex));
  return landing;
}

/** 单次支援查询（排除至多一个 id）。只降不升：maxStep = 0。 */
function baseline(
  objects: readonly DirectorObject[],
  cur: DirectorObject,
  currentBottom: number,
  excludeId: string | undefined,
): number {
  // supportUnder 的 ceiling = fromY + maxStep + EPS。用 currentBottom 作 fromY、
  // maxStep = 0 → 只接"顶面 ≤ 当前底面"的面；精确相切（== currentBottom）也算接住。
  return supportUnder(
    { objects: objects as DirectorObject[] } as DirectorState,
    cur.x,
    cur.z,
    currentBottom,
    0,
    excludeId,
  ).y;
}

/** 便捷：一条链平移 + 复位（拖动传播的完整语义）。 */
export function moveStack(
  state: DirectorState,
  id: string,
  dx: number,
  dz: number,
): DirectorObject[] {
  const chain = stackChain(state, id).map((o) => o.id);
  const translated = translateStack(state, id, dx, dz);
  return settleStack({ ...state, objects: translated }, chain);
}

/** 平移向量的便捷构造（供拖拽逐帧调用时复用）。 */
export function delta(from: Vec2, to: Vec2): Vec2 {
  return { x: to.x - from.x, z: to.z - from.z };
}
