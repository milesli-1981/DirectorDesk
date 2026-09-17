import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { DirectorObject } from "../domain/schema";
import { ArrayKind, ArraySpec, arrayCount } from "../engine/array";

/**
 * 阵列的排布方式。
 *
 * **刻意不提供「台阶」**：那是抽象楼梯（`topShape: "stair"`）出现之前的旧做法 ——
 * 一摞离散盒子必然带来三个毛病（每级一次 y 突变、得逐块标 `blocking: false`、不能拐弯，
 * 见 docs/3d/00 §9.15）。要做台阶请把顶面形状改成「抽象楼梯」，再用手绘 / 螺旋给路径。
 * 引擎侧 `array.ts` 仍保留 `stair` 分支（老场景可能存过这个 kind），但 UI 不再给入口。
 */
const ARRAY_KINDS: { k: ArrayKind; label: string; hint: string }[] = [
  { k: "line", label: "直线", hint: "沿一条直线依次排开（立柱、树、椅子）" },
  { k: "grid", label: "网格", hint: "矩形阵列 行×列（停车场、观众席）" },
  { k: "ring", label: "环绕", hint: "等角度绕一圈（围坐、环列）" },
];

/** 一行「标签 + 滑杆」：与 Inspector 同款语义，但按横向工具条排布。 */
function ArrRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="arr-field">
      <span>
        {label} {value}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/**
 * 阵列 / 批量复制：**通用操作**，不是对象属性，因此不放在右侧 Inspector 里。
 *
 * 属性面板只回答"这个对象**是**什么"；"把它复制成一排"是一次**动作**。所以它挂在
 * 画布顶部的操作条上（与「拖拽添加」「模板」同一排），选中一个对象后可用。
 *
 * **为什么 UI 只动几个数字**：排布本身是几何问题（`engine/array.ts` 的纯函数），
 * UI 不该重复那段几何。这里只收集作者的意图参数，落点交给 engine 算、
 * 落地交给 `placeObject` 逐个做。
 *
 * 预览直接问 `arrayCount()`，不自己乘 —— 预览和实际生成同源，
 * 不会出现"写着 12 个、出来 6 个"。
 */
export function ArrayPanel({ object }: { object: DirectorObject }) {
  const arrayAsset = useDirectorStore((s) => s.arrayAsset);
  const [kind, setKind] = useState<ArrayKind>("line");
  const [count, setCount] = useState(4);
  const [spacing, setSpacing] = useState(1.5);
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(3);
  const [radius, setRadius] = useState(3);
  const [alongRotation, setAlongRotation] = useState(false);

  // 只带"当前排布真正在用"的字段：多余的 key 会让默认兜底被覆盖成错值
  // （例如从 grid 切到 line 时若带着 rows，engine 里 line 不看 rows 才没出问题，
  //  但反过来 ui 显示与几何不一致就无从排查）。
  const spec: ArraySpec = (() => {
    switch (kind) {
      case "grid":
        return { kind, rows, cols, spacing, alongRotation };
      case "ring":
        return { kind, count, radius };
      case "line":
      default:
        return { kind, count, spacing, alongRotation };
    }
  })();
  // count / rows×cols 都是**总数（含源对象自身）** → 实际新增 = total − 1。
  const total = arrayCount(spec);
  const added = Math.max(0, total - 1);

  return (
    <div className="arr-panel">
      <span className="arr-title">阵列 · 批量复制</span>

      <div className="arr-kinds">
        {ARRAY_KINDS.map((item) => (
          <button
            key={item.k}
            type="button"
            className={`ghost-button ${kind === item.k ? "on" : ""}`}
            title={item.hint}
            onClick={() => setKind(item.k)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {kind === "line" ? (
        <>
          <ArrRow label="份数" value={count} min={2} max={24} step={1} onChange={setCount} />
          <ArrRow label="间距 m" value={spacing} min={0.2} max={6} step={0.1} onChange={setSpacing} />
        </>
      ) : null}

      {kind === "grid" ? (
        <>
          <ArrRow label="行" value={rows} min={1} max={12} step={1} onChange={setRows} />
          <ArrRow label="列" value={cols} min={1} max={12} step={1} onChange={setCols} />
          <ArrRow label="间距 m" value={spacing} min={0.2} max={6} step={0.1} onChange={setSpacing} />
        </>
      ) : null}

      {kind === "ring" ? (
        <>
          <ArrRow label="份数" value={count} min={2} max={24} step={1} onChange={setCount} />
          <ArrRow label="半径 m" value={radius} min={0.5} max={12} step={0.1} onChange={setRadius} />
        </>
      ) : null}

      {kind !== "ring" ? (
        <button
          type="button"
          className={`ghost-button ${alongRotation ? "on" : ""}`}
          onClick={() => setAlongRotation((v) => !v)}
          title="开启后沿对象自身的 Rotation 方向排布；关闭则固定沿世界 X 轴"
        >
          {alongRotation ? "沿对象朝向" : "沿世界 X"}
        </button>
      ) : null}

      <button
        type="button"
        className="ghost-button arr-go"
        disabled={added === 0}
        onClick={() => arrayAsset(object.id, spec)}
        title={`新增 ${added} 个副本`}
      >
        ＋ 阵列 {added} 份
      </button>

      <p className="hint arr-note">
        当前会新增 {added} 个副本（共 {total} 个，含它自己）。副本各自落到脚下的支撑面上。
      </p>
    </div>
  );
}
