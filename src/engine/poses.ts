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
  return { joints };
}
