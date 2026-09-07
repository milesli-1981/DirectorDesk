import { EaseCurve } from "../domain/schema";

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

/** 归一化速度（曲线斜率），用于 Speed Curve 下方的速度条。 */
export function easeSpeed(a: EaseCurve, u: number): number {
  const h = 0.008;
  return (easeVal(a, Math.min(1, u + h)) - easeVal(a, Math.max(0, u - h))) / (2 * h);
}
