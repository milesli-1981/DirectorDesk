import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  AssetCategory,
  EaseCurve,
  HandoffMode,
  objectDisplayName,
  TimelineItem,
} from "../domain/schema";
import { buildTimelineItems, itemRange, rawContentEnd } from "../engine/timeline";
import { easeVal, normalizeEase } from "../engine/ease";
import { waypointKeyframes } from "../engine/path";

const MAX_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 12;
const LABEL_WIDTH = 190;
/* 右侧留给 add-leg 等行内控件的宽度，避免刻度铺满把按钮挤出可视区 */
const LANE_TAIL = 32;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 资产类别对应的中文名词：时间轴里用「角色 / 载具 / 道具 …」而非笼统的 asset。 */
const ASSET_NOUN: Record<AssetCategory, string> = {
  human: "角色",
  animal: "动物",
  vehicle: "载具",
  building: "建筑",
  furniture: "家具",
  nature: "布景",
  prop: "道具",
};
function assetNoun(category: AssetCategory): string {
  return ASSET_NOUN[category] ?? "对象";
}

function easeSpark(ease: EaseCurve): string {
  let d = "";
  for (let i = 0; i <= 16; i += 1) {
    const u = i / 16;
    const v = Math.max(0, Math.min(1, easeVal(ease, u)));
    d += `${i ? "L" : "M"}${(1 + u * 38).toFixed(1)} ${(12.5 - v * 11).toFixed(1)}`;
  }
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='14' viewBox='0 0 40 14'>` +
    `<path d='M1 12.5L39 1.5' stroke='#ffffff14' fill='none'/>` +
    `<path d='${d}' stroke='#9fc5ffaa' fill='none' stroke-width='1.5'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

type DragMode = "l" | "r" | "m";

interface ClipDrag {
  /** 单条拖动时的片段；拖动「整队动作带」时为 null。 */
  item: TimelineItem | null;
  /** 整队动作带：带内每条动作的起止快照（拖动时按同一 delta 整队同步改写）。 */
  band?: { id: string; start: number; end: number }[];
  start: number;
  end: number;
  originX: number;
  mode: DragMode;
}

/**
 * 整队动作带：团队（Group Dynamics）的动作行把全体成员的动作合成一条带子。
 * 团队成员里除队首外的片段原本不参与时间轴渲染 —— 既看不到、也拖不动，
 * 却照样计入「内容末尾」，于是片长调小后警告永远消不掉。
 * 合成一条带子后即可见、可拖，拖动按整队同步写回。
 */
interface TeamActionBand {
  id: string;
  /** 锚点（队首）：选中它作为整队代表，Inspector 展示的动作也是它。 */
  anchorId: string;
  start: number;
  end: number;
  entries: { id: string; start: number; end: number }[];
}

function TimelineReadout() {
  const currentTime = useDirectorStore((s) => s.currentTime);
  const seconds = currentTime.toFixed(1);

  return (
    <span className="timecode" id="tc">
      00:{seconds.padStart(4, "0")}
    </span>
  );
}

function Playhead({ pxPerSec }: { pxPerSec: number }) {
  const currentTime = useDirectorStore((s) => s.currentTime);
  const setTime = useDirectorStore((s) => s.setTime);
  const duration = useDirectorStore((s) => s.state.duration);
  const gripRef = useRef<HTMLDivElement>(null);

  // 把屏幕 x 换算成时间，并正确计入横向滚动（scrollLeft）。
  const scrubToClientX = (clientX: number) => {
    const scrollEl = gripRef.current?.closest(".scroll") as HTMLElement | null;
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    const x = clientX - rect.left + scrollEl.scrollLeft - LABEL_WIDTH;
    setTime(clamp(x / pxPerSec, 0, duration));
  };

  // 可拖动的抓手：按下后捕获指针，移动即定位播放头。
  const onGripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) => scrubToClientX(next.clientX);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  return (
    <div className="ph" style={{ left: LABEL_WIDTH + currentTime * pxPerSec }}>
      <div className="ph-hit" ref={gripRef} onPointerDown={onGripDown} title="拖动以定位播放头" />
      <div className="ph-grip" />
    </div>
  );
}

export function Timeline() {
  const state = useDirectorStore((s) => s.state);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectItem = useDirectorStore((s) => s.selectItem);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const selectPoint = useDirectorStore((s) => s.selectPoint);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const setTime = useDirectorStore((s) => s.setTime);
  const setSegmentTime = useDirectorStore((s) => s.setSegmentTime);
  const setConstraintTime = useDirectorStore((s) => s.setConstraintTime);
  const setCameraMoveTime = useDirectorStore((s) => s.setCameraMoveTime);
  const addSegment = useDirectorStore((s) => s.addSegment);
  const addCameraMove = useDirectorStore((s) => s.addCameraMove);
  const addAction = useDirectorStore((s) => s.addAction);
  const setActionTime = useDirectorStore((s) => s.setActionTime);
  const setActionTimes = useDirectorStore((s) => s.setActionTimes);
  const setCameraJunctionMode = useDirectorStore((s) => s.setCameraJunctionMode);
  const updateCamera = useDirectorStore((s) => s.updateCamera);
  const setDuration = useDirectorStore((s) => s.setDuration);

  // Scene Duration 输入框：编辑期间用本地草稿接管，失焦 / 回车才写入。
  // 否则每敲一个字符都写库，且清空时 Number("") === 0 会被钳到下限，导致无法连续输入多位数。
  const [durDraft, setDurDraft] = useState<string | null>(null);

  // 时间刻度按可视宽度自适应：整段时长刚好铺满可滚动区，因此不会出现横向滚动条。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState(0);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setLaneWidth(element.clientWidth - LABEL_WIDTH - LANE_TAIL);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const reorderObject = useDirectorStore((s) => s.reorderObject);

  const items = useMemo(() => buildTimelineItems(state), [state]);
  // 内容排到片长之外时给出提示：这些片段不参与播放 / 导出，但没有被删除。
  const contentEnd = useMemo(() => rawContentEnd(state), [state]);
  const overflow = contentEnd > state.duration + 1e-6;
  // 点警告时把片长对齐到内容末尾：向上取到 0.1（duration 的存储精度），确保严格盖住内容。
  const alignEnd = Math.ceil((contentEnd - 1e-6) * 10) / 10;
  /**
   * 时间轴比例基准：正常按片长铺满可滚动区；内容排到片长之外时改用「内容末尾」，
   * 把刻度压一点，让超出的片段（尤其整队动作带的右把手）留在可视区内、拖得动，
   * 而不是画到右侧面板底下按不着。
   */
  const scaleEnd = Math.max(state.duration, contentEnd);
  const pxPerSec = useMemo(
    () => clamp(laneWidth / Math.max(1, scaleEnd), MIN_PX_PER_SEC, MAX_PX_PER_SEC),
    [laneWidth, scaleEnd],
  );
  // 团队（Group）在时间轴上合并为一行：整队只共用一条路线，不再为每个队员各开一行。
  const teamGroups = useMemo(
    () => (state.groups ?? []).filter((g) => g.dynamics && g.members.length >= 2),
    [state.groups],
  );
  const teamMemberIds = useMemo(
    () => new Set(teamGroups.flatMap((g) => g.members)),
    [teamGroups],
  );
  /**
   * 整队动作带：每支团队一条，覆盖全体成员的动作片段。
   * 带子的 end 取成员动作的最大 timeEnd，于是「队员动作排到片长之外」也看得见、拖得动。
   */
  const teamActionBands = useMemo(() => {
    const bands = new Map<string, TeamActionBand>();
    teamGroups.forEach((group) => {
      const entries = items
        .filter((item) => item.kind === "action" && group.members.includes(item.track))
        .map((item) => {
          const range = itemRange(state, item);
          return range ? { id: item.source, start: range.start, end: range.end } : null;
        })
        .filter((entry): entry is { id: string; start: number; end: number } => entry !== null);
      if (entries.length === 0) return;
      bands.set(group.id, {
        id: `band_${group.id}`,
        anchorId: group.members[0],
        start: Math.min(...entries.map((entry) => entry.start)),
        end: Math.max(...entries.map((entry) => entry.end)),
        entries,
      });
    });
    return bands;
  }, [items, state, teamGroups]);
  const dragRef = useRef<ClipDrag | null>(null);
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 相机行双击改名（name 可改、id 不变）。
  const [camEditingId, setCamEditingId] = useState<string | null>(null);
  const [camDraft, setCamDraft] = useState("");
  const startCamRename = (id: string, current: string) => {
    setCamEditingId(id);
    setCamDraft(current);
  };
  const commitCamRename = () => {
    if (camEditingId) updateCamera(camEditingId, { name: camDraft.trim() || camEditingId });
    setCamEditingId(null);
  };
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 行拖拽排序：拖住左侧标签上下移动，即可调整对象在时间轴 / Scene Tree 中的行序。
  const handleRowDragStart = (id: string) => (event: React.DragEvent) => {
    setDragRowId(id);
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setData("text/plain", id);
    } catch {
      // 部分浏览器对自定义拖拽源限制 setData，忽略即可。
    }
  };

  const handleRowDragOver = (id: string) => (event: React.DragEvent) => {
    if (!dragRowId || dragRowId === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    reorderObject(dragRowId, id);
  };

  const handleRowDragEnd = () => setDragRowId(null);

  /** 由按下位置判定拖动模式：左右把手 = 改起点 / 改终点，其余 = 整条移动。 */
  const dragModeOf = (event: React.PointerEvent<HTMLDivElement>): DragMode => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return "m";
    if (target.classList.contains("l")) return "l";
    if (target.classList.contains("r")) return "r";
    return "m";
  };

  const handleScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    // .clip 自行处理拖拽；.label 现在是行排序的拖拽把手，都不应触发播放头定位。
    if ((event.target as Element).closest?.(".clip, .label")) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    setTime((event.clientX - rect.left + element.scrollLeft - LABEL_WIDTH) / pxPerSec);
  };

  const handleClipMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.originX) / pxPerSec;

    // 整队动作带：带内每条按同一个 delta 同步改写（保留成员之间已有的相对差异）。
    if (drag.band) {
      setActionTimes(
        drag.band.map((entry) => {
          if (drag.mode === "l") {
            return { id: entry.id, timeStart: entry.start + delta, timeEnd: entry.end };
          }
          if (drag.mode === "r") {
            return { id: entry.id, timeStart: entry.start, timeEnd: entry.end + delta };
          }
          return { id: entry.id, timeStart: entry.start + delta, timeEnd: entry.end + delta };
        }),
      );
      return;
    }
    if (!drag.item) return;

    const length = drag.end - drag.start;
    let nextStart = drag.start;
    let nextEnd = drag.end;

    if (drag.mode === "m") {
      nextStart = clamp(drag.start + delta, 0, state.duration - length);
      nextEnd = nextStart + length;
    } else if (drag.mode === "l") {
      nextStart = clamp(drag.start + delta, 0, drag.end - 0.1);
      nextEnd = drag.end;
    } else {
      nextStart = drag.start;
      nextEnd = clamp(drag.end + delta, drag.start + 0.1, state.duration);
    }

    if (drag.item.kind === "segment") setSegmentTime(drag.item.source, nextStart, nextEnd);
    else if (drag.item.kind === "constraint") setConstraintTime(drag.item.source, nextStart, nextEnd);
    else if (drag.item.kind === "action") setActionTime(drag.item.source, nextStart, nextEnd);
    else setCameraMoveTime(drag.item.source, nextStart, nextEnd);
  };

  const renderClip = (item: TimelineItem) => {
    const range = itemRange(state, item);
    if (!range) return null;
    const segment =
      item.kind === "segment" ? state.segments.find((value) => value.id === item.source) : undefined;
    const spark =
      segment && range.end - range.start >= 0.9
        ? easeSpark(normalizeEase(segment.ease))
        : undefined;
    const clipWidth = Math.max(28, (range.end - range.start) * pxPerSec);
    // 路径转折点在该片段上的到达时刻：用于把关键帧画在片段条上。
    const keyframes = segment ? waypointKeyframes(segment) : [];

    return (
      <div
        key={item.id}
        className={`clip ${item.kind} ${selectedItem === item.source ? "sel" : ""}`}
        style={{
          left: range.start * pxPerSec,
          width: Math.max(28, (range.end - range.start) * pxPerSec),
          backgroundImage: spark,
          backgroundRepeat: spark ? "no-repeat" : undefined,
          backgroundPosition: spark ? "right 4px center" : undefined,
          backgroundSize: spark ? "38px 12px" : undefined,
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          // 顺序要紧：先选归属对象 / 相机，再选片段。
          // store 的「互斥选择」订阅只保留最后被设置生效的那一轴（见 directorStore 末尾），
          // 若先 selectItem 再 selectObject，刚设进去的片段选中会被随后的对象选中清掉，
          // 表现就是点 segment / action 永远选不中（无高亮、Inspector 也打不开）。
          if (item.kind === "camera") selectCamera(item.track);
          else selectObject(item.track);
          selectItem(item.source);
          const mode = dragModeOf(event);
          dragRef.current = {
            item,
            start: range.start,
            end: range.end,
            originX: event.clientX,
            mode,
          };
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={handleClipMove}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      >
        {item.label}
        {keyframes.map((keyframe) => (
          <span
            key={keyframe.id}
            className={`wp-key${keyframe.shape === "ARC" ? " is-arc" : ""}${
              selectedPoint === keyframe.id ? " sel" : ""
            }`}
            style={{ left: clamp((keyframe.time - range.start) * pxPerSec, 0, clipWidth) }}
            title={`转折点 #${keyframe.index + 1}${
              keyframe.shape === "ARC" ? "（曲线）" : ""
            } · ${keyframe.time.toFixed(2)}s（点击选中）`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              // 与画布保持一致的三层选中：归属对象 → 片段 → 该转折点。
              // 顺序不能反，详见本函数 clip 自身的 onPointerDown 注释。
              selectObject(item.track);
              selectItem(item.source);
              selectPoint(keyframe.id);
            }}
          />
        ))}
        <span className="handle l" />
        <span className="handle r" />
      </div>
    );
  };

  /**
   * 整队动作带：一条带子代表整队全体成员的动作，拖动即整队同步。
   * 这样队员的动作不会因为「不单独成行」而变成看不见、改不动的隐形内容。
   */
  const renderTeamActionBand = (band: TeamActionBand) => {
    const active = band.entries.some((entry) => entry.id === selectedItem);
    const over = band.end > state.duration + 1e-6;
    return (
      <div
        key={band.id}
        className={`clip action team-band${active ? " sel" : ""}${over ? " over" : ""}`}
        style={{
          left: band.start * pxPerSec,
          width: Math.max(28, (band.end - band.start) * pxPerSec),
        }}
        title={`整队动作 ×${band.entries.length}：整队共用一条动作时间轴，拖动即全体同步${
          over ? "；右端已越过片长，超出部分不参与播放 / 导出" : ""
        }`}
        onPointerDown={(event) => {
          event.stopPropagation();
          selectObject(band.anchorId);
          selectItem(band.entries[0].id);
          dragRef.current = {
            item: null,
            band: band.entries,
            start: band.start,
            end: band.end,
            originX: event.clientX,
            mode: dragModeOf(event),
          };
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={handleClipMove}
        onPointerUp={() => {
          dragRef.current = null;
        }}
      >
        整队动作 ×{band.entries.length}
        <span className="handle l" />
        <span className="handle r" />
      </div>
    );
  };

  return (
    <div className="timeline">
      <div className="tlbar">
        <TimelineReadout />
        {/* 场景最大时长：成片导出与时间轴刻度都以此为基准。置于时间轴顶栏右上角，便于随时调整。 */}
        <label
          className={`dur-field${overflow ? " is-overflow" : ""}`}
          title="成片长度（秒）：导出与时间轴刻度以此为准。调小不会删除片段，只是超出部分不参与播放 / 导出。"
        >
          <span className="lab">Scene Duration (s)</span>
          <input
            type="number"
            min={1}
            max={600}
            step={0.5}
            value={durDraft ?? state.duration}
            onChange={(event) => setDurDraft(event.target.value)}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) setDuration(next);
              setDurDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDurDraft(null);
            }}
          />
        </label>
        {/* 片长调得比内容短时明确告知：超出部分只是不出片，片段仍在。点一下即把片长对齐到内容末尾。 */}
        {overflow ? (
          <button
            type="button"
            className="dur-warn"
            title={`有片段排到 ${contentEnd.toFixed(1)}s（含团队队员的动作）。点击把片长设到 ${alignEnd}s；超出的部分不参与播放 / 导出，片段不会被删除`}
            onClick={() => setDuration(alignEnd)}
          >
            ⚠ 内容到 {contentEnd.toFixed(1)}s · 对齐片长
          </button>
        ) : null}
      </div>
      <div className="scroll" id="scroll" ref={scrollRef} onPointerDown={handleScrub}>
        <div className="ruler" id="ruler">
          {/* 刻度画到「比例基准」为止：内容超出片长时，多出来的刻度让溢出时段也有参照。 */}
          {Array.from({ length: Math.floor(scaleEnd) + 1 }, (_, index) => (
            <div
              key={index}
              className={`tick${index > state.duration ? " over" : ""}`}
              style={{ left: index * pxPerSec }}
            >
              {index}s
            </div>
          ))}
        </div>
        <Playhead pxPerSec={pxPerSec} />
        <div className="tracks" id="tracks">
          {state.objects
            .filter((object) => object.role === "agent" || items.some((item) => item.track === object.id))
            .map((object) => {
              // 团队成员不单独成行；遍历到锚点（队首）时渲染「整队」那一行。
              const team = teamGroups.find((g) => g.members[0] === object.id);
              if (teamMemberIds.has(object.id) && !team) return null;
              if (team) {
                const teamCollapsed = collapsed.has(team.id);
                const anchorId = team.members[0];
                const band = teamActionBands.get(team.id);
                return (
                  <Fragment key={team.id}>
                    <div className="row asset-node group-node">
                      <div
                        className="label asset-label"
                        title={`团队 · ${team.name}（${team.members.length} 人，整队共用一条路线）`}
                      >
                        <button
                          type="button"
                          className="caret"
                          title={teamCollapsed ? "展开动作" : "收起动作"}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => toggleCollapse(team.id)}
                        >
                          {teamCollapsed ? "▸" : "▾"}
                        </button>
                        <span className="node-dot" style={{ background: team.color }} />
                        <span className="node-name">
                          👥 {team.name} ×{team.members.length}
                        </span>
                      </div>
                      {/* 整队路线 = 锚点（队首）那条路径上的片段。 */}
                      <div className="lane" data-track={anchorId}>
                        {items
                          .filter((item) => item.track === anchorId && item.kind !== "action")
                          .map(renderClip)}
                      </div>
                      <button
                        type="button"
                        className="add-leg"
                        title="为整队添加一段 MOVE（写在队首路线上）"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => addSegment(anchorId)}
                      >
                        ＋
                      </button>
                    </div>
                    {!teamCollapsed ? (
                      <div className="row action-row action-node">
                        <div className="label act-label" title={`${team.name} 动作`}>
                          <span className="connector">↳</span>
                          <span>动作</span>
                        </div>
                        {/* 整队动作带：全体成员的动作合成一条（原来只渲染队首，队员片段是隐形的）。 */}
                        <div className="lane" data-track={anchorId}>
                          {band ? renderTeamActionBand(band) : null}
                        </div>
                        <button
                          type="button"
                          className="add-leg"
                          title="为队首添加动作片段"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => addAction(anchorId)}
                        >
                          ＋A
                        </button>
                      </div>
                    ) : null}
                  </Fragment>
                );
              }
              const isCollapsed = collapsed.has(object.id);
              const noun = assetNoun(object.category);
              return (
                <Fragment key={object.id}>
                  {/* 资产（父节点）：运动轨道即资产自身的路径 / 约束。 */}
                  <div className={`row asset-node ${dragRowId === object.id ? "row-dragging" : ""}`}>
                    <div
                      className="label asset-label"
                      title={`${noun} · ${objectDisplayName(object)}${
                        object.name?.trim() ? `（${object.id}）` : ""
                      }`}
                      draggable
                      onDragStart={handleRowDragStart(object.id)}
                      onDragOver={handleRowDragOver(object.id)}
                      onDragEnd={handleRowDragEnd}
                    >
                      <button
                        type="button"
                        className="caret"
                        title={isCollapsed ? "展开动作" : "收起动作"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => toggleCollapse(object.id)}
                      >
                        {isCollapsed ? "▸" : "▾"}
                      </button>
                      <span className="node-dot" style={{ background: object.color }} />
                      <span className="node-name">{noun} {objectDisplayName(object)}</span>
                    </div>
                    {/* 运动轨道：只放 MOVE / Constraint，动作片段单独一行避免重叠。 */}
                    <div className="lane" data-track={object.id}>
                      {items
                        .filter((item) => item.track === object.id && item.kind !== "action")
                        .map(renderClip)}
                    </div>
                    <button
                      type="button"
                      className="add-leg"
                      title="Add leg (append a new MOVE segment anchored to the last leg's end)"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => addSegment(object.id)}
                    >
                      ＋
                    </button>
                  </div>
                  {/* 动作轨道（子节点）：仅 human 类资产有，强绑定于上方资产。 */}
                  {object.category === "human" && !isCollapsed ? (
                    <div className="row action-row action-node">
                      <div className="label act-label" title={`${object.id} 动作`}>
                        <span className="connector">↳</span>
                        <span>动作</span>
                      </div>
                      <div className="lane" data-track={object.id}>
                        {items
                          .filter((item) => item.track === object.id && item.kind === "action")
                          .map(renderClip)}
                      </div>
                      <button
                        type="button"
                        className="add-leg"
                        title="Add action clip (pose / gesture / gait)"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => addAction(object.id)}
                      >
                        ＋A
                      </button>
                    </div>
                  ) : null}
                </Fragment>
              );
            })}

          {state.cameras.map((camera) => (
            <div key={camera.id} className="row camera-row">
              <div className="label cam-label" title={camera.name}>
                <span className="dot" style={{ background: camera.color }} />
                {camEditingId === camera.id ? (
                  <input
                    className="cam-rename"
                    autoFocus
                    value={camDraft}
                    onChange={(event) => setCamDraft(event.target.value)}
                    onBlur={commitCamRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitCamRename();
                      else if (event.key === "Escape") setCamEditingId(null);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                ) : (
                  <span
                    className="track-name"
                    onDoubleClick={() => startCamRename(camera.id, camera.name)}
                    title="双击改名"
                  >
                    {camera.name}
                  </span>
                )}
              </div>
              <div className="lane" data-track={camera.id}>
                {items.filter((item) => item.track === camera.id).map(renderClip)}
                {state.cameraJunctions
                  .filter((junction) => {
                    const prevMove = state.cameraMoves.find((move) => move.id === junction.prevMove);
                    const nextMove = state.cameraMoves.find((move) => move.id === junction.nextMove);
                    return (
                      prevMove &&
                      nextMove &&
                      prevMove.camera === camera.id &&
                      nextMove.camera === camera.id
                    );
                  })
                  .map((junction) => {
                    const prevMove = state.cameraMoves.find((move) => move.id === junction.prevMove)!;
                    const boundary = prevMove.timeEnd;
                    const color =
                      junction.mode === "cut" ? "#ff7b91" : junction.mode === "smooth" ? "#67a7ff" : "#f0a35a";
                    const glyph = junction.mode === "cut" ? "✕" : junction.mode === "smooth" ? "◉" : "■";
                    return (
                      <div
                        key={junction.id}
                        className="cam-junction"
                        style={{ left: boundary * pxPerSec, borderColor: color, color }}
                        title={`Camera junction: ${junction.mode} — click to cycle stop/smooth/cut`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => {
                          const order: HandoffMode[] = ["stop", "smooth", "cut"];
                          setCameraJunctionMode(junction.id, order[(order.indexOf(junction.mode) + 1) % order.length]);
                        }}
                      >
                        {glyph}
                      </div>
                    );
                  })}
              </div>
              <button
                type="button"
                className="add-leg"
                title="Add move (append a new CameraMove on this camera's track)"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => addCameraMove(camera.id, camera.motion)}
              >
                ＋
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
