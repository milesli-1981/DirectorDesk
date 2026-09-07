import { useRef } from "react";
import { useDirectorStore } from "../state/directorStore";
import { EaseCurve } from "../domain/schema";
import {
  EASE_PRESETS,
  EASE_YMAX,
  EASE_YMIN,
  easeSpeed,
  easeVal,
  isSameEase,
  normalizeEase,
} from "../engine/ease";

const EX0 = 24;
const EX1 = 240;
const EY0 = 16;
const EY1 = 128;

const ex = (u: number) => EX0 + u * (EX1 - EX0);
const ey = (v: number) => EY1 - ((v - EASE_YMIN) / (EASE_YMAX - EASE_YMIN)) * (EY1 - EY0);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function speedBars(ease: EaseCurve) {
  const count = 44;
  const step = (EX1 - EX0) / count;
  const width = step * 0.6;
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    values.push(easeSpeed(ease, (i + 0.5) / count));
  }
  const max = Math.max(1, ...values);
  return values.map((value, i) => {
    const height = Math.max(1, Math.min(24, (value / max) * 24));
    return (
      <rect
        key={i}
        x={EX0 + i * step + step * 0.2}
        y={164 - height}
        width={width}
        height={height}
        fill={value > 1.02 ? "#f0a35a" : "#3f6fa8"}
      />
    );
  });
}

export function EaseEditor({ segmentId }: { segmentId: string }) {
  const segment = useDirectorStore((s) => s.state.segments.find((item) => item.id === segmentId));
  const currentTime = useDirectorStore((s) => s.currentTime);
  const setSegmentEase = useDirectorStore((s) => s.setSegmentEase);
  const handleRef = useRef<1 | 2 | null>(null);

  if (!segment) return null;

  const ease = normalizeEase(segment.ease);
  const inside = currentTime >= segment.timeStart && currentTime <= segment.timeEnd;
  const span = segment.timeEnd - segment.timeStart || 1;
  const progress = inside ? clamp((currentTime - segment.timeStart) / span, 0, 1) : 0;
  const eased = easeVal(ease, progress);

  let curvePath = "";
  for (let i = 0; i <= 60; i += 1) {
    const u = i / 60;
    curvePath += `${i ? "L" : "M"}${ex(u).toFixed(1)} ${ey(easeVal(ease, u)).toFixed(1)}`;
  }

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const handle = handleRef.current;
    if (!handle) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = 250 / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const py = (event.clientY - rect.top) * scale;
    const u = (px - EX0) / (EX1 - EX0);
    const v = EASE_YMIN + ((EY1 - py) / (EY1 - EY0)) * (EASE_YMAX - EASE_YMIN);
    const next = [...ease] as EaseCurve;
    next[handle === 1 ? 0 : 2] = round3(clamp(u, 0, 1));
    next[handle === 1 ? 1 : 3] = round3(clamp(v, EASE_YMIN, EASE_YMAX));
    setSegmentEase(segmentId, next);
  };

  return (
    <>
      <div className="epills" id="easePresets">
        {EASE_PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className={`epill ${isSameEase(preset.value, ease) ? "on" : ""}`}
            onClick={() => setSegmentEase(segmentId, [...preset.value] as EaseCurve)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div
        id="easeWrap"
        className="ease-wrap"
        onPointerDown={(event) => {
          const handle = (event.target as Element).closest?.("[data-h]");
          if (!handle) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
          handleRef.current = handle.getAttribute("data-h") === "1" ? 1 : 2;
        }}
        onPointerMove={handleMove}
        onPointerUp={() => {
          handleRef.current = null;
        }}
      >
        <svg viewBox="0 0 250 172" xmlns="http://www.w3.org/2000/svg">
          <rect
            x={EX0}
            y={EY0}
            width={EX1 - EX0}
            height={EY1 - EY0}
            fill="#0a1016"
            stroke="#22303d"
          />
          {[0, 0.5, 1].map((value) => (
            <line
              key={`h-${value}`}
              x1={EX0}
              y1={ey(value)}
              x2={EX1}
              y2={ey(value)}
              stroke="#1c2933"
            />
          ))}
          {[0, 0.5, 1].map((value) => (
            <line
              key={`v-${value}`}
              x1={ex(value)}
              y1={EY0}
              x2={ex(value)}
              y2={EY1}
              stroke="#1c2933"
            />
          ))}
          <line
            x1={ex(0)}
            y1={ey(0)}
            x2={ex(1)}
            y2={ey(1)}
            stroke="#2b3d4d"
            strokeDasharray="4 4"
          />
          <line
            x1={ex(0)}
            y1={ey(0)}
            x2={ex(ease[0])}
            y2={ey(ease[1])}
            stroke="#67a7ff55"
            strokeDasharray="3 3"
          />
          <line
            x1={ex(1)}
            y1={ey(1)}
            x2={ex(ease[2])}
            y2={ey(ease[3])}
            stroke="#f0a35a55"
            strokeDasharray="3 3"
          />
          <path d={curvePath} fill="none" stroke="#67a7ff" strokeWidth={2} />
          <circle
            data-h="1"
            cx={ex(ease[0])}
            cy={ey(ease[1])}
            r={6}
            fill="#67a7ff"
            stroke="#0a1016"
            strokeWidth={2}
            style={{ cursor: "grab" }}
          />
          <circle
            data-h="2"
            cx={ex(ease[2])}
            cy={ey(ease[3])}
            r={6}
            fill="#f0a35a"
            stroke="#0a1016"
            strokeWidth={2}
            style={{ cursor: "grab" }}
          />
          <line
            x1={ex(progress)}
            y1={EY0}
            x2={ex(progress)}
            y2={EY1}
            stroke="#ffffff26"
            visibility={inside ? "visible" : "hidden"}
          />
          <circle
            r={3.5}
            cx={ex(progress)}
            cy={ey(eased)}
            fill="#fff"
            visibility={inside ? "visible" : "hidden"}
          />
          <text x={19} y={ey(0) + 3} fill="#55646f" fontSize={8} textAnchor="end">
            0
          </text>
          <text x={19} y={ey(1) + 3} fill="#55646f" fontSize={8} textAnchor="end">
            1
          </text>
          <text x={6} y={149} fill="#55646f" fontSize={7} letterSpacing={1}>
            SPD
          </text>
          {speedBars(ease)}
        </svg>
      </div>

      <div className="eread">
        {`${segment.id} · cubic-bezier(${ease.map((value) => value.toFixed(2)).join(", ")})`}
        {"\n"}
        {inside
          ? `t ${currentTime.toFixed(1)}s · time ${Math.round(progress * 100)}% → path ${Math.round(easeVal(ease, progress) * 100)}%`
          : `playhead outside ${segment.timeStart.toFixed(1)}–${segment.timeEnd.toFixed(1)}s`}
      </div>
    </>
  );
}
