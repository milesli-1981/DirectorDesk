import { DirectorState, WorldMode } from "../domain/schema";

/**
 * 世界模式的读取，以及「本次交互的 3D 覆盖」。
 *
 * ## 为什么需要覆盖层
 *
 * `worldMode` 是一个**场景级**属性：持久化、全局、决定整个世界的解算方式
 * （见 `schema.ts` 的说明 —— 它是能力表的退化取值，不是特例分支）。
 * 但作者的真实诉求常常是局部的：「我只想把这一摞盒子叠起来，然后接着画平面图」。
 * 为此引入一个**手势级**覆盖：按住 Shift 拖放 = 这一次操作按 terrain 语义走。
 *
 * ## 为什么不直接把覆盖写回 state.worldMode
 *
 * `worldMode` 是能力表的总闸（`locomotion.ts` 看到 planar 会整体换成 PLANAR_LOCOMOTION），
 * 所以改它 = 全场景重新解算：场内所有演员会瞬间跳到台阶上、路径标记整体抬升、
 * 高度手柄凭空出现 —— 松手又全部退回。一个按键引发全场跳变，噪音远大于收益，
 * 而且会把「我只是想把这一个盒子放上去」和「我要看 3D 世界」两件事混在一起。
 *
 * 覆盖只作用在**那一次操作**上：落点拾取与落位吸附。
 * 一旦 baseY 被写进数据，渲染 / 站立 / 路径贴地这些**稳态**行为本来就读 baseY
 * （`standingHeightFor`、`pathGroundAt`），planar 下 `maxStep = 0` 恰好等于
 * 「只在自己那一层里走动」，所以不需要为它们再做任何覆盖 —— 松开 Shift 也依然正确。
 */

/** 读世界模式，缺省 planar（老存档没有这个字段）。 */
export function worldModeOf(state: DirectorState): WorldMode {
  return state.worldMode ?? "planar";
}

/**
 * 生成一份「世界模式 = terrain」的 state 视图，供下游那些直接读 `state.worldMode` 的函数复用。
 *
 * 已经有 terrain / 没有覆盖时**原样返回同一个引用**，不产生分配。这一点不只是省内存：
 * `ground.ts` 的桶索引以 `objects` 数组引用 + worldMode 为 key 做缓存，
 * 浅拷贝保留 `objects` 引用，所以覆盖期间索引稳稳命中，不会每帧重建。
 */
export function effectiveState(state: DirectorState, forceTerrain?: boolean): DirectorState {
  if (!forceTerrain) return state;
  if (worldModeOf(state) === "terrain") return state;
  return { ...state, worldMode: "terrain" };
}
