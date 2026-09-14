import * as THREE from "three";
import {
  CameraObject,
  CameraPathPoint,
  DirectorObject,
  DirectorState,
  MoveSegment,
  PathPoint,
  Vec2,
} from "../domain/schema";
import { nearestOnPath, samplePath } from "./path";
import { objectPosition } from "./solver";
import { solveCamera } from "./cameraSolver";
import {
  ENDPOINT_MARKER_LIFT,
  POINT_MARKER_LIFT,
  objectBottom,
  pathGroundAt,
  standingHeightFor,
} from "./ground";
import { rayObjectBox } from "./raycast";

/** 路径标记离地高度不再写死：改为 `pathGroundAt + LIFT`，由 ground.ts 统一给出。
 *  原因见 ground.ts `pathGroundAt` 的注释 —— 渲染与拾取必须同源。 */

export interface ObjectHit {
  object: DirectorObject;
  distance: number;
}

export interface ScreenPointHit {
  segment: MoveSegment;
  point: PathPoint;
  /** 鼠标到标记的屏幕距离 ÷ 命中阈值：≤ 1 即命中，越小越准。 */
  score: number;
}

export interface CameraHit {
  camera: CameraObject;
  distance: number;
}

export interface ScreenEndpointHit {
  segment: MoveSegment;
  which: "start" | "end";
  /** 同上：≤ 1 即命中。 */
  score: number;
}

export interface PathHit {
  segment: MoveSegment;
  x: number;
  z: number;
  distance: number;
}

/**
 * 射线到竖直线段的最近点：返回「距离」与「该最近点在射线上的参数 t」。
 *
 * 为什么要一起把 t 带出来：拾取要在**多个对象**之间比远近，而"距离"是各自到射线的垂直距离，
 * 直接拿它们比大小是错的（近处的小物体与远处的大物体可以有同样的垂直距离）。
 * 统一成沿射线的 t 之后，"谁在前面"才有意义 —— 这也是堆叠后能按上下层正确选中的前提。
 */
function raySegmentClosest(
  ray: THREE.Ray,
  a: THREE.Vector3,
  b: THREE.Vector3,
): { distance: number; t: number } {
  const u = new THREE.Vector3().subVectors(b, a);
  const v = ray.direction;
  const w0 = new THREE.Vector3().subVectors(a, ray.origin);
  const A = u.dot(u);
  const B = u.dot(v);
  const C = v.dot(v);
  const D = u.dot(w0);
  const E = v.dot(w0);
  const denom = A * C - B * B;

  let s = Math.abs(denom) < 1e-8 ? 0 : (B * E - C * D) / denom;
  s = Math.max(0, Math.min(1, s));

  const point = new THREE.Vector3().copy(a).addScaledVector(u, s);
  const raw =
    (point.x - ray.origin.x) * v.x +
    (point.y - ray.origin.y) * v.y +
    (point.z - ray.origin.z) * v.z;
  const t = Math.max(0, raw);
  const onRay = new THREE.Vector3().copy(ray.origin).addScaledVector(v, t);
  return { distance: point.distanceTo(onRay), t };
}

/**
 * 光标射线命中的对象。
 *
 * 两级判定，取**沿射线最近**的那个：
 *
 * 1. **真射线-盒**（`rayObjectBox`）—— 用对象实际的 `[bottom, top] × footprint` 实体盒，
 *    按抓取容差外扩，`rotation` 生效。这是 3D 化后必须有的：堆叠的两个盒子共用同一个
 *    (x, z)，只有盒子测试能靠 t 分辨导演点的是哪一层。
 * 2. **竖向圆柱兜底**（保留扩展前的判定）—— 射线到"从底到顶的竖直线段"的距离 ≤ 抓取半径。
 *    它比盒子宽松（不要求射线真的穿进盒里），是"点边上一点也能选中"的手感来源。
 *    两条并存 ⇒ 只增不减，不会有"以前点得中、现在点不中"的回退。
 */
export function hitObjectRay(
  state: DirectorState,
  time: number,
  ray: THREE.Ray,
  radius: number,
): ObjectHit | null {
  let best: ObjectHit | null = null;
  for (const object of state.objects) {
    if (object.hidden) continue;
    const position = objectPosition(state, object.id, time);
    // set 资产钉在摆放位置；运动资产的 y 由脚下几何派生（站在平台上就不是 0 了）。
    const isSet = object.role === "set";
    const px = isSet ? object.x : position.x;
    const pz = isSet ? object.z : position.z;
    const bottomY = isSet ? objectBottom(object) : standingHeightFor(state, object, px, pz);
    const topY = bottomY + object.footprint.h;

    let t: number | null = rayObjectBox(ray, object, bottomY, topY, radius);
    // 圆柱兜底：高的对象用 footprint.h（不再是写死的 ACTOR_HEIGHT），容差按半宽外扩。
    const grabRadius = radius + Math.max(object.footprint.w, object.footprint.d) / 2;
    const cylinder = raySegmentClosest(
      ray,
      new THREE.Vector3(px, bottomY, pz),
      new THREE.Vector3(px, topY, pz),
    );
    if (cylinder.distance <= grabRadius && (t === null || cylinder.t < t)) {
      t = cylinder.t;
    }
    if (t !== null && (!best || t < best.distance)) {
      best = { object, distance: t };
    }
  }
  return best;
}

/**
 * 光标射线命中的相机代理。
 *
 * `distance` 取**沿射线的参数 t**（不是到点的垂直距离）：调用方要拿它与对象的
 * `hitObjectRay` 比"谁在前面"，而垂直距离与沿射线距离是两种尺度 ——
 * 混着比会让远处的相机抢走近处的对象。门槛仍用垂直距离判（那是"擦边也算点中"的含义）。
 */
export function hitCameraRay(
  state: DirectorState,
  time: number,
  ray: THREE.Ray,
  radius: number,
): CameraHit | null {
  let best: CameraHit | null = null;
  for (const camera of state.cameras) {
    const resolved = solveCamera(state, camera.id, time);
    if (!resolved) continue;
    const point = new THREE.Vector3(
      resolved.position[0],
      resolved.position[1],
      resolved.position[2],
    );
    const perpendicular = ray.distanceToPoint(point);
    if (perpendicular > radius) continue;
    const along =
      (point.x - ray.origin.x) * ray.direction.x +
      (point.y - ray.origin.y) * ray.direction.y +
      (point.z - ray.origin.z) * ray.direction.z;
    const distance = Math.max(0, along);
    if (!best || distance < best.distance) best = { camera, distance };
  }
  return best;
}

export interface CameraPathPointHit {
  moveId: string;
  point: CameraPathPoint;
  index: number;
  score: number;
}

/**
 * 相机 PATH 路径点（含首尾端点）的屏幕命中：光标落在标记 radiusPx 像素内即命中（同人物路径）。
 * 标记在 3D 位置上（带高度 y），因此按点自身高度算评分，而不是投到地面。
 */
export function hitCameraPathPointScreen(
  state: DirectorState,
  cameraId: string,
  ray: THREE.Ray,
  radiusPx: number,
  focalPx: number,
): CameraPathPointHit | null {
  let best: CameraPathPointHit | null = null;
  for (const move of state.cameraMoves) {
    if (move.camera !== cameraId || move.type !== "PATH") continue;
    const pts = move.pathPoints ?? [];
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const score = markerScore(ray, new THREE.Vector3(p.x, p.y, p.z), radiusPx, focalPx);
      if (score <= 1 && (!best || score < best.score)) {
        best = { moveId: move.id, point: p, index: i, score };
      }
    }
  }
  return best;
}

export function hitObject(
  state: DirectorState,
  time: number,
  p: Vec2,
  radius: number,
): ObjectHit | null {
  let best: ObjectHit | null = null;
  for (const object of state.objects) {
    const pos = objectPosition(state, object.id, time);
    const distance = Math.hypot(pos.x - p.x, pos.z - p.z);
    if (distance <= radius && (!best || distance < best.distance)) {
      best = { object, distance };
    }
  }
  return best;
}

/**
 * 路径标记的屏幕命中评分：射线到标记球心的三维距离 ÷「该深度下 radiusPx 像素对应的世界长度」。
 *
 * 不能拿「射线与地面的交点」去比世界坐标距离：标记是浮在地面之上的，
 * 机位压低时地面交点会整体后移 `浮空量 / tan(俯角)`，
 * 远超原来 0.45 的固定容差，于是端点「怎么点都点不中」；反过来相机靠近时固定世界容差
 * 又相对屏幕显得过宽，点旁边一点点也被判成点中。
 * 以球心为准、按深度把像素阈值折算成世界长度后，鼠标离图形的像素距离就是评分，
 * 相机远近、俯仰、画布缩放都不再改变手感。
 *
 * 标记的球心高度由 `pathGroundAt + LIFT` 给出 —— 与渲染同源，见 ground.ts 的说明。
 */
function markerScore(
  ray: THREE.Ray,
  center: THREE.Vector3,
  radiusPx: number,
  focalPx: number,
): number {
  const depth = ray.origin.distanceTo(center);
  if (depth <= 0 || focalPx <= 0) return Infinity;
  const radius = (radiusPx * depth) / focalPx;
  return ray.distanceToPoint(center) / radius;
}

/** 路径转折点的屏幕命中：光标落在标记 radiusPx 像素内即算选中，取最准的一个。 */
export function hitPathPointScreen(
  state: DirectorState,
  objectId: string,
  ray: THREE.Ray,
  radiusPx: number,
  focalPx: number,
): ScreenPointHit | null {
  let best: ScreenPointHit | null = null;
  for (const segment of state.segments) {
    if (segment.object !== objectId) continue;
    for (const point of segment.points ?? []) {
      const score = markerScore(
        ray,
        new THREE.Vector3(
          point.x,
          pathGroundAt(state, objectId, point.x, point.z) + POINT_MARKER_LIFT,
          point.z,
        ),
        radiusPx,
        focalPx,
      );
      if (score <= 1 && (!best || score < best.score)) best = { segment, point, score };
    }
  }
  return best;
}

/** 起终点把手的屏幕命中：它们离地更高（球心 0.26），是最容易「看着却点不中」的一类标记。 */
export function hitEndpointScreen(
  state: DirectorState,
  objectId: string,
  ray: THREE.Ray,
  radiusPx: number,
  focalPx: number,
): ScreenEndpointHit | null {
  let best: ScreenEndpointHit | null = null;
  for (const segment of state.segments) {
    if (segment.object !== objectId) continue;
    const candidates: Array<{ which: "start" | "end"; x: number; z: number }> = [
      { which: "start", x: segment.startX, z: segment.startZ },
      { which: "end", x: segment.endX, z: segment.endZ },
    ];
    for (const candidate of candidates) {
      const score = markerScore(
        ray,
        new THREE.Vector3(
          candidate.x,
          pathGroundAt(state, objectId, candidate.x, candidate.z) + ENDPOINT_MARKER_LIFT,
          candidate.z,
        ),
        radiusPx,
        focalPx,
      );
      // 完全同分（同一坐标处叠着多个把手）时让 end 胜出：路径串成多段后，
      // 前一段的 end 与后一段的 start 永远压在同一点，若让先遍历到的 start 拿走，
      // 路径末端的把手就永远点不中——这正是「end point 一直选不中」的来源。
      const tie = best !== null && score === best.score && best.which === "start";
      if (score <= 1 && (!best || score < best.score || (tie && candidate.which === "end"))) {
        best = { segment, which: candidate.which, score };
      }
    }
  }
  return best;
}

export function hitPath(
  state: DirectorState,
  objectId: string,
  p: Vec2,
  radius: number,
): PathHit | null {
  let best: PathHit | null = null;
  state.segments
    .filter((s) => s.object === objectId)
    .forEach((segment) => {
      const near = nearestOnPath(segment, p.x, p.z);
      if (near.distance <= radius && (!best || near.distance < (best as PathHit).distance)) {
        best = { segment, x: near.x, z: near.z, distance: near.distance };
      }
    });
  return best;
}

/**
 * 路径折线。`groundAt` 给了就贴地走（terrain 模式），否则恒在地面高度（planar）。
 * 采样点与运动求解共用同一份路径，只是 y 由几何派生 —— 与总纲决策 4 一致：
 * **路径决定 x/z，几何决定 y。**
 */
export function pathPolyline(
  segment: MoveSegment,
  groundAt?: (x: number, z: number) => number,
  lift = POINT_MARKER_LIFT,
): Array<[number, number, number]> {
  return samplePath(segment).map((point) => [
    point.x,
    (groundAt ? groundAt(point.x, point.z) : 0) + lift,
    point.z,
  ] as [number, number, number]);
}
