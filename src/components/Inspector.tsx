import { useMemo, useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  AnimalSpecies,
  CameraFraming,
  CameraMotionType,
  CameraSide,
  CameraKey,
  CameraStyle,
  CameraView,
  EaseCurve,
  Footprint,
  FormationKind,
  FORMATION_LABELS,
  HandoffMode,
  Pose,
  SpeedKey,
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
import { ANIMAL_MODELS, ANIMAL_SPECIES } from "../engine/animalModels";
import { EaseEditor } from "./EaseEditor";
import { PoseCustomizeModal } from "./PoseCustomizeModal";
import { clonePose, POSE_PRESETS, POSE_PRESET_NAMES } from "../engine/poses";
import { moveChannelsAt, solveCamera } from "../engine/cameraSolver";
import { CAMERA_CHANNELS, CameraChannel } from "../engine/ease";
import { axisSide, cameraAxis } from "../engine/axis";
import { waypointKeyframes } from "../engine/path";
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

/**
 * 关键帧通道定义（单一来源）：中文标签 + 取值范围/步进 + 分组 + 语义说明。
 * hint 会作为悬停提示显示，确保「数值 = 什么」与代码行为一致。
 */
const KEY_CHANNEL_META: Record<
  CameraChannel,
  { label: string; step: number; min: number; max: number; group: "motion" | "lens"; hint: string }
> = {
  orbitDeg: {
    label: "环绕 °",
    step: 5,
    min: -720,
    max: 720,
    group: "motion",
    hint: "机位绕目标旋转的角度（范围 ±720°，即正反各两圈）。0 = 该机位的默认方位（由 Side 决定）；正值沿「正前 → 侧面 → 正后」方向绕行，360° 为一整圈。只改绕行角度，机位到目标的距离不变。",
  },
  craneHeight: {
    label: "升降 m",
    step: 0.5,
    min: -10,
    max: 20,
    group: "motion",
    hint: "相对该 View 默认高度的垂直位移（米）。0 = 默认眼高；正值升高、负值降低。直接改机位高度，不改水平位置。",
  },
  dollyScale: {
    label: "推拉 ×",
    step: 0.05,
    min: 0.3,
    max: 3,
    group: "motion",
    hint: "取景距离倍数（基准 = 由景别 Framing 决定的距离）。1.0 = 基准；>1 拉远（主体变小、纳入更多环境）；<1 推近（主体变大）。改变的是距离，不是焦距。",
  },
  panDeg: {
    label: "摇摄 °",
    step: 5,
    min: -180,
    max: 180,
    group: "motion",
    hint: "机位不动，只把「注视方向」绕垂直轴左右旋转（度）。0 = 注视 Target；正值与「环绕」同旋向（方位角增加）。",
  },
  tiltDeg: {
    label: "俯仰 °",
    step: 5,
    min: -90,
    max: 90,
    group: "motion",
    hint: "机位不动，只把「注视方向」上下俯仰（度）。0 = 注视 Target；正值抬头、负值低头。不改变视线长度（距离不变）。",
  },
  truckDist: {
    label: "横移 m",
    step: 0.5,
    min: -15,
    max: 15,
    group: "motion",
    hint: "机位与注视点一起沿「垂直于视线」的方向平行横移（米），朝向保持不变（= 轨道横移）。正值移向画面一侧、负值反向。",
  },
  lensMm: {
    label: "焦距 mm",
    step: 1,
    min: 8,
    max: 200,
    group: "lens",
    hint: "该帧的镜头焦距（毫米）。改变视场角与透视：长焦压缩背景、广角扩张环境。不改变机位到目标的距离（距离用「推拉 ×」）。",
  },
  roll: {
    label: "荷兰角 °",
    step: 1,
    min: -360,
    max: 360,
    group: "lens",
    hint: "画面的滚转 / 荷兰角（度，范围 ±360°），正值顺时针倾斜。机位与注视方向不变。",
  },
  otsOffset: {
    label: "过肩偏",
    step: 0.05,
    min: 0,
    max: 0.8,
    group: "lens",
    hint: "仅「过肩 OTS」段有效：主体被推离画面中心的比例（以画面半宽为单位）。0 = 主体居中；越大主体越靠边、前景肩膀越占画面。非过肩段无效。",
  },
};

const MOTION_TYPES: CameraMotionType[] = [
  "STATIC",
  "FOLLOW",
  "ORBIT",
  "DOLLY",
  "DOLLY_ZOOM",
  "CRANE",
  "DRONE",
  "PATH",
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
 * 与 Field 同一套栅格外观，但用 div 承载：内部是按钮 / 自定义控件时用这个。
 * 若仍用 <label>，点击行标签文字会把点击派发给行内第一个可标注控件（按钮），
 * 造成「点一下『人数』就减员」这类误触发。
 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="inspector-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** 数值步进器：−  数值  ＋，用于「人数」这类小整数。外观沿用 ghost-button。 */
function Stepper({
  value,
  min,
  max,
  onChange,
  stepDownTitle,
  stepUpTitle,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  stepDownTitle: string;
  stepUpTitle: string;
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="ghost-button"
        disabled={value <= min}
        title={stepDownTitle}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="stepper-num">{value}</span>
      <button
        type="button"
        className="ghost-button"
        disabled={value >= max}
        title={stepUpTitle}
        onClick={() => onChange(value + 1)}
      >
        ＋
      </button>
    </div>
  );
}

/**
 * 宽 / 深 / 高 单行控件：固定量程滑杆 + 可直接输入的数字框。
 * 量程由调用方固定给定，不再随当前值自适应——否则拖动时刻度会翻倍、数值跳变。
 * 需要精确值（如 1.8m）时直接在右侧数字框输入，失焦或回车生效并夹到合法区间。
 */
function DimRow({
  label,
  title,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  // 编辑期间用本地文本接管，避免每敲一个字符就被 clamp / 格式化打断输入。
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    setDraft(null);
  };
  return (
    <div className="dim-row" title={title}>
      <span className="dim-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={value}
        onChange={(event) => {
          setDraft(null);
          onChange(Number(event.target.value));
        }}
      />
      <input
        className="dim-num"
        type="number"
        min={min}
        max={max}
        step={0.1}
        value={draft ?? value.toFixed(1)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(null);
        }}
      />
    </div>
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
  const currentTime = useDirectorStore((s) => s.currentTime);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const viewMode = useDirectorStore((s) => s.viewMode);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const setViewMode = useDirectorStore((s) => s.setViewMode);
  const setActiveCamera = useDirectorStore((s) => s.setActiveCamera);
  const updateCamera = useDirectorStore((s) => s.updateCamera);
  const addCameraMove = useDirectorStore((s) => s.addCameraMove);
  const patchCameraMove = useDirectorStore((s) => s.patchCameraMove);
  const deleteCameraMove = useDirectorStore((s) => s.deleteCameraMove);
  const addCameraKey = useDirectorStore((s) => s.addCameraKey);
  const updateCameraKey = useDirectorStore((s) => s.updateCameraKey);
  const addCameraPathPoint = useDirectorStore((s) => s.addCameraPathPoint);
  const deleteCameraKey = useDirectorStore((s) => s.deleteCameraKey);
  const clearCameraKeys = useDirectorStore((s) => s.clearCameraKeys);
  const addReverseShot = useDirectorStore((s) => s.addReverseShot);
  const removeCamera = useDirectorStore((s) => s.removeCamera);
  const setSegmentEase = useDirectorStore((s) => s.setSegmentEase);
  const setCameraMoveEase = useDirectorStore((s) => s.setCameraMoveEase);
  const setSegmentSpeedKeys = useDirectorStore((s) => s.setSegmentSpeedKeys);
  const setCameraMoveSpeedKeys = useDirectorStore((s) => s.setCameraMoveSpeedKeys);
  const setHandoffMode = useDirectorStore((s) => s.setHandoffMode);
  const setCameraJunctionMode = useDirectorStore((s) => s.setCameraJunctionMode);
  const deleteSegment = useDirectorStore((s) => s.deleteSegment);
  const updateAsset = useDirectorStore((s) => s.updateAsset);
  const removeAsset = useDirectorStore((s) => s.removeAsset);
  const updateGroup = useDirectorStore((s) => s.updateGroup);
  const setGroupCount = useDirectorStore((s) => s.setGroupCount);
  const setGroupFootprint = useDirectorStore((s) => s.setGroupFootprint);
  const setGroupPose = useDirectorStore((s) => s.setGroupPose);

  const renameGroup = useDirectorStore((s) => s.renameGroup);
  const removeGroup = useDirectorStore((s) => s.removeGroup);

  const object = selectedKind === "object" ? state.objects.find((o) => o.id === selectedId) : undefined;
  const camera = selectedKind === "camera" ? state.cameras.find((c) => c.id === selectedId) : undefined;
  // 组是对象的一类：选中某个组成员（如团队队首）时，按成员关系找到其所属组，配置在下方展示。
  const group = object ? (state.groups ?? []).find((g) => g.members.includes(object.id)) : undefined;
  // 真正接管位置的「团队」：只有它才把整队作为唯一编辑单位。
  // 纯取景分组（dynamics=false）不接管成员位置，成员仍是独立资产，要保留单资产入口。
  const team = group && group.dynamics && group.members.length >= 2 ? group : undefined;
  // 未选中任何对象 / 相机时，整个 Inspector（标题、占位 "—"）都不显示。
  // 注：下方时间轴片段选中态会重新放开 showInspector。
  // 组 Block 尺寸：以锚点（members[0]）的 footprint 为代表，改动时统一写回所有成员。
  const groupFootprint = group
    ? state.objects.find((o) => o.id === group.members[0])?.footprint ?? { w: 1, d: 1, h: 1 }
    : undefined;
  // 组静态基线姿势：与 Block 尺寸同理，以锚点（members[0]）为代表展示，改动统一写回所有成员。
  const groupAnchor = group ? state.objects.find((o) => o.id === group.members[0]) : undefined;
  const groupPose = groupAnchor?.pose;
  const groupIsHuman = groupAnchor?.category === "human";
  const segment = state.segments.find((item) => item.id === selectedItem);
  // 路径转折点在该片段上的抵达时刻：交给 EaseEditor 画在迷你时间轴上，便于和关键点对照。
  // 用 useMemo 缓存 —— 弧长积分不便宜，而这段代码所在的重渲染远多于片段数据变更。
  const segmentWaypoints = useMemo(() => (segment ? waypointKeyframes(segment) : []), [segment]);
  const constraint = state.constraints.find((item) => item.id === selectedItem);
  const move = state.cameraMoves.find((item) => item.id === selectedItem);
  const moveCamera = move ? state.cameras.find((c) => c.id === move.camera) : undefined;
  // 过肩需要至少 2 名演员（前景 + 主体）；不足时 OTS 选项禁用，新增演员后自动解封。
  const actors = state.objects.filter((o) => o.type === "actor");
  const canOts = actors.length >= 2;
  // 段级未设置时沿用相机级错位量，滑块显示的就是实际生效值。
  const moveOtsOffset = move?.otsOffset ?? moveCamera?.otsOffset ?? 0.35;
  // 过肩相关控件只在「可能是过肩」时展开：类型为 OTS，或已指定前景演员。
  const cameraOts = !!camera && camera.targetType === "OTS";
  const moveOts = !!move && move.targetType === "OTS";
  const action = state.actions?.find((item) => item.id === selectedItem);
  // 互斥选择下，时间轴片段（segment / move / constraint / action）也是合法的 Inspector 主体，
  // 选中它们时对象轴已清空，故这里也要放行，否则片段编辑 UI（ease / handoff / joints 等）打不开。
  const showInspector = !!(object || camera || segment || constraint || move || action);
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
    ? (["framing", "view", "side", "lensMm", "roll", "shoulderId", "otsOffset", "stabilize"] as const).filter((key) =>
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

  // 自定义动作弹窗：新建（空）/ 编辑（带已有记录）。由 Kind 下拉的「自定义」选项驱动。
  const [customize, setCustomize] = useState<{ mode: "create" } | { mode: "edit"; id: string } | null>(
    null,
  );
  // 关键帧选中态（与时间轴共享）。
  const selectedKeyId = useDirectorStore((s) => s.selectedKeyId);
  const selectCameraKey = useDirectorStore((s) => s.selectCameraKey);

  const pointCount = segment ? segment.points.length : 0;
  const selectedPointShape = segment?.points.find((point) => point.id === selectedPoint)?.shape;

  const easeTarget = segment
    ? {
        title: segment.id,
        ease: segment.ease,
        keys: segment.speedKeys ?? null,
        waypoints: segmentWaypoints,
        timeStart: segment.timeStart,
        timeEnd: segment.timeEnd,
        onChange: (ease: EaseCurve) => setSegmentEase(segment.id, ease),
        onKeysChange: (keys: SpeedKey[] | null) => setSegmentSpeedKeys(segment.id, keys),
      }
    : move
      ? {
          title: move.id,
          ease: move.ease,
          keys: move.speedKeys ?? null,
          // 相机 move 没有路径转折点（转向由 framing / style 表达），给空集保持两分支形状一致。
          waypoints: [],
          timeStart: move.timeStart,
          timeEnd: move.timeEnd,
          onChange: (ease: EaseCurve) => setCameraMoveEase(move.id, ease),
          onKeysChange: (keys: SpeedKey[] | null) => setCameraMoveSpeedKeys(move.id, keys),
        }
      : null;

  // 用显示名（改名后即时联动），未命名的资产回退到 id。
  const title = camera
    ? camera.name
    : group
      ? `👥 ${group.name}`
      : object
        ? objectDisplayName(object)
        : segment
          ? segment.id
          : constraint
            ? constraint.id
            : move
              ? move.id
              : action
                ? action.id
                : "—";

  return (
    <aside className="right">
      {showInspector ? (
        <>
          <div className="insp-head">
            <span className="insp-eyebrow">INSPECTOR</span>
            <span className="title">{title}</span>
            <span id="itemInfo" className="item-info">
              {segment
                ? `${pointCount} path point${pointCount === 1 ? "" : "s"}${selectedPointShape ? ` · ${selectedPointShape}` : ""}`
                : ""}
            </span>
          </div>
          {camera && <div className="sub">Camera Intent</div>}
          {group && <div className="sub">Group Dynamics（对象 / 团队）</div>}
          {segment && <div className="sub">Camera Path</div>}
          {move && <div className="sub">Camera Move</div>}
          {constraint && <div className="sub">Constraint</div>}
          {action && <div className="sub">Action</div>}

      {group ? (
        <div className="field">
          <div className="lab">Group — {group.members.length} 人</div>
          <SubGroup title="团队 Team">
            <Field label="名称">
              <input
                type="text"
                value={group.name}
                onChange={(event) => renameGroup(group.id, event.target.value)}
              />
            </Field>
            <Row label="人数">
              <Stepper
                value={group.members.length}
                min={1}
                max={24}
                stepDownTitle="减少一名尾随队员"
                stepUpTitle="增加一名尾随队员"
                onChange={(v) => setGroupCount(group.id, v)}
              />
            </Row>
          </SubGroup>
          <SubGroup
            title="编队 Formation"
            hint="⚓ 首位成员是锚点：它的路径就是整队的唯一路线，其余队员按编队跟随。匀速时保持编队，加速 / 减速 / 变线时出现弹簧拉扯后复原。"
          >
            <Field label="编队">
              <select
                value={group.formation ?? "column"}
                onChange={(event) => updateGroup(group.id, { formation: event.target.value as FormationKind })}
              >
                {(Object.keys(FORMATION_LABELS) as FormationKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {FORMATION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`间距 ${(group.spacing ?? 1.2).toFixed(1)}m`}>
              <input
                type="range"
                min={0.4}
                max={4}
                step={0.1}
                value={group.spacing ?? 1.2}
                onChange={(event) => updateGroup(group.id, { spacing: Number(event.target.value) })}
              />
            </Field>
            <Field label={`微扰 ${(group.noise ?? 0.35).toFixed(2)}`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={group.noise ?? 0.35}
                onChange={(event) => updateGroup(group.id, { noise: Number(event.target.value) })}
              />
            </Field>
          </SubGroup>
          {groupFootprint && (
            <SubGroup title="Block 尺寸（m）" hint="全体队员统一。">
              {(
                [
                  { key: "w", label: "W", title: "Width 宽" },
                  { key: "d", label: "D", title: "Depth 深" },
                  { key: "h", label: "H", title: "Height 高" },
                ] as const
              ).map((dim) => (
                <DimRow
                  key={dim.key}
                  label={dim.label}
                  title={dim.title}
                  value={groupFootprint[dim.key]}
                  min={0.4}
                  max={5}
                  onChange={(v) =>
                    setGroupFootprint(
                      group.id,
                      dim.key === "w" ? { w: v } : dim.key === "d" ? { d: v } : { h: v },
                    )
                  }
                />
              ))}
            </SubGroup>
          )}
          {groupIsHuman && (
            <SubGroup title="Pose（全体队员统一）">
              <div className="mini-btns">
                {STATIC_POSE_NAMES.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`ghost-button ${poseEquals(groupPose, POSE_PRESETS[name]) ? "on" : ""}`}
                    onClick={() => setGroupPose(group.id, clonePose(POSE_PRESETS[name]))}
                  >
                    {name}
                  </button>
                ))}
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setGroupPose(group.id, { joints: {} })}
                >
                  reset
                </button>
              </div>
            </SubGroup>
          )}
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              title="删除组"
              onClick={() => removeGroup(group.id)}
            >
              删除组
            </button>
          </div>
        </div>
      ) : null}

      {/* 属于某个团队时不再显示「单个资产」面板：整队是唯一的编辑单位，配置都在上方
          Group Dynamics 里；两套面板并存会出现互相打架的入口（尺寸 / Pose 都重复）。 */}
      {object && !team ? (
        <div className="field">
          <div className="lab">Asset — {object.category}</div>
          <SubGroup title="资产 Asset">
            <Field label="Role">
              <select
                value={object.role}
                onChange={(event) => updateAsset(object.id, { role: event.target.value as "agent" | "set" })}
              >
                <option value="agent">agent（可运动 / 可作目标）</option>
                <option value="set">set（环境 / 遮挡体）</option>
              </select>
            </Field>
            {object.category === "animal" ? (
              <Field label="Species 物种">
                <select
                  value={object.species ?? ""}
                  onChange={(event) => {
                    const sp = event.target.value as AnimalSpecies;
                    const am = ANIMAL_MODELS[sp];
                    updateAsset(object.id, {
                      species: sp,
                      footprint: { ...am.footprint },
                      color: am.color,
                    });
                  }}
                >
                  {ANIMAL_SPECIES.map((sp) => (
                    <option key={sp} value={sp}>
                      {ANIMAL_MODELS[sp].label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {/* Rotation 只对环境（set）有意义：agent / human 的朝向由运动方向或 LOOK_AT 决定，
                组成员更是由整队大方向统一给出，单独设它会被求解器覆盖，故不再提供。 */}
            {object.role === "set" ? (
              <Field label={`Rotation ${object.rotation}°`}>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={object.rotation}
                  onChange={(event) => updateAsset(object.id, { rotation: Number(event.target.value) })}
                />
              </Field>
            ) : null}
            <Row label="Lock">
              <LockBadge
                locked={!!object.locked}
                title={
                  object.locked
                    ? "已锁定初始位置：编辑时不可拖拽（点此解锁）；播放时仍按轨迹移动"
                    : "锁定初始位置：编辑时不可拖拽，播放时仍按轨迹移动"
                }
                onClick={() => updateAsset(object.id, { locked: !object.locked })}
              />
            </Row>
          </SubGroup>
          {/* W / D / H：固定量程滑杆（0.1–24m）+ 数字框。
              量程不再随当前值自适应，否则拖动时刻度翻倍会导致数值跳变；精确值直接输入。 */}
          <SubGroup
            title="Block 尺寸（m）"
            hint="固定量程滑杆（0.1–24m）+ 数字框：需要精确值时直接在右侧数字框输入。"
          >
            {(
              [
                { key: "w", label: "W", title: "Width 宽" },
                { key: "d", label: "D", title: "Depth 深" },
                { key: "h", label: "H", title: "Height 高" },
              ] as const
            ).map((dim) => (
              <DimRow
                key={dim.key}
                label={dim.label}
                title={dim.title}
                value={object.footprint[dim.key]}
                min={0.1}
                max={24}
                onChange={(v) =>
                  updateAsset(object.id, {
                    footprint: { ...object.footprint, [dim.key]: v },
                  })
                }
              />
            ))}
          </SubGroup>
          {object.category === "human" ? (
            <SubGroup
              title="Pose（静态基线姿势）"
              hint="这里只设人物的静态基线姿势；关节微调请在选中某个动作片段后，于「Action」面板的 Joints 区调整。"
            >
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
            </SubGroup>
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
            <Row label="自定义">
              <button
                type="button"
                className="ghost-button"
                title="重新编辑这条自定义动作的关节角"
                onClick={() => setCustomize({ mode: "edit", id: customAction.id })}
              >
                编辑「{customAction.name}」
              </button>
            </Row>
          ) : null}
          <Row label="Time">
            <span className="val">
              {action.timeStart}s – {action.timeEnd}s
            </span>
          </Row>
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
        <div className="lab">缓动曲线 · cubic-bezier</div>
        {easeTarget ? (
          <EaseEditor
            title={easeTarget.title}
            ease={easeTarget.ease}
            keys={easeTarget.keys}
            timeStart={easeTarget.timeStart}
            timeEnd={easeTarget.timeEnd}
            onChange={easeTarget.onChange}
            onKeysChange={easeTarget.onKeysChange}
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
            <SubGroup
              title="构图 Composition"
              hint={
                cameraOts
                  ? "过肩镜头下，机位角度 / 距离 / 眼高由过肩几何固定，仅 Target 与 Lens 生效；侧面关系由下方「过肩 OTS」决定。"
                  : "拍谁、多近、从哪个角度。"
              }
            >
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
                        targetType: cameraOts ? "OTS" : "GROUP",
                        groupId: id,
                      });
                    } else {
                      updateCamera(camera.id, {
                        targetId: id,
                        targetType: cameraOts ? "OTS" : "OBJECT",
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
              {cameraOts ? null : (
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
              )}
              {cameraOts ? null : (
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
              )}
              {cameraOts ? null : (
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
              )}
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
              {!cameraOts && camera.motion === "PAN" ? (
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
              {!cameraOts && camera.motion === "TILT" ? (
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
              {!cameraOts && camera.motion === "TRUCK" ? (
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
                {cameraOts && !canOts ? (
                  <p className="hint" style={{ color: "#ffb86b" }}>
                    ⚠ 过肩需要至少 2 名演员（前景 + 主体）；当前不足，过肩不生效，请先加入另一个演员。
                  </p>
                ) : cameraOts && (!camera.shoulderId || camera.shoulderId === camera.targetId) ? (
                  <p className="hint" style={{ color: "#ffb86b" }}>
                    ⚠ 需设置与主体（Target）不同的前景演员（Shoulder），否则过肩不生效、Side（左/右肩）无效。
                  </p>
                ) : null}
                <Field label="前景演员（Shoulder）">
                  <select
                    value={camera.shoulderId ?? ""}
                    disabled={!canOts}
                    onChange={(event) =>
                      updateCamera(camera.id, { shoulderId: event.target.value || undefined })
                    }
                  >
                    <option value="">{canOts ? "(自动)" : "(需至少 2 名演员)"}</option>
                    {actors.filter((item) => item.id !== camera.targetId).map((item) => (
                      <option key={item.id} value={item.id}>
                        {objectDisplayName(item)}
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
                  value={cameraOts ? "OTS" : camera.motion}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "OTS") {
                      updateCamera(camera.id, {
                        targetType: "OTS",
                        shoulderId:
                          camera.shoulderId ??
                          state.objects.find((o) => o.type === "actor" && o.id !== camera.targetId)?.id,
                      });
                    } else {
                      const grp = state.groups?.find((g) => g.id === camera.targetId);
                      updateCamera(camera.id, {
                        motion: value as CameraMotionType,
                        targetType: grp ? "GROUP" : "OBJECT",
                      });
                    }
                  }}
                >
                  {MOTION_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {MOTION_LABELS[value]}
                    </option>
                  ))}
                  <option value="OTS" disabled={!canOts}>
                    过肩 OTS{canOts ? "" : "（需 ≥2 名演员）"}
                  </option>
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
              <Field label={`防抖 Stabilization ${Math.round((camera.stabilize ?? 0) * 100)}%`}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={camera.stabilize ?? 0}
                  onChange={(event) =>
                    updateCamera(camera.id, { stabilize: Number(event.target.value) })
                  }
                />
              </Field>
              <p className="hint">
                跟随阻尼：相机对目标瞬变（转向 / 绕障让位 / 扭动）的响应滞后一点；瞬变若很快消失则被忽略。0 = 完全跟手，越大越「拖」。可在单个运镜段覆盖。
              </p>
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
            <p className="hint">{cameraOts ? "过肩：镜头越过前景演员的肩膀拍摄主体；在下方「过肩 OTS」组里设置前景演员与肩侧。" : MOTION_HINTS[camera.motion]}</p>
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
                value={moveOts ? "OTS" : move.type}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "OTS") {
                    patchCameraMove(move.id, {
                      targetType: "OTS",
                      shoulderId:
                        move.shoulderId ??
                        moveCamera?.shoulderId ??
                        state.objects.find(
                          (o) => o.type === "actor" && o.id !== (move.targetId ?? moveCamera?.targetId),
                        )?.id,
                    });
                  } else {
                    patchCameraMove(move.id, { type: value as CameraMotionType, targetType: undefined });
                  }
                }}
              >
                {MOTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {MOTION_LABELS[value]}
                  </option>
                ))}
                <option value="OTS" disabled={!canOts}>
                  过肩 OTS{canOts ? "" : "（需 ≥2 名演员）"}
                </option>
              </select>
            </Field>

            {!moveOts && move.type === "PATH" ? (
              <div className="path-editor">
                <Row label={`路径点 ${move.pathPoints?.length ?? 0}`}>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => {
                      const pts = move.pathPoints ?? [];
                      const cam = state.cameras.find((c) => c.id === move.camera);
                      const t = state.objects.find((o) => o.id === (move.targetId ?? cam?.targetId));
                      const last = pts[pts.length - 1];
                      const prev = pts[pts.length - 2];
                      if (last && prev) {
                        // 沿最后一段方向继续延伸 3m：避免新点固定堆在终点上（旧实现恒为 (bx-4,·,bz+3)，正好压住 P2）。
                        const dx = last.x - prev.x;
                        const dz = last.z - prev.z;
                        const len = Math.hypot(dx, dz) || 1;
                        addCameraPathPoint(move.id, last.x + (dx / len) * 3, last.y, last.z + (dz / len) * 3);
                      } else if (last) {
                        addCameraPathPoint(move.id, last.x + 3, last.y, last.z + 3);
                      } else {
                        addCameraPathPoint(move.id, t?.x ?? 0, 1.6, (t?.z ?? 0) + 3);
                      }
                    }}
                  >
                    ＋ 加点
                  </button>
                </Row>
                <p className="hint">
                  在 Director View 拖拽蓝色路径点塑形；轻点蓝点弹菜单删除（与人物 move 一致）。
                  相机沿折线行进。朝向三选一：跟随对象 / 固定方向（用平面 · 立面两个角度设定，机位平移、朝向不变）/ 沿轨迹（朝行进方向）。
                </p>
                {(() => {
                  const hasFixedDir =
                    move.fixedYawDeg !== undefined || move.fixedPitchDeg !== undefined;
                  const lookMode = hasFixedDir ? "fixed" : move.targetId ? "target" : "tangent";
                  return (
                    <>
                      <Field label="朝向 Look">
                        <select
                          value={lookMode}
                          onChange={(event) => {
                            const mode = event.target.value;
                            if (mode === "target") {
                              patchCameraMove(move.id, {
                                fixedYawDeg: undefined,
                                fixedPitchDeg: undefined,
                                targetId: move.targetId ?? moveCamera?.targetId ?? undefined,
                              });
                            } else if (mode === "fixed") {
                              // 从当前朝向反推「平面 / 立面」两角，切换瞬间画面不跳。
                              let yawDeg = move.fixedYawDeg;
                              let pitchDeg = move.fixedPitchDeg;
                              if (yawDeg === undefined && pitchDeg === undefined) {
                                const solved = solveCamera(state, move.camera, (move.timeStart + move.timeEnd) / 2);
                                if (solved) {
                                  const dx = solved.target[0] - solved.position[0];
                                  const dy = solved.target[1] - solved.position[1];
                                  const dz = solved.target[2] - solved.position[2];
                                  const len = Math.hypot(dx, dy, dz) || 1;
                                  yawDeg = ((Math.atan2(dx / len, dz / len) * 180) / Math.PI + 360) % 360;
                                  pitchDeg = ((Math.asin(Math.max(-1, Math.min(1, dy / len))) * 180) / Math.PI + 360) % 360;
                                }
                              }
                              patchCameraMove(move.id, {
                                targetId: undefined,
                                fixedYawDeg: yawDeg ?? 0,
                                fixedPitchDeg: pitchDeg ?? 0,
                              });
                            } else {
                              patchCameraMove(move.id, {
                                targetId: undefined,
                                fixedYawDeg: undefined,
                                fixedPitchDeg: undefined,
                              });
                            }
                          }}
                        >
                          <option value="target">跟随对象 Target</option>
                          <option value="fixed">固定方向 Fixed</option>
                          <option value="tangent">沿轨迹 Tangent</option>
                        </select>
                      </Field>
                      {lookMode === "fixed" ? (
                        <>
                          <Field label={`平面 Yaw ${(move.fixedYawDeg ?? 0).toFixed(0)}°`}>
                            <input
                              type="range"
                              min={0}
                              max={360}
                              step={1}
                              value={move.fixedYawDeg ?? 0}
                              onChange={(event) =>
                                patchCameraMove(move.id, { fixedYawDeg: Number(event.target.value) })
                              }
                            />
                          </Field>
                          <Field label={`立面 Pitch ${(move.fixedPitchDeg ?? 0).toFixed(0)}°`}>
                            <input
                              type="range"
                              min={0}
                              max={360}
                              step={1}
                              value={move.fixedPitchDeg ?? 0}
                              onChange={(event) =>
                                patchCameraMove(move.id, { fixedPitchDeg: Number(event.target.value) })
                              }
                            />
                          </Field>
                        </>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            ) : null}

            {!moveOts && (move.type === "ORBIT" || move.type === "DRONE") ? (
              <Field label={`Orbit ${(move.orbitDeg ?? 0).toFixed(0)}°`}>
                <input
                  type="range"
                  min={-360}
                  max={360}
                  step={5}
                  value={move.orbitDeg ?? 0}
                  onChange={(event) => patchCameraMove(move.id, { orbitDeg: Number(event.target.value) })}
                />
              </Field>
            ) : null}

            {!moveOts && (move.type === "DOLLY" || move.type === "DRONE" || move.type === "DOLLY_ZOOM") ? (
              <Field label={`Dolly ×${(move.dollyScale ?? 1).toFixed(2)}`}>
                <input
                  type="range"
                  min={0.3}
                  max={2}
                  step={0.05}
                  value={move.dollyScale ?? 1}
                  onChange={(event) =>
                    patchCameraMove(move.id, { dollyScale: Number(event.target.value) })
                  }
                />
              </Field>
            ) : null}

            {!moveOts && (move.type === "CRANE" || move.type === "DRONE") ? (
              <Field label={`Crane +${(move.craneHeight ?? 0).toFixed(1)}m`}>
                <input
                  type="range"
                  min={-6}
                  max={8}
                  step={0.1}
                  value={move.craneHeight ?? 0}
                  onChange={(event) =>
                    patchCameraMove(move.id, { craneHeight: Number(event.target.value) })
                  }
                />
              </Field>
            ) : null}
          </SubGroup>

          <SubGroup
            title="构图 Composition"
            hint={
              moveOts
                ? "过肩镜头下，机位角度 / 距离 / 眼高由过肩几何固定，仅 Target 与 Lens 生效；侧面关系由下方「过肩 OTS」决定。"
                : "留空即继承相机级设置。"
            }
          >
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
                    {objectDisplayName(item)}
                  </option>
                ))}
              </select>
            </Field>
            {moveOts ? null : (
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
            )}
            {moveOts ? null : (
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
            )}
            {moveOts ? null : (
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
            )}
            {moveOts ? null : (
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
            )}
          </SubGroup>

          {moveOts ? (
            <SubGroup
              title="过肩 OTS"
              hint="越过前景演员的肩膀拍主体：Shoulder 是前景、Target 是主体（在上方构图组里设置）。"
              >
              {moveOts && !canOts ? (
              <p className="hint" style={{ color: "#ffb86b" }}>
                ⚠ 过肩需要至少 2 名演员（前景 + 主体）；当前不足，过肩不生效，请先加入另一个演员。
              </p>
              ) : moveOts &&
              (!(move.shoulderId ?? moveCamera?.shoulderId) ||
              (move.shoulderId ?? moveCamera?.shoulderId) ===
                (move.targetId ?? moveCamera?.targetId)) ? (
              <p className="hint" style={{ color: "#ffb86b" }}>
                ⚠ 需设置与主体（Target）不同的前景演员（Shoulder），否则过肩不生效、Side（左/右肩）无效。
              </p>
              ) : null}
              <Field label="前景演员（Shoulder）">
                <select
                  value={move.shoulderId ?? ""}
                  disabled={!canOts}
                  onChange={(event) =>
                    patchCameraMove(move.id, { shoulderId: event.target.value || undefined })
                  }
                >
                  <option value="">{canOts ? "(camera default)" : "(需至少 2 名演员)"}</option>
                  {actors.filter((item) => item.id !== (move.targetId ?? moveCamera?.targetId)).map((item) => (
                    <option key={item.id} value={item.id}>
                      {objectDisplayName(item)}
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
            <Field
              label={`防抖 Stabilization ${Math.round((move.stabilize ?? moveCamera?.stabilize ?? 0) * 100)}%（覆盖相机）`}
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={move.stabilize ?? moveCamera?.stabilize ?? 0}
                onChange={(event) =>
                  patchCameraMove(move.id, { stabilize: Number(event.target.value) })
                }
              />
            </Field>
          </SubGroup>

          {(() => {
            const keys = move.keys ?? [];
            const span = move.timeEnd - move.timeStart || 1;
            const activeKey = keys.find((key) => key.id === selectedKeyId) ?? keys[0];
            const absTime = activeKey ? move.timeStart + activeKey.t * span : move.timeStart;
            const eff = moveChannelsAt(state, move.camera, move, absTime);
            const playheadT = Math.max(0, Math.min(1, (currentTime - move.timeStart) / span));
            const keyIndex = Math.max(0, keys.findIndex((key) => key.id === activeKey?.id));
            const patchKey = (keyId: string, patch: Partial<CameraKey>) =>
              updateCameraKey(move.id, keyId, patch);
            return (
              <SubGroup
                title="关键帧 Keyframes"
                hint="在运镜基元之上定制通道：只填你要改的通道（留空 = 沿用基元）。同一通道从「段首原值」过渡到第一个帧，帧间按后一帧的缓动插值，末帧之后保持（段首帧 = 整段恒定）。可据此在环绕时叠加升降等，拼出复杂运镜。"
              >
                <div className="mini-btns">
                  <button
                    type="button"
                    className="ghost-button"
                    title="在播放头处插入一个空关键帧（不填通道前不改变画面）"
                    onClick={() => {
                      addCameraKey(move.id, playheadT);
                      selectCameraKey(null);
                    }}
                  >
                    ＋ 关键帧@播放头 {currentTime.toFixed(1)}s
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!keys.length}
                    onClick={() => {
                      clearCameraKeys(move.id);
                      selectCameraKey(null);
                    }}
                  >
                    清空
                  </button>
                </div>
                {keys.length ? (
                  <>
                    <p className="hint">
                      在时间轴上操作关键帧：拖动改时刻 · 双击片段空白处新增 · 右键删除。这里编辑选中帧的通道值（当前 #
                      {Math.max(0, keys.findIndex((key) => key.id === activeKey?.id)) + 1} / {keys.length}）。
                    </p>
                    {activeKey ? (
                      <>
                        <div className="mini-btns">
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={keyIndex <= 0}
                            onClick={() => selectCameraKey(keys[keyIndex - 1].id)}
                          >
                            ◀ 上一帧
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={keyIndex >= keys.length - 1}
                            onClick={() => selectCameraKey(keys[keyIndex + 1].id)}
                          >
                            下一帧 ▶
                          </button>
                        </div>
                        <Field
                          label={`时刻 ${(move.timeStart + activeKey.t * span).toFixed(2)}s（${Math.round(activeKey.t * 100)}%）`}
                        >
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={activeKey.t}
                            onChange={(event) => patchKey(activeKey.id, { t: Number(event.target.value) })}
                          />
                        </Field>
                        {(["motion", "lens"] as const).map((group) => (
                          <div key={group}>
                            <div className="kf-group">
                              {group === "motion" ? "运动 Motion" : "镜头 Lens"}
                            </div>
                            {CAMERA_CHANNELS.filter(
                              (channel) => KEY_CHANNEL_META[channel].group === group,
                            ).map((channel) => {
                              const meta = KEY_CHANNEL_META[channel];
                              const value = activeKey[channel];
                              const base = eff ? eff[channel] : 0;
                              const isSet = value !== undefined;
                              const shown = value ?? Math.min(meta.max, Math.max(meta.min, base));
                              const apply = (next: number | undefined) =>
                                patchKey(activeKey.id, { [channel]: next } as Partial<CameraKey>);
                              return (
                                <div key={channel} className={`kf-row${isSet ? " set" : ""}`}>
                                  <span className="kf-name" title={meta.hint}>
                                    {meta.label}
                                  </span>
                                  <input
                                    className="kf-slider"
                                    type="range"
                                    min={meta.min}
                                    max={meta.max}
                                    step={meta.step}
                                    value={shown}
                                    title={`${meta.hint}\n\n${
                                      isSet
                                        ? `本帧已覆盖（${value}）`
                                        : `未覆盖 · 当前实际值 ${base.toFixed(2)}（拖动即覆盖）`
                                    }`}
                                    onChange={(event) => apply(Number(event.target.value))}
                                  />
                                  <input
                                    className="kf-num"
                                    type="number"
                                    min={meta.min}
                                    max={meta.max}
                                    step={meta.step}
                                    value={value ?? ""}
                                    placeholder={base.toFixed(2)}
                                    onChange={(event) => {
                                      const raw = event.target.value;
                                      apply(raw === "" ? undefined : Number(raw));
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="kf-clear"
                                    title="清除该通道（回落到运镜基元 / 相邻帧）"
                                    disabled={!isSet}
                                    onClick={() => apply(undefined)}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                        {(() => {
                          const off = [
                            activeKey.panDeg ? "摇摄" : null,
                            activeKey.tiltDeg ? "俯仰" : null,
                            activeKey.truckDist ? "横移" : null,
                          ].filter(Boolean);
                          return off.length ? (
                            <p className="hint" style={{ color: "#ffb86b" }}>
                              ⚠ 本帧设置了 {off.join(" / ")}：它们会让镜头主动离开主体（摇摄/俯仰转视线、横移平移机位）。
                              想让主体始终居中，请把它们清成 0（点行尾 ×）。
                            </p>
                          ) : null;
                        })()}
                        <div className="mini-btns">
                          <button
                            type="button"
                            className="ghost-button danger-button"
                            onClick={() => {
                              deleteCameraKey(move.id, activeKey.id);
                              selectCameraKey(null);
                            }}
                          >
                            删除此帧
                          </button>
                        </div>
                        <p className="hint">
                          拖动滑块 / 输入数值 = 本帧覆盖该通道（整行高亮）；点 × 取消覆盖、回落基元或相邻帧。未高亮的行显示的是当前实际值（灰字）。
                        </p>
                      </>
                    ) : null}
                  </>
                ) : (
                  <p className="hint">
                    暂无关键帧。把播放头移到目标时刻，点「＋ 关键帧@播放头」加一帧；例如给 ORBIT 段在
                    t=0 与 t=1 各加一帧、填「升降」0 → 5m，即成环绕攀升。
                  </p>
                )}
              </SubGroup>
            );
          })()}

          {(() => {
            const junction = state.cameraJunctions.find(
              (j) => j.prevMove === move.id || j.nextMove === move.id,
            );
            if (!junction) return null;
            return (
              <SubGroup
                title={`Move Junction → ${junction.prevMove === move.id ? "next" : "prev"} (${junction.id})`}
                hint="stop = pause then go · smooth = continuous（一镜到底） · cut = allow jump"
              >
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
              </SubGroup>
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
