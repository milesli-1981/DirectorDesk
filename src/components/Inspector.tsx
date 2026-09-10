import { useMemo, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  ASPECT_OPTIONS,
  AspectRatio,
  CameraFraming,
  CameraMotionType,
  CameraSide,
  CameraStyle,
  CameraView,
  EaseCurve,
  Footprint,
  FormationKind,
  FORMATION_LABELS,
  HandoffMode,
  Pose,
  ActionKind,
  FRAMING_LABELS,
  LENS_OPTIONS,
  MOTION_HINTS,
  MOTION_LABELS,
  STYLE_HINTS,
  STYLE_LABELS,
  objectDisplayName,
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
/** Kind 下拉里自定义动作的取值前缀：下拉值拼接成 `custom:<id>`，便于与内置 kind 区分。 */
const CUSTOM_PREFIX = "custom:";
/** 「＋ 自定义…」哨兵值：选中它不是取值，而是打开编辑弹窗。 */
const NEW_CUSTOM = "__new_custom__";
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
  // 队伍成员作为整体单位，不单独出现在相机 Target 下拉里（只列独立对象与队伍本身）。
  const memberIds = new Set((state.groups ?? []).flatMap((g) => g.members));
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
  const updateGroup = useDirectorStore((s) => s.updateGroup);
  const setGroupCount = useDirectorStore((s) => s.setGroupCount);
  const setGroupFootprint = useDirectorStore((s) => s.setGroupFootprint);
  const setCameraGroup = useDirectorStore((s) => s.setCameraGroup);
  const renameGroup = useDirectorStore((s) => s.renameGroup);
  const removeGroup = useDirectorStore((s) => s.removeGroup);

  const object = selectedKind === "object" ? state.objects.find((o) => o.id === selectedId) : undefined;
  const camera = selectedKind === "camera" ? state.cameras.find((c) => c.id === selectedId) : undefined;
  // 组是对象的一类：选中某个组成员（如团队队首）时，按成员关系找到其所属组，配置在下方展示。
  const group = object ? (state.groups ?? []).find((g) => g.members.includes(object.id)) : undefined;
  // 未选中任何对象 / 相机时，整个 Inspector（标题、占位 “—”、Selected Timeline Item）都不显示。
  const showInspector = !!(object || camera);
  // 组 Block 尺寸：以锚点（members[0]）的 footprint 为代表，改动时统一写回所有成员。
  const groupFootprint = group
    ? state.objects.find((o) => o.id === group.members[0])?.footprint ?? { w: 1, d: 1, h: 1 }
    : undefined;
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
  // 当前片段引用的自定义动作：kind === "custom" 时按 customId 到库里查（悬空则为 undefined）。
  const customAction =
    action && action.kind === "custom"
      ? (state.customActions ?? []).find((item) => item.id === action.customId)
      : undefined;
  const actionObject = action ? state.objects.find((o) => o.id === action.object) : undefined;
  const updateAction = useDirectorStore((s) => s.updateAction);
  const deleteAction = useDirectorStore((s) => s.deleteAction);
  const saveCustomAction = useDirectorStore((s) => s.saveCustomAction);
  // 自定义动作库（命名的关节姿势）：selector 直接取原始引用，避免每次返回新数组触发重渲染。
  const customActions = useDirectorStore((s) => s.state.customActions) ?? [];
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
  // 自定义动作弹窗：新建（空）/ 编辑（带已有记录）。由 Kind 下拉的「自定义」选项驱动。
  const [customize, setCustomize] = useState<{ mode: "create" } | { mode: "edit"; id: string } | null>(
    null,
  );

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

  // 用显示名（改名后即时联动），未命名的资产回退到 id。
  const title = camera
    ? camera.name
    : group
      ? `👥 ${group.name}`
      : object
        ? objectDisplayName(object)
        : "—";

  return (
    <aside className="right">
      {/* 场景级设置：始终显示，不依赖是否选中对象 */}
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

      {showInspector ? (
        <>
          <div className="st">INSPECTOR</div>
          <div className="title">{title}</div>
          {camera && <div className="sub">Camera Intent</div>}
          {group && <div className="sub">Group Dynamics（对象 / 团队）</div>}

          <div className="field">
            <div className="lab">Selected Timeline Item</div>
        <div id="itemInfo">
          {selectedItem ?? "—"}
          {segment ? ` · ${pointCount} path point${pointCount === 1 ? "" : "s"}` : ""}
          {selectedPointShape ? ` · ${selectedPointShape}` : ""}
        </div>
      </div>

      {group ? (
        <div className="field">
          <div className="lab">Group — {group.members.length} 人</div>
          <div className="row2">
            <label>名称</label>
            <input
              type="text"
              value={group.name}
              onChange={(event) => renameGroup(group.id, event.target.value)}
            />
          </div>
          <div className="row2">
            <label>人数</label>
            <div className="grp-count" style={{ border: "none", padding: 0 }}>
              <button
                type="button"
                className="grp-btn"
                disabled={group.members.length <= 1}
                title="减少一名尾随队员"
                onClick={() => setGroupCount(group.id, group.members.length - 1)}
              >
                −
              </button>
              <span className="grp-count-num">{group.members.length}</span>
              <button
                type="button"
                className="grp-btn"
                disabled={group.members.length >= 24}
                title="增加一名尾随队员"
                onClick={() => setGroupCount(group.id, group.members.length + 1)}
              >
                ＋
              </button>
            </div>
          </div>
          {groupFootprint && (
            <div className="grp-block">
              <div className="lab">Block 尺寸（全体队员统一）</div>
              <div className="grp-slider">
                <span>宽 W {groupFootprint.w.toFixed(1)}</span>
                <input
                  type="range"
                  min={0.4}
                  max={5}
                  step={0.1}
                  value={groupFootprint.w}
                  onChange={(event) => setGroupFootprint(group.id, { w: Number(event.target.value) })}
                />
              </div>
              <div className="grp-slider">
                <span>深 D {groupFootprint.d.toFixed(1)}</span>
                <input
                  type="range"
                  min={0.4}
                  max={5}
                  step={0.1}
                  value={groupFootprint.d}
                  onChange={(event) => setGroupFootprint(group.id, { d: Number(event.target.value) })}
                />
              </div>
              <div className="grp-slider">
                <span>高 H {groupFootprint.h.toFixed(1)}</span>
                <input
                  type="range"
                  min={0.4}
                  max={5}
                  step={0.1}
                  value={groupFootprint.h}
                  onChange={(event) => setGroupFootprint(group.id, { h: Number(event.target.value) })}
                />
              </div>
            </div>
          )}
          <button
            type="button"
            className="grp-btn wide"
            disabled={!activeCameraId}
            title={activeCameraId ? `让 ${activeCameraId} 以 GROUP 取景本组` : "先选中一台相机"}
            onClick={() => activeCameraId && setCameraGroup(activeCameraId, group.id)}
          >
            相机取景（{activeCameraId ?? "未选相机"}）
          </button>
          <label className="grp-toggle">
            <input
              type="checkbox"
              checked={group.dynamics}
              onChange={(event) => updateGroup(group.id, { dynamics: event.target.checked })}
            />
            引力场
          </label>
          <div className="grp-slider">
            <span>编队</span>
            <select
              className="grp-select"
              value={group.formation ?? "column"}
              onChange={(event) => updateGroup(group.id, { formation: event.target.value as FormationKind })}
            >
              {(Object.keys(FORMATION_LABELS) as FormationKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {FORMATION_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>
          <div className="grp-slider">
            <span>间距 {(group.spacing ?? 1.2).toFixed(1)}m</span>
            <input
              type="range"
              min={0.4}
              max={4}
              step={0.1}
              value={group.spacing ?? 1.2}
              onChange={(event) => updateGroup(group.id, { spacing: Number(event.target.value) })}
            />
          </div>
          <div className="grp-slider">
            <span>微扰 {(group.noise ?? 0.35).toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={group.noise ?? 0.35}
              onChange={(event) => updateGroup(group.id, { noise: Number(event.target.value) })}
            />
          </div>
          <p className="hint">
            ⚓ 首位成员是<b>锚点</b>：它的路径就是整队的唯一路线，其余队员按编队跟随。
            匀速时保持编队，加速 / 减速 / 变线时出现弹簧拉扯后复原。
          </p>
          <button type="button" className="obj-del wide" title="删除组" onClick={() => removeGroup(group.id)}>
            删除组
          </button>
        </div>
      ) : null}

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
              // 选「＋ 自定义…」只是开弹窗、并不真的改 kind。弹窗开关时换 key 让下拉重挂载，
              // 否则它会停在哨兵项上、显示的与真实 kind 不一致（尤其取消之后）。
              key={
                customize
                  ? "customizing"
                  : action.kind === "custom"
                    ? `custom:${action.customId ?? ""}`
                    : action.kind
              }
              value={action.kind === "custom" ? `custom:${action.customId ?? ""}` : action.kind}
              onChange={(event) => {
                const value = event.target.value;
                // 「＋ 自定义…」：不当作取值，而是打开弹窗编辑并命名保存。
                if (value === NEW_CUSTOM) {
                  setCustomize({ mode: "create" });
                  return;
                }
                if (value.startsWith(CUSTOM_PREFIX)) {
                  updateAction(action.id, {
                    kind: "custom",
                    customId: value.slice(CUSTOM_PREFIX.length) || undefined,
                  });
                  return;
                }
                updateAction(action.id, { kind: value as ActionKind, customId: undefined });
              }}
            >
              {ACTION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
              {customActions.map((preset) => (
                <option key={preset.id} value={`${CUSTOM_PREFIX}${preset.id}`}>
                  {preset.name}
                </option>
              ))}
              <option value={NEW_CUSTOM}>＋ 自定义…</option>
            </select>
          </Field>
          {action.kind === "custom" && customAction ? (
            <div className="row2">
              <label>自定义</label>
              <button
                type="button"
                className="ghost-button"
                title="重新编辑这条自定义动作的关节角"
                onClick={() => setCustomize({ mode: "edit", id: customAction.id })}
              >
                编辑「{customAction.name}」
              </button>
            </div>
          ) : null}
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
          {/* 自定义动作统一走 Kind 下拉：选「＋ 自定义…」在弹窗里编辑 → 命名 → 入库持久化。
              不再把关节编辑区直接铺在面板里（避免与库的版本脱节、也避免产生无名脏数据）。 */}
          {customize && action ? (
            <PoseCustomizeModal
              mode={customize.mode}
              joints={
                customize.mode === "edit"
                  ? customActions.find((item) => item.id === customize.id)?.joints ?? {}
                  : {}
              }
              initialName={
                customize.mode === "edit"
                  ? customActions.find((item) => item.id === customize.id)?.name ?? ""
                  : ""
              }
              onSave={(name, joints) => {
                const id = saveCustomAction(
                  name,
                  joints,
                  customize.mode === "edit" ? customize.id : undefined,
                );
                updateAction(action.id, { kind: "custom", customId: id, pose: undefined });
                setCustomize(null);
              }}
              onClose={() => setCustomize(null)}
            />
          ) : null}

          <p className="hint">
            MOVE 决定「去哪里」，动作只决定「身体怎么动」：walk / run 选择步态（不选时按速度自动判定，低速走、高速跑），
            sit / crouch 会停止腿部摆动。在时间轴该演员的「动作」行点 ＋A 新增片段，拖动 clip 改时间、拖边缘修剪时长。
            需要自创姿势时在 Kind 里选「＋ 自定义…」：在弹窗中调关节角 → 命名 → 保存进**自定义动作库**（随场景持久化），
            之后任意演员都能按名称直接复用，改库即改所有引用它的片段。
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
              <Field label="Target（跟随对象 / 队伍）">
                <select
                  value={camera.targetId}
                  onChange={(event) => {
                    const id = event.target.value;
                    const grp = state.groups?.find((g) => g.id === id);
                    if (grp) {
                      // 选中的是队伍：与对象同等地位，自动按 GROUP 取景并框住全队。
                      updateCamera(camera.id, {
                        targetId: id,
                        targetType: "GROUP",
                        groupId: id,
                      });
                    } else {
                      updateCamera(camera.id, {
                        targetId: id,
                        targetType: "OBJECT",
                        groupId: undefined,
                      });
                    }
                  }}
                >
                  <option value="">— 无 —</option>
                  {state.objects
                    .filter((item) => !memberIds.has(item.id))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {objectDisplayName(item)}
                      </option>
                    ))}
                  {(state.groups ?? []).map((grp) => (
                    <option key={grp.id} value={grp.id}>
                      👥 {grp.name}
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
              <Field label={`Altitude ${camera.altitude ?? 0}m（基准高度）`}>
                <input
                  type="range"
                  min={0}
                  max={30}
                  step={1}
                  value={camera.altitude ?? 0}
                  onChange={(event) => updateCamera(camera.id, { altitude: Number(event.target.value) })}
                />
              </Field>
              {camera.motion === "PAN" ? (
                <Field label={`Pan ${camera.panDeg ?? 0}°（原地水平摇）`}>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={5}
                    value={camera.panDeg ?? 0}
                    onChange={(event) => updateCamera(camera.id, { panDeg: Number(event.target.value) })}
                  />
                </Field>
              ) : null}
              {camera.motion === "TILT" ? (
                <Field label={`Tilt ${camera.tiltDeg ?? 0}°（原地俯仰）`}>
                  <input
                    type="range"
                    min={-60}
                    max={60}
                    step={5}
                    value={camera.tiltDeg ?? 0}
                    onChange={(event) => updateCamera(camera.id, { tiltDeg: Number(event.target.value) })}
                  />
                </Field>
              ) : null}
              {camera.motion === "TRUCK" ? (
                <Field label={`Truck ${camera.truckDist ?? 0}m（横向平移）`}>
                  <input
                    type="range"
                    min={-20}
                    max={20}
                    step={1}
                    value={camera.truckDist ?? 0}
                    onChange={(event) => updateCamera(camera.id, { truckDist: Number(event.target.value) })}
                  />
                </Field>
              ) : null}
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
              {camera.kind === "drone" ? (
                <>
                  <Field label="Style 稳定方式">
                    <select value="drone" disabled>
                      <option value="drone">Drone 增稳（云台）</option>
                    </select>
                  </Field>
                  <p className="hint">无人机机位自带云台增稳，风格固定为「Drone 增稳」，无需选择。</p>
                </>
              ) : (
                <>
                  <Field label="Style 稳定方式">
                    <select
                      value={camera.style ?? "locked"}
                      onChange={(event) =>
                        updateCamera(camera.id, { style: event.target.value as CameraStyle })
                      }
                    >
                      {(["locked", "gimbal", "handheld", "vlog"] as CameraStyle[]).map((value) => (
                        <option key={value} value={value}>
                          {STYLE_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="hint">{STYLE_HINTS[camera.style ?? "locked"]}</p>
                </>
              )}
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
            <Field label="Style 稳定方式（覆盖）">
              <select
                value={moveCamera?.kind === "drone" ? "locked" : move.style ?? "locked"}
                disabled={moveCamera?.kind === "drone"}
                onChange={(event) =>
                  patchCameraMove(move.id, { style: event.target.value as CameraStyle })
                }
              >
                {(["locked", "gimbal", "handheld", "vlog"] as CameraStyle[]).map((value) => (
                  <option key={value} value={value}>
                    {STYLE_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
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
      </>
      ) : null}
    </aside>
  );
}
