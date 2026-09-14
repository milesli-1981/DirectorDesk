import { AssetCategory, DirectorObject, DirectorState, Locomotion } from "../domain/schema";

/**
 * 运动能力表。
 *
 * 设计要点：**阈值挂在运动主体上，不是障碍上。**
 * 同一堵 0.3m 的台阶，人抬腿就上去了；车要绕；马直接跨过去还嫌矮。
 * 把 maxStep 放在障碍上是错的 —— 障碍不知道自己面对的是谁。
 *
 * 这些数会同时喂给：
 * - `groundHeightAt` / `standable`（贴地判定）
 * - 跳跃包络 `reach(Δh) = R/2 · (1 + √(1 − Δh/H))`（见 docs/3d/02）
 * - 头顶净空与落脚面积采样
 */

/** 会动的类别（有运动能力）；set 类没有。 */
export const LOCOMOTION: Partial<Record<AssetCategory, Locomotion>> = {
  human: {
    // 单步 0.35m ≈ 正常抬腿能上的台阶高度（建筑规范里踏步常用 0.15–0.18m，室内外高差常 0.3–0.45m）。
    maxStep: 0.35,
    maxSlopeDeg: 45,
    // 原地起跳 0.9m ≈ 约身高一半；平地助跑跳远 2.5m ≈ 成年人的及格线。
    maxJumpHeight: 0.9,
    maxJumpReach: 2.5,
    // 攀爬 1.6m ≈ 举手够得到、能引体上去的极限（约等于身高减头高）。
    maxClimbHeight: 1.6,
    height: 1.8,
    foot: { w: 0.6, d: 0.6 },
  },
  animal: {
    // 马 / 犬的跨步能力明显高于人，但坡度容忍略低（四足重心高）。
    maxStep: 0.5,
    maxSlopeDeg: 40,
    maxJumpHeight: 1.2,
    maxJumpReach: 3.5,
    // 四足不会"攀爬"。
    maxClimbHeight: 0,
    height: 1.1,
    foot: { w: 0.9, d: 1.6 },
  },
  vehicle: {
    // 车只能上很缓的坎：0.15m 已经是普通轿车的极限，坡度 20° 接近越野车上限。
    maxStep: 0.15,
    maxSlopeDeg: 20,
    maxJumpHeight: 0,
    maxJumpReach: 0,
    maxClimbHeight: 0,
    height: 1.5,
    foot: { w: 2.0, d: 4.2 },
  },
};

/** 兜底能力表：不会跳、不会爬、只能走平地的"普通主体"。set 类用它。 */
export const ZERO_LOCOMOTION: Locomotion = {
  maxStep: 0,
  maxSlopeDeg: 0,
  maxJumpHeight: 0,
  maxJumpReach: 0,
  maxClimbHeight: 0,
  height: 1,
  foot: { w: 0.6, d: 0.6 },
};

/** planar 世界的能力表：maxStep = 0，于是只有 top ≤ 0 的面可站、所有 set 都保留为障碍。 */
export const PLANAR_LOCOMOTION: Locomotion = {
  ...ZERO_LOCOMOTION,
  maxStep: 0,
};

/**
 * 取某对象的运动能力。
 * 优先级：场景级 override > 类别预设 > 兜底。
 *
 * planar 世界直接短路成 PLANAR_LOCOMOTION —— 这是"planar 是能力表退化"的落地点，
 * 下游全部逻辑因此不需要特判世界模式。
 */
export function locomotionOf(state: DirectorState, object: DirectorObject | undefined): Locomotion {
  if (!object) return ZERO_LOCOMOTION;
  if ((state.worldMode ?? "planar") === "planar") return PLANAR_LOCOMOTION;
  const base = LOCOMOTION[object.category] ?? ZERO_LOCOMOTION;
  const override = state.locomotion?.[object.category];
  return override ? { ...base, ...override } : base;
}

/** 按 id 取运动能力。 */
export function locomotionOfId(state: DirectorState, objectId: string): Locomotion {
  return locomotionOf(
    state,
    state.objects.find((o) => o.id === objectId),
  );
}
