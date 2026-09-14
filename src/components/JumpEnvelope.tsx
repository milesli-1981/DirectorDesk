import { useMemo } from "react";
import { Locomotion } from "../domain/schema";
import { jumpReach, speedScale } from "../engine/jump";

/**
 * 跳跃包络图（docs/3d/02 §3 的"UI 上的表达"）。
 *
 * 把 `reach(Δh) = R/2·(1+√(1−Δh/H))` 这条曲线直接画给导演看：
 * `Δh` 横轴（左低右高）、`reach` 纵轴。再把这个路径实际的 `(Δh, dx)` 标成一个点：
 *
 * - 点在曲线**下方** → 跳得过去 → 绿
 * - 点在曲线**上方** → 跳不过去 → 红
 *
 * 这比给一串数字直观得多，而且**把"能不能过"变成了一眼可见的几何关系**。
 *
 * 用 inline SVG（与 `EaseEditor` 同构）—— 不需要引入图表库，
 * 也自动跟随应用主题色（颜色都写死成项目调色板里的值）。
 */

const VIEW_W = 268;
const VIEW_H = 150;
const PAD_L = 34;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 24;

const X0 = PAD_L;
const X1 = VIEW_W - PAD_R;
const Y0 = PAD_T;
const Y1 = VIEW_H - PAD_B;

export interface JumpEnvelopeProps {
  /** 主体能力表（决定 H / R）。 */
  loco: Locomotion;
  /** 当前路径的高差（米，正 = 往上）。 */
  dh: number;
  /** 当前路径的水平跨度（米）。 */
  dx: number;
  /** 助跑速度比 0..1（缺省 1）。 */
  speedRatio?: number;
}

export function JumpEnvelope({ loco, dh, dx, speedRatio = 1 }: JumpEnvelopeProps) {
  const H = loco.maxJumpHeight;
  const R = loco.maxJumpReach;

  const chart = useMemo(() => {
    if (H <= 0 || R <= 0) return null;
    // 横轴范围：把 dh 包进去（往下给到 −H，往上到 H），留一点余量。
    const dhMin = Math.min(-H, dh) - 0.1 * H;
    const dhMax = H + 0.02;
    // 纵轴：曲线最大 reach 在 dh=dhMin 处（可能 > R），取曲线峰值与 dx 的较大者。
    const reachAtMin = jumpReach(dhMin, H, R);
    const yMax = Math.max(reachAtMin, dx) * 1.05 || 1;

    const px = (v: number) => X0 + ((v - dhMin) / (dhMax - dhMin)) * (X1 - X0);
    const py = (v: number) => Y1 - (v / yMax) * (Y1 - Y0);

    // 曲线（只画可达段 dh ≤ H）。
    const steps = 48;
    let d = "";
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const v = dhMin + (dhMax - dhMin) * t;
      if (v > H) break;
      const r = jumpReach(v, H, R);
      d += `${i === 0 ? "M" : "L"}${px(v).toFixed(2)},${py(r).toFixed(2)} `;
    }

    // 当前点的有效包络（助跑缩放后）。
    const effectiveReach = jumpReach(dh, H, R) * speedScale(speedRatio);
    const ok = dx <= effectiveReach + 1e-6 && dh <= H + 1e-6;
    // 有效包络曲线（虚线：助跑不足时整体下移）。速度 = 1 时与主线重合，不画。
    let dEff = "";
    if (speedRatio < 1) {
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const v = dhMin + (dhMax - dhMin) * t;
        if (v > H) break;
        const r = jumpReach(v, H, R) * speedScale(speedRatio);
        dEff += `${i === 0 ? "M" : "L"}${px(v).toFixed(2)},${py(r).toFixed(2)} `;
      }
    }

    return { dhMin, dhMax, yMax, px, py, d, dEff, pointX: px(dh), pointY: py(dx), ok, effectiveReach };
  }, [H, R, dh, dx, speedRatio]);

  if (!chart) {
    return <p className="hint">该主体不会跳跃（起跳高度 0），无包络可言。</p>;
  }

  return (
    <div className="jump-envelope">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} xmlns="http://www.w3.org/2000/svg">
        {/* 绘图区 */}
        <rect x={X0} y={Y0} width={X1 - X0} height={Y1 - Y0} fill="#0a1016" stroke="#22303d" />

        {/* 水平网格（reach = 0 / 中点 / 顶） */}
        {[0, chart.yMax / 2, chart.yMax].map((v, i) => (
          <line key={`h${i}`} x1={X0} y1={chart.py(v)} x2={X1} y2={chart.py(v)} stroke="#1c2933" />
        ))}
        {/* 竖直网格（dh = −H / 0 / +H） */}
        {[-H, 0, H].map((v, i) => (
          <line key={`v${i}`} x1={chart.px(v)} y1={Y0} x2={chart.px(v)} y2={Y1} stroke="#1c2933" />
        ))}

        {/* 基准线 dh = 0（平地） */}
        <line
          x1={chart.px(0)}
          y1={Y0}
          x2={chart.px(0)}
          y2={Y1}
          stroke="#2b3d4d"
          strokeDasharray="3 3"
        />

        {/* 包络曲线 */}
        <path d={chart.d} fill="none" stroke="#63d39b" strokeWidth={2} />
        {/* 有效包络（助跑不足时） */}
        {chart.dEff ? (
          <path d={chart.dEff} fill="none" stroke="#f0a35a" strokeWidth={1.5} strokeDasharray="4 3" />
        ) : null}

        {/* 当前路径点 */}
        <circle
          cx={chart.pointX}
          cy={chart.pointY}
          r={5}
          fill={chart.ok ? "#63d39b" : "#ff5a6a"}
          stroke="#e8f2ff"
          strokeWidth={1.5}
        />

        {/* 轴标签 */}
        <text x={X0 - 4} y={Y1} fill="#6b7f92" fontSize={8} textAnchor="end">
          0
        </text>
        <text x={X0 - 4} y={Y0 + 7} fill="#6b7f92" fontSize={8} textAnchor="end">
          {chart.yMax.toFixed(1)}
        </text>
        <text x={chart.px(-H)} y={VIEW_H - 8} fill="#6b7f92" fontSize={8} textAnchor="middle">
          −H
        </text>
        <text x={chart.px(0)} y={VIEW_H - 8} fill="#6b7f92" fontSize={8} textAnchor="middle">
          0
        </text>
        <text x={chart.px(H)} y={VIEW_H - 8} fill="#6b7f92" fontSize={8} textAnchor="middle">
          +H
        </text>
        <text x={X1} y={Y0 + 7} fill="#6b7f92" fontSize={8} textAnchor="end">
          跳远 m
        </text>
      </svg>
      <p className="hint" style={{ marginTop: 4 }}>
        曲线 = 该主体的跳远包络；<span style={{ color: chart.ok ? "#63d39b" : "#ff5a6a" }}>●</span>{" "}
        = 本段（Δh {dh >= 0 ? "+" : ""}
        {dh.toFixed(2)}m，跨度 {dx.toFixed(2)}m）。{" "}
        {chart.ok ? "在包络内，跳得过去。" : "在包络外，跳不过去。"}
        {speedRatio < 1 ? " 橙色虚线 = 当前助跑下的有效包络（站着跳只有一半远）。" : ""}
      </p>
    </div>
  );
}
