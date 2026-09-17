import { JointName, Pose, Vec3 } from "../domain/schema";

/** 预设姿势：只给出需要覆盖的关节，未列出的关节保持默认 0（标准站姿）。 */
export const POSE_PRESETS: Record<string, Pose> = {
  stand: { joints: {} },
  sit: {
    joints: {
      hipL: [-1.2, 0, 0],
      hipR: [-1.2, 0, 0],
      kneeL: [1.2, 0, 0],
      kneeR: [1.2, 0, 0],
      spine: [0.15, 0, 0],
    },
  },
  crouch: {
    joints: {
      hipL: [-1.9, 0, 0],
      hipR: [-1.9, 0, 0],
      kneeL: [1.9, 0, 0],
      kneeR: [1.9, 0, 0],
      spine: [0.4, 0, 0],
    },
  },
  wave: {
    joints: {
      shoulderR: [-Math.PI * 0.5, 0, 0],
      elbowR: [Math.PI * 0.4, 0, 0],
    },
  },
  point: {
    joints: {
      shoulderR: [-Math.PI * 0.3, 0, 0],
      elbowR: [0, 0, -Math.PI * 0.25],
    },
  },
  talk: {
    joints: {
      shoulderL: [0.1, 0, 0],
      elbowL: [Math.PI * 0.5, 0, 0],
    },
  },
  // 步态类：无静态关节角度，由 HumanoidRig 依此选择步频 / 摆幅 / 前倾。
  walk: { joints: {} },
  run: { joints: {} },

  /* ---------------------------------------------- Phase 7：跳跃 / 攀爬姿态 */
  //
  // 这六个预设**不是新的运动**，只是关节角 —— 由 `actionPose.ts` 在离地区间内自动叠加
  // （判据见 `stance.ts` 的 `airborneOf`，与相机跟跳防抖同源）。
  // 作者的显式动作片段优先：这几个只是"没手动 K 姿势时"的兜底。

  /** 起跳：屈膝蓄力后蹬伸 —— 髋前摆、膝略屈、躯干前倾、双臂后摆。 */
  jumpTakeoff: {
    joints: {
      hipL: [-0.55, 0, 0],
      hipR: [-0.55, 0, 0],
      kneeL: [0.5, 0, 0],
      kneeR: [0.5, 0, 0],
      spine: [0.22, 0, 0],
      shoulderL: [0.5, 0, 0],
      shoulderR: [0.5, 0, 0],
    },
  },
  /** 滞空：抱膝收腿，双臂微张保持平衡。 */
  jumpAir: {
    joints: {
      hipL: [-0.95, 0, 0],
      hipR: [-0.35, 0, 0],
      kneeL: [1.25, 0, 0],
      kneeR: [0.55, 0, 0],
      spine: [0.1, 0, 0],
      shoulderL: [-0.35, 0, -0.5],
      shoulderR: [-0.35, 0, 0.5],
    },
  },
  /** 落地：屈膝缓冲 —— 深屈髋膝、躯干前倾、双臂前伸。 */
  jumpLand: {
    joints: {
      hipL: [-1.1, 0, 0],
      hipR: [-1.1, 0, 0],
      kneeL: [1.35, 0, 0],
      kneeR: [1.35, 0, 0],
      spine: [0.42, 0, 0],
      shoulderL: [-0.6, 0, 0],
      shoulderR: [-0.6, 0, 0],
    },
  },
  /** 攀爬够手：单臂上举抓边缘，另一臂辅助，同侧腿抬起。 */
  climbReach: {
    joints: {
      shoulderR: [-Math.PI * 0.92, 0, 0],
      elbowR: [0.25, 0, 0],
      shoulderL: [-Math.PI * 0.35, 0, 0],
      hipR: [-1.5, 0, 0],
      kneeR: [1.1, 0, 0],
      spine: [0.3, 0, 0],
    },
  },
  /** 攀爬上步：撑起身体、屈髋提膝踩上边缘。 */
  climbUp: {
    joints: {
      shoulderR: [-Math.PI * 0.55, 0, 0],
      elbowR: [Math.PI * 0.55, 0, 0],
      shoulderL: [-Math.PI * 0.3, 0, 0],
      elbowL: [Math.PI * 0.4, 0, 0],
      hipR: [-1.8, 0, 0],
      kneeR: [1.6, 0, 0],
      hipL: [-0.4, 0, 0],
      spine: [0.5, 0, 0],
    },
  },
  /** 悬挂：双臂伸直挂住，双腿自然垂下微屈。 */
  hang: {
    joints: {
      shoulderR: [-Math.PI, 0, 0],
      shoulderL: [-Math.PI, 0, 0],
      hipL: [-0.2, 0, 0],
      hipR: [-0.2, 0, 0],
      kneeL: [0.35, 0, 0],
      kneeR: [0.35, 0, 0],
      spine: [0.05, 0, 0],
    },
  },
};

/**
 * **作者可选**的姿势（静态 / 手势）：只有这些能出现在"静态基线姿势"的下拉里。
 *
 * 用**白名单**而不是"从 `POSE_PRESET_NAMES` 里排除几个"：那张表里还住着步态与阶段姿势，
 * 黑名单按定义一定会漏 —— 漏的结果是下拉里出现**选了也不触发**的死选项
 * （例如选 `jumpAir`，人只会摆出抱膝的姿势站着，并不会跳）。
 */
export const AUTHOR_POSE_NAMES = ["stand", "sit", "crouch", "wave", "point", "talk"] as const;
export type AuthorPoseName = (typeof AUTHOR_POSE_NAMES)[number];

/** 步态类：不是姿势，只决定步频 / 摆幅 / 前倾（没有静态关节角度）。 */
export const GAIT_POSE_NAMES = ["walk", "run"] as const;

/**
 * **阶段姿势**：由弧线的进度自动挑，**不可选**。
 *
 * 起跳 / 滞空 / 落地的边界在 `actionPose.ts` 的 `airbornePresetAt`（15% / 70% / 15%），
 * 离地判据在 `stance.ts` 的 `airborneOf` —— 两者才是这几个预设的"开关"，不是下拉框。
 * 它们与静态姿势共用 `Pose` 这个形状，仅此而已。
 */
export const STANCE_POSE_NAMES = [
  "jumpTakeoff",
  "jumpAir",
  "jumpLand",
  "climbReach",
  "climbUp",
  "hang",
] as const;
export type StancePoseName = (typeof STANCE_POSE_NAMES)[number];

/**
 * `POSE_PRESETS` 的**全部**键（作者可选 + 步态 + 阶段）。
 *
 * 要"作者可选"那份请用 `AUTHOR_POSE_NAMES` —— 这个常量只用来做完整性校验
 * （三类不重不漏，见 scripts/check-3d.ts §35）。
 */
export const POSE_PRESET_NAMES = Object.keys(POSE_PRESETS);

/** 步态类动作：只影响步频 / 摆幅 / 前倾，不影响静态关节角度。 */
export function isGaitKind(kind: string): boolean {
  return kind === "walk" || kind === "run";
}

/** 取某关节当前角度（默认 [0,0,0]）。 */
export function jointAngle(pose: Pose | undefined, joint: JointName): Vec3 {
  return pose?.joints[joint] ?? [0, 0, 0];
}

/** 深拷贝一份姿势，避免直接复用预设对象的引用。 */
export function clonePose(pose: Pose): Pose {
  const joints: Pose["joints"] = {};
  for (const key of Object.keys(pose.joints) as JointName[]) {
    const v = pose.joints[key];
    if (v) joints[key] = [v[0], v[1], v[2]];
  }
  // rootY 是作者旋钮（骨盆额外偏移），必须一起带走 —— 漏掉就等于静默丢弃作者的微调。
  return pose.rootY === undefined ? { joints } : { joints, rootY: pose.rootY };
}
