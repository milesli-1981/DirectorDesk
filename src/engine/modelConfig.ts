import { ActionKind, AssetCategory } from "../domain/schema";

/** 非步态类动作（姿态 / 手势）对应的 clip 名候选。 */
type PoseClipMap = Partial<Record<Exclude<ActionKind, "walk" | "run">, string[]>>;

export interface ModelConfig {
  url: string;
  /** 朝向修正：模型正面若与我们的 +Z 前向相反，设为 180。 */
  facingFixDeg?: number;
  clips: {
    idle: string[];
    walk: string[];
    run: string[];
    poses: PoseClipMap;
  };
}

/**
 * 按资产类别配置 GLB 模型。
 * 目前只接人物（最小验证）；车辆 / 动物后续按同样方式加进来即可，
 * 未配置的类别继续走方块简模（见 WorldView）。
 */
export const MODEL_CONFIG: Partial<Record<AssetCategory, ModelConfig>> = {
  human: {
    url: "/models/Xbot.glb",
    // Xbot（Mixamo / three.js 官方示例）：正常人体比例，无盔甲、非大头。
    // 自带片段：idle / walk / run / agree(点头) / headShake(摇头) / sad_pose / sneak_pose(潜行下蹲)。
    // 朝向：本项目约定「模型正面 = 本地 +Z、相机/行走前向 = (sin,cos)」，该模型正面朝 +Z，与约定一致。
    // 注意：facingFixDeg 同时作用于行走朝向与相机取景，改它会让角色相对行进方向侧身，
    // 不要用它去修相机 Side 错位（Side 由 cameraSolver 的 SIDE_ANGLE 决定）。
    // 若换其它模型发现背对镜头，才按需改为 180。
    facingFixDeg: 0,
    clips: {
      idle: ["idle"],
      walk: ["walking", "walk"],
      run: ["running", "run"],
      poses: {
        // 只保留**诚实的**映射：模型真有这个状态才映射。
        stand: ["standing", "idle"],
        crouch: ["crouch", "crouching", "sneak_pose"],
        // Xbot 没有 sit / wave / point / talk 的专用片段。
        //
        // **不拿别的片段顶替**：曾经 wave→agree、talk→agree，于是"挥手"和"说话"演成
        // 同一段点头 —— 作者看到的正是"选哪个都一个样"。缺片段时退回**关节角**
        // （见 `actionPose.ts` 的 `clipJointAngles` + `HumanoidModel` 的兜底分支），
        // 这样每个动作各不相同，且与方块简模的姿势一致。
      },
    },
  },
};

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * 在可用 clip 名中找出第一个匹配：先精确，再去符号小写全等，最后子串。
 * 这样同一份配置能适配不同命名风格的模型（Idle / idle / Walking …）。
 */
export function findClip(available: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const hit = available.find((name) => name === candidate);
    if (hit) return hit;
  }
  const targets = candidates.map(norm);
  for (const target of targets) {
    const hit = available.find((name) => norm(name) === target);
    if (hit) return hit;
  }
  for (const target of targets) {
    if (!target) continue;
    const hit = available.find((name) => norm(name).includes(target));
    if (hit) return hit;
  }
  return undefined;
}

/** 每类动作的名义速度（m/s），用于按实际速度缩放 timeScale，减少脚底打滑。 */
export const NOMINAL_SPEED: Record<"walk" | "run", number> = {
  walk: 1.6,
  run: 3.2,
};
