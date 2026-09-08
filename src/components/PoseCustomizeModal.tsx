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
  /** 当前动作片段的关节覆盖（来自 action.pose.joints）。 */
  joints: Partial<Record<JointName, Vec3>>;
  /** 每次改动即上报（写入 action.pose，随场景自动持久化）。 */
  onChange: (joints: Partial<Record<JointName, Vec3>>) => void;
  onClose: () => void;
}

export function PoseCustomizeModal({ joints, onChange, onClose }: PoseCustomizeModalProps) {
  const update = (joint: JointName, axis: 0 | 1 | 2, value: number) => {
    const next: Partial<Record<JointName, Vec3>> = {};
    for (const key of Object.keys(joints) as JointName[]) {
      const v = joints[key];
      if (v) next[key] = [v[0], v[1], v[2]];
    }
    const cur = next[joint] ?? [0, 0, 0];
    cur[axis] = value;
    // 三轴全零视为「恢复预设」，从覆盖中移除。
    if (cur[0] === 0 && cur[1] === 0 && cur[2] === 0) delete next[joint];
    else next[joint] = cur;
    onChange(next);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>Customize Joints · 关节角度（弧度）</h3>
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
          <button type="button" className="ghost-button" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="hint">
          角度作用于选中动作片段的关节覆盖，叠加在该片段预设之上；改动会随场景自动保存。
        </p>
      </div>
    </div>
  );
}
