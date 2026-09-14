/**
 * Shot Archetype Library（机位模板库）
 *
 * 把视频参考里"模型最容易翻车"的运镜沉淀成结构化机位模板：导演从模板选最接近的
 *
 * 字段对齐真实 schema 枚举（CameraFraming / CameraView / CameraSide / CameraMotionType / lensMm），
 * 因此模板可直接实例化到一台 CameraObject + 初始 CameraMove。
 *
 * 设计来源：`Director_Desk_Camera_Archetypes_Design_2026-09-07.md` §3。
 * 已知缺口（见同文档 §4 / §6，不在本文件范围）：
 *  - 运镜 PAN / TILT / TRUCK / STEADICAM / HANDHELD 尚未在 schema 落地，相关模板（whip_pan）以
 *    ORBIT 近似占位，待补 Motion 维度后再精确。
 *  - 目标类型 GROUP / POV / LOCATION 的多参照取景尚未在 cameraSolver 落地，应用时按单目标 best-effort
 *    映射（首个 agent），待补 Target 维度。
 *  - altitude（航拍高度）暂存为相机数据，cameraSolver 尚未消费（DRONE 用常量基准高度）。
 */

import type { CameraFraming, CameraMotionType, CameraSide, CameraView } from "./schema";

/** 集中情况分类（对应设计 §2）。 */
export type TemplateCategory =
  | "one_take"
  | "aerial"
  | "multi_character"
  | "transition"
  | "emotion"
  | "product"
  | "establishing";

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  one_take: "一镜到底 / 复杂运动线",
  aerial: "航拍绕飞",
  multi_character: "多人复杂关系",
  transition: "转场",
  emotion: "情绪 / 张力",
  product: "产品 / 特写",
  establishing: "环境建立",
};

/**
 * 模板目标描述。
 * - OBJECT：单个对象（现有 schema 直接支持）。
 * - OTS：过肩；ref = [前景演员(shoulder), 主体(subject)]。
 * - GROUP：一组对象（双人同框 / 群像）。
 * - POV：以某角色为视线来源（主观）。
 * - LOCATION：固定机位，不跟任何人（环境 / 转场）。
 * 后四种里的多参照取景待 cameraSolver 扩展，目前 apply 时按单目标 best-effort 解析。
 */
export interface ShotTemplateTarget {
  type: "OBJECT" | "OTS" | "GROUP" | "POV" | "LOCATION";
  ref: string[];
}

export interface ShotTemplate {
  id: string;
  label: string;
  category: TemplateCategory;
  motion: CameraMotionType;
  framing: CameraFraming;
  view: CameraView;
  side: CameraSide;
  lens: number;
  target: ShotTemplateTarget;
  /** 初始 CameraMove 时长（秒）。 */
  duration: number;
  /** ORBIT：本段绕目标转过的角度。 */
  orbitDeg?: number;
  /** DOLLY / DOLLY_ZOOM：结束时距离系数（1 = 保持基准取景距离）。 */
  dollyScale?: number;
  /** CRANE：结束时附加高度（米）。 */
  craneHeight?: number;
  /** PAN：原地水平旋转角度（度）。 */
  panDeg?: number;
  /** TILT：原地俯仰角度（度）。 */
  tiltDeg?: number;
  /** TRUCK：横向平移距离（米，正负=左右）。 */
  truckDist?: number;
  /** 荷兰角（度）。 */
  roll?: number;
  /** 过肩错位量（仅 OTS 模板使用）。 */
  otsOffset?: number;
  /** 航拍 / 升降高度（米），暂存为相机数据。 */
  altitude?: number;
  /** drone = 无人机平台（自带基础飞行高度）。 */
  kind?: "ground" | "drone";
  /** 中文说明（UI 提示）。 */
  description: string;
}

export const SHOT_TEMPLATES: ShotTemplate[] = [
  {
    id: "static_locked",
    label: "固定机位",
    category: "one_take",
    motion: "STATIC",
    framing: "medium",
    view: "eye_level",
    side: "back_3_4",
    lens: 50,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 4,
    description: "机器不动，让世界在框里发生。最基础的机位，也是对照其它运镜的基线。",
  },
  {
    id: "tracking_follow",
    label: "跟移",
    category: "one_take",
    motion: "FOLLOW",
    framing: "medium",
    view: "eye_level",
    side: "side",
    lens: 50,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 5,
    description: "平行跟随主体，主体始终在框。",
  },
  {
    id: "dolly_in_reveal",
    label: "推入揭示",
    category: "one_take",
    motion: "DOLLY",
    framing: "close_up",
    view: "eye_level",
    side: "back_3_4",
    lens: 50,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 5,
    dollyScale: 0.6,
    description: "沿光轴推进，穿过遮挡露出主体。",
  },
  {
    id: "crane_hero",
    label: "升降英雄",
    category: "one_take",
    motion: "CRANE",
    framing: "medium",
    view: "low",
    side: "back_3_4",
    lens: 35,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 5,
    craneHeight: 3,
    description: "由低仰拍拉到眼平，经典英雄登场。",
  },
  {
    id: "orbit_hero",
    label: "环绕英雄",
    category: "one_take",
    motion: "ORBIT",
    framing: "medium",
    view: "eye_level",
    side: "side",
    lens: 35,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 5,
    orbitDeg: 180,
    description: "绕主体转，改变视点角度。",
  },
  {
    id: "aerial_orbit",
    label: "航拍绕飞",
    category: "aerial",
    motion: "ORBIT",
    framing: "wide",
    view: "overhead",
    side: "side",
    lens: 35,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 6,
    orbitDeg: 360,
    altitude: 12,
    kind: "drone",
    description: "高空恒定高度环绕，俯视。",
  },
  {
    id: "aerial_reveal",
    label: "航拍揭幕",
    category: "aerial",
    motion: "CRANE",
    framing: "wide",
    view: "overhead",
    side: "side",
    lens: 35,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 6,
    craneHeight: 14,
    kind: "drone",
    description: "由仰拍拉到俯视，拉开看全貌。",
  },
  {
    id: "aerial_drone",
    label: "无人机自由飞行",
    category: "aerial",
    motion: "DRONE",
    framing: "wide",
    view: "high",
    side: "side",
    lens: 35,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 6,
    orbitDeg: 120,
    dollyScale: 1.3,
    craneHeight: 6,
    altitude: 8,
    kind: "drone",
    description: "边绕边升边拉的一镜自由飞行。",
  },
  {
    id: "ots_dialogue",
    label: "过肩对话",
    category: "multi_character",
    motion: "FOLLOW",
    framing: "medium",
    view: "eye_level",
    side: "front_3_4",
    lens: 50,
    target: { type: "OTS", ref: ["M16", "M17"] },
    duration: 4,
    otsOffset: 0.35,
    description: "越过前景演员肩膀拍主体，反打保持 180° 轴线。",
  },
  {
    id: "two_shot",
    label: "双人同框",
    category: "multi_character",
    motion: "STATIC",
    framing: "two_shot",
    view: "eye_level",
    side: "side",
    lens: 35,
    target: { type: "GROUP", ref: ["M16", "M17"] },
    duration: 4,
    description: "框住双人，谁左谁右不反。",
  },
  {
    id: "group_blocking",
    label: "群像调度",
    category: "multi_character",
    motion: "ORBIT",
    framing: "wide",
    view: "eye_level",
    side: "side",
    lens: 35,
    target: { type: "GROUP", ref: ["M16", "M17"] },
    duration: 6,
    orbitDeg: 60,
    description: "多人前后景走位，环绕呈现群像。",
  },
  {
    id: "pov_walk",
    label: "主观行走",
    category: "multi_character",
    motion: "FOLLOW",
    framing: "medium",
    view: "eye_level",
    side: "front",
    lens: 35,
    target: { type: "POV", ref: ["M17"] },
    duration: 5,
    description: "以某角色为眼走（真·POV 视线待 cameraSolver 支持，当前以跟随近似）。",
  },
  {
    id: "whip_pan",
    label: "甩镜转场",
    category: "transition",
    motion: "PAN",
    framing: "wide",
    view: "eye_level",
    side: "side",
    lens: 35,
    target: { type: "LOCATION", ref: [] },
    duration: 1.5,
    panDeg: 160,
    description: "快速水平摇转场（真·PAN 待 Motion 维度补全，当前以快速 ORBIT 近似）。",
  },
  {
    id: "vertigo",
    label: "眩晕推拉",
    category: "emotion",
    motion: "DOLLY_ZOOM",
    framing: "medium",
    view: "eye_level",
    side: "side",
    lens: 50,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 4,
    dollyScale: 0.5,
    description: "推拉 + 反向变焦，主体大小不变、背景透视畸变。",
  },
  {
    id: "product_turntable",
    label: "产品转盘",
    category: "product",
    motion: "ORBIT",
    framing: "close_up",
    view: "eye_level",
    side: "side",
    lens: 50,
    target: { type: "OBJECT", ref: ["M17"] },
    duration: 6,
    orbitDeg: 360,
    description: "环绕静物特写，旋转展示。",
  },
  {
    id: "establishing",
    label: "环境建立",
    category: "establishing",
    motion: "CRANE",
    framing: "extreme_wide",
    view: "overhead",
    side: "side",
    lens: 24,
    target: { type: "LOCATION", ref: [] },
    duration: 6,
    craneHeight: 10,
    description: "拉开看全貌，建立环境。",
  },
];

/** 按分类分组（保持 §3.2 模板顺序）。 */
export function groupTemplatesByCategory(): Array<{
  category: TemplateCategory;
  label: string;
  templates: ShotTemplate[];
}> {
  const groups: Array<{ category: TemplateCategory; templates: ShotTemplate[] }> = [];
  for (const template of SHOT_TEMPLATES) {
    let group = groups.find((item) => item.category === template.category);
    if (!group) {
      group = { category: template.category, templates: [] };
      groups.push(group);
    }
    group.templates.push(template);
  }
  return groups.map((group) => ({
    category: group.category,
    label: TEMPLATE_CATEGORY_LABELS[group.category],
    templates: group.templates,
  }));
}

export function findTemplate(id: string): ShotTemplate | undefined {
  return SHOT_TEMPLATES.find((item) => item.id === id);
}
