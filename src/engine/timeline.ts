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

  // 动作片段：与 segments / constraints 同挂在该演员的对象轨道上。
  (state.actions ?? []).forEach((clip) => {
    // 自定义动作显示用户起的名称（而不是 "custom"），便于在时间轴上辨认。
    const customName =
      clip.kind === "custom"
        ? (state.customActions ?? []).find((p) => p.id === clip.customId)?.name
        : undefined;
    items.push({
      id: `clip_${clip.id}`,
      track: clip.object,
      source: clip.id,
      kind: "action",
      label: customName ?? clip.kind,
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
  if (move) return { start: move.timeStart, end: move.timeEnd };
  const action = state.actions?.find((a) => a.id === item.source);
  return action ? { start: action.timeStart, end: action.timeEnd } : null;
}

export function roundTime(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 场景中最后一个有内容的时刻：segment / constraint / camera move / action 的最大 timeEnd。
 * 播放应在此处结束，而不是硬编码的 state.duration。
 * 没有任何内容时回退到 state.duration；结果夹到 [0, duration]。
 */
/** 内容的真实末尾（不按 state.duration 夹取）：segment / constraint / camera move / action 的最大 timeEnd。 */
export function rawContentEnd(state: DirectorState): number {
  let end = 0;
  state.segments.forEach((segment) => {
    if (segment.timeEnd > end) end = segment.timeEnd;
  });
  state.constraints.forEach((constraint) => {
    if (constraint.timeEnd > end) end = constraint.timeEnd;
  });
  state.cameraMoves.forEach((move) => {
    if (move.timeEnd > end) end = move.timeEnd;
  });
  // 动作片段同样是内容：漏掉它会让「内容末尾」被算早（成片被截短）。
  state.actions.forEach((action) => {
    if (action.timeEnd > end) end = action.timeEnd;
  });
  return end;
}

export function contentEndTime(state: DirectorState): number {
  const end = rawContentEnd(state);
  if (end <= 0) return state.duration;
  return Math.min(end, state.duration);
}
