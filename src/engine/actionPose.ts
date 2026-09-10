import { ActionKind, DirectorState, JointName, Pose } from "../domain/schema";
import { POSE_PRESETS, isGaitKind } from "./poses";

/** 静态姿势类：坐下 / 蹲下时腿部不再走/跑摆动（locomotionScale → 0）。 */
const STATIC_KINDS = new Set<ActionKind>(["stand", "sit", "crouch"]);
/** 周期类：在预设基线上叠加随时间振荡（挥手 / 说话手势）。 */
const CYCLIC_KINDS = new Set<ActionKind>(["wave", "talk"]);

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
 * 采样某演员在 time 时刻由 ActionClip 贡献的姿势。
 * - 静态类（sit/crouch）：以 easing 渐入的关节角度。
 * - 周期类（wave/talk）：在预设基线上叠加随时间振荡。
 * - 多个 clip 叠加（角度累加）；locomotionScale 取静态 clip 的最大渐入量。
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
  const empty: ActionSample = { pose: { joints: {} }, locomotionScale: 1, gait: "auto" };
  if (active.length === 0) return empty;

  const joints: Pose["joints"] = {};
  let locoSuppress = 0;
  let gait: GaitMode = "auto";

  for (const clip of active) {
    // custom：关节角完全取自「自定义动作库」里那条命名记录；customId 悬空时按标准站姿处理。
    const customPose =
      clip.kind === "custom"
        ? (state.customActions ?? []).find((p) => p.id === clip.customId)
        : undefined;
    const preset = customPose ? { joints: customPose.joints } : POSE_PRESETS[clip.kind] ?? { joints: {} };
    // 片段自带的关节覆盖优先于 kind 预设。
    const override = clip.pose?.joints ?? {};
    const map: Pose["joints"] = { ...preset.joints, ...override };
    const tLocal =
      (time - clip.timeStart) / Math.max(0.001, clip.timeEnd - clip.timeStart);
    const blend = easeInOut(tLocal);
    const cyclic = CYCLIC_KINDS.has(clip.kind);

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
      const cur = joints[key]?.[0] ?? 0;
      joints[key] = [cur + v * blend, 0, 0];
    }
    if (STATIC_KINDS.has(clip.kind)) locoSuppress = Math.max(locoSuppress, blend);
    // 步态类片段指定"怎么走"；多个时以最后一个为准。
    if (isGaitKind(clip.kind)) gait = clip.kind as GaitMode;
  }

  return { pose: { joints }, locomotionScale: 1 - locoSuppress, gait };
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
