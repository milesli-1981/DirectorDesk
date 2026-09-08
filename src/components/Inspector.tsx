import { useMemo, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  ASPECT_OPTIONS,
  AspectRatio,
  CameraFraming,
  CameraMotionType,
  CameraSide,
  CameraView,
  EaseCurve,
  HandoffMode,
  JointName,
  Pose,
  ActionKind,
  FRAMING_LABELS,
  LENS_OPTIONS,
  MOTION_HINTS,
  MOTION_LABELS,
  OtsSide,
  OTS_SIDE_LABELS,
  SIDE_LABELS,
  VIEW_LABELS,
} from "../domain/schema";
import { EaseEditor } from "./EaseEditor";
import { PoseCustomizeModal } from "./PoseCustomizeModal";
import { clonePose, POSE_PRESETS, POSE_PRESET_NAMES } from "../engine/poses";
import { solveCamera } from "../engine/cameraSolver";
import { axisSide, cameraAxis } from "../engine/axis";
import { LockBadge } from "./LockBadge";

const ACTION_KINDS: ActionKind[] = [
  "stand",
  "sit",
  "crouch",
  "wave",
  "point",
  "talk",
  "walk",
  "run",
];
// 对象面板只展示静态基线姿势；步态类（walk/run）没有静态关节角度，只在动作片段里选。
const STATIC_POSE_NAMES = POSE_PRESET_NAMES.filter((name) => name !== "walk" && name !== "run");

const MOTION_TYPES: CameraMotionType[] = [
  "STATIC",
  "FOLLOW",
  "ORBIT",
  "DOLLY",
  "DOLLY_ZOOM",
  "CRANE",
  "DRONE",
  "OTS",
];

/** 可在 Inspector 微调的关节（其余如 root 不暴露）。 */
const POSE_SLIDER_JOINTS: { joint: JointName; label: string }[] = [
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

const poseEquals = (pose: Pose | undefined, preset: Pose) =>
  JSON.stringify(pose?.joints ?? {}) === JSON.stringify(preset.joints);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="inspector-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * 面板内的子分组：把强相关的控件收在一起（如 OTS 三件套），
 * 避免十几个字段平铺在一起难以定位。
 */
function SubGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sub-group">
      <div className="sub-title">{title}</div>
      {children}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Inspector() {
  const state = useDirectorStore((s) => s.state);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const viewMode = useDirectorStore((s) => s.viewMode);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const setViewMode = useDirectorStore((s) => s.setViewMode);
  const setActiveCamera = useDirectorStore((s) => s.setActiveCamera);
  const updateCamera = useDirectorStore((s) => s.updateCamera);
  const addCameraMove = useDirectorStore((s) => s.addCameraMove);
  const patchCameraMove = useDirectorStore((s) => s.patchCameraMove);
  const deleteCameraMove = useDirectorStore((s) => s.deleteCameraMove);
  const addReverseShot = useDirectorStore((s) => s.addReverseShot);
  const removeCamera = useDirectorStore((s) => s.removeCamera);
  const setSegmentEase = useDirectorStore((s) => s.setSegmentEase);
  const setCameraMoveEase = useDirectorStore((s) => s.setCameraMoveEase);
  const setAspectRatio = useDirectorStore((s) => s.setAspectRatio);
  const setHandoffMode = useDirectorStore((s) => s.setHandoffMode);
  const setCameraJunctionMode = useDirectorStore((s) => s.setCameraJunctionMode);
  const deleteSegment = useDirectorStore((s) => s.deleteSegment);
  const updateAsset = useDirectorStore((s) => s.updateAsset);
  const removeAsset = useDirectorStore((s) => s.removeAsset);

  const object = selectedKind === "object" ? state.objects.find((o) => o.id === selectedId) : undefined;
  const camera = selectedKind === "camera" ? state.cameras.find((c) => c.id === selectedId) : undefined;
  const segment = state.segments.find((item) => item.id === selectedItem);
  const constraint = state.constraints.find((item) => item.id === selectedItem);
  const move = state.cameraMoves.find((item) => item.id === selectedItem);
  const moveCamera = move ? state.cameras.find((c) => c.id === move.camera) : undefined;
  // 段级未设置时沿用相机级错位量，滑块显示的就是实际生效值。
  const moveOtsOffset = move?.otsOffset ?? moveCamera?.otsOffset ?? 0.35;
  // 过肩相关控件只在「可能是过肩」时展开：类型为 OTS，或已指定前景演员。
  const cameraOts = !!camera && (camera.motion === "OTS" || !!camera.shoulderId);
  const moveOts = !!move && (move.type === "OTS" || !!move.shoulderId);
  const action = state.actions?.find((item) => item.id === selectedItem);
  const actionObject = action ? state.objects.find((o) => o.id === action.object) : undefined;
  const updateAction = useDirectorStore((s) => s.updateAction);
  const deleteAction = useDirectorStore((s) => s.deleteAction);
  // 该相机上被 CameraMove 写死的段级覆盖：相机级同名属性在那些时间段内不生效。
  const overriddenByMoves = camera
    ? (["framing", "view", "side", "lensMm", "roll", "shoulderId", "otsOffset"] as const).filter((key) =>
        state.cameraMoves.some((item) => item.camera === camera.id && item[key] !== undefined),
      )
    : [];

  // 越轴（180° 规则）检测：本段机位与相邻段是否落在动作轴线两侧。
  const moveAxisWarn = useMemo(() => {
    if (!move) return null;
    const cam = move.camera;
    const sibs = state.cameraMoves
      .filter((m) => m.camera === cam)
      .sort((a, b) => a.timeStart - b.timeStart);
    const idx = sibs.findIndex((m) => m.id === move.id);
    if (idx < 0) return null;
    const sideAt = (m: (typeof state.cameraMoves)[number]) => {
      const t = (m.timeStart + m.timeEnd) / 2;
      const ax = cameraAxis(state, cam, t);
      if (!ax) return null;
      const resolved = solveCamera(state, cam, t);
      if (!resolved) return null;
      return axisSide(ax, { x: resolved.position[0], z: resolved.position[2] });
    };
    const cur = sideAt(move);
    if (cur === null || cur === 0) return null;
    const warns: string[] = [];
    const pv = sibs[idx - 1] ? sideAt(sibs[idx - 1]) : null;
    const nx = sibs[idx + 1] ? sideAt(sibs[idx + 1]) : null;
    if (pv !== null && pv !== 0 && pv !== cur) warns.push("前一段");
    if (nx !== null && nx !== 0 && nx !== cur) warns.push("后一段");
    return warns.length ? warns : null;
  }, [move, state]);
  const handoff = segment
    ? state.handoffs.find((h) => h.prevSeg === segment.id) ??
      state.handoffs.find((h) => h.nextSeg === segment.id)
    : undefined;

  const json = useMemo(() => JSON.stringify(state, null, 2), [state]);
  const [showJson, setShowJson] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const pointCount = segment ? segment.points.length : 0;
  const selectedPointShape = segment?.points.find((point) => point.id === selectedPoint)?.shape;

  const easeTarget = segment
    ? {
        title: segment.id,
        ease: segment.ease,
        timeStart: segment.timeStart,
        timeEnd: segment.timeEnd,
        onChange: (ease: EaseCurve) => setSegmentEase(segment.id, ease),
      }
    : move
      ? {
          title: move.id,
          ease: move.ease,
          timeStart: move.timeStart,
          timeEnd: move.timeEnd,
          onChange: (ease: EaseCurve) => setCameraMoveEase(move.id, ease),
        }
      : null;

  const title = camera ? camera.name : (object?.id ?? "—");

  return (
    <aside className="right">
      <div className="st">INSPECTOR</div>
      <div className="title">{title}</div>
      <div className="sub">{camera ? "Camera Intent" : "Director State"}</div>

      <div className="field">
        <div className="lab">Current Intent</div>
        <div id="intentInfo">
          {camera ? (
            <>
              <span className="pill">CAMERA</span> TARGET {camera.targetId} ·{" "}
              {FRAMING_LABELS[camera.framing]} / {SIDE_LABELS[camera.side]} /{" "}
              {VIEW_LABELS[camera.view]} · {camera.lensMm}mm
            </>
          ) : constraint ? (
            <>
              <span className="pill">{constraint.type}</span> {constraint.subject} →{" "}
              {constraint.target} · {constraint.timeStart.toFixed(1)}–
              {constraint.timeEnd.toFixed(1)}s
            </>
          ) : segment ? (
            <>
              <span className="pill">{segment.type}</span> {segment.object} ·{" "}
              {segment.timeStart.toFixed(1)}–{segment.timeEnd.toFixed(1)}s
            </>
          ) : move ? (
            <>
              <span className="pill">{move.type}</span> {move.camera} ·{" "}
              {move.timeStart.toFixed(1)}–{move.timeEnd.toFixed(1)}s
            </>
          ) : (
            "No timeline intent selected."
          )}
        </div>
      </div>

      <div className="field">
        <div className="lab">Selected Timeline Item</div>
        <div id="itemInfo">
          {selectedItem ?? "—"}
          {segment ? ` · ${pointCount} path point${pointCount === 1 ? "" : "s"}` : ""}
          {selectedPointShape ? ` · ${selectedPointShape}` : ""}
        </div>
      </div>

      {object ? (
        <div className="field">
          <div className="lab">Asset — {object.category}</div>
          <div className="row2">
            <label>Role</label>
            <select
              value={object.role}
              onChange={(event) => updateAsset(object.id, { role: event.target.value as "agent" | "set" })}
            >
              <option value="agent">agent（可运动 / 可作目标）</option>
              <option value="set">set（环境 / 遮挡体）</option>
            </select>
          </div>
          <div className="row2">
            <label>Rotation</label>
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={object.rotation}
              onChange={(event) => updateAsset(object.id, { rotation: Number(event.target.value) })}
            />
            <span className="val">{object.rotation}°</span>
          </div>
          {/* W / D / H 三个滑杆：尺寸是连续量，拖动比输数字更快也更直观。 */}
          <div className="block-size">
            <div className="block-size-title">Block 尺寸</div>
            {(
              [
                { key: "w", label: "W", title: "Width 宽" },
                { key: "d", label: "D", title: "Depth 深" },
                { key: "h", label: "H", title: "Height 高" },
              ] as const
            ).map((dim) => {
              const value = object.footprint[dim.key];
              // 滑杆上限随当前值自适应：小到 0.6m 的人物、大到 24m 的楼体都能在一屏内精确拖动。
              const max = Math.max(2, Math.ceil(value) * 2);
              return (
                <div className="size-slider" key={dim.key}>
                  <span className="val" title={dim.title}>
                    {dim.label}
                  </span>
                  <input
                    type="range"
                    min={0.1}
                    max={max}
                    step={0.1}
                    value={value}
                    onChange={(event) =>
                      updateAsset(object.id, {
                        footprint: { ...object.footprint, [dim.key]: Number(event.target.value) },
                      })
                    }
                  />
                  <span className="sz">{value.toFixed(1)}</span>
                </div>
              );
            })}
          </div>
          <div className="row2">
            <label>Lock</label>
            <LockBadge
              locked={!!object.locked}
              title={
                object.locked
                  ? "已锁定初始位置：编辑时不可拖拽（点此解锁）；播放时仍按轨迹移动"
                  : "锁定初始位置：编辑时不可拖拽，播放时仍按轨迹移动"
              }
              onClick={() => updateAsset(object.id, { locked: !object.locked })}
            />
          </div>
          {object.category === "human" ? (
            <div className="field">
              <div className="lab">Pose（静态基线姿势）</div>
              <div className="mini-btns">
                {STATIC_POSE_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`ghost-button ${poseEquals(object.pose, POSE_PRESETS[name]) ? "on" : ""}`}
                    onClick={() => updateAsset(object.id, { pose: clonePose(POSE_PRESETS[name]) })}
                  >
                    {name}
                  </button>
                ))}
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => updateAsset(object.id, { pose: { joints: {} } })}
                >
                  reset
                </button>
              </div>
              <p className="hint">这里只设人物的静态基线姿势；关节微调请在选中某个动作片段后，于「Action」面板的 Joints 区调整。</p>
            </div>
          ) : null}
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              onClick={() => removeAsset(object.id)}
            >
              Delete Asset
            </button>
          </div>
          <p className="hint">锁定后不可通过拖拽移动位置（防误触），仍可点选以便解锁；agent = 可运动、可作相机目标，set = 环境遮挡体与路径障碍</p>
        </div>
      ) : null}

      {segment && handoff ? (
        <div className="field">
          <div className="lab">
            Leg Handoff → {handoff.prevSeg === segment.id ? "next" : "prev"} ({handoff.id})
          </div>
          <div className="mini-btns">
            {(["stop", "smooth", "cut"] as HandoffMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`ghost-button ${handoff.mode === mode ? "on" : ""}`}
                onClick={() => setHandoffMode(handoff.id, mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              onClick={() => deleteSegment(segment.id)}
            >
              Delete Leg
            </button>
          </div>
          <p className="hint">stop = pause then go · smooth = continuous (一镜到底) · cut = allow teleport</p>
        </div>
      ) : null}

      {action && actionObject?.category === "human" ? (
        <div className="field">
          <div className="lab">Action（动作片段）</div>
          <Field label="Kind">
            <select
              value={action.kind}
              onChange={(event) => updateAction(action.id, { kind: event.target.value as ActionKind })}
            >
              {ACTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </Field>
          <div className="row2">
            <label>Intensity</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={action.intensity}
              onChange={(event) => updateAction(action.id, { intensity: Number(event.target.value) })}
            />
            <span className="val">{Math.round(action.intensity * 100)}%</span>
          </div>
          <div className="row2">
            <label>Time</label>
            <span className="val">
              {action.timeStart}s – {action.timeEnd}s
            </span>
          </div>
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              onClick={() => deleteAction(action.id)}
            >
              Delete Action
            </button>
          </div>
          <div className="lab">
            Joints（关节微调 · 覆盖本片段预设）
            <button type="button" className="ghost-button" onClick={() => setCustomizeOpen(true)}>
              Customize
            </button>
          </div>
          {POSE_SLIDER_JOINTS.map(({ joint, label }) => {
            const angle = action.pose?.joints[joint]?.[0] ?? 0;
            return (
              <div className="row2" key={joint}>
                <label>{label}</label>
                <input
                  type="range"
                  min={-Math.PI}
                  max={Math.PI}
                  step={0.05}
                  value={angle}
                  onChange={(event) => {
                    const v = Number(event.target.value);
                    const joints = { ...(action.pose?.joints ?? {}) };
                    if (v === 0) delete joints[joint];
                    else joints[joint] = [v, 0, 0];
                    updateAction(action.id, { pose: { joints } });
                  }}
                />
                <span className="val">{Math.round((angle * 180) / Math.PI)}°</span>
              </div>
            );
          })}

          {customizeOpen && action && (
            <PoseCustomizeModal
              joints={action.pose?.joints ?? {}}
              onChange={(joints) => updateAction(action.id, { pose: { joints } })}
              onClose={() => setCustomizeOpen(false)}
            />
          )}

          <p className="hint">
            MOVE 决定「去哪里」，动作只决定「身体怎么动」：walk / run 选择步态（不选时按速度自动判定，低速走、高速跑），
            sit / crouch 会停止腿部摆动。在时间轴该演员的「动作」行点 ＋A 新增片段，拖动 clip 改时间、拖边缘修剪时长。
          </p>
        </div>
      ) : null}

      <div className="field" id="easeField" style={{ display: easeTarget ? "" : "none" }}>
        <div className="lab">Speed Curve · cubic-bezier</div>
        {easeTarget ? (
          <EaseEditor
            title={easeTarget.title}
            ease={easeTarget.ease}
            timeStart={easeTarget.timeStart}
            timeEnd={easeTarget.timeEnd}
            onChange={easeTarget.onChange}
          />
        ) : null}
      </div>

      {camera ? (
        <>
          <div className="field">
            <div className="lab">Camera Intent</div>
            {overriddenByMoves.length > 0 ? (
              <p className="hint">
                ⚠ {overriddenByMoves.join(" / ")} 已被某些 CameraMove 段级覆盖，相机级同名属性在那些时间段内不生效（段级留空即继承此处）。
              </p>
            ) : null}
            <SubGroup title="构图 Composition" hint="拍谁、多近、从哪个角度。">
              <Field label="Target">
                <select
                  value={camera.targetId}
                  onChange={(event) => updateCamera(camera.id, { targetId: event.target.value })}
                >
                  {state.objects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Framing">
                <select
                  value={camera.framing}
                  onChange={(event) =>
                    updateCamera(camera.id, { framing: event.target.value as CameraFraming })
                  }
                >
                  {(Object.keys(FRAMING_LABELS) as CameraFraming[]).map((value) => (
                    <option key={value} value={value}>
                      {FRAMING_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="View">
                <select
                  value={camera.view}
                  onChange={(event) =>
                    updateCamera(camera.id, { view: event.target.value as CameraView })
                  }
                >
                  {(Object.keys(VIEW_LABELS) as CameraView[]).map((value) => (
                    <option key={value} value={value}>
                      {VIEW_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Side">
                <select
                  value={camera.side}
                  onChange={(event) =>
                    updateCamera(camera.id, { side: event.target.value as CameraSide })
                  }
                >
                  {(Object.keys(SIDE_LABELS) as CameraSide[]).map((value) => (
                    <option key={value} value={value}>
                      {SIDE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lens">
                <select
                  value={camera.lensMm}
                  onChange={(event) =>
                    updateCamera(camera.id, { lensMm: Number(event.target.value) })
                  }
                >
                  {LENS_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}mm
                    </option>
                  ))}
                </select>
              </Field>
            </SubGroup>

            {cameraOts ? (
              <SubGroup
                title="过肩 OTS"
                hint="越过前景演员的肩膀拍主体：Shoulder 是前景、Target 是主体；Offset 控制主体偏离画面中心的程度。"
              >
                <Field label="Shoulder（前景演员）">
                  <select
                    value={camera.shoulderId ?? ""}
                    onChange={(event) =>
                      updateCamera(camera.id, { shoulderId: event.target.value || undefined })
                    }
                  >
                    <option value="">(none)</option>
                    {state.objects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Side（左肩 / 右肩）">
                  <select
                    value={camera.otsSide ?? "R"}
                    onChange={(event) =>
                      updateCamera(camera.id, { otsSide: event.target.value as OtsSide })
                    }
                  >
                    {(Object.keys(OTS_SIDE_LABELS) as OtsSide[]).map((value) => (
                      <option key={value} value={value}>
                        {OTS_SIDE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Offset ${(camera.otsOffset ?? 0.35).toFixed(2)}（错位量）`}>
                  <input
                    type="range"
                    min={0}
                    max={0.6}
                    step={0.05}
                    value={camera.otsOffset ?? 0.35}
                    onChange={(event) =>
                      updateCamera(camera.id, { otsOffset: Number(event.target.value) })
                    }
                  />
                </Field>
              </SubGroup>
            ) : null}

            <SubGroup title="机位与运动 Rig / Motion">
              <Field label="Kind">
                <select
                  value={camera.kind ?? "ground"}
                  onChange={(event) =>
                    updateCamera(camera.id, { kind: event.target.value as "ground" | "drone" })
                  }
                >
                  <option value="ground">Ground</option>
                  <option value="drone">Drone</option>
                </select>
              </Field>
              <Field label={`Roll ${camera.roll ?? 0}°（荷兰角）`}>
                <input
                  type="range"
                  min={-45}
                  max={45}
                  step={1}
                  value={camera.roll ?? 0}
                  onChange={(event) => updateCamera(camera.id, { roll: Number(event.target.value) })}
                />
              </Field>
              <Field label="Default Motion">
                <select
                  value={camera.motion}
                  onChange={(event) =>
                    updateCamera(camera.id, { motion: event.target.value as CameraMotionType })
                  }
                >
                  {MOTION_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {MOTION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
            </SubGroup>
          </div>

          <div className="field">
            <div className="lab">Add Camera Move @ playhead</div>
            <div className="mini-btns">
              {MOTION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="ghost-button"
                  title={MOTION_HINTS[type]}
                  onClick={() => addCameraMove(camera.id, type)}
                >
                  ＋ {MOTION_LABELS[type]}
                </button>
              ))}
            </div>
            <p className="hint">{MOTION_HINTS[camera.motion]}</p>
            <div className="mini-btns">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setActiveCamera(camera.id)}
              >
                Set Active
              </button>
              <button
                type="button"
                className={`ghost-button ${viewMode === "camera" && activeCameraId === camera.id ? "on" : ""}`}
                onClick={() => {
                  setActiveCamera(camera.id);
                  setViewMode(viewMode === "camera" && activeCameraId === camera.id ? "director" : "camera");
                }}
              >
                {viewMode === "camera" && activeCameraId === camera.id ? "Exit Camera View" : "Camera View"}
              </button>
            </div>
            <div className="mini-btns" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="ghost-button danger-button"
                onClick={() => removeCamera(camera.id)}
              >
                Delete Camera
              </button>
            </div>
          </div>
        </>
      ) : null}

      {move ? (
        <div className="field">
          <div className="lab">
            Camera Move · {MOTION_LABELS[move.type]} on {move.camera}
          </div>
          {moveAxisWarn && (
            <p className="hint" style={{ color: "#ffb86b" }}>
              ⚠ 跨轴（180° 规则）：本段机位与 {moveAxisWarn.join(" / ")} 分别位于动作轴线两侧，剪辑时会让观众迷失方位。建议保持同一侧，或以一次轴向摇移作过渡。
            </p>
          )}
          <SubGroup title="运镜 Motion" hint={MOTION_HINTS[move.type]}>
            <Field label="Motion">
              <select
                value={move.type}
                onChange={(event) =>
                  patchCameraMove(move.id, { type: event.target.value as CameraMotionType })
                }
              >
                {MOTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {MOTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>

            {move.type === "ORBIT" || move.type === "DRONE" ? (
              <Field label={`Orbit ${move.orbitDeg.toFixed(0)}°`}>
                <input
                  type="range"
                  min={-360}
                  max={360}
                  step={5}
                  value={move.orbitDeg}
                  onChange={(event) => patchCameraMove(move.id, { orbitDeg: Number(event.target.value) })}
                />
              </Field>
            ) : null}

            {move.type === "DOLLY" || move.type === "DRONE" || move.type === "DOLLY_ZOOM" ? (
              <Field label={`Dolly ×${move.dollyScale.toFixed(2)}`}>
                <input
                  type="range"
                  min={0.3}
                  max={2}
                  step={0.05}
                  value={move.dollyScale}
                  onChange={(event) =>
                    patchCameraMove(move.id, { dollyScale: Number(event.target.value) })
                  }
                />
              </Field>
            ) : null}

            {move.type === "CRANE" || move.type === "DRONE" ? (
              <Field label={`Crane +${move.craneHeight.toFixed(1)}m`}>
                <input
                  type="range"
                  min={-6}
                  max={8}
                  step={0.1}
                  value={move.craneHeight}
                  onChange={(event) =>
                    patchCameraMove(move.id, { craneHeight: Number(event.target.value) })
                  }
                />
              </Field>
            ) : null}
          </SubGroup>

          <SubGroup title="构图 Composition" hint="留空即继承相机级设置。">
            <Field label="Target">
              <select
                value={move.targetId ?? ""}
                onChange={(event) =>
                  patchCameraMove(move.id, { targetId: event.target.value || undefined })
                }
              >
                <option value="">(camera default)</option>
                {state.objects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Framing">
              <select
                value={move.framing ?? ""}
                onChange={(event) =>
                  patchCameraMove(move.id, { framing: (event.target.value || undefined) as CameraFraming | undefined })
                }
              >
                <option value="">(camera default)</option>
                {(Object.keys(FRAMING_LABELS) as CameraFraming[]).map((value) => (
                  <option key={value} value={value}>
                    {FRAMING_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="View">
              <select
                value={move.view ?? ""}
                onChange={(event) =>
                  patchCameraMove(move.id, { view: (event.target.value || undefined) as CameraView | undefined })
                }
              >
                <option value="">(camera default)</option>
                {(Object.keys(VIEW_LABELS) as CameraView[]).map((value) => (
                  <option key={value} value={value}>
                    {VIEW_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Side">
              <select
                value={move.side ?? ""}
                onChange={(event) =>
                  patchCameraMove(move.id, { side: (event.target.value || undefined) as CameraSide | undefined })
                }
              >
                <option value="">(camera default)</option>
                {(Object.keys(SIDE_LABELS) as CameraSide[]).map((value) => (
                  <option key={value} value={value}>
                    {SIDE_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Lens">
              <select
                value={move.lensMm ?? ""}
                onChange={(event) =>
                  patchCameraMove(move.id, { lensMm: event.target.value ? Number(event.target.value) : undefined })
                }
              >
                <option value="">(camera default)</option>
                {LENS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}mm
                  </option>
                ))}
              </select>
            </Field>
          </SubGroup>

          {moveOts ? (
            <SubGroup
              title="过肩 OTS"
              hint="越过前景演员的肩膀拍主体：Shoulder 是前景、Target 是主体（在上方构图组里设置）。"
            >
              <Field label="Shoulder（前景演员）">
                <select
                  value={move.shoulderId ?? ""}
                  onChange={(event) =>
                    patchCameraMove(move.id, { shoulderId: event.target.value || undefined })
                  }
                >
                  <option value="">(camera default)</option>
                  {state.objects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Side（左肩 / 右肩）">
                <select
                  value={move.otsSide ?? "R"}
                  onChange={(event) =>
                    patchCameraMove(move.id, { otsSide: (event.target.value || undefined) as OtsSide | undefined })
                  }
                >
                  <option value="">(camera default)</option>
                  {(Object.keys(OTS_SIDE_LABELS) as OtsSide[]).map((value) => (
                    <option key={value} value={value}>
                      {OTS_SIDE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={`Offset ${moveOtsOffset.toFixed(2)}（错位量：0 = 正对，越大主体越靠边）`}
              >
                <input
                  type="range"
                  min={0}
                  max={0.6}
                  step={0.05}
                  value={moveOtsOffset}
                  onChange={(event) =>
                    patchCameraMove(move.id, { otsOffset: Number(event.target.value) })
                  }
                />
              </Field>
            </SubGroup>
          ) : null}

          <SubGroup title="风格 Style">
            <Field label={`Roll ${move.roll ?? 0}°（荷兰角）`}>
              <input
                type="range"
                min={-45}
                max={45}
                step={1}
                value={move.roll ?? 0}
                onChange={(event) => patchCameraMove(move.id, { roll: Number(event.target.value) })}
              />
            </Field>
          </SubGroup>

          {(() => {
            const junction = state.cameraJunctions.find(
              (j) => j.prevMove === move.id || j.nextMove === move.id,
            );
            if (!junction) return null;
            return (
              <div className="field" style={{ marginTop: 8 }}>
                <div className="lab">
                  Move Junction → {junction.prevMove === move.id ? "next" : "prev"} ({junction.id})
                </div>
                <div className="mini-btns">
                  {(["stop", "smooth", "cut"] as HandoffMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`ghost-button ${junction.mode === mode ? "on" : ""}`}
                      onClick={() => setCameraJunctionMode(junction.id, mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <p className="hint">stop = pause then go · smooth = continuous (一镜到底) · cut = allow jump</p>
              </div>
            );
          })()}

          <div className="mini-btns">
            {move.targetId && move.shoulderId && move.targetId !== move.shoulderId ? (
              <button
                type="button"
                className="ghost-button"
                title="基于本段生成正反打：互换前景/主体、翻转肩侧，自动保持同侧轴线"
                onClick={() => addReverseShot(move.id)}
              >
                ＋ 正反打
              </button>
            ) : null}
            <button type="button" className="ghost-button danger-button" onClick={() => deleteCameraMove(move.id)}>
              Delete Move
            </button>
          </div>
        </div>
      ) : null}

      <div className="field">
        <div className="lab">Master Aspect Ratio</div>
        <select
          value={state.aspectRatio}
          onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
        >
          {ASPECT_OPTIONS.map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div className="lab">State Revision</div>
        <div id="rev">{state.revision}</div>
      </div>

      <div className="field">
        <div className="lab">
          Director State JSON
          <button type="button" className="ghost-button" onClick={() => setShowJson((v) => !v)}>
            {showJson ? "Hide" : "Show"}
          </button>
        </div>
        {showJson && <pre id="state">{json}</pre>}
      </div>

      <div className="field">
        <div className="hint">
          Timeline is a view of Director State. Dragging a clip changes the underlying
          Segment/Constraint/CameraMove directly. Play reads the same state.
        </div>
      </div>
    </aside>
  );
}
