import * as THREE from "three";
import {
  CameraObject,
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

export interface ObjectHit {
  object: DirectorObject;
  distance: number;
}

export interface PointHit {
  segment: MoveSegment;
  point: PathPoint;
  distance: number;
}

export interface CameraHit {
  camera: CameraObject;
  distance: number;
}

export interface EndpointHit {
  segment: MoveSegment;
  which: "start" | "end";
  distance: number;
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

export function hitPathPoint(
  state: DirectorState,
  objectId: string,
  p: Vec2,
  radius: number,
): PointHit | null {
  let best: PointHit | null = null;
  state.segments
    .filter((s) => s.object === objectId)
    .forEach((segment) => {
      (segment.points ?? []).forEach((point) => {
        const distance = Math.hypot(point.x - p.x, point.z - p.z);
        if (distance <= radius && (!best || distance < (best as PointHit).distance)) {
          best = { segment, point, distance };
        }
      });
    });
  return best;
}

export function hitEndpoint(
  state: DirectorState,
  objectId: string,
  p: Vec2,
  radius: number,
): EndpointHit | null {
  let best: EndpointHit | null = null;
  state.segments
    .filter((s) => s.object === objectId)
    .forEach((segment) => {
      const candidates: Array<{ which: "start" | "end"; x: number; z: number }> = [
        { which: "start", x: segment.startX, z: segment.startZ },
        { which: "end", x: segment.endX, z: segment.endZ },
      ];
      candidates.forEach((candidate) => {
        const distance = Math.hypot(candidate.x - p.x, candidate.z - p.z);
        if (distance <= radius && (!best || distance < (best as EndpointHit).distance)) {
          best = { segment, which: candidate.which, distance };
        }
      });
    });
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
