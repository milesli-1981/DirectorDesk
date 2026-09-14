import { useMemo, useRef, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { EaseCurve, SpeedKey } from "../domain/schema";
import {
  EASE_PRESETS,
  EASE_YMAX,
  EASE_YMIN,
  SPEED_KEY_MIN_GAP,
  curveSpeed,
  curveVal,
  defaultSpeedKeys,
  isSameEase,
  normalizeEase,
  normalizeSpeedKeys,
} from "../engine/ease";
import { WaypointKeyframe } from "../engine/path";

const EX0 = 28;
const EX1 = 252;
const EY0 = 14;
const EY1 = 124;
/** 速度条：基线 + 最大柱高。 */
const SPEED_BASE = 158;
const SPEED_MAX = 26;
/** 曲线下方的迷你时间轴（横轴 = 片段的真实秒数）。 */
const TY0 = 176;
const TY1 = 214;
/** viewBox 宽度，用于把屏幕指针坐标换算回图形坐标。 */
const VIEW_W = 268;

const ex = (u: number) => EX0 + u * (EX1 - EX0);
const ey = (v: number) => EY1 - ((v - EASE_YMIN) / (EASE_YMAX - EASE_YMIN)) * (EY1 - EY0);
const ux = (px: number) => (px - EX0) / (EX1 - EX0);
const vy = (py: number) => EASE_YMIN + ((EY1 - py) / (EY1 - EY0)) * (EASE_YMAX - EASE_YMIN);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** 关键点配色：首点蓝、中间绿、末点橙。段色沿用段起点，两点时整条为蓝（与旧版一致）。 */
function keyColor(index: number, count: number): string {
  if (index === 0) return "#67a7ff";
  if (index === count - 1) return "#f0a35a";
  return "#63d39b";
}

/** 迷你时间轴的秒刻度间隔：片段越短刻度越密。 */
const tickStep = (span: number) => (span <= 4 ? 0.5 : span <= 10 ? 1 : 2);

export interface EaseEditorProps {
  title: string;
  /** 单段 cubic-bezier：无 key 时的兜底形状，也是新插关键点的默认段缓动。 */
  ease: EaseCurve;
  /** 多段速度曲线关键点（≥2 生效）。为空 = 单段 cubic-bezier。 */
  keys: SpeedKey[] | null;
  /** 路径转折点（对象在此转向，速度会突变）在该片段上的抵达时刻与几何里程。
   *  只用于在迷你时间轴上做对照显示，不参与求解 —— 求解只认 ease + keys。 */
  waypoints?: WaypointKeyframe[];
  timeStart: number;
  timeEnd: number;
  onChange: (ease: EaseCurve) => void;
  onKeysChange: (keys: SpeedKey[] | null) => void;
}

/**
 * 速度曲线编辑器。
 *
 * 横轴 = 片段内的归一化时间，纵轴 = 已经过的路径进度。曲线上的圆点是关键点：
 * - 首点往右拖 = 起步前先等一会（延迟），末点往左拖 = 提前到位后停住；
 * - 中间插点 = 多段变速（加速 → 减速 → 再加速）；
 * - 两点之间用「后一个点」的缓动插值，所以拖点和缓动预设可以混用。
 *
 * 曲线下方是迷你时间轴：把关键点按**真实秒数**标出来，可拖动定位播放头；
 * 同时把**路径转折点**投在同一条横轴上，且每个转折点画两根：
 * - 绿色菱形（活）：实际抵达时刻，由曲线反解而来，改曲线它就动；
 * - 灰色虚线（死）：几何里程比例对应的「匀速抵达」位置，是静止的标尺。
 * 两者的间距 = 曲线在该点的提前 / 推迟量。之所以必须是「一根不动 + 一根动」：
 * 拿一个随曲线滑动的游标当参照，标尺和被测量同源，是怎么也对不上的。
 */
export function EaseEditor({
  title,
  ease,
  keys,
  timeStart,
  timeEnd,
  onChange,
  onKeysChange,
  waypoints = [],
}: EaseEditorProps) {
  const currentTime = useDirectorStore((s) => s.currentTime);
  const setTime = useDirectorStore((s) => s.setTime);
  const dragRef = useRef<number | null>(null);
  const scrubRef = useRef(false);
  const [selected, setSelected] = useState<number | null>(null);

  const curve = normalizeEase(ease);
  const profile = useMemo(() => normalizeSpeedKeys(keys), [keys]);
  // 无关键点时也渲染首尾两个锚点：拖它即自动切到关键点模式，曲线形状保持连续。
  const active = useMemo(() => profile ?? defaultSpeedKeys(curve), [profile, curve]);
  const count = active.length;

  const inside = currentTime >= timeStart && currentTime <= timeEnd;
  const span = timeEnd - timeStart || 1;
  const progress = inside ? clamp((currentTime - timeStart) / span, 0, 1) : 0;
  const eased = curveVal(curve, active, progress);

  /**
   * 转折点在迷你时间轴上的两种横坐标，共用同一条轴（ex 的入参都是归一化时间）：
   * - `u`：实际抵达时刻换成的比例 —— 由曲线反解而来，曲线一改它就动（活的游标）。
   * - `fraction`：几何里程比例 —— 「匀速走完」时该点的位置，与曲线无关（死的标尺）。
   * 两者之差就是曲线在这个转折点上造成的提前 / 推迟量，这样才是一对可用的对照。
   */
  const waypointMarks = (waypoints ?? []).map((mark) => {
    const fraction = clamp(mark.fraction, 0, 1);
    const linear = timeStart + fraction * span;
    return {
      id: mark.id,
      index: mark.index,
      shape: mark.shape,
      time: mark.time,
      u: clamp((mark.time - timeStart) / span, 0, 1),
      fraction,
      linear,
      /** 实际抵达相对匀速参照的偏移（秒）：正 = 被曲线推迟，负 = 提前。 */
      drift: mark.time - linear,
    };
  });

  /** 分段画曲线：每段用自己的缓动采样，段色 = 段起点色。 */
  const segments = active.slice(1).map((to, index) => {
    const from = active[index];
    const SAMPLES = 26;
    let d = "";
    for (let s = 0; s <= SAMPLES; s += 1) {
      const w = s / SAMPLES;
      const u = from.t + (to.t - from.t) * w;
      const v = from.v + (to.v - from.v) * easeValSafe(to.ease, w);
      d += `${s ? "L" : "M"}${ex(u).toFixed(1)} ${ey(v).toFixed(1)}`;
    }
    return { d, stroke: keyColor(index, count) };
  });

  const bars = useMemo(() => {
    const barCount = 44;
    const step = (EX1 - EX0) / barCount;
    const values: number[] = [];
    for (let i = 0; i < barCount; i += 1) values.push(curveSpeed(curve, active, (i + 0.5) / barCount));
    const max = Math.max(1, ...values);
    return values.map((value, i) => ({
      x: EX0 + i * step + step * 0.2,
      w: step * 0.6,
      h: Math.max(1, Math.min(SPEED_MAX, (value / max) * SPEED_MAX)),
      fast: value > 1.02,
    }));
  }, [curve, active]);

  const ticks = useMemo(() => {
    const step = tickStep(span);
    const out: number[] = [];
    for (let at = 0; at <= span + 1e-6; at += step) out.push(round3(at));
    return out;
  }, [span]);

  /** 指针坐标 → 图形坐标（svg 宽度自适应，需按 viewBox 换算）。 */
  const toLocal = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = VIEW_W / rect.width;
    return {
      px: (event.clientX - rect.left) * scale,
      py: (event.clientY - rect.top) * scale,
    };
  };

  const scrubTo = (px: number) => {
    const u = clamp(ux(px), 0, 1);
    setTime(timeStart + u * span);
  };

  /** 拖动关键点：只改被拖的那个，越界时被相邻点挤住（不反向推动邻居）。 */
  const dragKey = (px: number, py: number) => {
    const index = dragRef.current;
    if (index === null) return;
    const next = active.map((key) => ({ ...key }));
    const key = next[index];
    const minT = index === 0 ? 0 : next[index - 1].t + SPEED_KEY_MIN_GAP;
    const maxT = index === count - 1 ? 1 : next[index + 1].t - SPEED_KEY_MIN_GAP;
    key.t = round3(clamp(ux(px), minT, Math.max(minT, maxT)));
    // 首末点的进度是硬约束（曲线必须从 0 走到 1，否则跑不完 path），
    // 所以这两点只能水平拖动改时刻，上下拖无效。
    if (index === 0) key.v = 0;
    else if (index === count - 1) key.v = 1;
    else key.v = round3(clamp(vy(py), next[index - 1].v, next[index + 1].v));
    onKeysChange(next);
  };

  /** 在时刻比例 u 处插点：取值取当前曲线，所以插点不会改变已调好的形状。 */
  const insertKey = (u: number) => {
    const t = round3(clamp(u, 0, 1));
    const v = round3(clamp(curveVal(curve, profile, t), 0, 1));
    const id = `K${count + 1}-${Math.round(t * 100)}`;
    const next = [...active.map((key) => ({ ...key })), { id, t, v, ease: curve }];
    const normalized = normalizeSpeedKeys(next);
    if (!normalized) return;
    onKeysChange(normalized);
    setSelected(normalized.findIndex((key) => key.id === id));
  };

  const removeSelected = () => {
    if (selected === null || selected === 0 || selected === count - 1) return;
    const next = active.filter((_, index) => index !== selected).map((key) => ({ ...key }));
    onKeysChange(next);
    setSelected(null);
  };

  const handleDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.target as Element;
    const hit = element.closest?.("[data-k]");
    if (hit) {
      const index = Number(hit.getAttribute("data-k"));
      dragRef.current = index;
      setSelected(index);
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (element.closest?.("[data-tl]")) {
      scrubRef.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      scrubTo(toLocal(event).px);
      return;
    }
    setSelected(null);
  };

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null && !scrubRef.current) return;
    const { px, py } = toLocal(event);
    if (dragRef.current !== null) dragKey(px, py);
    else scrubTo(px);
  };

  const handleUp = () => {
    dragRef.current = null;
    scrubRef.current = false;
  };

  const sel = selected !== null ? active[selected] : undefined;
  const canRemove = selected !== null && selected > 0 && selected < count - 1;

  return (
    <>
      <div className="epills" id="easePresets">
        {EASE_PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className={`epill ${!profile && isSameEase(preset.value, curve) ? "on" : ""}`}
            onClick={() => {
              onChange([...preset.value] as EaseCurve);
              onKeysChange(null);
            }}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div
        id="easeWrap"
        className="ease-wrap"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = VIEW_W / rect.width;
          const py = (event.clientY - rect.top) * scale;
          if (py > EY1 + 6) return; // 只在曲线区双击插点
          insertKey(ux((event.clientX - rect.left) * scale));
        }}
      >
        <svg viewBox="0 0 268 250" xmlns="http://www.w3.org/2000/svg">
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
          <line x1={ex(0)} y1={ey(0)} x2={ex(1)} y2={ey(1)} stroke="#2b3d4d" strokeDasharray="4 4" />

          {segments.map((segment, index) => (
            <path
              key={`seg-${index}`}
              d={segment.d}
              fill="none"
              stroke={segment.stroke}
              strokeWidth={2}
            />
          ))}

          {active.map((key, index) => {
            const color = keyColor(index, count);
            const on = selected === index;
            return (
              <g key={`${key.id}-${index}`}>
                <circle
                  data-k={index}
                  cx={ex(key.t)}
                  cy={ey(key.v)}
                  r={on ? 7.5 : 6}
                  fill={color}
                  stroke={on ? "#e8f2ff" : "#0a1016"}
                  strokeWidth={2}
                  style={{ cursor: index === 0 || index === count - 1 ? "ew-resize" : "grab" }}
                />
                <text
                  x={ex(key.t)}
                  y={ey(key.v) - 10}
                  fill={color}
                  fontSize={7}
                  textAnchor="middle"
                >
                  {index + 1}
                </text>
              </g>
            );
          })}

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

          <text x={EX0 - 4} y={ey(0) + 3} fill="#55646f" fontSize={8} textAnchor="end">
            0
          </text>
          <text x={EX0 - 4} y={ey(1) + 3} fill="#55646f" fontSize={8} textAnchor="end">
            1
          </text>
          <text x={8} y={SPEED_BASE - 8} fill="#55646f" fontSize={7} letterSpacing={1}>
            SPD
          </text>
          {bars.map((bar, index) => (
            <rect
              key={`bar-${index}`}
              x={bar.x}
              y={SPEED_BASE - bar.h}
              width={bar.w}
              height={bar.h}
              fill={bar.fast ? "#f0a35a" : "#3f6fa8"}
            />
          ))}

          {/* ---- 迷你时间轴：关键点在真实秒数上的位置 ---- */}
          <g data-tl="1" style={{ cursor: "ew-resize" }}>
            <rect
              x={EX0}
              y={TY0}
              width={EX1 - EX0}
              height={TY1 - TY0}
              fill="#0a1016"
              stroke="#22303d"
            />
            <rect x={EX0} y={TY0 + 14} width={EX1 - EX0} height={10} fill="#161f28" stroke="#26313b" />
            {ticks.map((at) => (
              <line
                key={`tick-${at}`}
                x1={ex(at / span)}
                y1={TY0 + 12}
                x2={ex(at / span)}
                y2={TY0 + 26}
                stroke="#26313b"
              />
            ))}
            {/* 匀速参照尺（灰虚线）：位置只由几何里程 fraction 决定，曲线怎么改它都不动。
                它到绿菱形的间距，就是曲线在该转折点上的提前 / 推迟量 ——
                标尺不动读数才可信。下面那根 9px 宽的透明线只负责撑开悬停 / 点击区
                （1px 的虚线太难点到，和时间轴上 .wp-key 的处理同理）。 */}
            {waypointMarks.map((mark) => {
              const xRef = ex(mark.fraction);
              const xReal = ex(mark.u);
              const drift =
                Math.abs(mark.drift) < 0.005
                  ? "与匀速一致"
                  : `${mark.drift > 0 ? "推迟" : "提前"} ${Math.abs(mark.drift).toFixed(2)}s`;
              return (
                <g key={`ref-${mark.id}`}>
                  <title>
                    {`转折点 #${mark.index + 1}${mark.shape === "ARC" ? "（曲线）" : ""} · 匀速 ${mark.linear.toFixed(2)}s → 实际 ${mark.time.toFixed(2)}s · ${drift}`}
                  </title>
                  <line
                    x1={xRef}
                    y1={TY0}
                    x2={xRef}
                    y2={TY1}
                    stroke="transparent"
                    strokeWidth={9}
                    style={{ pointerEvents: "stroke" }}
                  />
                  <line
                    x1={xRef}
                    y1={TY0 + 1}
                    x2={xRef}
                    y2={TY1 - 1}
                    stroke="#7f93a8"
                    strokeWidth={1}
                    strokeDasharray="1 2.5"
                    opacity={0.6}
                  />
                  {Math.abs(xReal - xRef) >= 1.5 && (
                    <line
                      x1={xRef}
                      y1={TY0 - 6.5}
                      x2={xReal}
                      y2={TY0 - 6.5}
                      stroke="#7f93a8"
                      strokeWidth={1}
                      opacity={0.85}
                    />
                  )}
                </g>
              );
            })}
            {/* 路径转折点：绿色虚线 + 菱形，与关键点的实线 + 圆点区分开。
                整组落在 data-tl 内，所以点击它就会 scrub 到该时刻（上方读数同步跳过去），
                想在某次转向处插关键点，就不用再手工对齐了。 */}
            {waypointMarks.map((mark) => (
              <g key={`wp-${mark.id}`}>
                <title>
                  {`转折点 #${mark.index + 1}${mark.shape === "ARC" ? "（曲线）" : ""} · ${mark.time.toFixed(2)}s`}
                </title>
                <line
                  x1={ex(mark.u)}
                  y1={TY0 + 2}
                  x2={ex(mark.u)}
                  y2={TY1 - 2}
                  stroke="#55d88a"
                  strokeWidth={1}
                  strokeDasharray="3 2"
                  opacity={0.7}
                />
                <path
                  d={`M${ex(mark.u)} ${TY0 - 3}l3.6 3.6-3.6 3.6-3.6-3.6z`}
                  fill="#55d88a"
                />
              </g>
            ))}
            {active.map((key, index) => {
              const color = keyColor(index, count);
              const at = timeStart + key.t * span;
              return (
                <g key={`tk-${index}`}>
                  <line
                    x1={ex(key.t)}
                    y1={TY0 + 3}
                    x2={ex(key.t)}
                    y2={TY0 + 31}
                    stroke={color}
                    strokeWidth={selected === index ? 2 : 1}
                  />
                  <circle cx={ex(key.t)} cy={TY0 + 19} r={3.2} fill={color} />
                  <text x={ex(key.t)} y={TY0 + 11} fill={color} fontSize={6.5} textAnchor="middle">
                    {index + 1}
                  </text>
                  <text x={ex(key.t)} y={TY1 - 3} fill="#7b8d9c" fontSize={6.5} textAnchor="middle">
                    {at.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <line
              x1={ex(progress)}
              y1={TY0}
              x2={ex(progress)}
              y2={TY1}
              stroke="#ffffff"
              opacity={inside ? 0.8 : 0}
            />
          </g>
        </svg>
      </div>

      <div className="ease-tools">
        <button
          type="button"
          className="ghost-button"
          title="在播放头处插入关键点（也可直接双击曲线）"
          onClick={() => insertKey(inside ? progress : 0.5)}
        >
          ＋ 关键点
        </button>
        <button
          type="button"
          className="ghost-button"
          title="删除选中的关键点（首尾锚点不可删）"
          disabled={!canRemove}
          onClick={removeSelected}
        >
          － 删点
        </button>
        <button
          type="button"
          className="ghost-button"
          title="清空关键点，回到单段 cubic-bezier"
          disabled={!profile}
          onClick={() => onKeysChange(null)}
        >
          重置
        </button>
      </div>

      <div className="eread">
        {`${title} · ${profile ? `${count} keys (多段)` : `cubic-bezier(${curve.map((value) => value.toFixed(2)).join(", ")})`}`}
        {"\n"}
        {inside
          ? `t ${currentTime.toFixed(1)}s · time ${Math.round(progress * 100)}% → path ${Math.round(eased * 100)}%`
          : `playhead outside ${timeStart.toFixed(1)}–${timeEnd.toFixed(1)}s`}
        {"\n"}
        {sel
          ? `#${(selected ?? 0) + 1} · ${(timeStart + sel.t * span).toFixed(1)}s · t ${Math.round(sel.t * 100)}% → 进度 ${Math.round(sel.v * 100)}%`
          : waypointMarks.length
            ? "拖动圆点改关键点 · 绿菱形 = 转折点实际抵达（点击定位） · 灰虚线 = 同点匀速参照，间距 = 提前 / 推迟"
            : "拖动圆点改关键点（首末点只能左右拖） · 双击曲线插点 · 拖动下方时间轴定位"}
      </div>
    </>
  );
}

/** 段内插值用的缓动：与 easeVal 同义，抽出来只为让分段采样读起来干净。 */
function easeValSafe(curve: EaseCurve, u: number): number {
  return curveVal(curve, null, u);
}
