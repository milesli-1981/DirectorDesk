import { ActionClip, ActionKind, DirectorState, JointName, Pose } from "../domain/schema";
import { POSE_PRESETS, isGaitKind } from "./poses";
import { airborneOf } from "./stance";

/** 静态姿势类：坐下 / 蹲下时腿部不再走/跑摆动（locomotionScale → 0）。 */
const STATIC_KINDS = new Set<ActionKind>(["stand", "sit", "crouch"]);
/** 周期类：在预设基线上叠加随时间振荡（挥手 / 说话手势）。 */
const CYCLIC_KINDS = new Set<ActionKind>(["wave", "talk"]);

/**
 * Phase 7：**离地自动姿态**的三段边界（占弧线区间的比例）。
 *
 * 起跳段 = 离地后前 15%，落地段 = 落地前 15%，中间是滞空段。
 * 这不是"物理阶段"，只是让三种关节角在视觉上接得上的时间窗。
 */
const TAKEOFF_FRACTION = 0.15;
const LAND_FRACTION = 0.15;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 进出缓动，避免姿势/动作突然跳变。 */
const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 步态：auto = 由 MOVE 的速度自动判定（低速走、高速跑）。 */
export type GaitMode = "auto" | "walk" | "run";

export interface ActionSample {
  pose: Pose;
  /** 0..1：乘到程序化走/跑摆动上；坐/蹲时为 0（腿部不再摆动）。 */
  locomotionScale: number;
  /** 当前步态：由 walk / run 片段指定，无片段时为 auto。 */
  gait: GaitMode;
}

/**
 * 片段内的**渐入量**（0..1）：进出都缓动，避免姿势突然跳变。
 *
 * 单独导出是因为"渐入怎么算"只该有一处 —— 渲染层要用同一个量做别的事
 * （GLB 里按它驱动动画权重、`actionPoseAt` 用它算 `locomotionScale`）。
 */
export function clipBlend(clip: ActionClip, time: number): number {
  const span = Math.max(0.001, clip.timeEnd - clip.timeStart);
  return easeInOut((time - clip.timeStart) / span);
}

/**
 * 一个动作片段在**关节空间**的角度贡献（已含渐入与 wave / talk 的时间振荡）。
 *
 * **这是"这个片段是什么姿势"的唯一出处**：方块简模（`WorldView` 的 `HumanoidRig`）
 * 与 GLB 骨骼（`HumanoidModel` 里"本模型没有对应动画片段"那一支）都调它。
 *
 * 为什么必须合一：GLB 那边曾经**只认动画片段名**，于是 `sit` / `point` / **自定义动作**
 * 选了完全没反应（`POSE_PRESETS` 与 `customActions` 它根本没读），而方块简模照做 ——
 * 同一份数据、两条渲染路径、两种结果。凡"同一件事在两处各写一遍"，迟早长歪。
 *
 * 不含**离地兜底**：那是"整段都没有作者姿势时"的叠加，不属于某个片段的贡献。
 */
export function clipJointAngles(
  state: DirectorState,
  clip: ActionClip,
  time: number,
): Pose["joints"] {
  // custom：关节角完全取自「自定义动作库」里那条命名记录；customId 悬空时按标准站姿处理。
  const customPose =
    clip.kind === "custom"
      ? (state.customActions ?? []).find((p) => p.id === clip.customId)
      : undefined;
  const preset = customPose ? { joints: customPose.joints } : POSE_PRESETS[clip.kind] ?? { joints: {} };
  // 片段自带的关节覆盖优先于 kind 预设。
  const override = clip.pose?.joints ?? {};
  const map: Pose["joints"] = { ...preset.joints, ...override };
  const blend = clipBlend(clip, time);
  const cyclic = CYCLIC_KINDS.has(clip.kind);
  const out: Pose["joints"] = {};

  for (const key of Object.keys(map) as JointName[]) {
    const base = preset.joints[key]?.[0] ?? 0;
    const over = override[key];
    let v: number;
    if (cyclic) {
      const omega = clip.kind === "wave" ? 7.5 : 9.5;
      v = (over ? over[0] : base) + Math.sin(time * omega) * 0.4;
    } else {
      v = over ? over[0] : base;
    }
    out[key] = [v * blend, 0, 0];
  }
  return out;
}

/**
 * 该片段算不算"**作者显式写的姿态**"（决定离地兜底要不要给它让位）。
 *
 * 步态（walk / run）不是姿态；`stand` 是"标准站姿"、`custom` 的关节躺在库里 ——
 * 这两者由渲染层各自叠加，所以不在此列。**采样与渲染共用这一个判据。**
 */
function isAuthorPoseClip(clip: ActionClip): boolean {
  return !isGaitKind(clip.kind) && clip.kind !== "custom" && clip.kind !== "stand";
}

/** 此刻是否有作者显式的姿态片段在生效（GLB 也问这一句，免得出现第二个答案）。 */
export function authorPoseActive(
  state: DirectorState,
  objectId: string,
  time: number,
): boolean {
  return (state.actions ?? []).some(
    (a) => a.object === objectId && time >= a.timeStart && time <= a.timeEnd && isAuthorPoseClip(a),
  );
}

/**
 * 采样某演员在 time 时刻由 ActionClip 贡献的姿势。
 * - 静态类（sit/crouch）：以 easing 渐入的关节角度。
 * - 周期类（wave/talk）：在预设基线上叠加随时间振荡。
 * - 多个 clip 叠加（角度累加）；locomotionScale 取静态 clip 的最大渐入量。
 * - **离地兜底**（Phase 7）：若该对象此刻在空中（`airborneOf`）、且**没有**显式的
 *   姿态类片段覆盖，则按"起跳 / 滞空 / 落地"三段自动给关节角。
 */
export function actionPoseAt(
  state: DirectorState,
  objectId: string,
  time: number,
): ActionSample {
  const actions = state.actions ?? [];
  const active = actions.filter(
    (a) => a.object === objectId && time >= a.timeStart && time <= a.timeEnd,
  );
  const joints: Pose["joints"] = {};
  let locoSuppress = 0;
  let gait: GaitMode = "auto";

  for (const clip of active) {
    // 角度来自唯一出处（kind 预设 / 自定义库 + 渐入 + 振荡），这里只负责累加。
    const angles = clipJointAngles(state, clip, time);
    for (const key of Object.keys(angles) as JointName[]) {
      const cur = joints[key]?.[0] ?? 0;
      joints[key] = [cur + (angles[key]?.[0] ?? 0), 0, 0];
    }
    if (STATIC_KINDS.has(clip.kind)) locoSuppress = Math.max(locoSuppress, clipBlend(clip, time));
    // 步态类片段指定"怎么走"；多个时以最后一个为准。
    if (isGaitKind(clip.kind)) gait = clip.kind as GaitMode;
  }

  // 离地兜底：仅当**没有**显式姿态类片段时才叠加（作者的姿势永远优先）。
  const airJoints = airborneJointAngles(state, objectId, time);
  if (airJoints && !active.some(isAuthorPoseClip)) {
    for (const key of Object.keys(airJoints) as JointName[]) {
      const v = airJoints[key]?.[0] ?? 0;
      const cur = joints[key]?.[0] ?? 0;
      joints[key] = [cur + v, 0, 0];
    }
  }

  if (active.length === 0 && !airJoints) {
    return { pose: { joints: {} }, locomotionScale: 1, gait: "auto" };
  }
  return { pose: { joints }, locomotionScale: 1 - locoSuppress, gait };
}

/**
 * 离地自动姿态（Phase 7）：起跳 / 滞空 / 落地三段 —— 返回**关节角**，不在空中则 null。
 *
 * 判据与相机跟跳防抖**同源**（`stance.ts` 的 `airborneOf`）—— 同一件事（"人在空中"）
 * 只该有一个判据。不在空中 → null（调用方跳过）。
 *
 * 三段的边界按**段进度**划分（起跳段 = 前 15%、落地段 = 后 15%），
 * 而不是按离地高度 —— 因为"滞空"是一段持续时间，不是一个高度阈值。
 *
 * 导出是因为 GLB 骨骼也要叠它：方块简模与它在同一段跳跃里必须是同一个姿势，
 * 否则"跳起来收不收腿"取决于用哪种身形渲染。
 */
export function airborneJointAngles(
  state: DirectorState,
  objectId: string,
  time: number,
): Pose["joints"] | null {
  const object = state.objects.find((o) => o.id === objectId);
  if (!object) return null;
  const { airborne } = airborneOf(state, object, object.x, object.z, time);
  if (!airborne) return null;
  return POSE_PRESETS[airbornePresetAt(state, objectId, time)]?.joints ?? null;
}

/** 按段进度挑"起跳 / 滞空 / 落地"三段之一（无活跃段时判为滞空）。 */
function airbornePresetAt(
  state: DirectorState,
  objectId: string,
  time: number,
): "jumpTakeoff" | "jumpAir" | "jumpLand" {
  const seg = (state.segments ?? []).find(
    (s) => s.object === objectId && time >= s.timeStart && time <= s.timeEnd,
  );
  if (!seg) return "jumpAir";
  const span = seg.timeEnd - seg.timeStart || 1;
  const s = (time - seg.timeStart) / span;
  if (s <= TAKEOFF_FRACTION) return "jumpTakeoff";
  if (s >= 1 - LAND_FRACTION) return "jumpLand";
  return "jumpAir";
}

/** 静态基线姿势淡出的速度下限/上限（m/s）。 */
const STATIC_POSE_MIN = 0.3;
const STATIC_POSE_MAX = 1.2;

/**
 * 静态基线姿势（object.pose）在给定速度下的权重。
 *
 * 「Pose（静态基线姿势）」只对**站定**的角色成立：角色一旦起步走/跑，就该由步态接管，
 * 否则会同时叠加静态关节角与走跑摆动——观感就是"一边走一边坐着"，腿部既不自然也看不出步态。
 * 因此在低速全额生效、进入步态后平滑衰减到 0；中间用 smoothstep 过渡，避免起步/停步
 * 的瞬间姿势突变（啪一下塌成静态姿势）。
 */
export function staticPoseWeight(speed: number): number {
  if (speed <= STATIC_POSE_MIN) return 1;
  if (speed >= STATIC_POSE_MAX) return 0;
  const t = (speed - STATIC_POSE_MIN) / (STATIC_POSE_MAX - STATIC_POSE_MIN);
  return 1 - t * t * (3 - 2 * t); // smoothstep
}
