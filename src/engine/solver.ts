import { Constraint, DirectorObject, DirectorState, Vec2 } from "../domain/schema";
import { segmentPosition } from "./path";

/** 无驱动（Segment / Constraint）时的基础位置。 */
function basePosition(state: DirectorState, o: DirectorObject, time: number): Vec2 {
  const ss = state.segments
    .filter((s) => s.object === o.id)
    .sort((a, b) => a.timeStart - b.timeStart);

  if (ss.length === 0) return { x: o.x, z: o.z };
  // 第一个 Segment 开始前，对象停在它自己的 ORIGIN。
  if (time < ss[0].timeStart) return { x: o.x, z: o.z };

  const active = ss.find((s) => time >= s.timeStart && time <= s.timeEnd);
  if (active) return segmentPosition(active, time);

  const prev = [...ss].reverse().find((s) => time > s.timeEnd);
  if (prev) return { x: prev.endX, z: prev.endZ };

  const next = ss.find((s) => time < s.timeStart);
  if (next) return { x: next.startX, z: next.startZ };

  return { x: o.x, z: o.z };
}

function activeConstraint(
  state: DirectorState,
  objectId: string,
  time: number,
  skip?: Constraint,
): Constraint | undefined {
  return state.constraints.find(
    (q) =>
      q.subject === objectId &&
      q !== skip &&
      time >= q.timeStart &&
      time <= q.timeEnd,
  );
}

/**
 * Follow 的偏移量在约束开始时刻捕获：
 * 之后跟随者保持这个相对位移，而不是吸附到目标身上。
 */
function followOffset(
  state: DirectorState,
  q: Constraint,
  stack: Set<string>,
): Vec2 | null {
  const subject = state.objects.find((o) => o.id === q.subject);
  const target = state.objects.find((o) => o.id === q.target);
  if (!subject || !target) return null;
  const a = objectPosition(state, q.subject, q.timeStart, stack, q);
  const b = objectPosition(state, q.target, q.timeStart, new Set([...stack, subject.id]));
  return { x: a.x - b.x, z: a.z - b.z };
}

/** 解析任意对象在任意时刻的世界位置。stack 用于打断循环引用。 */
export function objectPosition(
  state: DirectorState,
  objectId: string,
  time: number,
  stack: Set<string> = new Set(),
  skip?: Constraint,
): Vec2 {
  const o = state.objects.find((item) => item.id === objectId);
  if (!o) return { x: 0, z: 0 };
  if (stack.has(objectId)) return basePosition(state, o, time);

  const others = state.constraints.filter((q) => q.subject === objectId && q !== skip);
  const active = others.find((q) => time >= q.timeStart && time <= q.timeEnd);

  if (active && active.type === "FOLLOW") {
    const target = state.objects.find((item) => item.id === active.target);
    const off = target ? followOffset(state, active, stack) : null;
    if (target && off) {
      const b = objectPosition(state, active.target, time, new Set([...stack, objectId]));
      return { x: b.x + off.x, z: b.z + off.z };
    }
    return basePosition(state, o, time);
  }

  const hasActiveSegment = state.segments.some(
    (s) => s.object === objectId && time >= s.timeStart && time <= s.timeEnd,
  );
  if (hasActiveSegment) return basePosition(state, o, time);

  // 没有驱动时保持最近一次驱动结束的姿态，而不是弹回 ORIGIN。
  let hold: { end: number; pose: Vec2 } | null = null;
  state.segments.forEach((s) => {
    if (s.object === objectId && time >= s.timeEnd && (!hold || s.timeEnd > hold.end)) {
      hold = { end: s.timeEnd, pose: { x: s.endX, z: s.endZ } };
    }
  });
  others.forEach((q) => {
    if (q.type !== "FOLLOW") return;
    if (time <= q.timeEnd) return;
    if (hold && q.timeEnd <= hold.end) return;
    const target = state.objects.find((item) => item.id === q.target);
    if (!target) return;
    const off = followOffset(state, q, stack);
    if (!off) return;
    const b = objectPosition(state, q.target, q.timeEnd, new Set([...stack, objectId]));
    hold = { end: q.timeEnd, pose: { x: b.x + off.x, z: b.z + off.z } };
  });
  if (hold) return (hold as { end: number; pose: Vec2 }).pose;

  return basePosition(state, o, time);
}

/** 朝向：优先运动方向，其次 LOOK_AT 约束。 */
export function objectFacing(state: DirectorState, objectId: string, time: number): number {
  const step = 0.06;
  const a = objectPosition(state, objectId, Math.max(0, time - step));
  const b = objectPosition(state, objectId, time + step);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-4) return Math.atan2(dx, dz);

  const look = state.constraints.find(
    (q) =>
      q.type === "LOOK_AT" &&
      q.subject === objectId &&
      time >= q.timeStart &&
      time <= q.timeEnd,
  );
  if (look) {
    const p = objectPosition(state, objectId, time);
    const t = objectPosition(state, look.target, time);
    if (Math.hypot(t.x - p.x, t.z - p.z) > 1e-4) return Math.atan2(t.x - p.x, t.z - p.z);
  }
  return Math.atan2(dx, dz);
}

export function resolvePositions(state: DirectorState, time: number): Record<string, Vec2> {
  const out: Record<string, Vec2> = {};
  for (const o of state.objects) {
    out[o.id] = objectPosition(state, o.id, time);
  }
  return out;
}
