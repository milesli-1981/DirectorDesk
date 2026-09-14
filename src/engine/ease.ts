import { CameraKey, EaseCurve, SpeedKey } from "../domain/schema";

export interface EasePreset {
  name: string;
  value: EaseCurve;
}

export const EASE_PRESETS: EasePreset[] = [
  { name: "LINEAR", value: [0, 0, 1, 1] },
  { name: "EASE-IN", value: [0.42, 0, 1, 1] },
  { name: "EASE-OUT", value: [0, 0, 0.58, 1] },
  { name: "EASE-IN-OUT", value: [0.42, 0, 0.58, 1] },
];

export const EASE_YMIN = -0.25;
export const EASE_YMAX = 1.25;

export function normalizeEase(value?: readonly number[] | null): EaseCurve {
  if (!Array.isArray(value) || value.length < 4) return [0, 0, 1, 1];
  const out: EaseCurve = [0, 0, 1, 1];
  for (let i = 0; i < 4; i += 1) {
    const raw = Number(value[i]);
    out[i] = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : out[i];
  }
  // y 允许越界（overshoot / anticipation），x 必须落在 [0,1]。
  const raw1 = Number(value[1]);
  const raw3 = Number(value[3]);
  if (Number.isFinite(raw1)) out[1] = Math.min(EASE_YMAX, Math.max(EASE_YMIN, raw1));
  if (Number.isFinite(raw3)) out[3] = Math.min(EASE_YMAX, Math.max(EASE_YMIN, raw3));
  return out;
}

export function isSameEase(a: EaseCurve, b: EaseCurve): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * 求 cubic-bezier 在时间进度 u 上的值。
 * 先牛顿迭代，失败后退化为二分，保证 [0,1] 上单调可解。
 */
export function easeVal(a: EaseCurve, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const [x1, y1, x2, y2] = a;
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return u;

  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const fx = (q: number) => ((ax * q + bx) * q + cx) * q;
  const dfx = (q: number) => (3 * ax * q + 2 * bx) * q + cx;

  let q = u;
  for (let i = 0; i < 6; i += 1) {
    const err = fx(q) - u;
    if (Math.abs(err) < 1e-5) break;
    const d = dfx(q);
    if (Math.abs(d) < 1e-6) break;
    q -= err / d;
  }

  if (q < 0 || q > 1 || Math.abs(fx(q) - u) > 1e-5) {
    let lo = 0;
    let hi = 1;
    q = u;
    for (let i = 0; i < 30; i += 1) {
      const v = fx(q);
      if (Math.abs(v - u) < 1e-6) break;
      if (v < u) lo = q;
      else hi = q;
      q = (lo + hi) / 2;
    }
  }

  q = Math.max(0, Math.min(1, q));
  return ((ay * q + by) * q + cy) * q;
}

/**
 * easeVal 的逆解：给定**已缓动的值** v，求满足 ease(u) = v 的时间进度 u。
 *
 * 运动求解里「走了多远」是 ease(u) × 总里程，所以要把某个空间位置换算成时刻，
 * 必须反解而不是直接按里程比例线性取时间——否则 ease-out 段落的关键帧会明显偏移。
 *
 * 采样 + 线性插值求首次跨越：比牛顿迭代稳，且不要求曲线严格单调（overshoot 缓动也退化的可用）。
 */
export function easeTimeForValue(a: EaseCurve, value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  const [x1, y1, x2, y2] = a;
  if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return value;

  const STEPS = 64;
  let prevU = 0;
  let prevV = easeVal(a, 0);
  for (let i = 1; i <= STEPS; i += 1) {
    const u = i / STEPS;
    const v = easeVal(a, u);
    const crossed = prevV <= value ? v >= value : v <= value;
    if (crossed) {
      const dv = v - prevV;
      const ratio = Math.abs(dv) < 1e-9 ? 0 : (value - prevV) / dv;
      return prevU + (u - prevU) * ratio;
    }
    prevU = u;
    prevV = v;
  }
  return 1;
}

/** 归一化速度（曲线斜率），用于缓动曲线下方的速度条。 */
export function easeSpeed(a: EaseCurve, u: number): number {
  const h = 0.008;
  return (easeVal(a, Math.min(1, u + h)) - easeVal(a, Math.max(0, u - h))) / (2 * h);
}

/* ------------------------------------------------- 多段速度曲线（关键点） */

/** 相邻关键点之间的最小时间间距（归一化），保证每段都有非零时长。 */
export const SPEED_KEY_MIN_GAP = 0.02;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 由单段缓动生成两关键点 profile，用于从 cubic-bezier 切到关键点模式。 */
export function defaultSpeedKeys(curve: EaseCurve): SpeedKey[] {
  return [
    { id: "K1", t: 0, v: 0, ease: curve },
    { id: "K2", t: 1, v: 1, ease: curve },
  ];
}

/**
 * 关键点规范化：排序 → 夹紧间距 → 首末点钉死 → 中间点保证 v 单调不减。
 *
 * 两条硬约束：
 * - 首点 v = 0、末点 v = 1：这是「进度曲线」，只要末点小于 1，求解到片段末尾时
 *   进度也到不了 100%，物体就会停在 path 中途。延迟出发 / 提前到位请改这两点的 t。
 * - 中间点 v 单调不减：运动求解里进度只能前进（倒退会让物体往回跑、编队解算失去单调性），
 *   所以越界的点被推进相邻区间，而不是反过来改邻居——保持「拖谁动谁」的手感。
 */
export function normalizeSpeedKeys(value?: readonly SpeedKey[] | null): SpeedKey[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const keys = value
    .map((key) => ({
      id: key.id,
      t: Number.isFinite(key.t) ? clamp01(key.t) : 0,
      v: Number.isFinite(key.v) ? clamp01(key.v) : 0,
      ease: normalizeEase(key.ease),
    }))
    .sort((a, b) => a.t - b.t);
  let prevT = -Infinity;
  let prevV = 0;
  keys.forEach((key, index) => {
    // 首点默认贴 0，也可以往后拖（= 起步前先等一会）；后续点至少与上一点留出间隙。
    const floor = index === 0 ? 0 : prevT + SPEED_KEY_MIN_GAP;
    key.t = Math.min(1, Math.max(key.t, floor));
    if (index === 0) key.v = 0;
    else key.v = Math.max(key.v, prevV);
    prevT = key.t;
    prevV = key.v;
  });
  // 末点必须满进度，否则曲线末端 < 1 → 永远走不完 path。
  keys[keys.length - 1].v = 1;
  return keys;
}

/** 关键点求值：u 落在哪一段，就用该段末点的缓动在段内插值。 */
export function profileVal(keys: readonly SpeedKey[], u: number): number {
  const count = keys.length;
  if (count === 0) return 0;
  if (u <= keys[0].t) return keys[0].v;
  if (u >= keys[count - 1].t) return keys[count - 1].v;
  for (let i = 0; i < count - 1; i += 1) {
    const from = keys[i];
    const to = keys[i + 1];
    if (u < from.t || u > to.t) continue;
    const span = to.t - from.t;
    if (span <= 1e-6) return to.v;
    return from.v + (to.v - from.v) * easeVal(to.ease, (u - from.t) / span);
  }
  return keys[count - 1].v;
}

/** 统一入口：≥2 个关键点走多段曲线，否则退化为单段 cubic-bezier。 */
export function curveVal(
  curve: EaseCurve,
  keys: readonly SpeedKey[] | null | undefined,
  u: number,
): number {
  return keys && keys.length >= 2 ? profileVal(keys, u) : easeVal(curve, u);
}

/** 统一入口的斜率版本（归一化速度），用于速度条与读数。 */
export function curveSpeed(
  curve: EaseCurve,
  keys: readonly SpeedKey[] | null | undefined,
  u: number,
): number {
  const h = 0.008;
  return (
    (curveVal(curve, keys, Math.min(1, u + h)) - curveVal(curve, keys, Math.max(0, u - h))) / (2 * h)
  );
}

/**
 * 统一入口的反解：给定已完成的进度 v，求对应时刻比例 u。
 * 多段曲线里进度可能走出平台（等一会再动），取**首次**达到该进度的时刻。
 */
export function curveTimeForValue(
  curve: EaseCurve,
  keys: readonly SpeedKey[] | null | undefined,
  value: number,
): number {
  if (!keys || keys.length < 2) return easeTimeForValue(curve, value);
  if (value <= keys[0].v) return keys[0].t;
  const last = keys[keys.length - 1];
  if (value >= last.v) return last.t;

  const STEPS = 96;
  let prevU = 0;
  let prevV = curveVal(curve, keys, 0);
  for (let i = 1; i <= STEPS; i += 1) {
    const u = i / STEPS;
    const v = curveVal(curve, keys, u);
    if (prevV <= value && v >= value) {
      const dv = v - prevV;
      const ratio = Math.abs(dv) < 1e-9 ? 0 : (value - prevV) / dv;
      return prevU + (u - prevU) * ratio;
    }
    prevU = u;
    prevV = v;
  }
  return last.t;
}

/* ------------------------------------------------- 相机通道关键帧（CameraKey） */

/** 相邻相机关键帧之间的最小时间间距（归一化），避免同刻多帧。 */
export const CAMERA_KEY_MIN_GAP = 0.02;

/** 可被关键帧接管的通道名（与 CameraKey 的数值字段一一对应）。 */
export type CameraChannel =
  | "orbitDeg"
  | "craneHeight"
  | "dollyScale"
  | "panDeg"
  | "tiltDeg"
  | "truckDist"
  | "lensMm"
  | "roll"
  | "otsOffset";

export const CAMERA_CHANNELS: readonly CameraChannel[] = [
  "orbitDeg",
  "craneHeight",
  "dollyScale",
  "panDeg",
  "tiltDeg",
  "truckDist",
  "lensMm",
  "roll",
  "otsOffset",
];

/**
 * 相机关键帧规范化：排序 → 夹紧时刻并保证最小间距。
 *
 * 与 SpeedKey 不同，这里**不强制首末帧**：只有被赋值的通道才生效，
 * 单帧即「整段恒定为该值」，所以长度为 1 也有效。
 */
export function normalizeCameraKeys(value?: readonly CameraKey[] | null): CameraKey[] | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const keys = value
    .map((key) => {
      const out: CameraKey = {
        id: key.id,
        t: Number.isFinite(key.t) ? clamp01(key.t) : 0,
        ease: normalizeEase(key.ease),
      };
      for (const channel of CAMERA_CHANNELS) {
        const v = key[channel];
        if (typeof v === "number" && Number.isFinite(v)) out[channel] = v;
      }
      return out;
    })
    .sort((a, b) => a.t - b.t);
  let prevT = -Infinity;
  keys.forEach((key, index) => {
    const floor = index === 0 ? 0 : prevT + CAMERA_KEY_MIN_GAP;
    key.t = Math.min(1, Math.max(key.t, floor));
    prevT = key.t;
  });
  return keys;
}

/** 单通道的一个采样点（由关键帧投影而来）。 */
export interface ChannelPoint {
  t: number;
  v: number;
  ease: EaseCurve;
}

/**
 * 单通道求值：`points` 已按 t 升序、且只含定义了该通道的帧。
 * 段内用「后一帧的缓动」插值；首帧之前 / 末帧之后保持端点值（常数外推）。
 */
export function channelVal(points: readonly ChannelPoint[], u: number): number | undefined {
  if (!points.length) return undefined;
  if (u <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (u >= last.t) return last.v;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (u < a.t || u > b.t) continue;
    const span = b.t - a.t;
    if (span <= 1e-6) return b.v;
    return a.v + (b.v - a.v) * easeVal(b.ease, (u - a.t) / span);
  }
  return last.v;
}
