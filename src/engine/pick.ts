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

const ACTOR_HEIGHT = 1.9;

/** 路径标记离地高度：判定必须按标记球心的高度来算，才与屏幕上看到的位置重合。
 *  与 WorldView 里 PointMarker（圆盘 y=0.09）/ EndpointMarker（球心 y=0.26）保持一致。 */
const POINT_MARKER_Y = 0.09;
const ENDPOINT_MARKER_Y = 0.26;

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

/** 射线到竖直线段的最短距离：让点击角色身体任意高度都能选中。 */
function raySegmentDistance(ray: THREE.Ray, a: THREE.Vector3, b: THREE.Vector3): number {
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
  const t = Math.max(0, new THREE.Vector3().subVectors(point, ray.origin).dot(v));
  const onRay = new THREE.Vector3().copy(ray.origin).addScaledVector(v, t);
  return point.distanceTo(onRay);
}

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
    // 用资产自身体块（footprint）做命中，而不是固定 ACTOR_HEIGHT 的细线段：
    // 高度取资产实际高度，抓取容差按 footprint 半宽外扩，
    // 这样高大的建筑 / 宽大的家具（set 资产）点上去也能选中并拖动。
    const height = Math.max(object.footprint.h, ACTOR_HEIGHT);
    const distance = raySegmentDistance(
      ray,
      new THREE.Vector3(position.x, 0, position.z),
      new THREE.Vector3(position.x, height, position.z),
    );
    const grabRadius = radius + Math.max(object.footprint.w, object.footprint.d) / 2;
    if (distance <= grabRadius && (!best || distance < best.distance)) {
      best = { object, distance };
    }
  }
  return best;
}

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
    const distance = ray.distanceToPoint(point);
    if (distance <= radius && (!best || distance < best.distance)) {
      best = { camera, distance };
    }
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
 * 标记的屏幕命中评分：射线到标记球心的三维距离 ÷「该深度下 radiusPx 像素对应的世界长度」。
 *
 * 不能拿「射线与地面的交点」去比世界坐标距离：标记是浮在地面之上的（端点球心 0.26），
 * 机位压低时地面交点会整体后移 0.26 / tan(俯角)——俯角 20° 就有 0.71 世界单位，
 * 远超原来 0.45 的固定容差，于是端点「怎么点都点不中」；反过来相机靠近时固定世界容差
 * 又相对屏幕显得过宽，点旁边一点点也被判成点中。
 * 以球心为准、按深度把像素阈值折算成世界长度后，鼠标离图形的像素距离就是评分，
 * 相机远近、俯仰、画布缩放都不再改变手感。
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
        new THREE.Vector3(point.x, POINT_MARKER_Y, point.z),
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
        new THREE.Vector3(candidate.x, ENDPOINT_MARKER_Y, candidate.z),
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

export function pathPolyline(segment: MoveSegment): Array<[number, number, number]> {
  return samplePath(segment).map((point) => [point.x, 0.06, point.z] as [number, number, number]);
}
