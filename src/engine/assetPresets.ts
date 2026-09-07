import { AssetCategory, AssetRole, Footprint } from "../domain/schema";

export interface AssetPreset {
  category: AssetCategory;
  role: AssetRole;
  footprint: Footprint;
  color: string;
  label: string;
}

/** 每个资产类别的默认体块：尺寸（米）、颜色、角色。 */
export const ASSET_PRESETS: Record<AssetCategory, AssetPreset> = {
  human: { category: "human", role: "agent", footprint: { w: 0.6, d: 0.6, h: 1.8 }, color: "#67a7ff", label: "Human" },
  animal: { category: "animal", role: "agent", footprint: { w: 0.9, d: 1.6, h: 1.1 }, color: "#63d39b", label: "Animal" },
  vehicle: { category: "vehicle", role: "agent", footprint: { w: 2.0, d: 4.2, h: 1.5 }, color: "#f0a35a", label: "Vehicle" },
  building: { category: "building", role: "set", footprint: { w: 10, d: 10, h: 24 }, color: "#9aa7b5", label: "Building" },
  furniture: { category: "furniture", role: "set", footprint: { w: 1.2, d: 1.2, h: 0.9 }, color: "#b9a07a", label: "Furniture" },
  nature: { category: "nature", role: "set", footprint: { w: 2.5, d: 2.5, h: 4 }, color: "#4f9d69", label: "Nature" },
  prop: { category: "prop", role: "set", footprint: { w: 0.8, d: 0.8, h: 0.8 }, color: "#c0c8d0", label: "Prop" },
};

export const ASSET_ORDER: AssetCategory[] = [
  "human",
  "animal",
  "vehicle",
  "building",
  "furniture",
  "nature",
  "prop",
];
