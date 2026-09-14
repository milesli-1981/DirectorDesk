import { DirectorObject } from "../domain/schema";

/**
 * 阵列（批量复制）的**落点纯函数** —— Phase 8 的"编辑效率"部分。
 *
 * ## 为什么它是纯函数
 *
 * 这里只做一件事：**给源对象的几何 + 一个规格，算出 N 个目标落点**。
 * 不读 `state`、不读 `currentTime`、不做射线查询 —— 与 `arc.ts` / `routeHeightFor`
 * 守同一条红线（`engine/avoidance.ts` 那条"时间无关 ⇒ 可按 revision 缓存"）。
 *
 * **副本最终落在哪个标高，不由这里决定** —— `baseY` 交给 `placeObject` 反查支撑面，
 * 这是全项目「摆放只有一个权威」的红线。唯一例外是 `stair`：台阶的抬高量是**作者的
 * 显式意图**（"我要一级 0.15m"），不是几何反查的结果，所以这里直接给 `baseY`，
 * 由 `placeObject` 以 `layerY` 身份接收（调用方显式给了标高时它就是权威）。
 *
 * ## planar 逐像素不变
 *
 * `stair` 只在 terrain 下才有意义（planar 没有高度）。所以非 stair 的 `ArraySlot.baseY`
 * 恒为 `undefined`；stair 是否真的生效由 store 跟着 `placeObject` 的返回走 ——
 * 与 `moveObject` / `addAsset` 判 terrain 的方式一致。
 */

/** 阵列排布方式。 */
export type ArrayKind =
  /** 一条直线：沿 X（或对象面向）依次排开。 */
  | "line"
  /** 矩形网格：rows × cols。 */
  | "grid"
  /** 台阶：每级抬高 rise、水平进深 run（**terrain 专属**）。 */
  | "stair"
  /** 圆环：半径 radius 上均匀分布。 */
  | "ring";

export interface ArraySpec {
  kind: ArrayKind;
  /** line / stair / ring 的份数。 */
  count?: number;
  /** grid 的行数（沿法线方向）。 */
  rows?: number;
  /** grid 的列数（沿前进方向）。 */
  cols?: number;
  /** 间距（米）。grid 未给 spacingX/Z 时用它同时作两轴的间距。 */
  spacing?: number;
  spacingX?: number;
  spacingZ?: number;
  /** stair：每级抬高（米）。 */
  rise?: number;
  /** stair：每级水平进深（米）。 */
  run?: number;
  /** ring：半径（米）。 */
  radius?: number;
  /** line / stair / grid 是否沿对象自身面向（rotation）排布，而非世界 X。默认 false。 */
  alongRotation?: boolean;
}

/** 一个阵列槽位的目标落点。`baseY` 仅 stair 给出。 */
export interface ArraySlot {
  /** 序号，从 0 起。第 0 号槽位与源对象当前位置重合。 */
  index: number;
  x: number;
  z: number;
  /** 作者显式指定的标高（仅 stair）；`undefined` = 让 `placeObject` 反查。 */
  baseY?: number;
}

const DEFAULT_COUNT = 3;
const DEFAULT_SPACING = 1.5;
const DEFAULT_RISE = 0.15;
const DEFAULT_RUN = 0.3;
const DEFAULT_RADIUS = 3;

/**
 * 计算阵列的每个落点。
 *
 * 返回**全部 N 个位置**，且**第 0 个与源对象当前位置重合**。这样两种 UI 语义
 * 共用同一份几何：
 * - "原地保留源对象、追加 N−1 个副本" → `arraySlots(...).slice(1)`
 * - "把整组（含源）重排成阵列" → 直接用全部，第 0 个会覆盖写回源对象
 *
 * @param source 源对象（提供起点 x/z、rotation 与 baseY）。
 * @param spec 阵列规格。缺字段走默认值，不会抛。
 */
export function arraySlots(source: DirectorObject, spec: ArraySpec): ArraySlot[] {
  const count = Math.max(1, Math.floor(spec.count ?? DEFAULT_COUNT));
  const spacing = spec.spacing ?? DEFAULT_SPACING;

  switch (spec.kind) {
    case "line": {
      const dir = unitDir(source, spec.alongRotation);
      const out: ArraySlot[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push({
          index: i,
          x: source.x + dir.x * spacing * i,
          z: source.z + dir.z * spacing * i,
        });
      }
      return out;
    }

    case "grid": {
      const rows = Math.max(1, Math.floor(spec.rows ?? 2));
      const cols = Math.max(1, Math.floor(spec.cols ?? count));
      const sx = spec.spacingX ?? spacing;
      const sz = spec.spacingZ ?? spacing;
      const dir = unitDir(source, spec.alongRotation);
      // 沿"前进方向"布列，沿其法线布行 —— 这样 `alongRotation` 对 grid 也生效。
      const nx = -dir.z;
      const nz = dir.x;
      const out: ArraySlot[] = [];
      let index = 0;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          out.push({
            index,
            x: source.x + dir.x * sx * c + nx * sz * r,
            z: source.z + dir.z * sx * c + nz * sz * r,
          });
          index += 1;
        }
      }
      return out;
    }

    case "stair": {
      const dir = unitDir(source, spec.alongRotation);
      const rise = spec.rise ?? DEFAULT_RISE;
      const run = spec.run ?? DEFAULT_RUN;
      const baseY0 = source.baseY ?? 0;
      const out: ArraySlot[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push({
          index: i,
          x: source.x + dir.x * run * i,
          z: source.z + dir.z * run * i,
          // 作者的显式意图：第 i 级 = 源标高 + i×rise。
          // 抬高之后它下方是否还有东西托着，是 `placeObject` 的事，不由这里操心。
          baseY: baseY0 + rise * i,
        });
      }
      return out;
    }

    case "ring": {
      const radius = spec.radius ?? DEFAULT_RADIUS;
      const n = Math.max(1, count);
      // i=0 落在"源对象所在的方位角"上，于是第一个副本与源同向，视觉上不会跳一下。
      const baseAngle = Math.atan2(source.z, source.x);
      const out: ArraySlot[] = [];
      for (let i = 0; i < n; i += 1) {
        const t = (i / n) * Math.PI * 2;
        out.push({
          index: i,
          x: Math.cos(baseAngle + t) * radius,
          z: Math.sin(baseAngle + t) * radius,
        });
      }
      return out;
    }

    default:
      return [];
  }
}

/**
 * 阵列的前进方向单位向量。
 *
 * `alongRotation` 为假时固定沿世界 +X —— 这是"阵列"最直觉的默认值，
 * 且与 Inspector 里的 rotation 输入框互相独立（改朝向不会让阵列跟着乱转）。
 */
function unitDir(source: DirectorObject, alongRotation?: boolean): { x: number; z: number } {
  if (!alongRotation || !source.rotation) return { x: 1, z: 0 };
  const t = ((source.rotation ?? 0) * Math.PI) / 180;
  return { x: Math.cos(t), z: Math.sin(t) };
}

/**
 * 阵列的总份数 —— 给 UI 做"会生成多少份"的预览，不必真的构造 Slots。
 * grid 是 rows×cols，其余是 count。
 */
export function arrayCount(spec: ArraySpec): number {
  if (spec.kind === "grid") {
    return Math.max(1, Math.floor(spec.rows ?? 2)) * Math.max(1, Math.floor(spec.cols ?? 1));
  }
  return Math.max(1, Math.floor(spec.count ?? DEFAULT_COUNT));
}
