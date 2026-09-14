import type { AnimalSpecies, Footprint } from "../domain/schema";
import type { ModelConfig } from "./modelConfig";

/**
 * 动物物种 → GLB 模型 注册表。
 *
 * 模型来源（均免费 / CC0 或 CC-BY，可商用）：
 *  - three.js 官方示例（r180）：Parrot / Flamingo / Stork / Horse
 *  - Khronos glTF 示例资产：Fox（带动画，作「狗」；CC-BY，作者 Microsoft）
 *  - Poly Pizza（CC0，用户上传）：Cat / Wolf / Pigeon / Fish
 *
 * 每个模型用其真实动画片段名映射 idle / walk / run（片段名含 `|` 也能被
 * findClip 的子串匹配命中）。想加新物种：把 .glb 放进 `public/models/`，
 * 在这里加一条记录即可，渲染层与 UI 无需改动。
 */
export interface AnimalModelDef {
  species: AnimalSpecies;
  /** 中文显示名（Inspector / 资产下拉）。 */
  label: string;
  /** 名词（鸟 / 马 / 狗 / 猫 / 鱼），用于提示文案。 */
  noun: string;
  config: ModelConfig;
  /** 默认体块尺寸（米），同时作为 GLB 的归一化高度。 */
  footprint: Footprint;
  /** 默认角色色（仅用于无 GLB 时的方块回退；GLB 为蒙皮网格时不着色）。 */
  color: string;
}

export const ANIMAL_MODELS: Record<AnimalSpecies, AnimalModelDef> = {
  // —— 鸟（three.js 官方示例，单循环飞行动画）——
  parrot: {
    species: "parrot",
    label: "鹦鹉 Parrot",
    noun: "鸟",
    config: {
      url: "/models/Parrot.glb",
      clips: { idle: ["parrot_A_"], walk: ["parrot_A_"], run: ["parrot_A_"], poses: {} },
    },
    footprint: { w: 1.0, d: 1.3, h: 0.9 },
    color: "#5fb8c8",
  },
  flamingo: {
    species: "flamingo",
    label: "火烈鸟 Flamingo",
    noun: "鸟",
    config: {
      url: "/models/Flamingo.glb",
      clips: { idle: ["flamingo_flyA_"], walk: ["flamingo_flyA_"], run: ["flamingo_flyA_"], poses: {} },
    },
    footprint: { w: 1.0, d: 1.4, h: 1.1 },
    color: "#e58aa8",
  },
  stork: {
    species: "stork",
    label: "鹳 Stork",
    noun: "鸟",
    config: {
      url: "/models/Stork.glb",
      clips: { idle: ["storkFly_B_"], walk: ["storkFly_B_"], run: ["storkFly_B_"], poses: {} },
    },
    footprint: { w: 1.0, d: 1.4, h: 1.0 },
    color: "#d8dde2",
  },
  pigeon: {
    species: "pigeon",
    label: "鸽 Pigeon",
    noun: "鸟",
    config: {
      url: "/models/Pigeon.glb",
      clips: { idle: ["CharacterArmature|Idle"], walk: ["CharacterArmature|Walk"], run: ["CharacterArmature|Walk"], poses: {} },
    },
    footprint: { w: 0.5, d: 0.6, h: 0.4 },
    color: "#b8bcc4",
  },
  // —— 马（three.js 官方示例，单循环奔跑动画）——
  horse: {
    species: "horse",
    label: "马 Horse",
    noun: "马",
    config: {
      url: "/models/Horse.glb",
      clips: { idle: ["horse_A_"], walk: ["horse_A_"], run: ["horse_A_"], poses: {} },
    },
    footprint: { w: 0.9, d: 2.0, h: 1.6 },
    color: "#b07a4a",
  },
  // —— 犬科：狗（Khronos Fox，带动画 Survey/Walk/Run） / 狼（Poly Pizza，带动画）——
  dog: {
    species: "dog",
    label: "狗 Dog（Fox）",
    noun: "狗",
    config: {
      url: "/models/Fox.glb",
      clips: { idle: ["Survey"], walk: ["Walk"], run: ["Run"], poses: {} },
    },
    footprint: { w: 0.6, d: 1.2, h: 0.7 },
    color: "#b07a4a",
  },
  wolf: {
    species: "wolf",
    label: "狼 Wolf",
    noun: "犬科",
    config: {
      url: "/models/Wolf.glb",
      clips: {
        idle: ["AnimalArmature|Idle"],
        walk: ["AnimalArmature|Walk"],
        run: ["AnimalArmature|Gallop"],
        poses: {},
      },
    },
    footprint: { w: 0.7, d: 1.3, h: 0.9 },
    color: "#7d7f86",
  },
  // —— 猫（Poly Pizza，带 Idle/Walk 等动画）——
  cat: {
    species: "cat",
    label: "猫 Cat",
    noun: "猫",
    config: {
      url: "/models/Cat.glb",
      clips: { idle: ["CharacterArmature|Idle"], walk: ["CharacterArmature|Walk"], run: ["CharacterArmature|Walk"], poses: {} },
    },
    footprint: { w: 0.6, d: 1.0, h: 0.7 },
    color: "#9a8c7a",
  },
  // —— 鱼（Poly Pizza，带 Idle/Walk 等动画）——
  fish: {
    species: "fish",
    label: "鱼 Fish",
    noun: "鱼",
    config: {
      url: "/models/Fish.glb",
      clips: { idle: ["CharacterArmature|Idle"], walk: ["CharacterArmature|Walk"], run: ["CharacterArmature|Walk"], poses: {} },
    },
    footprint: { w: 0.4, d: 0.9, h: 0.4 },
    color: "#5aa9c8",
  },
};

/** 资产面板「动物」下拉里可选的物种顺序（鸟 → 犬科 → 猫 → 鱼 → 马）。 */
export const ANIMAL_SPECIES: AnimalSpecies[] = [
  "parrot",
  "flamingo",
  "stork",
  "pigeon",
  "dog",
  "wolf",
  "cat",
  "fish",
  "horse",
];

/** 新增动物时的默认物种。 */
export const DEFAULT_ANIMAL_SPECIES: AnimalSpecies = "dog";

/** 取物种定义；非动物或未知物种返回 undefined（渲染层会回退到方块简模）。 */
export function animalModelOf(species?: AnimalSpecies): AnimalModelDef | undefined {
  return species ? ANIMAL_MODELS[species] : undefined;
}
