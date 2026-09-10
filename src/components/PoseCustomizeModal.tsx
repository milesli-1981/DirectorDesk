import { useState } from "react";
import { JointName, Vec3 } from "../domain/schema";

/** 弹窗里可编辑的关节（与 Inspector 内联微调一致，覆盖 root 之外的主要关节）。 */
const JOINTS: { joint: JointName; label: string }[] = [
  { joint: "hipL", label: "Hip L" },
  { joint: "hipR", label: "Hip R" },
  { joint: "kneeL", label: "Knee L" },
  { joint: "kneeR", label: "Knee R" },
  { joint: "shoulderL", label: "Shoulder L" },
  { joint: "shoulderR", label: "Shoulder R" },
  { joint: "elbowL", label: "Elbow L" },
  { joint: "elbowR", label: "Elbow R" },
  { joint: "spine", label: "Spine" },
  { joint: "neck", label: "Neck" },
];

const AXES: { key: 0 | 1 | 2; label: string }[] = [
  { key: 0, label: "X" },
  { key: 1, label: "Y" },
  { key: 2, label: "Z" },
];

interface PoseCustomizeModalProps {
  /** 初值关节角：新建时为空，编辑已有记录时带入库里的值。 */
  joints: Partial<Record<JointName, Vec3>>;
  /** 初值名称（编辑已有记录时带入）。 */
  initialName?: string;
  /** 新建 / 编辑：只影响标题与按钮文案。 */
  mode?: "create" | "edit";
  /**
   * 点「保存」时才上报：命名后写入自定义动作库并持久保存。
   * 编辑过程中只改本地副本，取消即丢弃，避免留下无名脏数据。
   */
  onSave: (name: string, joints: Partial<Record<JointName, Vec3>>) => void;
  onClose: () => void;
}

export function PoseCustomizeModal({
  joints: initialJoints,
  initialName = "",
  mode = "create",
  onSave,
  onClose,
}: PoseCustomizeModalProps) {
  // 本地副本：改动不立即落到场景里，命名保存后才会 persist。
  const [joints, setJoints] = useState<Partial<Record<JointName, Vec3>>>(() => {
    const next: Partial<Record<JointName, Vec3>> = {};
    for (const key of Object.keys(initialJoints) as JointName[]) {
      const v = initialJoints[key];
      if (v) next[key] = [v[0], v[1], v[2]];
    }
    return next;
  });
  const [name, setName] = useState(initialName);

  const update = (joint: JointName, axis: 0 | 1 | 2, value: number) => {
    setJoints((prev) => {
      const next: Partial<Record<JointName, Vec3>> = {};
      for (const key of Object.keys(prev) as JointName[]) {
        const v = prev[key];
        if (v) next[key] = [v[0], v[1], v[2]];
      }
      const cur: Vec3 = next[joint] ? [next[joint]![0], next[joint]![1], next[joint]![2]] : [0, 0, 0];
      cur[axis] = value;
      // 三轴全零视为「未覆盖」，从记录里移除。
      if (cur[0] === 0 && cur[1] === 0 && cur[2] === 0) delete next[joint];
      else next[joint] = cur;
      return next;
    });
  };

  const canSave = name.trim().length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{mode === "edit" ? "编辑自定义动作" : "新建自定义动作"}</h3>
        <label className="modal-field">
          <span>名称</span>
          <input
            type="text"
            value={name}
            placeholder="例如：举手致意"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="joint-hint">关节角度（弧度）· 三轴全零的关节不会被记录</div>
        {JOINTS.map(({ joint, label }) => {
          const v = joints[joint] ?? [0, 0, 0];
          return (
            <div className="joint-row" key={joint}>
              <div className="jname">{label}</div>
              {AXES.map(({ key, label: axisLabel }) => (
                <div className="axis" key={key}>
                  <span>{axisLabel}</span>
                  <input
                    type="range"
                    min={-Math.PI}
                    max={Math.PI}
                    step={0.02}
                    value={v[key]}
                    onChange={(event) => update(joint, key, Number(event.target.value))}
                  />
                  <span className="deg">{Math.round((v[key] * 180) / Math.PI)}°</span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={!canSave}
            title={canSave ? "命名并保存到自定义动作库" : "请先填写名称"}
            onClick={() => onSave(name.trim(), joints)}
          >
            Save
          </button>
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="hint">
          保存后进到场景的自定义动作库（随场景持久化），并自动应用到当前动作片段；
          其它片段之后也能在 Kind 下拉里按名称直接复用——改库即改所有引用它的片段。
        </p>
      </div>
    </div>
  );
}
