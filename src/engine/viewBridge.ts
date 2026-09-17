import * as THREE from "three";
import { DirectorState } from "../domain/schema";
import { raycastGround } from "./raycast";

/** 画布（R3F）当前相机与 canvas 元素，供画布外的 HTML 拖放落点做屏幕→世界坐标换算。 */
export const viewRef: { camera: THREE.Camera | null; canvas: HTMLCanvasElement | null } = {
  camera: null,
  canvas: null,
};

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();

/**
 * 把 DOM 屏幕坐标换算成世界落点。
 *
 * 水平坐标走 y=0 平面投影（连续、跟手），**高度**由射线拾取决定 —— 见 `engine/raycast` 的说明：
 * 面拾取的水平坐标在棱边处会跳，所以它只负责回答"指着哪一层"。
 *
 * state 缺省时高度恒 0，与扩展前的行为一致。
 *
 * @param forceTerrain 本次拖放强制按 3D 语义拾取（按住 Shift）。
 */
export function screenToGround(
  clientX: number,
  clientY: number,
  state?: DirectorState,
  forceTerrain?: boolean,
): { x: number; y: number; z: number } | null {
  const cam = viewRef.camera;
  const canvas = viewRef.canvas;
  if (!cam || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, cam);
  const result = raycaster.ray.intersectPlane(GROUND, hit);
  if (!result) return null;
  const layer = state ? raycastGround(state, raycaster.ray, forceTerrain) : null;
  return {
    x: Math.round(hit.x * 10) / 10,
    y: layer ? layer.y : 0,
    z: Math.round(hit.z * 10) / 10,
  };
}
