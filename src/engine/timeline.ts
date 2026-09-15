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
      label: `${move.targetType === "OTS" ? "OTS" : move.type} · ${move.targetId ?? "default target"}`,
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

/** 顶在「内容末尾」的那个东西属于哪一类。 */
export type ContentEndKind = "segment" | "constraint" | "camera" | "action";

/** 内容末尾**以及是谁顶在那儿**。 */
export interface ContentEndCause {
  /** 内容的真实末尾（秒）。 */
  end: number;
  kind: ContentEndKind;
  /** 那个东西自己的 id（片段 / 约束 / 镜头 / 动作）。 */
  id: string;
  /** 它挂在谁身上：对象 id，或相机 id —— 用来在时间轴上找到那一行。 */
  owner: string;
  /** 给人看的短名（与时间轴上那条 clip 的 label 同一套写法）。 */
  label: string;
}

/**
 * 内容的真实末尾 **以及是谁顶在那儿**（不按 `state.duration` 夹取）。
 *
 * 四类都算内容：`segment` / `constraint` / 相机镜头 / 动作片段。漏掉任何一类都会让
 * 「内容末尾」被算早，成片被悄悄截短。
 *
 * ## 为什么必须连"是谁"一起返回
 *
 * 只报一个数字是查不下去的：这四类**不一定都在当前视野里** —— 相机有自己的轨道、
 * 动作片段在「动作」折叠行里、对象多了还要横向滚。作者看到"内容到 12.0s"、画面上却
 * 没有任何东西到 12s 时，唯一能自救的信息就是"**是哪一个**到 12s"。
 * 所以这两件事由同一个函数一起给出 —— 也就不可能再长出第二份跟着漂的算法。
 */
export function contentEndCause(state: DirectorState): ContentEndCause {
  let best: ContentEndCause = { end: 0, kind: "segment", id: "", owner: "", label: "" };
  const consider = (end: number, cause: Omit<ContentEndCause, "end">) => {
    if (end > best.end) best = { end, ...cause };
  };

  state.segments.forEach((segment) =>
    consider(segment.timeEnd, {
      kind: "segment",
      id: segment.id,
      owner: segment.object,
      label: `${segment.id} · ${segment.type}`,
    }),
  );
  state.constraints.forEach((constraint) =>
    consider(constraint.timeEnd, {
      kind: "constraint",
      id: constraint.id,
      owner: constraint.subject,
      label:
        constraint.type === "FOLLOW"
          ? `FOLLOW ${constraint.target}`
          : `LOOK AT ${constraint.target}`,
    }),
  );
  state.cameraMoves.forEach((move) =>
    consider(move.timeEnd, {
      kind: "camera",
      id: move.id,
      owner: move.camera,
      label: `镜头 ${move.type}`,
    }),
  );
  (state.actions ?? []).forEach((clip) => {
    // 自定义动作显示用户起的名称（而不是 "custom"），便于在时间轴上辨认。
    const customName =
      clip.kind === "custom"
        ? (state.customActions ?? []).find((p) => p.id === clip.customId)?.name
        : undefined;
    consider(clip.timeEnd, {
      kind: "action",
      id: clip.id,
      owner: clip.object,
      label: customName ?? clip.kind,
    });
  });

  return best;
}

/** 只要数值的形式（播放 / 导出 / 顶栏都读它）：内容的真实末尾。 */
export function rawContentEnd(state: DirectorState): number {
  return contentEndCause(state).end;
}

export function contentEndTime(state: DirectorState): number {
  const end = rawContentEnd(state);
  if (end <= 0) return state.duration;
  return Math.min(end, state.duration);
}
