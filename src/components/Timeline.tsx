import { useMemo, useRef } from "react";
import { useDirectorStore } from "../state/directorStore";
import { EaseCurve, TimelineItem } from "../domain/schema";
import { buildTimelineItems, itemRange } from "../engine/timeline";
import { easeVal, normalizeEase } from "../engine/ease";

const PX_PER_SEC = 100;
const LABEL_WIDTH = 82;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
  const selectedObj = useDirectorStore((s) => s.selectedObj);
  const seconds = currentTime.toFixed(1);

  return (
    <>
      <span className="ctx" id="ctx">
        Frame {seconds}s · Track {selectedObj}
      </span>
      <span className="timecode" id="tc">
        00:{seconds.padStart(4, "0")}
      </span>
    </>
  );
}

function Playhead() {
  const currentTime = useDirectorStore((s) => s.currentTime);
  return <div className="ph" style={{ left: LABEL_WIDTH + currentTime * PX_PER_SEC }} />;
}

export function Timeline() {
  const state = useDirectorStore((s) => s.state);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectItem = useDirectorStore((s) => s.selectItem);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const setTime = useDirectorStore((s) => s.setTime);
  const setSegmentTime = useDirectorStore((s) => s.setSegmentTime);
  const setConstraintTime = useDirectorStore((s) => s.setConstraintTime);

  const items = useMemo(() => buildTimelineItems(state), [state]);
  const dragRef = useRef<ClipDrag | null>(null);

  const handleScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest?.(".clip")) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    setTime((event.clientX - rect.left + element.scrollLeft - LABEL_WIDTH) / PX_PER_SEC);
  };

  const handleClipMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = (event.clientX - drag.originX) / PX_PER_SEC;
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
    else setConstraintTime(drag.item.source, nextStart, nextEnd);
  };

  return (
    <div className="timeline">
      <div className="tlbar">
        <TimelineReadout />
      </div>
      <div className="scroll" id="scroll" onPointerDown={handleScrub}>
        <div className="ruler" id="ruler">
          {Array.from({ length: state.duration + 1 }, (_, index) => (
            <div key={index} className="tick" style={{ left: index * PX_PER_SEC }}>
              {index}s
            </div>
          ))}
        </div>
        <Playhead />
        <div className="tracks" id="tracks">
          {state.objects.map((object) => (
            <div key={object.id} className="row">
              <div className="label">{object.id}</div>
              <div className="lane" data-track={object.id}>
                {items
                  .filter((item) => item.track === object.id)
                  .map((item) => {
                    const range = itemRange(state, item);
                    if (!range) return null;
                    const segment =
                      item.kind === "segment"
                        ? state.segments.find((value) => value.id === item.source)
                        : undefined;
                    const spark =
                      segment && range.end - range.start >= 0.9
                        ? easeSpark(normalizeEase(segment.ease))
                        : undefined;

                    return (
                      <div
                        key={item.id}
                        className={`clip ${item.kind} ${selectedItem === item.source ? "sel" : ""}`}
                        style={{
                          left: range.start * PX_PER_SEC,
                          width: Math.max(28, (range.end - range.start) * PX_PER_SEC),
                          backgroundImage: spark,
                          backgroundRepeat: spark ? "no-repeat" : undefined,
                          backgroundPosition: spark ? "right 4px center" : undefined,
                          backgroundSize: spark ? "38px 12px" : undefined,
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          selectItem(item.source);
                          selectObject(item.track);
                          const mode: DragMode = event.target instanceof HTMLElement
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
                  })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
