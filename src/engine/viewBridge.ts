import * as THREE from "three";

/** 画布（R3F）当前相机与 canvas 元素，供画布外的 HTML 拖放落点做屏幕→世界坐标换算。 */
export const viewRef: { camera: THREE.Camera | null; canvas: HTMLCanvasElement | null } = {
  camera: null,
  canvas: null,
};

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();

/** 把 DOM 屏幕坐标换算成地面（y=0）上的世界坐标（x, z）。相机视图下无效则返回 null。 */
export function screenToGround(clientX: number, clientY: number): { x: number; z: number } | null {
  const cam = viewRef.camera;
  const canvas = viewRef.canvas;
  if (!cam || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, cam);
  const result = raycaster.ray.intersectPlane(GROUND, hit);
  if (!result) return null;
  return { x: Math.round(hit.x * 10) / 10, z: Math.round(hit.z * 10) / 10 };
}
