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

// 步态类：没有静态关节角度，只决定走/跑节奏，因此不作为"静态基线姿势"展示。
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
