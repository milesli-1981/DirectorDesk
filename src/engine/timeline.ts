import { DirectorState, TimelineItem } from "../domain/schema";

/** Timeline 只是 Director State 的一个视图，不持有独立数据。 */
export function buildTimelineItems(state: DirectorState): TimelineItem[] {
  const items: TimelineItem[] = [];

  state.segments.forEach((segment) => {
    items.push({
      id: `clip_${segment.id}`,
      track: segment.object,
      source: segment.id,
      kind: "segment",
      label: `${segment.id} · ${segment.type}`,
    });
  });

  state.constraints.forEach((constraint) => {
    items.push({
      id: `clip_${constraint.id}`,
      track: constraint.subject,
      source: constraint.id,
      kind: "constraint",
      label:
        constraint.type === "FOLLOW"
          ? `FOLLOW ${constraint.target}`
          : `LOOK AT ${constraint.target}`,
    });
  });

  // 每台相机拥有自己的 Camera Track。
  state.cameraMoves.forEach((move) => {
    items.push({
      id: `clip_${move.id}`,
      track: move.camera,
      source: move.id,
      kind: "camera",
      label: `${move.type} · ${move.targetId ?? "default target"}`,
    });
  });

  return items;
}

export function findTimelineItem(
  items: TimelineItem[],
  sourceId: string | null,
): TimelineItem | undefined {
  if (!sourceId) return undefined;
  return items.find((item) => item.source === sourceId);
}

export function itemRange(
  state: DirectorState,
  item: TimelineItem,
): { start: number; end: number } | null {
  if (item.kind === "segment") {
    const segment = state.segments.find((s) => s.id === item.source);
    return segment ? { start: segment.timeStart, end: segment.timeEnd } : null;
  }
  if (item.kind === "constraint") {
    const constraint = state.constraints.find((q) => q.id === item.source);
    return constraint ? { start: constraint.timeStart, end: constraint.timeEnd } : null;
  }
  const move = state.cameraMoves.find((m) => m.id === item.source);
  return move ? { start: move.timeStart, end: move.timeEnd } : null;
}

export function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}
