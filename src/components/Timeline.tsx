import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  AssetCategory,
  EaseCurve,
  HandoffMode,
  objectDisplayName,
  TimelineItem,
} from "../domain/schema";
import { buildTimelineItems, itemRange } from "../engine/timeline";
import { easeVal, normalizeEase } from "../engine/ease";

const MAX_PX_PER_SEC = 100;
const MIN_PX_PER_SEC = 12;
const LABEL_WIDTH = 124;
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
  item: TimelineItem;
  start: number;
  end: number;
  originX: number;
  mode: DragMode;
}

function TimelineReadout() {
  const currentTime = useDirectorStore((s) => s.currentTime);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const seconds = currentTime.toFixed(1);

  return (
    <>
      <span className="ctx" id="ctx">
        Frame {seconds}s · Track {selectedId}
        {selectedKind === "camera" ? " (CAM)" : ""}
      </span>
      <span className="timecode" id="tc">
        00:{seconds.padStart(4, "0")}
      </span>
    </>
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
  const setCameraJunctionMode = useDirectorStore((s) => s.setCameraJunctionMode);

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
  const pxPerSec = useMemo(
    () => clamp(laneWidth / Math.max(1, state.duration), MIN_PX_PER_SEC, MAX_PX_PER_SEC),
    [laneWidth, state.duration],
  );
  const reorderObject = useDirectorStore((s) => s.reorderObject);

  const items = useMemo(() => buildTimelineItems(state), [state]);
  const dragRef = useRef<ClipDrag | null>(null);
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
          selectItem(item.source);
          if (item.kind === "camera") selectCamera(item.track);
          else selectObject(item.track);
          const mode: DragMode =
            event.target instanceof HTMLElement
              ? event.target.classList.contains("l")
                ? "l"
                : event.target.classList.contains("r")
                  ? "r"
                  : "m"
              : "m";
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
        <span className="handle l" />
        <span className="handle r" />
      </div>
    );
  };

  return (
    <div className="timeline">
      <div className="tlbar">
        <TimelineReadout />
      </div>
      <div className="scroll" id="scroll" ref={scrollRef} onPointerDown={handleScrub}>
        <div className="ruler" id="ruler">
          {Array.from({ length: state.duration + 1 }, (_, index) => (
            <div key={index} className="tick" style={{ left: index * pxPerSec }}>
              {index}s
            </div>
          ))}
        </div>
        <Playhead pxPerSec={pxPerSec} />
        <div className="tracks" id="tracks">
          {state.objects
            .filter((object) => object.role === "agent" || items.some((item) => item.track === object.id))
            .map((object) => {
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
                <span className="track-name">{camera.name}</span>
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
