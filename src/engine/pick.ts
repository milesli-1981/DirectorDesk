import { DirectorObject, DirectorState, MoveSegment, PathPoint, Vec2 } from "../domain/schema";
import { nearestOnPath, samplePath } from "./path";
import { objectPosition } from "./solver";

export interface ObjectHit {
  object: DirectorObject;
  distance: number;
}

export interface PointHit {
  segment: MoveSegment;
  point: PathPoint;
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
