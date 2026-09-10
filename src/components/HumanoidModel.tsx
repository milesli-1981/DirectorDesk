import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { useAnimations, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { useDirectorStore } from "../state/directorStore";
import { actionPoseAt, staticPoseWeight } from "../engine/actionPose";
import { findClip, NOMINAL_SPEED, type ModelConfig } from "../engine/modelConfig";
import { JointName, Pose } from "../domain/schema";

/** 速度达到此值即视为跑（与 WorldView 里方块简模的步态阈值一致）。 */
const RUN_SPEED = 1.6;
/** 动作切换的交叉淡入时长（秒）。 */
const FADE = 0.25;
/**
 * 角色色的着色强度：向目标色插值，而不是直接相乘。
 * 相乘会把整体压暗（灰色模型尤其明显），插值则能保持亮度、只改变色相。
 */
const CHARACTER_TINT = 0.65;

/**
 * 关节名 → GLB 骨骼名候选（大小写无关、忽略 mixamorig 前缀）。
 * 仅用于在用户自定义关节时按名找到对应骨骼并叠加角度；
 * 找不到则跳过（不影响动画 clip 本身）。
 */
const JOINT_BONE_CANDIDATES: Record<JointName, string[]> = {
  root: ["hips", "pelvis", "hip"],
  spine: ["spine"],
  neck: ["neck"],
  shoulderL: ["leftshoulder", "leftarm", "leftupperarm"],
  elbowL: ["leftforearm", "leftelbow", "leftlowerarm"],
  shoulderR: ["rightshoulder", "rightarm", "rightupperarm"],
  elbowR: ["rightforearm", "rightelbow", "rightlowerarm"],
  hipL: ["leftupleg", "lefthip", "leftupperleg"],
  kneeL: ["leftleg", "leftknee", "leftlowerleg"],
  hipR: ["rightupleg", "righthip", "rightupperleg"],
  kneeR: ["rightleg", "rightknee", "rightlowerleg"],
};

function resolveBones(model: THREE.Object3D): Partial<Record<JointName, THREE.Bone>> {
  const found: Partial<Record<JointName, THREE.Bone>> = {};
  model.traverse((obj) => {
    const bone = obj as THREE.Bone;
    if (!(bone as unknown as { isBone?: boolean }).isBone) return;
    const name = bone.name.toLowerCase().replace(/^mixamorig/i, "");
    for (const joint of Object.keys(JOINT_BONE_CANDIDATES) as JointName[]) {
      if (found[joint]) continue;
      if (JOINT_BONE_CANDIDATES[joint].some((candidate) => name.includes(candidate))) {
        found[joint] = bone;
      }
    }
  });
  return found;
}

/**
 * GLB 骨骼人物：位置 / 朝向仍由 solver 驱动（单一数据源不变），
 * 这里只负责「身体怎么动」——按速度在 Idle / Walk / Run 之间混合，
 * 并在有姿态类动作片段（sit / wave …）时覆盖播放对应 clip。
 */
export function HumanoidGLB({
  objectId,
  height,
  speedRef,
  config,
  color,
}: {
  objectId: string;
  height: number;
  speedRef: { current: number };
  config: ModelConfig;
  /** 角色颜色：用来区分不同演员（每个演员独立材质，互不串色）。 */
  color?: string;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const { scene, animations } = useGLTF(config.url);
  // 每个演员需要独立骨骼，必须用 SkeletonUtils.clone（Object3D.clone 会共享骨骼）。
  // 材质同样要 clone：clone 出来的模型默认共享材质，直接改色会串色、还会污染 GLTF 缓存。
  const model = useMemo(() => {
    const cloned = cloneSkeleton(scene);
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      mesh.material = Array.isArray(material)
        ? material.map((item) => item.clone())
        : material.clone();
    });
    return cloned;
  }, [scene]);

  // 记下材质原色，着色时基于原色计算——否则重复着色会不断累积、越叠越浓。
  const baseColors = useMemo(() => {
    const map = new Map<THREE.MeshStandardMaterial, THREE.Color>();
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const item of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const material = item as THREE.MeshStandardMaterial;
        if (material?.color) map.set(material, material.color.clone());
      }
    });
    return map;
  }, [model]);

  useEffect(() => {
    if (!color) return;
    const tint = new THREE.Color(color);
    for (const [material, base] of baseColors) {
      material.color.copy(base).lerp(tint, CHARACTER_TINT);
    }
  }, [baseColors, color]);
  const { actions } = useAnimations(animations, rootRef);

  const names = useMemo(() => animations.map((clip) => clip.name), [animations]);
  const idleName = useMemo(() => findClip(names, config.clips.idle), [names, config]);
  const walkName = useMemo(() => findClip(names, config.clips.walk), [names, config]);
  const runName = useMemo(() => findClip(names, config.clips.run), [names, config]);
  // 解析各关节对应的骨骼（仅用于叠加用户自定义角度，找不到则该关节跳过）。
  const bones = useMemo(() => resolveBones(model), [model]);

  // 归一化到资产的 footprint 高度，并把脚底对齐到 y = 0。
  const { scale, offsetY } = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const h = box.max.y - box.min.y;
    const s = h > 0.001 ? height / h : 1;
    return { scale: s, offsetY: -box.min.y * s };
  }, [scene, height]);

  const overrideRef = useRef<string | null>(null);

  useEffect(() => {
    const base = [idleName, walkName, runName].filter((name): name is string => !!name);
    base.forEach((name) => {
      const action = actions[name];
      if (!action) return;
      action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
      action.setEffectiveWeight(0);
    });
    return () => {
      base.forEach((name) => actions[name]?.stop());
    };
  }, [actions, idleName, walkName, runName]);

  useFrame(() => {
    const speed = speedRef.current;
    const { state, currentTime } = useDirectorStore.getState();
    const sample = actionPoseAt(state, objectId, currentTime);

    // 关节覆盖 = 静态基线（object.pose）+ 本片段自定义（clip.pose），二者叠加。
    // 静态基线即 Inspector「Pose（静态基线姿势）」写入的 object.pose：方块简模 HumanoidRig
    // 一直有叠加，但 GLB 这边此前完全没读它 → 角色上 Pose 按钮无效。Xbot 自带片段里并没有
    // sitting（只有 sneak_pose 对应 crouch），这类静态姿势只能靠关节角表达，故必须补上。
    const overrideJoints: Pose["joints"] = {};
    // 静态基线只对站定的角色生效：起步后随速度衰减到 0，让位给步态（见 staticPoseWeight）。
    const sw = staticPoseWeight(speed);
    if (sw > 0.001) {
      const baseline = state.objects.find((o) => o.id === objectId)?.pose?.joints;
      if (baseline) {
        for (const key of Object.keys(baseline) as JointName[]) {
          const v = baseline[key];
          if (v) overrideJoints[key] = [v[0] * sw, v[1] * sw, v[2] * sw];
        }
      }
    }
    for (const clip of state.actions ?? []) {
      if (clip.object !== objectId) continue;
      if (currentTime < clip.timeStart || currentTime > clip.timeEnd) continue;
      const o = clip.pose?.joints;
      if (!o) continue;
      for (const key of Object.keys(o) as JointName[]) {
        const v = o[key];
        if (!v) continue;
        const cur = overrideJoints[key] ?? [0, 0, 0];
        overrideJoints[key] = [cur[0] + v[0], cur[1] + v[1], cur[2] + v[2]];
      }
    }

    // 姿态 / 手势类动作：找到对应 clip 就覆盖步态（后出现的片段优先）。
    let override: string | null = null;
    for (const clip of state.actions ?? []) {
      if (clip.object !== objectId) continue;
      if (currentTime < clip.timeStart || currentTime > clip.timeEnd) continue;
      if (clip.kind === "walk" || clip.kind === "run") continue;
      const candidates = (config.clips.poses as Record<string, string[] | undefined>)[clip.kind];
      const name = candidates ? findClip(names, candidates) : undefined;
      if (name) override = name;
    }

    // 覆盖切换：交叉淡入 / 淡出。
    if (override !== overrideRef.current) {
      const previous = overrideRef.current;
      overrideRef.current = override;
      const next = override ? actions[override] : undefined;
      if (next) {
        next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        next.setEffectiveWeight(1);
        const prev = previous ? actions[previous] : undefined;
        if (prev) next.crossFadeFrom(prev, FADE, false);
      } else {
        const prev = previous ? actions[previous] : undefined;
        if (prev) prev.fadeOut(FADE);
      }
    }

    // 步态权重：显式 walk / run 优先，否则按速度自动判定（低速走、高速跑）。
    const isRun = sample.gait === "run" || (sample.gait === "auto" && speed >= RUN_SPEED);
    let wIdle = 0;
    let wWalk = 0;
    let wRun = 0;
    if (speed < 0.15) {
      wIdle = 1;
    } else if (isRun) {
      const t = Math.min(1, (speed - RUN_SPEED) / 1.2 + 1);
      wRun = t;
      wWalk = 1 - t;
    } else {
      const t = Math.min(1, (speed - 0.15) / (RUN_SPEED - 0.15));
      wIdle = 1 - t;
      wWalk = t;
    }

    const apply = (name: string | undefined, weight: number, nominal?: number) => {
      if (!name) return;
      const action = actions[name];
      if (!action) return;
      action.setEffectiveWeight(override ? 0 : weight);
      // 按实际速度缩放播放速率，减少脚底打滑。
      if (nominal && !override) {
        action.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / nominal, 0.6, 1.8));
      }
    };
    apply(idleName, wIdle);
    apply(walkName, wWalk, NOMINAL_SPEED.walk);
    apply(runName, wRun, NOMINAL_SPEED.run);

    // 把用户自定义关节角度叠加到动画之上（动画 mixer 每帧先复位骨骼，此处后于它执行）。
    for (const joint of Object.keys(overrideJoints) as JointName[]) {
      const bone = bones[joint];
      const v = overrideJoints[joint];
      if (!bone || !v) continue;
      bone.rotation.x += v[0];
      bone.rotation.y += v[1];
      bone.rotation.z += v[2];
    }
  });

  return (
    <group
      ref={rootRef}
      rotation={[0, ((config.facingFixDeg ?? 0) * Math.PI) / 180, 0]}
    >
      <group scale={scale} position={[0, offsetY, 0]}>
        <primitive object={model} />
      </group>
    </group>
  );
}

/** 模型缺失 / 加载失败时回退到方块简模，不影响其它功能。 */
export class ModelBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[model] GLB 加载失败，已回退到方块简模", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export { Suspense as ModelSuspense };
