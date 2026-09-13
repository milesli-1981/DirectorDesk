import { create } from "zustand";
import {
  AspectRatio,
  CameraFraming,
  CameraJunction,
  CameraKey,
  CameraMove,
  CameraMotionType,
  CameraObject,
  CameraSide,
  CameraView,
  Constraint,
  DirectorGroup,
  DirectorState,
  EaseCurve,
  Footprint,
  Handoff,
  HandoffMode,
  IntentAction,
  MoveSegment,
  OtsSide,
  PathPoint,
  SpeedKey,
  StageManifest,
  ActionClip,
  ActionKind,
  Pose,
  Vec2,
  ViewMode,
} from "../domain/schema";
import { createBlankState } from "../engine/demoShot";
import { normalizePathPointModes, pathInsertIndex, simplifyPath } from "../engine/path";
import { contentEndTime } from "../engine/timeline";
import { normalizeCameraKeys, normalizeEase, normalizeSpeedKeys } from "../engine/ease";
import { ASSET_PRESETS } from "../engine/assetPresets";
import { separateSetAsset } from "../engine/collision";
import {
  AssetCategory,
  DirectorObject,
  FORMATION_MORPH_SECONDS,
  FormationKind,
} from "../domain/schema";
import { formationSlotOf } from "../engine/solver";
import { findTemplate } from "../domain/templates";

const CAMERA_COLORS = ["#c792ea", "#67a7ff", "#63d39b", "#f0a35a", "#ff7b91", "#8ad1ff"];

/**
 * 手绘路径的抽稀容差（米）：小于此偏离的采样点视为手抖，合并掉。
 * 调大 → 控制点更少更"硬"；调小 → 保留更多细节但点更密。
 */
const HAND_DRAW_EPSILON = 0.35;

// 持久化 v3：每张场景页独立 localStorage key，由片场 manifest 索引。
const MANIFEST_KEY = "director-desk-manifest-v3";
const sceneKey = (id: string) => `director-desk-scene-${id}-v3`;

function loadManifest(): StageManifest | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(MANIFEST_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StageManifest;
    if (!parsed || !Array.isArray(parsed.order) || !parsed.activeSceneId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveManifest(manifest: StageManifest): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
  } catch {
    /* ignore */
  }
}

function loadSceneState(id: string): DirectorState | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(sceneKey(id)) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DirectorState;
    if (!parsed || !Array.isArray(parsed.objects) || !Array.isArray(parsed.cameraMoves)) return null;
    // 读盘即兜底清理孤儿路径等悬空引用，保证任何来源的存档都干净。
    return sanitizeState({
      ...parsed,
      actions: parsed.actions ?? [],
      customActions: parsed.customActions ?? [],
    });
  } catch {
    return null;
  }
}

function saveSceneState(id: string, state: DirectorState): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(sceneKey(id), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function removeSceneState(id: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(sceneKey(id));
  } catch {
    /* ignore */
  }
}

function genSceneId(): string {
  return `SCN_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
}

/**
 * 内建示例片场：打包 scene_examples/ 下的所有 JSON（整片场导出格式 {manifest, scenes}）。
 * 作为首屏默认片场，不再读取 _scene.json，也不再代码生成 demo 场景。
 */
const exampleModules = import.meta.glob("../../scene_examples/*.json", {
  eager: true,
  import: "default",
}) as Record<string, { manifest?: StageManifest; scenes?: Record<string, DirectorState> }>;

/** 收集 scene_examples 下所有示例（按 scene id 去重），用于合并进默认片场。 */
function collectExamples(): {
  order: StageManifest["order"];
  scenes: Record<string, DirectorState>;
} {
  const scenes: Record<string, DirectorState> = {};
  const order: StageManifest["order"] = [];
  for (const mod of Object.values(exampleModules)) {
    if (!mod || !mod.manifest || !mod.scenes) continue;
    for (const tab of mod.manifest.order) {
      const st = mod.scenes[tab.id];
      if (!st || scenes[tab.id]) continue;
      scenes[tab.id] = st;
      order.push({ id: tab.id, name: tab.name });
    }
  }
  return { order, scenes };
}

/** 稳定字符串哈希（djb2）：给示例内容做指纹。 */
function hashString(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

const exampleHashKey = (id: string) => `director-desk-example-hash-${id}`;
const exampleWrittenKey = (id: string) => `director-desk-example-written-${id}`;
/** 用户改过的示例页：标记为不再自动覆盖（只能用 ↺ 强刷）。 */
const USER_MODIFIED = "user-modified";

function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** 写入示例并记录两个指纹：示例源内容指纹 + 本次实际写入内容指纹。 */
function writeExample(id: string, st: DirectorState, exampleHash: string): void {
  saveSceneState(id, st);
  lsSet(exampleHashKey(id), exampleHash);
  lsSet(exampleWrittenKey(id), hashString(JSON.stringify(st)));
}

/**
 * 示例同步：示例 JSON 改了之后自动刷新本地示例页，避免"改了示例却看不到效果"。
 *
 * 判定规则（force = ↺ 强刷时无条件覆盖）：
 * - tab 缺失 → 补建；
 * - 本地内容仍是上次写进去的那份（未被用户编辑）→ 示例一变就覆盖；
 * - 本地内容已被用户改过 → 标为 user-modified，之后**永不自动覆盖**（只能 ↺ 强刷）；
 * - 没有任何历史指纹（首次启用本机制）→ 视为陈旧样本，覆盖。
 */
function syncExamples(order: StageManifest["order"], force = false): StageManifest["order"] {
  const built = collectExamples();
  const next = [...order];
  for (const tab of built.order) {
    const st = built.scenes[tab.id];
    if (!st) continue;
    const exampleHash = hashString(JSON.stringify(st));
    const written = lsGet(exampleWrittenKey(tab.id));
    const savedRaw = lsGet(sceneKey(tab.id));
    const savedHash = savedRaw !== null ? hashString(savedRaw) : null;
    const missing = !next.some((t) => t.id === tab.id);
    const upToDate = savedHash === exampleHash;
    const untouched = written !== null && savedHash === written;

    if (force || missing || (!upToDate && (untouched || written === null))) {
      writeExample(tab.id, st, exampleHash);
      if (missing) next.push(tab);
    } else if (!upToDate && written !== null) {
      // 本地与"我们写进去的"不一致 = 用户改过：标记后不再自动覆盖。
      lsSet(exampleWrittenKey(tab.id), USER_MODIFIED);
      lsSet(exampleHashKey(tab.id), exampleHash);
    } else {
      lsSet(exampleHashKey(tab.id), exampleHash);
    }
  }
  return next;
}

/**
 * 启动时装配片场：
 * - 已有 manifest（用户继续编辑）→ 保留现状，并同步示例（陈旧/未改动的示例页自动更新）。
 * - 首屏（无 manifest）→ 以 scene_examples 目录下所有示例片场作为默认片场。
 * 返回的 activeState 直接作为 store 顶层 `state`（= 当前激活场景页的引用）。
 */
function initStage(): { manifest: StageManifest; activeState: DirectorState } {
  const built = collectExamples();
  const manifest = loadManifest();

  if (manifest && manifest.order.length > 0) {
    // 保留用户片场，同时同步示例：缺失的补建，陈旧且未被改动的自动更新。
    const order = syncExamples(manifest.order);
    const nextManifest = order.length !== manifest.order.length ? { ...manifest, order } : manifest;
    if (nextManifest !== manifest) saveManifest(nextManifest);
    const activeId =
      nextManifest.activeSceneId && nextManifest.order.some((t) => t.id === nextManifest.activeSceneId)
        ? nextManifest.activeSceneId
        : nextManifest.order[0].id;
    const activeState = loadSceneState(activeId) ?? createBlankState();
    return { manifest: nextManifest, activeState };
  }

  // 首屏：以 scene_examples 全部示例作为默认片场。
  if (built.order.length === 0) {
    const blank = createBlankState();
    const id = "SCN_BLANK";
    saveSceneState(id, blank);
    const newManifest: StageManifest = {
      name: "空白片场",
      order: [{ id, name: "空白场景" }],
      activeSceneId: id,
    };
    saveManifest(newManifest);
    return { manifest: newManifest, activeState: blank };
  }
  for (const tab of built.order) {
    const st = built.scenes[tab.id];
    if (st) writeExample(tab.id, st, hashString(JSON.stringify(st)));
  }
  const newManifest: StageManifest = {
    name: "示例片场",
    order: built.order,
    activeSceneId: built.order[0].id,
  };
  saveManifest(newManifest);
  return { manifest: newManifest, activeState: built.scenes[newManifest.activeSceneId] };
}

export type SelectionKind = "object" | "camera";

/** 环形菜单（RadialRing）的宿主：可以是场景对象，也可以是某条路径上的一个转折点。
 *  两者共用同一套甜甜圈 UI，只是可用动作不同，故用一个联合类型承载，避免两套字段各自残留。 */
export type RadialTarget = { kind: "object" | "point"; id: string };

/** 光标当前悬停的路径标记（转折点 / 起终点把手）。
 *  纯视觉反馈：让「这个把手现在能不能点中」先看得见，命中判定仍由 WorldView 决定。 */
export type MarkerHover =
  | { kind: "point"; segmentId: string; id: string }
  | { kind: "endpoint"; segmentId: string; id: "start" | "end" };

interface DirectorStore {
  state: DirectorState;
  /** 片场 manifest：场景页索引 + 片场名（数据各自独立存储）。 */
  manifest: StageManifest;
  currentTime: number;
  playing: boolean;
  zoom: number;
  selectedKind: SelectionKind;
  selectedId: string;
  selectedItem: string | null;
  selectedPoint: string | null;
  /** 光标悬停的路径标记：只驱动高亮，不代表选中，也不进 undo 历史。 */
  hoverMarker: MarkerHover | null;
  radialTarget: RadialTarget | null;
  viewMode: ViewMode;
  activeCameraId: string | null;
  /** 锁视角：开启后拖拽不再改变 Director View 的机位。 */
  viewLocked: boolean;
  /** 手绘路径模式：开启后可在画布上拖拽绘制选中资产的移动轨迹。 */
  pathDrawMode: boolean;
  /** 是否正在拖拽场景对象 / 路径点，用于临时接管 OrbitControls。 */
  dragging: boolean;

  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  setZoom: (zoom: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setActiveCamera: (cameraId: string) => void;
  toggleViewLocked: () => void;
  togglePathDraw: () => void;
  setDragging: (dragging: boolean) => void;

  selectObject: (objectId: string) => void;
  selectCamera: (cameraId: string) => void;
  selectItem: (itemId: string | null) => void;
  selectPoint: (pointId: string | null) => void;
  setHoverMarker: (marker: MarkerHover | null) => void;
  openRing: (objectId: string) => void;
  /** 轻点路径转折点打开环形菜单（Line/Curve 切换 + 删除），与对象环形菜单共用同一套 UI。 */
  openPointRing: (pointId: string) => void;
  closeRing: () => void;

  moveObject: (objectId: string, x: number, z: number) => void;
  /** 调整对象在时间轴 / Scene Tree 中的行顺序：把 dragId 移到 targetId 所在的位置。 */
  reorderObject: (dragId: string, targetId: string) => void;
  /** 锁定 / 解锁资产：锁定后不可通过拖拽移动位置（防误触），仍可点选以便解锁。 */
  toggleLock: (id: string) => void;
  addAsset: (category: AssetCategory, at?: { x: number; z: number }) => void;
  /**
   * 拖入一个「团队 Group」：一次生成 count 个同类资产并建组，整队共用一条路线
   * （锚点 = members[0]），队员按 formation 跟随。
   */
  addGroupAt: (
    category: AssetCategory,
    count: number,
    formation: FormationKind,
    at?: { x: number; z: number },
  ) => void;
  updateAsset: (id: string, patch: Partial<DirectorObject>) => void;
  removeAsset: (id: string) => void;
  /** 组（Group Dynamics） */
  createGroup: () => void;
  removeGroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  addMemberToGroup: (groupId: string, objectId: string) => void;
  removeMemberFromGroup: (groupId: string, objectId: string) => void;
  setGroupCount: (groupId: string, count: number) => void;
  updateGroup: (groupId: string, patch: Partial<DirectorGroup>) => void;
  /** 组 Block 尺寸：统一写回组内所有成员的 footprint（w=宽 d=深 h=高）。 */
  setGroupFootprint: (groupId: string, patch: Partial<Footprint>) => void;
  /** 组静态基线姿势：统一写回组内所有成员的 pose（pose 是逐对象属性，团队需整体生效）。 */
  setGroupPose: (groupId: string, pose: Pose) => void;
  /** 让某台相机以 GROUP 方式取景指定组（实时跟随成员变化）。 */
  setCameraGroup: (cameraId: string, groupId?: string) => void;
  exportScene: () => string;
  importScene: (json: string) => void;
  persist: () => void;
  // —— 片场 / 场景页管理 ——
  addScene: () => void;
  switchScene: (id: string) => void;
  renameScene: (id: string, name: string) => void;
  renameStage: (name: string) => void;
  removeScene: (id: string) => void;
  duplicateScene: (id: string) => void;
  reorderScene: (fromId: string, toId: string) => void;
  /** 用磁盘上 scene_examples 的最新内容覆盖同名示例场景页，并切到第一个示例页。 */
  resetExamples: () => void;
  exportProject: () => string;
  importProject: (json: string) => void;
  addPathPoint: (segmentId: string, x: number, z: number) => string | null;
  movePathPoint: (segmentId: string, pointId: string, x: number, z: number) => void;
  moveEndpoint: (segmentId: string, which: "start" | "end", x: number, z: number) => void;
  toggleCurve: (segmentId: string, pointId: string) => void;
  deletePoint: (segmentId: string, pointId: string) => void;
  addSegment: (objectId: string, afterSegmentId?: string) => void;
  /** 用一组有序坐标点直接覆盖某 segment 的路径（起点/终点取首尾点）。 */
  setSegmentPoints: (segmentId: string, points: { x: number; z: number }[]) => void;
  /** 手绘路径：为资产创建/复用最后的 MOVE segment，并写入拖拽得到的轨迹点。 */
  drawAssetPath: (objectId: string, points: { x: number; z: number }[]) => void;
  setHandoffMode: (handoffId: string, mode: HandoffMode) => void;
  setCameraJunctionMode: (junctionId: string, mode: HandoffMode) => void;
  deleteSegment: (segmentId: string) => void;
  // —— 动作片段（ActionClip）管理 ——
  addAction: (objectId: string, time?: number) => void;
  setActionTime: (actionId: string, start: number, end: number) => void;
  /**
   * 整队动作：一次写入多条动作片段的时间（时间轴上「整队动作带」拖动时使用）。
   * 逐条按 setActionTime 同样的规则夹到 [0, duration]，但只压一条历史，
   * 避免拖动过程中每帧 N 条各压一次栈。
   */
  setActionTimes: (entries: { id: string; timeStart: number; timeEnd: number }[]) => void;
  updateAction: (actionId: string, patch: Partial<ActionClip>) => void;
  deleteAction: (actionId: string) => void;
  // —— 自定义动作库（命名的关节姿势，随场景持久化、可被多片段复用）——
  /** 新建或更新（传 id 即覆盖同名 / 改名）一条自定义动作，返回其 id。 */
  saveCustomAction: (name: string, joints: Pose["joints"], id?: string) => string;
  deleteCustomAction: (id: string) => void;

  setSegmentTime: (segmentId: string, start: number, end: number) => void;
  setConstraintTime: (constraintId: string, start: number, end: number) => void;
  setSegmentEase: (segmentId: string, ease: EaseCurve) => void;
  /** 写入多段速度曲线关键点（null / 少于 2 个点 = 退回单段 cubic-bezier）。 */
  setSegmentSpeedKeys: (segmentId: string, keys: SpeedKey[] | null) => void;

  addCamera: () => void;
  addDroneCamera: () => void;
  addCameraFromTemplate: (templateId: string) => void;
  removeCamera: (cameraId: string) => void;
  updateCamera: (
    cameraId: string,
    patch: Partial<
      Pick<
        CameraObject,
        | "targetId"
        | "framing"
        | "view"
        | "side"
        | "lensMm"
        | "motion"
        | "name"
        | "kind"
        | "roll"
        | "shoulderId"
        | "otsSide"
        | "otsOffset"
        | "altitude"
        | "templateId"
        | "targetType"
        | "groupIds"
        | "groupId"
        | "panDeg"
        | "tiltDeg"
        | "truckDist"
        | "style"
        | "stabilize"
      >
    >,
  ) => void;
  addCameraMove: (cameraId: string, type: CameraMotionType) => void;
  addOtsMove: (cameraId: string) => void;
  setCameraMoveTime: (moveId: string, start: number, end: number) => void;
  setCameraMoveEase: (moveId: string, ease: EaseCurve) => void;
  /** 写入多段速度曲线关键点（null / 少于 2 个点 = 退回单段 cubic-bezier）。 */
  setCameraMoveSpeedKeys: (moveId: string, keys: SpeedKey[] | null) => void;
  patchCameraMove: (moveId: string, patch: Partial<CameraMove>) => void;
  deleteCameraMove: (moveId: string) => void;
  /** 在归一化时刻 t（0..1）插入一个空关键帧：不含通道覆盖，插入本身不改变画面。 */
  addCameraKey: (moveId: string, t: number) => void;
  /** 修改关键帧：patch 中值为 undefined 的通道会被清除（该通道回落到运镜基元）。 */
  updateCameraKey: (moveId: string, keyId: string, patch: Partial<CameraKey>) => void;
  deleteCameraKey: (moveId: string, keyId: string) => void;
  /** 清空该段所有关键帧，回到纯运镜基元。 */
  clearCameraKeys: (moveId: string) => void;
  /** 基于某条过肩 move 生成正反打：互换前景 / 主体、翻转肩侧，并保持同一侧轴线。 */
  addReverseShot: (moveId: string) => void;
  setAspectRatio: (ratio: AspectRatio) => void;
  /**
   * 设置本场景的最大时长（秒）。成片导出与时间轴刻度都以此为准。
   * 下限受已有内容约束（不允许把片段截掉），上限防止误输入超大值。
   */
  setDuration: (seconds: number) => void;

  executeIntent: (objectId: string, action: IntentAction) => void;
  // —— 撤销 / 重做历史 ——
  past: DirectorState[];
  future: DirectorState[];
  undo: () => void;
  redo: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

function nextCustomActionId(state: DirectorState): string {
  const list = state.customActions ?? [];
  let index = list.length + 1;
  let id = `POSE_${String(index).padStart(2, "0")}`;
  while (list.some((p) => p.id === id)) {
    index += 1;
    id = `POSE_${String(index).padStart(2, "0")}`;
  }
  return id;
}

function nextActionId(state: DirectorState): string {
  let index = (state.actions?.length ?? 0) + 1;
  let id = `ACT_${String(index).padStart(2, "0")}`;
  while (state.actions?.some((a) => a.id === id)) {
    index += 1;
    id = `ACT_${String(index).padStart(2, "0")}`;
  }
  return id;
}

function nextSegmentId(state: DirectorState): string {
  let index = state.segments.length + 1;
  let id = `SEG_${String(index).padStart(2, "0")}`;
  while (state.segments.some((s) => s.id === id)) {
    index += 1;
    id = `SEG_${String(index).padStart(2, "0")}`;
  }
  return id;
}

function nextConstraintId(state: DirectorState, prefix: string): string {
  let index = state.constraints.length + 1;
  let id = `${prefix}_${String(index).padStart(2, "0")}`;
  while (state.constraints.some((q) => q.id === id)) {
    index += 1;
    id = `${prefix}_${String(index).padStart(2, "0")}`;
  }
  return id;
}

function nextPointId(): string {
  return `P_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
}

function nextCameraId(state: DirectorState): string {
  const index = state.cameras.length;
  if (index < 26) {
    const id = `CAM_${String.fromCharCode(65 + index)}`;
    if (!state.cameras.some((c) => c.id === id)) return id;
  }
  let suffix = index + 1;
  let id = `CAM_${suffix}`;
  while (state.cameras.some((c) => c.id === id)) {
    suffix += 1;
    id = `CAM_${suffix}`;
  }
  return id;
}

function nextCameraMoveId(state: DirectorState, cameraId: string): string {
  const count = state.cameraMoves.filter((move) => move.camera === cameraId).length + 1;
  const base = `MOVE_${cameraId}_${String(count).padStart(2, "0")}`;
  if (!state.cameraMoves.some((move) => move.id === base)) return base;
  let index = count + 1;
  let id = `MOVE_${cameraId}_${String(index).padStart(2, "0")}`;
  while (state.cameraMoves.some((move) => move.id === id)) {
    index += 1;
    id = `MOVE_${cameraId}_${String(index).padStart(2, "0")}`;
  }
  return id;
}

/**
 * 由相邻 leg（同对象、时间相接）推导 Handoff 列表。
 * 用确定性的 id（H_<prev>_<next>）保证 mode 在重算后得以保留。
 */
function reconcileHandoffs(segments: MoveSegment[], prevHandoffs: Handoff[]): Handoff[] {
  const byObject: Record<string, MoveSegment[]> = {};
  for (const segment of segments) {
    (byObject[segment.object] ??= []).push(segment);
  }
  const next: Handoff[] = [];
  for (const objectId of Object.keys(byObject)) {
    const sorted = byObject[objectId].slice().sort((a, b) => a.timeStart - b.timeStart);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const prevSeg = sorted[index];
      const nextSeg = sorted[index + 1];
      if (prevSeg.timeEnd <= nextSeg.timeStart + 1e-6) {
        const id = `H_${prevSeg.id}_${nextSeg.id}`;
        const existing = prevHandoffs.find((item) => item.id === id);
        next.push({
          id,
          prevSeg: prevSeg.id,
          nextSeg: nextSeg.id,
          mode: existing?.mode ?? "stop",
        });
      }
    }
  }
  return next;
}

/**
 * 清理「悬空引用」：移除 object 字段指向不存在资产的 segment（孤儿路径）、
 * 以及引用缺失对象的 constraint / handoff / cameraMove。
 * 用于导入、读盘时兜底，避免历史/手工数据导致渲染或求解出错。
 */
function sanitizeState(s: DirectorState): DirectorState {
  const ids = new Set(s.objects.map((o) => o.id));
  // 速度曲线关键点在这里统一规范化：历史上允许把末点进度拖到 1 以下（会跑不完 path），
  // 读盘 / 导入时一并修正，下游求解就能假定数据永远合法。
  const segments = s.segments
    .filter((seg) => ids.has(seg.object))
    .map((seg) =>
      seg.speedKeys ? { ...seg, speedKeys: normalizeSpeedKeys(seg.speedKeys) ?? undefined } : seg,
    );
  return {
    ...s,
    segments,
    cameraMoves: s.cameraMoves.map((move) =>
      move.speedKeys
        ? { ...move, speedKeys: normalizeSpeedKeys(move.speedKeys) ?? undefined }
        : move,
    ),
    constraints: s.constraints.filter((c) => ids.has(c.subject) && ids.has(c.target)),
    handoffs: reconcileHandoffs(segments, s.handoffs),
    // 引力场恒开：该开关不再对用户开放，任何来源的存档 / 导入都统一强制为 true。
    groups: s.groups?.map((g) => (g.dynamics ? g : { ...g, dynamics: true })),
  };
}

/**
 * 团队路线的归属者：整队只 author 一条路线，挂在锚点（members[0]）上。
 * 任何落在队员身上的建段 / 画路径请求都重定向到锚点，避免「每个人各有一条路线」。
 */
function teamRouteOwner(state: DirectorState, objectId: string): string {
  const group = (state.groups ?? []).find((g) => g.dynamics && g.members.includes(objectId));
  if (!group || group.members.length < 2) return objectId;
  return group.members[0];
}

/**
 * 由相邻 CameraMove（同相机、时间相接）推导 CameraJunction 列表。
 * 用确定性 id（J_<prev>_<next>）保留 mode。与 reconcileHandoffs 同构。
 */
function reconcileCameraJunctions(moves: CameraMove[], prev: CameraJunction[]): CameraJunction[] {
  const byCamera: Record<string, CameraMove[]> = {};
  for (const move of moves) {
    (byCamera[move.camera] ??= []).push(move);
  }
  const next: CameraJunction[] = [];
  for (const cameraId of Object.keys(byCamera)) {
    const sorted = byCamera[cameraId].slice().sort((a, b) => a.timeStart - b.timeStart);
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const prevMove = sorted[index];
      const nextMove = sorted[index + 1];
      if (prevMove.timeEnd <= nextMove.timeStart + 1e-6) {
        const id = `J_${prevMove.id}_${nextMove.id}`;
        const existing = prev.find((item) => item.id === id);
        next.push({
          id,
          prevMove: prevMove.id,
          nextMove: nextMove.id,
          mode: existing?.mode ?? "stop",
        });
      }
    }
  }
  return next;
}

export const useDirectorStore = create<DirectorStore>((setParam, get) => {
  // 原 Zustand set（类型保留，供 action 内回调正确推断 store 类型）。
  const rawSet = setParam as unknown as (partial: any, replace?: any) => void;
  // 撤销历史：每次「改场景数据」的 set 之前，把当前 state 压入 past；
  // 连续编辑（如拖拽，<500ms 内的多次 set）合并为同一历史项，避免拖拽刷屏；
  // 切/增/删场景页（含 manifest）时清空历史，避免跨场景误撤销。
  const HISTORY_LIMIT = 200;
  const COALESCE_MS = 500;
  let lastEditTime = 0;
  const set: typeof setParam = (partial, replace) => {
    const prev = get().state;
    const p = partial as any;
    const next = typeof p === "function" ? p(get()) : p;
    if (next && next.state && next.state !== prev && !next.manifest) {
      const now = Date.now();
      if (now - lastEditTime > COALESCE_MS) {
        rawSet({ past: [...get().past, prev].slice(-HISTORY_LIMIT), future: [] });
        lastEditTime = now;
      }
      // 否则视为连续编辑（如拖拽），合并到上一条历史项，不重复压栈。
    } else if (next && next.manifest) {
      rawSet({ past: [], future: [] });
    }
    rawSet(partial, replace);
  };

  const patchSegment = (segmentId: string, patch: Partial<MoveSegment>) =>
    set((store) => {
      const segments = store.state.segments.map((segment) =>
        segment.id === segmentId ? { ...segment, ...patch } : segment,
      );
      return {
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          segments,
          handoffs: reconcileHandoffs(segments, store.state.handoffs),
        },
      };
    });

  const patchConstraint = (constraintId: string, patch: Partial<Constraint>) =>
    set((store) => ({
      state: {
        ...store.state,
        revision: store.state.revision + 1,
        constraints: store.state.constraints.map((constraint) =>
          constraint.id === constraintId ? { ...constraint, ...patch } : constraint,
        ),
      },
    }));

  const patchCameraMove = (moveId: string, patch: Partial<CameraMove>) =>
    set((store) => {
      const cameraMoves = store.state.cameraMoves.map((move) =>
        move.id === moveId ? { ...move, ...patch } : move,
      );
      return {
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, store.state.cameraJunctions),
        },
      };
    });

  /** 规范化后的关键帧集合写回某条 move（null = 清空）。 */
  const setMoveKeys = (moveId: string, keys: CameraKey[] | null) =>
    set((store) => ({
      state: {
        ...store.state,
        revision: store.state.revision + 1,
        cameraMoves: store.state.cameraMoves.map((move) =>
          move.id === moveId ? { ...move, keys: keys ?? undefined } : move,
        ),
      },
    }));

  const addCameraKey = (moveId: string, t: number) => {
    const move = get().state.cameraMoves.find((m) => m.id === moveId);
    if (!move) return;
    const at = clamp(t, 0, 1);
    const existing = move.keys ?? [];
    const id = `${moveId}_K${existing.length + 1}_${Math.round(at * 100)}`;
    setMoveKeys(moveId, normalizeCameraKeys([...existing, { id, t: at, ease: normalizeEase(move.ease) }]));
  };

  const updateCameraKey = (moveId: string, keyId: string, patch: Partial<CameraKey>) => {
    const move = get().state.cameraMoves.find((m) => m.id === moveId);
    if (!move) return;
    setMoveKeys(
      moveId,
      normalizeCameraKeys(
        (move.keys ?? []).map((key) => (key.id === keyId ? { ...key, ...patch } : key)),
      ),
    );
  };

  const deleteCameraKey = (moveId: string, keyId: string) => {
    const move = get().state.cameraMoves.find((m) => m.id === moveId);
    if (!move) return;
    setMoveKeys(moveId, normalizeCameraKeys((move.keys ?? []).filter((key) => key.id !== keyId)));
  };

  const init = initStage();
  return {
    state: init.activeState,
    manifest: init.manifest,
    past: [],
    future: [],
    currentTime: 0,
    playing: false,
    zoom: 1,
    selectedKind: "object",
    selectedId: "M17",
    selectedItem: null,
    selectedPoint: null,
    hoverMarker: null,
    radialTarget: null,
    viewMode: "director",
    activeCameraId: "CAM_A",
    viewLocked: false,
    pathDrawMode: false,
    dragging: false,

    // 播放需要连续时间，不能在这里做 0.1s 量化。
    setTime: (time) =>
      set((store) => ({
        currentTime: clamp(time, 0, store.state.duration),
      })),

    setPlaying: (playing) => set({ playing }),

    togglePlay: () =>
      set((store) => {
        const next = !store.playing;
        // 播放头已在末尾时按播放，先回到第一帧，避免「按下播放却立刻结束」。
        if (next && store.currentTime >= contentEndTime(store.state) - 1e-6) {
          return { playing: true, currentTime: 0 };
        }
        return { playing: next };
      }),

    setZoom: (zoom) => set({ zoom: clamp(round1(clamp(zoom, 0.5, 2)), 0.5, 2) }),

    setViewMode: (mode) => set({ viewMode: mode }),

    setActiveCamera: (cameraId) => set({ activeCameraId: cameraId }),

    toggleViewLocked: () => set((store) => ({ viewLocked: !store.viewLocked })),

    togglePathDraw: () => set((store) => ({ pathDrawMode: !store.pathDrawMode })),

    setDragging: (dragging) => set({ dragging }),

    selectObject: (objectId) =>
      set((store) => ({
        selectedKind: "object",
        selectedId: objectId,
        // 切换对象时不能残留上一个对象的路径点选中状态。
        selectedPoint:
          store.selectedKind === "object" && store.selectedId === objectId
            ? store.selectedPoint
            : null,
      })),

    selectCamera: (cameraId) =>
      set({
        selectedKind: "camera",
        selectedId: cameraId,
        // 选中相机即把它设为镜头视图当前相机：避免「Inspector 在改 A、camera view 却显示 B」
        // 的脱节（两者曾是两个独立字段），否则改配置看起来像「不起作用」。
        activeCameraId: cameraId,
        selectedPoint: null,
      }),

    selectItem: (itemId) => set({ selectedItem: itemId }),

    selectPoint: (pointId) => set({ selectedPoint: pointId }),

    setHoverMarker: (marker) => set({ hoverMarker: marker }),

    openRing: (objectId) => set({ radialTarget: { kind: "object", id: objectId } }),

    openPointRing: (pointId) => set({ radialTarget: { kind: "point", id: pointId } }),

    closeRing: () => set({ radialTarget: null }),

    moveObject: (objectId, x, z) =>
      set((store) => {
        const state = store.state;
        const target = state.objects.find((o) => o.id === objectId);
        // 锁定对象不可通过拖拽移动位置（防误触）。
        if (target && target.locked) return {};
        // 锁定团队：拖动其锚点（队首）= 移动整队，故一并禁止。
        const team = (state.groups ?? []).find(
          (g) => g.dynamics && g.members[0] === objectId,
        );
        if (team && team.locked) return {};
        // set 资产落点需与已有环境资产分离，避免穿模。
        const { x: nx, z: nz } =
          target && target.role === "set"
            ? separateSetAsset(state.objects, objectId, x, z)
            : { x, z };

        // 拖动对象时，其第一段路径的起点跟随 ORIGIN：
        // 否则播放到该段时，对象会从新的 ORIGIN 瞬移回老起点。
        const first = state.segments
          .filter((s) => s.object === objectId)
          .sort((a, b) => a.timeStart - b.timeStart)[0];
        const segments = first
          ? state.segments.map((s) =>
              s.id === first.id ? { ...s, startX: nx, startZ: nz } : s,
            )
          : state.segments;

        return {
          state: {
            ...state,
            revision: state.revision + 1,
            objects: state.objects.map((object) =>
              object.id === objectId ? { ...object, x: nx, z: nz } : object,
            ),
            segments,
            handoffs: first ? reconcileHandoffs(segments, state.handoffs) : state.handoffs,
          },
        };
      }),

    toggleLock: (id) =>
      set((store) => {
        const target = store.state.objects.find((o) => o.id === id);
        if (!target) return {};
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            objects: store.state.objects.map((o) =>
              o.id === id ? { ...o, locked: !o.locked } : o,
            ),
          },
        };
      }),

    reorderObject: (dragId, targetId) =>
      set((store) => {
        const objects = [...store.state.objects];
        const from = objects.findIndex((o) => o.id === dragId);
        const to = objects.findIndex((o) => o.id === targetId);
        if (from < 0 || to < 0 || from === to) return {};
        const [moved] = objects.splice(from, 1);
        objects.splice(to, 0, moved);
        return {
          state: { ...store.state, revision: store.state.revision + 1, objects },
        };
      }),

    addAsset: (category, at) => {
      const store = get();
      const { state } = store;
      const preset = ASSET_PRESETS[category];
      let count = state.objects.filter((o) => o.category === category).length + 1;
      let id = `AST_${category.toUpperCase()}_${String(count).padStart(2, "0")}`;
      while (state.objects.some((o) => o.id === id)) {
        count += 1;
        id = `AST_${category.toUpperCase()}_${String(count).padStart(2, "0")}`;
      }
      // 拖拽落点优先；否则沿用原有「黄金角螺旋」散布，避免默认全堆在原点。
      const spiral = (() => {
        const angle = (state.objects.length * 137.5 * Math.PI) / 180;
        const radius = 2 + state.objects.length * 0.6;
        return {
          x: Math.round(Math.cos(angle) * radius * 10) / 10,
          z: Math.round(Math.sin(angle) * radius * 10) / 10,
        };
      })();
      const spawnX = at ? Math.round(at.x * 10) / 10 : spiral.x;
      const spawnZ = at ? Math.round(at.z * 10) / 10 : spiral.z;
      const asset: DirectorObject = {
        id,
        type: preset.role === "agent" ? "actor" : "prop",
        category,
        role: preset.role,
        x: spawnX,
        z: spawnZ,
        rotation: 0,
        footprint: { ...preset.footprint },
        color: preset.color,
      };
      // set 资产落点需与已有环境资产分离，避免穿模（agent 可自由摆放）。
      const { x: placedX, z: placedZ } =
        preset.role === "set"
          ? separateSetAsset([...state.objects, asset], id, spawnX, spawnZ)
          : { x: spawnX, z: spawnZ };
      const placed: DirectorObject = { ...asset, x: placedX, z: placedZ };
      set({
        state: { ...state, revision: state.revision + 1, objects: [...state.objects, placed] },
        selectedKind: "object",
        selectedId: id,
        selectedItem: null,
        selectedPoint: null,
      });
    },

    /**
     * 团队（Group）作为一个整体拖入：一次生成 count 个同类资产并建组。
     * 只给「组」设定一条路线——锚点（members[0]）承载它，其余队员由求解器按
     * formation 实时跟随（匀速保持编队、变速/变线弹簧回弹）。
     */
    addGroupAt: (category, count, formation, at) => {
      const store = get();
      const { state } = store;
      const preset = ASSET_PRESETS[category];
      if (!preset) return;
      const total = Math.max(1, Math.min(24, Math.round(count) || 1));
      const spacing = 1.3;
      const baseX = at ? Math.round(at.x * 10) / 10 : 0;
      const baseZ = at ? Math.round(at.z * 10) / 10 : 0;

      const created: DirectorObject[] = [];
      const members: string[] = [];
      for (let i = 0; i < total; i += 1) {
        let n = state.objects.filter((o) => o.category === category).length + created.length + 1;
        let id = `AST_${category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        while ([...state.objects, ...created].some((o) => o.id === id)) {
          n += 1;
          id = `AST_${category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        }
        // 初始摆放沿用求解器同一套编队槽位（本地坐标 forward = +z, right = +x）。
        const slot = formationSlotOf(formation, spacing, i, total);
        created.push({
          id,
          type: preset.role === "agent" ? "actor" : "prop",
          category,
          role: preset.role,
          x: Math.round((baseX + slot.right) * 10) / 10,
          z: Math.round((baseZ + slot.fwd) * 10) / 10,
          rotation: 0,
          footprint: { ...preset.footprint },
          color: preset.color,
        });
        members.push(id);
      }

      const palette = ["#ff8fab", "#9d7bff", "#5ad1c4", "#f0c050", "#7bd88f", "#ff9d5c"];
      const group: DirectorGroup = {
        id: `GRP_${Date.now().toString(36)}`,
        name: `${preset.label}队${(state.groups?.length ?? 0) + 1}`,
        color: palette[(state.groups?.length ?? 0) % palette.length],
        members,
        dynamics: true,
        formation,
        spacing,
        noise: 0.35,
      };

      set({
        state: {
          ...state,
          revision: state.revision + 1,
          objects: [...state.objects, ...created],
          groups: [...(state.groups ?? []), group],
        },
        selectedKind: "object",
        // 选中锚点：之后画路径 / 加 MOVE 都是给整队设定那唯一一条路线。
        selectedId: members[0],
        selectedItem: null,
        selectedPoint: null,
      });
    },

    updateAsset: (id, patch) =>
      set((store) => {
        const state = store.state;
        const target = state.objects.find((o) => o.id === id);
        // 若编辑了 set 资产的位置 / 体块，重新分离以避免穿模。
        const needsSeparate =
          target &&
          target.role === "set" &&
          (patch.x !== undefined || patch.z !== undefined || patch.footprint !== undefined);
        const merged =
          target && needsSeparate
            ? { ...target, ...patch }
            : null;
        const sep = merged ? separateSetAsset(state.objects, id, merged.x, merged.z) : null;
        const effectivePatch =
          sep && patch.x !== undefined
            ? { ...patch, x: sep.x }
            : sep && patch.z !== undefined
              ? { ...patch, z: sep.z }
              : patch;
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            objects: state.objects.map((o) =>
              o.id === id ? { ...o, ...effectivePatch } : o,
            ),
          },
        };
      }),

    removeAsset: (id) =>
      set((store) => {
        const cameraMoves = store.state.cameraMoves.map((m) =>
          m.targetId === id ? { ...m, targetId: undefined } : m,
        );
        const objects = store.state.objects.filter((o) => o.id !== id);
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            objects,
            segments: store.state.segments.filter((s) => s.object !== id),
            constraints: store.state.constraints.filter((c) => c.subject !== id && c.target !== id),
            cameraMoves,
            cameraJunctions: reconcileCameraJunctions(cameraMoves, store.state.cameraJunctions),
            // 被删对象同时从各组成员中移除，空组清理掉。
            groups: (store.state.groups ?? [])
              .map((g) => ({ ...g, members: g.members.filter((m) => m !== id) }))
              .filter((g) => g.members.length > 0),
          },
          selectedItem:
            store.selectedItem && store.state.segments.some((s) => s.id === store.selectedItem)
              ? store.selectedItem
              : null,
          selectedPoint: null,
          // 删掉的正是当前选中资产时，清空选择，避免后续 DRAW PATH 把轨迹写进不存在的 id（孤儿路径）。
          selectedId: store.selectedId === id ? "" : store.selectedId,
          selectedKind: store.selectedKind === "object" && store.selectedId === id ? undefined : store.selectedKind,
          // 删掉资产时若正开着它的环形菜单，务必一并关掉，避免菜单指向已不存在的对象。
          radialTarget:
            store.radialTarget?.kind === "object" && store.radialTarget.id === id
              ? null
              : store.radialTarget,
        };
      }),

    createGroup: () =>
      set((store) => {
        const n = (store.state.groups?.length ?? 0) + 1;
        const palette = ["#ff8fab", "#9d7bff", "#5ad1c4", "#f0c050", "#7bd88f", "#ff9d5c"];
        const group: DirectorGroup = {
          id: `GRP_${Date.now().toString(36)}`,
          name: `G${n}`,
          color: palette[(n - 1) % palette.length],
          members: [],
          dynamics: true,
          formation: "column",
          spacing: 1.2,
          noise: 0.35,
        };
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            groups: [...(store.state.groups ?? []), group],
          },
        };
      }),

    removeGroup: (groupId) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          groups: (store.state.groups ?? []).filter((g) => g.id !== groupId),
          cameras: store.state.cameras.map((c) =>
            c.groupId === groupId ? { ...c, groupId: undefined } : c,
          ),
        },
      })),

    renameGroup: (groupId, name) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          groups: (store.state.groups ?? []).map((g) =>
            g.id === groupId ? { ...g, name: name.trim() || g.name } : g,
          ),
        },
      })),

    addMemberToGroup: (groupId, objectId) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          groups: (store.state.groups ?? []).map((g) =>
            g.id === groupId && !g.members.includes(objectId)
              ? { ...g, members: [...g.members, objectId] }
              : g,
          ),
        },
      })),

    removeMemberFromGroup: (groupId, objectId) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          groups: (store.state.groups ?? []).map((g) =>
            g.id === groupId ? { ...g, members: g.members.filter((m) => m !== objectId) } : g,
          ),
        },
      })),

    // 只通过「数量」管理队伍规模：以锚点（members[0]）为基准增删尾随队员，不暴露单独增删改。
    setGroupCount: (groupId, count) =>
      set((store) => {
        const state = store.state;
        const group = (state.groups ?? []).find((g) => g.id === groupId);
        if (!group) return {};
        const target = Math.max(1, Math.min(24, Math.round(count) || 1));
        const current = group.members.length;
        if (target === current) return {};

        // 减少：删除尾部队员，并清理其对象 / 路径 / 约束（锚点始终保留）。
        if (target < current) {
          const removed = group.members.slice(target);
          const kept = group.members.slice(0, target);
          return {
            state: {
              ...state,
              revision: state.revision + 1,
              objects: state.objects.filter((o) => !removed.includes(o.id)),
              segments: state.segments.filter((s) => !removed.includes(s.object)),
              constraints: state.constraints.filter(
                (c) => !removed.includes(c.subject) && !removed.includes(c.target),
              ),
              groups: (state.groups ?? []).map((g) =>
                g.id === groupId ? { ...g, members: kept } : g,
              ),
            },
          };
        }

        // 增加：以锚点当前位置为基准，按编队槽位生成新的尾随队员对象。
        const anchor = state.objects.find((o) => o.id === group.members[0]);
        if (!anchor) return {};
        const created: DirectorObject[] = [];
        const newMembers = [...group.members];
        const formation = group.formation ?? "column";
        const spacing = group.spacing ?? 1.2;
        for (let k = 0; k < target - current; k += 1) {
          const i = current + k;
          let n = state.objects.filter((o) => o.category === anchor.category).length + created.length + 1;
          let id = `AST_${anchor.category.toUpperCase()}_${String(n).padStart(2, "0")}`;
          while ([...state.objects, ...created].some((o) => o.id === id)) {
            n += 1;
            id = `AST_${anchor.category.toUpperCase()}_${String(n).padStart(2, "0")}`;
          }
          const slot = formationSlotOf(formation, spacing, i, target);
          created.push({
            id,
            type: anchor.type,
            category: anchor.category,
            role: anchor.role,
            x: Math.round((anchor.x + slot.right) * 10) / 10,
            z: Math.round((anchor.z + slot.fwd) * 10) / 10,
            rotation: anchor.rotation ?? 0,
            footprint: { ...anchor.footprint },
            color: anchor.color,
          });
          newMembers.push(id);
        }
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            objects: [...state.objects, ...created],
            groups: (state.groups ?? []).map((g) =>
              g.id === groupId ? { ...g, members: newMembers } : g,
            ),
          },
        };
      }),

    updateGroup: (groupId, patch) =>
      set((store) => {
        const currentTime = store.currentTime;
        const groups = (store.state.groups ?? []).map((g) => {
          if (g.id !== groupId) return g;
          const next = { ...g, ...patch };
          // 编队切换：记录切换时刻与上一阵型，供求解器按时间插值，避免瞬间变阵（不真实）。
          if (patch.formation !== undefined && patch.formation !== g.formation) {
            next.prevFormation = g.formation;
            // 过渡按【场景时间】推进，所以只有时间真的在走（播放中）时才把过渡放在播放头之后；
            // 暂停时场景时间不动，放在播放头之后就永远推不到头——点了切换却看不到任何变化
            // （还会一直显示上一个阵型）。因此暂停时把整段过渡挪到播放头之前，
            // 切完这一刻刚好走完：立刻看到新阵型，成片里依然是一段平滑变阵而非瞬移。
            next.formationChangeAt = store.playing
              ? currentTime
              : currentTime - FORMATION_MORPH_SECONDS;
          }
          return next;
        });
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            groups,
          },
        };
      }),

    setGroupFootprint: (groupId, patch) =>
      set((store) => {
        const state = store.state;
        const group = (state.groups ?? []).find((g) => g.id === groupId);
        if (!group || group.members.length === 0) return {};
        const memberSet = new Set(group.members);
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            objects: state.objects.map((object) =>
              memberSet.has(object.id)
                ? { ...object, footprint: { ...object.footprint, ...patch } }
                : object,
            ),
          },
        };
      }),

    setGroupPose: (groupId, pose) =>
      set((store) => {
        const state = store.state;
        const group = (state.groups ?? []).find((g) => g.id === groupId);
        if (!group || group.members.length === 0) return {};
        const memberSet = new Set(group.members);
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            // 每人持独立副本：共享同一份 joints 引用会被后续逐个改动互相串改。
            objects: state.objects.map((object) =>
              memberSet.has(object.id)
                ? { ...object, pose: { joints: { ...pose.joints } } }
                : object,
            ),
          },
        };
      }),

    setCameraGroup: (cameraId, groupId) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          cameras: store.state.cameras.map((c) =>
            c.id === cameraId
              ? { ...c, groupId: groupId ?? undefined, targetType: groupId ? "GROUP" : c.targetType }
              : c,
          ),
        },
      })),

    exportScene: () => JSON.stringify(get().state, null, 2),

    importScene: (json) => {
      try {
        const parsed = JSON.parse(json) as DirectorState;
        if (!parsed || !Array.isArray(parsed.objects) || !Array.isArray(parsed.cameraMoves)) {
          throw new Error("invalid scene");
        }
        const activeId = get().manifest.activeSceneId;
        saveSceneState(activeId, parsed);
        set({
          state: {
            ...sanitizeState(parsed),
            actions: parsed.actions ?? [],
            groups: parsed.groups ?? [],
            customActions: parsed.customActions ?? [],
            revision: (parsed.revision ?? 0) + 1,
          },
          currentTime: 0,
          playing: false,
          selectedKind: "object",
          selectedId: parsed.objects[0]?.id ?? "",
          selectedItem: null,
          selectedPoint: null,
          radialTarget: null,
          activeCameraId: parsed.cameras[0]?.id ?? null,
        });
      } catch (error) {
        console.error("importScene failed", error);
      }
    },

    exportProject: () => {
      const store = get();
      const scenes: Record<string, DirectorState> = {};
      for (const tab of store.manifest.order) {
        scenes[tab.id] =
          tab.id === store.manifest.activeSceneId
            ? store.state
            : loadSceneState(tab.id) ?? createBlankState();
      }
      return JSON.stringify({ manifest: store.manifest, scenes }, null, 2);
    },

    importProject: (json) => {
      try {
        const parsed = JSON.parse(json) as {
          manifest?: StageManifest;
          scenes?: Record<string, DirectorState>;
        };
        if (parsed.manifest && parsed.scenes) {
          const manifest = parsed.manifest;
          for (const tab of manifest.order) {
            const st = parsed.scenes[tab.id];
            if (st) saveSceneState(tab.id, st);
          }
          saveManifest(manifest);
          const active = loadSceneState(manifest.activeSceneId) ?? createBlankState();
          set({
            manifest,
            state: active,
            currentTime: 0,
            playing: false,
            selectedKind: "object",
            selectedId: active.objects[0]?.id ?? "",
            selectedItem: null,
            selectedPoint: null,
            radialTarget: null,
            activeCameraId: active.cameras[0]?.id ?? null,
          });
          return;
        }
        // 兼容旧的单场景文件：当作当前场景页的内容替换。
        const single = parsed as unknown as DirectorState;
        if (!single || !Array.isArray(single.objects) || !Array.isArray(single.cameraMoves)) {
          throw new Error("invalid scene");
        }
        const activeId = get().manifest.activeSceneId;
        saveSceneState(activeId, single);
        set({
          state: { ...sanitizeState(single), revision: (single.revision ?? 0) + 1 },
          currentTime: 0,
          playing: false,
          selectedKind: "object",
          selectedId: single.objects[0]?.id ?? "",
          selectedItem: null,
          selectedPoint: null,
          radialTarget: null,
          activeCameraId: single.cameras[0]?.id ?? null,
        });
      } catch (error) {
        console.error("importProject failed", error);
      }
    },

    persist: () => {
      const store = get();
      saveSceneState(store.manifest.activeSceneId, store.state);
      saveManifest(store.manifest);
    },

    addScene: () => {
      const store = get();
      const id = genSceneId();
      const blank = createBlankState();
      saveSceneState(id, blank);
      const manifest: StageManifest = {
        ...store.manifest,
        order: [...store.manifest.order, { id, name: `场景 ${store.manifest.order.length + 1}` }],
        activeSceneId: id,
      };
      saveManifest(manifest);
      set({
        manifest,
        state: blank,
        currentTime: 0,
        playing: false,
        selectedKind: "object",
        selectedId: "",
        selectedItem: null,
        selectedPoint: null,
        radialTarget: null,
        viewMode: "director",
        activeCameraId: null,
      });
    },

    switchScene: (id) => {
      const store = get();
      if (id === store.manifest.activeSceneId) return;
      const state = loadSceneState(id);
      if (!state) return;
      const manifest: StageManifest = { ...store.manifest, activeSceneId: id };
      saveManifest(manifest);
      set({
        manifest,
        state,
        currentTime: 0,
        playing: false,
        selectedKind: "object",
        selectedId: state.objects[0]?.id ?? "",
        selectedItem: null,
        selectedPoint: null,
        radialTarget: null,
        activeCameraId: state.cameras[0]?.id ?? null,
      });
    },

    renameScene: (id, name) => {
      const store = get();
      const manifest: StageManifest = {
        ...store.manifest,
        order: store.manifest.order.map((t) => (t.id === id ? { ...t, name } : t)),
      };
      saveManifest(manifest);
      set({ manifest });
    },

    renameStage: (name) => {
      const store = get();
      const manifest: StageManifest = { ...store.manifest, name };
      saveManifest(manifest);
      set({ manifest });
    },

    removeScene: (id) => {
      const store = get();
      if (store.manifest.order.length <= 1) return; // 至少保留一个场景页
      const remaining = store.manifest.order.filter((t) => t.id !== id);
      removeSceneState(id);
      let state = store.state;
      let activeSceneId = store.manifest.activeSceneId;
      if (id === store.manifest.activeSceneId) {
        activeSceneId = remaining[0].id;
        state = loadSceneState(activeSceneId) ?? createBlankState();
      }
      const manifest: StageManifest = { ...store.manifest, order: remaining, activeSceneId };
      saveManifest(manifest);
      if (id === store.manifest.activeSceneId) {
        set({
          manifest,
          state,
          selectedKind: "object",
          selectedId: state.objects[0]?.id ?? "",
          selectedItem: null,
          selectedPoint: null,
          radialTarget: null,
          activeCameraId: state.cameras[0]?.id ?? null,
        });
      } else {
        set({ manifest });
      }
    },

    duplicateScene: (id) => {
      const store = get();
      const src =
        id === store.manifest.activeSceneId ? store.state : loadSceneState(id) ?? store.state;
      const newId = genSceneId();
      const copy: DirectorState = { ...src, revision: (src.revision ?? 0) + 1 };
      saveSceneState(newId, copy);
      const idx = store.manifest.order.findIndex((t) => t.id === id);
      const tab = store.manifest.order[idx];
      const newTab = { id: newId, name: `${tab?.name ?? "场景"} 副本` };
      const order = [...store.manifest.order];
      order.splice(idx + 1, 0, newTab);
      const manifest: StageManifest = { ...store.manifest, order, activeSceneId: newId };
      saveManifest(manifest);
      set({
        manifest,
        state: copy,
        selectedKind: "object",
        selectedId: copy.objects[0]?.id ?? "",
        selectedItem: null,
        selectedPoint: null,
        radialTarget: null,
        activeCameraId: copy.cameras[0]?.id ?? null,
      });
    },

    reorderScene: (fromId, toId) => {
      if (fromId === toId) return;
      const store = get();
      const order = [...store.manifest.order];
      const fromIdx = order.findIndex((t) => t.id === fromId);
      const toIdx = order.findIndex((t) => t.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      const manifest: StageManifest = { ...store.manifest, order };
      saveManifest(manifest);
      set({ manifest });
    },

    /**
     * 开发 / 演示用：磁盘上的 scene_examples 改了，但 localStorage 里已有旧存档，
     * 正常启动流程不会覆盖它们，于是改了示例看不到效果。这里强制用最新示例覆盖
     * 同名场景页并切过去。注意：会丢失这些示例页上的本地修改。
     */
    resetExamples: () => {
      const store = get();
      const built = collectExamples();
      if (built.order.length === 0) return;
      // force = true：无条件用最新示例覆盖（已有 tab 保留其位置与名字，缺失的补到末尾）。
      const order = syncExamples(store.manifest.order, true);
      const first = built.order[0];
      const manifest: StageManifest = { ...store.manifest, order, activeSceneId: first.id };
      saveManifest(manifest);
      const state = loadSceneState(first.id) ?? createBlankState();
      set({
        manifest,
        state,
        currentTime: 0,
        playing: false,
        selectedKind: "object",
        selectedId: state.objects[0]?.id ?? "",
        selectedItem: null,
        selectedPoint: null,
        radialTarget: null,
        activeCameraId: state.cameras[0]?.id ?? null,
      });
    },

    addPathPoint: (segmentId, x, z) => {
      const store = get();
      const segment = store.state.segments.find((s) => s.id === segmentId);
      if (!segment) return null;
      const points = segment.points ?? [];
      const index = pathInsertIndex(segment, x, z);
      const node: PathPoint = {
        id: nextPointId(),
        type: "path",
        shape: "LINE",
        x,
        z,
      };
      const next = [...points];
      next.splice(index, 0, node);
      patchSegment(segmentId, { points: normalizePathPointModes(next) });
      set({ selectedItem: segmentId, selectedPoint: node.id });
      return node.id;
    },

    movePathPoint: (segmentId, pointId, x, z) => {
      const segment = get().state.segments.find((s) => s.id === segmentId);
      if (!segment) return;
      const next = (segment.points ?? []).map((point) =>
        point.id === pointId ? { ...point, x, z } : point,
      );
      patchSegment(segmentId, { points: normalizePathPointModes(next) });
    },

    moveEndpoint: (segmentId, which, x, z) => {
      const store = get();
      const state = store.state;
      const segment = state.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const handoff = state.handoffs.find((item) =>
        which === "end" ? item.prevSeg === segmentId : item.nextSeg === segmentId,
      );
      // cut 模式下一段起点解耦；否则交接点是同一份坐标，两端一起更新。
      if (!handoff || handoff.mode === "cut") {
        if (which === "start") patchSegment(segmentId, { startX: x, startZ: z });
        else patchSegment(segmentId, { endX: x, endZ: z });
        return;
      }
      const segments = state.segments.map((item) => {
        if (item.id === segmentId) {
          return which === "start"
            ? { ...item, startX: x, startZ: z }
            : { ...item, endX: x, endZ: z };
        }
        if (which === "end" && item.id === handoff.nextSeg) return { ...item, startX: x, startZ: z };
        if (which === "start" && item.id === handoff.prevSeg) return { ...item, endX: x, endZ: z };
        return item;
      });
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          segments,
          handoffs: reconcileHandoffs(segments, state.handoffs),
        },
      });
    },

    toggleCurve: (segmentId, pointId) => {
      const segment = get().state.segments.find((s) => s.id === segmentId);
      if (!segment) return;
      const points = segment.points ?? [];
      const index = points.findIndex((p) => p.id === pointId);
      if (index < 0) return;
      const next = points.map((point, i) =>
        i === index ? { ...point, shape: point.shape === "ARC" ? "LINE" : "ARC" } : point,
      ) as PathPoint[];
      patchSegment(segmentId, { points: normalizePathPointModes(next) });
      set({ selectedItem: segmentId, selectedPoint: pointId });
    },

    deletePoint: (segmentId, pointId) => {
      const segment = get().state.segments.find((s) => s.id === segmentId);
      if (!segment) return;
      const next = (segment.points ?? []).filter((point) => point.id !== pointId);
      patchSegment(segmentId, { points: normalizePathPointModes(next) });
      set({ selectedPoint: null });
    },

    addSegment: (objectId, afterSegmentId) => {
      const store = get();
      const { state } = store;
      // 团队路线归一：队员身上的建段请求全部落到锚点，整队只保留一条路线。
      const targetId = teamRouteOwner(state, objectId);
      // 防呆：对象不存在时不建段，避免产生孤儿路径（object 指向无主资产）。
      if (!state.objects.some((o) => o.id === targetId)) return;
      const objectSegments = state.segments
        .filter((segment) => segment.object === targetId)
        .sort((a, b) => a.timeStart - b.timeStart);
      const reference = afterSegmentId
        ? objectSegments.find((segment) => segment.id === afterSegmentId)
        : objectSegments[objectSegments.length - 1];
      let startX = 0;
      let startZ = 0;
      let timeStart = 0;
      let directionX = 1;
      let directionZ = 0;
      if (reference) {
        startX = reference.endX;
        startZ = reference.endZ;
        timeStart = reference.timeEnd;
        const deltaX = reference.endX - reference.startX;
        const deltaZ = reference.endZ - reference.startZ;
        const length = Math.hypot(deltaX, deltaZ);
        if (length > 0.001) {
          directionX = deltaX / length;
          directionZ = deltaZ / length;
        }
      } else {
        const object = state.objects.find((item) => item.id === objectId);
        startX = object?.x ?? 0;
        startZ = object?.z ?? 0;
        timeStart = 0;
      }
      const timeEnd = round1(Math.min(state.duration, Math.max(timeStart + 0.5, timeStart + 2)));
      const segment: MoveSegment = {
        id: nextSegmentId(state),
        type: "MOVE",
        object: targetId,
        startX: round1(startX),
        startZ: round1(startZ),
        endX: round1(startX + directionX * 2),
        endZ: round1(startZ + directionZ * 2),
        points: [],
        timeStart: round1(timeStart),
        timeEnd,
        ease: [0, 0, 1, 1],
      };
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          segments: [...state.segments, segment],
          handoffs: reconcileHandoffs([...state.segments, segment], state.handoffs),
        },
        selectedKind: "object",
        selectedId: targetId,
        selectedItem: segment.id,
        selectedPoint: null,
      });
    },

    setSegmentPoints: (segmentId, points) => {
      const store = get();
      const state = store.state;
      const segment = state.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      let counter = 0;
      const pts: PathPoint[] = points.map((point) => ({
        id: `pp_${Date.now().toString(36)}_${counter++}`,
        type: "path",
        shape: "LINE",
        x: round1(point.x),
        z: round1(point.z),
      }));
      const patch: Partial<MoveSegment> = { points: normalizePathPointModes(pts) };
      if (pts.length > 0) {
        patch.startX = pts[0].x;
        patch.startZ = pts[0].z;
        patch.endX = pts[pts.length - 1].x;
        patch.endZ = pts[pts.length - 1].z;
      }
      patchSegment(segmentId, patch);
    },

    drawAssetPath: (objectId, points) => {
      const store = get();
      const state = store.state;
      // 团队路线归一：给队员画路径 = 给整队画路径，落到锚点那唯一一条路线上。
      const targetId = teamRouteOwner(state, objectId);
      // 防呆：选中的对象已不存在时直接跳过，避免把轨迹写进无主资产（孤儿路径）。
      if (!state.objects.some((o) => o.id === targetId)) return;
      const objectSegments = state.segments
        .filter((item) => item.object === targetId)
        .sort((a, b) => a.timeStart - b.timeStart);
      let segment = objectSegments[objectSegments.length - 1];
      if (!segment) {
        store.addSegment(targetId, undefined);
        const after = get().state.segments
          .filter((item) => item.object === targetId)
          .sort((a, b) => a.timeStart - b.timeStart);
        segment = after[after.length - 1];
      }
      if (!segment) return;
      // 手绘是逐帧采样的，先抽稀再落库：只保留真正拐弯的关键点，避免几十个控制点堆在画布上。
      get().setSegmentPoints(segment.id, simplifyPath(points, HAND_DRAW_EPSILON));
      set({ selectedItem: segment.id });
    },

    setHandoffMode: (handoffId, mode) => {
      const store = get();
      const state = store.state;
      const handoff = state.handoffs.find((item) => item.id === handoffId);
      if (!handoff) return;
      // mode 本质是缓动曲线边界的便捷配置：不另写物理。
      const EASE_OUT: EaseCurve = [0, 0, 0.58, 1];
      const EASE_IN: EaseCurve = [0.42, 0, 1, 1];
      const LINEAR: EaseCurve = [0, 0, 1, 1];
      const segments = state.segments.map((segment) => {
        if (segment.id === handoff.prevSeg) {
          return { ...segment, ease: mode === "stop" ? EASE_OUT : mode === "smooth" ? LINEAR : segment.ease };
        }
        if (segment.id === handoff.nextSeg) {
          return { ...segment, ease: mode === "stop" ? EASE_IN : mode === "smooth" ? LINEAR : segment.ease };
        }
        return segment;
      });
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          segments,
          handoffs: state.handoffs.map((item) => (item.id === handoffId ? { ...item, mode } : item)),
        },
      });
    },

    setCameraJunctionMode: (junctionId, mode) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          cameraJunctions: store.state.cameraJunctions.map((item) =>
            item.id === junctionId ? { ...item, mode } : item,
          ),
        },
      })),

    deleteSegment: (segmentId) => {
      const store = get();
      const state = store.state;
      const segments = state.segments.filter((segment) => segment.id !== segmentId);
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          segments,
          handoffs: reconcileHandoffs(segments, state.handoffs),
        },
        selectedItem: store.selectedItem === segmentId ? null : store.selectedItem,
      });
    },

    setSegmentTime: (segmentId, start, end) => {
      const duration = get().state.duration;
      const nextStart = clamp(round1(start), 0, duration - 0.1);
      const nextEnd = clamp(round1(end), nextStart + 0.1, duration);
      patchSegment(segmentId, { timeStart: nextStart, timeEnd: nextEnd });
    },

    setConstraintTime: (constraintId, start, end) => {
      const duration = get().state.duration;
      const nextStart = clamp(round1(start), 0, duration - 0.1);
      const nextEnd = clamp(round1(end), nextStart + 0.1, duration);
      patchConstraint(constraintId, { timeStart: nextStart, timeEnd: nextEnd });
    },

    setSegmentEase: (segmentId, ease) => patchSegment(segmentId, { ease }),

    setSegmentSpeedKeys: (segmentId, keys) =>
      patchSegment(segmentId, { speedKeys: normalizeSpeedKeys(keys) ?? undefined }),

    addCamera: () => {
      const store = get();
      const { state } = store;
      const id = nextCameraId(state);
      const camera: CameraObject = {
        id,
        name: id,
        color: CAMERA_COLORS[state.cameras.length % CAMERA_COLORS.length],
        targetId: state.objects.find((object) => object.type === "actor")?.id ?? state.objects[0]?.id ?? "",
        framing: "medium",
        view: "eye_level",
        side: "back_3_4",
        lensMm: 50,
        motion: "FOLLOW",
        kind: "ground",
      };
      // 新相机自带一条初始运镜段，否则它默认是 FOLLOW 却没有任何 cameraMove，
      // timebar 的相机行里看不到 segment（drone / 模板相机都这么做了，这里保持一致）。
      const start = 0;
      const end = round1(Math.min(state.duration, start + Math.max(2, state.duration * 0.5)));
      const move: CameraMove = {
        id: nextCameraMoveId(state, id),
        camera: id,
        type: camera.motion,
        timeStart: start,
        timeEnd: end,
        targetId: camera.targetId,
        orbitDeg: 90,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      };
      const cameraMoves = [...state.cameraMoves, move];
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameras: [...state.cameras, camera],
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: id,
        selectedItem: move.id,
        activeCameraId: store.activeCameraId ?? id,
      });
    },

    addDroneCamera: () => {
      const store = get();
      const { state } = store;
      const id = nextCameraId(state);
      const camera: CameraObject = {
        id,
        name: id,
        color: CAMERA_COLORS[state.cameras.length % CAMERA_COLORS.length],
        targetId: state.objects.find((object) => object.type === "actor")?.id ?? state.objects[0]?.id ?? "",
        framing: "wide",
        view: "high",
        side: "back_3_4",
        lensMm: 24,
        motion: "DRONE",
        kind: "drone",
      };
      const start = 0;
      const end = round1(Math.min(state.duration, start + Math.max(2, state.duration * 0.5)));
      const move: CameraMove = {
        id: nextCameraMoveId(state, id),
        camera: id,
        type: "DRONE",
        timeStart: start,
        timeEnd: end,
        orbitDeg: 180,
        dollyScale: 1.4,
        craneHeight: 8,
        ease: [0.42, 0, 0.58, 1],
      };
      const cameraMoves = [...state.cameraMoves, move];
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameras: [...state.cameras, camera],
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: id,
        selectedItem: move.id,
        activeCameraId: store.activeCameraId ?? id,
      });
    },

    addCameraFromTemplate: (templateId) => {
      const store = get();
      const { state } = store;
      const template = findTemplate(templateId);
      if (!template) return;
      const id = nextCameraId(state);
      const actors = state.objects.filter((object) => object.role === "agent" || object.type === "actor");
      const pick = (refId?: string): string => {
        if (refId && state.objects.some((object) => object.id === refId)) return refId;
        return actors[0]?.id ?? state.objects[0]?.id ?? "";
      };
      const isOts = template.target.type === "OTS";
      // OTS：ref = [前景演员(shoulder), 主体(subject)]
      const shoulderId = isOts ? pick(template.target.ref[0]) : undefined;
      // 求解器需要参照点：LOCATION（环境 / 转场）无显式目标也锚到首个对象，避免空 targetId 崩溃。
      const targetId = pick(isOts ? template.target.ref[1] : template.target.ref[0]);
      const camera: CameraObject = {
        id,
        name: id,
        color: CAMERA_COLORS[state.cameras.length % CAMERA_COLORS.length],
        targetId,
        framing: template.framing,
        view: template.view,
        side: template.side,
        lensMm: template.lens,
        motion: template.motion,
        kind: template.kind ?? "ground",
        altitude: template.altitude,
        templateId: template.id,
        targetType: template.target.type,
        groupIds: template.target.type === "GROUP" ? [...template.target.ref] : undefined,
        roll: template.roll,
        otsSide: isOts ? "R" : undefined,
        otsOffset: isOts ? (template.otsOffset ?? 0.35) : undefined,
        shoulderId,
      };
      const duration = state.duration;
      const end = round1(Math.min(duration, Math.max(2, template.duration)));
      const move: CameraMove = {
        id: nextCameraMoveId(state, id),
        camera: id,
        type: template.motion,
        timeStart: 0,
        timeEnd: end,
        orbitDeg: template.orbitDeg ?? 0,
        dollyScale: template.dollyScale ?? 1,
        craneHeight: template.craneHeight ?? 0,
        panDeg: template.panDeg ?? 0,
        tiltDeg: template.tiltDeg ?? 0,
        truckDist: template.truckDist ?? 0,
        ease: [0.42, 0, 0.58, 1],
      };
      const cameraMoves = [...state.cameraMoves, move];
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameras: [...state.cameras, camera],
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: id,
        selectedItem: move.id,
        activeCameraId: store.activeCameraId ?? id,
      });
    },

    updateCamera: (cameraId, patch) =>
      set((store) => {
        const prev = store.state.cameras.find((c) => c.id === cameraId);
        const cameras = store.state.cameras.map((camera) =>
          camera.id === cameraId ? { ...camera, ...patch } : camera,
        );
        // 改「相机级 Target」时，把它同步给该相机的所有运镜段，使相机级 Target 成为主控：
        // camera view 里 active CameraMove 的 targetId 会覆盖相机级，故一并更新才能让跟随实时生效。
        // （某段想单独跟不同目标，可在该段的 Target 下拉里覆盖，但改相机级时会整体重设。）
        let cameraMoves = store.state.cameraMoves;
        if (patch.targetId !== undefined && prev && prev.targetId !== patch.targetId) {
          cameraMoves = cameraMoves.map((move) =>
            move.camera === cameraId ? { ...move, targetId: patch.targetId } : move,
          );
        }
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            cameras,
            cameraMoves,
          },
        };
      }),

    addCameraMove: (cameraId, type) => {
      const store = get();
      const { state } = store;
      const duration = state.duration;
      // 每段独立、互不重叠：新段插在播放头处，被夹在相邻两段之间。
      const atTime = clamp(round1(store.currentTime), 0, Math.max(0, duration - 0.5));
      const camera = state.cameras.find((c) => c.id === cameraId);
      const siblings = state.cameraMoves
        .filter((m) => m.camera === cameraId)
        .sort((a, b) => a.timeStart - b.timeStart);
      // 落在某条已有段内部 → 把它从播放头截断，本段接管后续时间。
      const host = siblings.find((m) => atTime > m.timeStart && atTime < m.timeEnd);
      // 播放头之后的第一条段，新段右端不能超过它的起点。
      const next = siblings.filter((m) => m.timeStart >= atTime).sort((a, b) => a.timeStart - b.timeStart)[0];

      let newStart = atTime;
      let newEnd = round1(Math.min(atTime + 2, duration));
      if (next) newEnd = round1(Math.min(newEnd, next.timeStart));
      if (newEnd - newStart < 0.5) {
        // 旁边没有空间，改放到该段之后，仍不与其重叠。
        newStart = next ? next.timeEnd : round1(duration - 0.5);
        newEnd = round1(Math.min(newStart + 2, duration));
        if (next) newEnd = Math.min(newEnd, next.timeEnd);
      }

      const cameraMoves = [...state.cameraMoves];
      if (host) {
        const hi = cameraMoves.findIndex((m) => m.id === host.id);
        if (hi >= 0) {
          if (atTime - host.timeStart < 0.05) {
            // 几乎压在起点：直接删除原段，新段从其起点接管。
            cameraMoves.splice(hi, 1);
            newStart = host.timeStart;
          } else {
            cameraMoves[hi] = { ...cameraMoves[hi], timeEnd: atTime };
          }
        }
      }

      const move: CameraMove = {
        id: nextCameraMoveId(state, cameraId),
        camera: cameraId,
        type,
        targetId: camera?.targetId,
        timeStart: newStart,
        timeEnd: newEnd,
        orbitDeg: 90,
        dollyScale: type === "DOLLY" ? 0.55 : 1,
        craneHeight: type === "CRANE" ? 3 : 0,
        ease: [0.42, 0, 0.58, 1],
      };
      cameraMoves.push(move);
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: cameraId,
        selectedItem: move.id,
      });
    },

    addOtsMove: (cameraId) => {
      const store = get();
      const { state } = store;
      const duration = state.duration;
      const atTime = clamp(round1(store.currentTime), 0, Math.max(0, duration - 0.5));
      const camera = state.cameras.find((c) => c.id === cameraId);
      const siblings = state.cameraMoves
        .filter((m) => m.camera === cameraId)
        .sort((a, b) => a.timeStart - b.timeStart);
      const host = siblings.find((m) => atTime > m.timeStart && atTime < m.timeEnd);
      const next = siblings.filter((m) => m.timeStart >= atTime).sort((a, b) => a.timeStart - b.timeStart)[0];

      let newStart = atTime;
      let newEnd = round1(Math.min(atTime + 2, duration));
      if (next) newEnd = round1(Math.min(newEnd, next.timeStart));
      if (newEnd - newStart < 0.5) {
        newStart = next ? next.timeEnd : round1(duration - 0.5);
        newEnd = round1(Math.min(newStart + 2, duration));
        if (next) newEnd = Math.min(newEnd, next.timeEnd);
      }

      const cameraMoves = [...state.cameraMoves];
      if (host) {
        const hi = cameraMoves.findIndex((m) => m.id === host.id);
        if (hi >= 0) {
          if (atTime - host.timeStart < 0.05) {
            cameraMoves.splice(hi, 1);
            newStart = host.timeStart;
          } else {
            cameraMoves[hi] = { ...cameraMoves[hi], timeEnd: atTime };
          }
        }
      }

      // 过肩：前景自动挑一个非主体的演员；不足 2 名演员时不应调用（UI 已禁用）。
      const shoulderId =
        camera?.shoulderId ??
        state.objects.find((o) => o.type === "actor" && o.id !== camera?.targetId)?.id;
      const move: CameraMove = {
        id: nextCameraMoveId(state, cameraId),
        camera: cameraId,
        type: "FOLLOW",
        targetType: "OTS",
        targetId: camera?.targetId,
        shoulderId,
        otsSide: camera?.otsSide ?? "R",
        timeStart: newStart,
        timeEnd: newEnd,
        orbitDeg: 90,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      };
      cameraMoves.push(move);
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: cameraId,
        selectedItem: move.id,
      });
    },

    addReverseShot: (moveId) => {
      const store = get();
      const { state } = store;
      const src = state.cameraMoves.find((m) => m.id === moveId);
      if (!src) return;
      const camera = state.cameras.find((c) => c.id === src.camera);
      if (!camera) return;
      // 正反打：前景与主体互换、肩侧翻转，从而落在动作轴线的同一侧。
      const newShoulder = src.targetId ?? camera.targetId;
      const newTarget = src.shoulderId;
      if (!newShoulder || !newTarget || newShoulder === newTarget) return;
      const flip = (s?: OtsSide): OtsSide => (s === "L" ? "R" : "L");
      const newSide = flip(src.otsSide ?? camera.otsSide ?? "R");
      // 放在源段之后，不与同相机其它段重叠。
      const sibs = state.cameraMoves
        .filter((m) => m.camera === src.camera)
        .sort((a, b) => a.timeStart - b.timeStart);
      const atTime = src.timeEnd;
      const next = sibs.filter((m) => m.timeStart >= atTime).sort((a, b) => a.timeStart - b.timeStart)[0];
      let newStart = atTime;
      let newEnd = round1(Math.min(atTime + (src.timeEnd - src.timeStart), state.duration));
      if (next) newEnd = round1(Math.min(newEnd, next.timeStart));
      if (newEnd - newStart < 0.5) {
        newStart = next ? next.timeEnd : round1(state.duration - 0.5);
        newEnd = round1(Math.min(newStart + 2, state.duration));
        if (next) newEnd = Math.min(newEnd, next.timeEnd);
      }
      const move: CameraMove = {
        id: nextCameraMoveId(state, src.camera),
        camera: src.camera,
        type: "FOLLOW",
        targetType: "OTS",
        targetId: newTarget,
        shoulderId: newShoulder,
        otsSide: newSide,
        timeStart: newStart,
        timeEnd: newEnd,
        orbitDeg: 90,
        dollyScale: 1,
        craneHeight: 0,
        ease: src.ease,
      };
      const cameraMoves = [...state.cameraMoves, move];
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: src.camera,
        selectedItem: move.id,
      });
    },

    setCameraMoveTime: (moveId, start, end) => {
      const store = get();
      const duration = store.state.duration;
      const self = store.state.cameraMoves.find((m) => m.id === moveId);
      if (!self) return;
      let nextStart = clamp(round1(start), 0, duration - 0.1);
      let nextEnd = clamp(round1(end), nextStart + 0.1, duration);
      // 不与同相机其它段重叠：把本段夹在相邻两段之间。
      const sibs = store.state.cameraMoves
        .filter((m) => m.camera === self.camera && m.id !== moveId)
        .sort((a, b) => a.timeStart - b.timeStart);
      const prev = sibs.filter((m) => m.timeEnd <= nextStart + 1e-6).sort((a, b) => b.timeEnd - a.timeEnd)[0];
      const next = sibs.filter((m) => m.timeStart >= nextEnd - 1e-6).sort((a, b) => a.timeStart - b.timeStart)[0];
      if (prev) nextStart = Math.max(nextStart, round1(prev.timeEnd));
      if (next) nextEnd = Math.min(nextEnd, round1(next.timeStart));
      if (nextEnd - nextStart < 0.1) nextEnd = Math.min(duration, nextStart + 0.1);
      patchCameraMove(moveId, { timeStart: nextStart, timeEnd: nextEnd });
    },

    setCameraMoveEase: (moveId, ease) => patchCameraMove(moveId, { ease }),

    setCameraMoveSpeedKeys: (moveId, keys) =>
      patchCameraMove(moveId, { speedKeys: normalizeSpeedKeys(keys) ?? undefined }),

    patchCameraMove: (moveId, patch) => patchCameraMove(moveId, patch),

    deleteCameraMove: (moveId) =>
      set((store) => {
        const cameraMoves = store.state.cameraMoves.filter((move) => move.id !== moveId);
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            cameraMoves,
            cameraJunctions: reconcileCameraJunctions(cameraMoves, store.state.cameraJunctions),
          },
          selectedItem: store.selectedItem === moveId ? null : store.selectedItem,
        };
      }),

    addCameraKey: (moveId, t) => addCameraKey(moveId, t),

    updateCameraKey: (moveId, keyId, patch) => updateCameraKey(moveId, keyId, patch),

    deleteCameraKey: (moveId, keyId) => deleteCameraKey(moveId, keyId),

    clearCameraKeys: (moveId) => setMoveKeys(moveId, null),

    removeCamera: (cameraId) =>
      set((store) => {
        const cameraMoves = store.state.cameraMoves.filter((move) => move.camera !== cameraId);
        const nextActive =
          store.activeCameraId === cameraId
            ? (store.state.cameras.find((c) => c.id !== cameraId)?.id ?? null)
            : store.activeCameraId;
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            cameras: store.state.cameras.filter((camera) => camera.id !== cameraId),
            cameraMoves,
            cameraJunctions: reconcileCameraJunctions(cameraMoves, store.state.cameraJunctions),
          },
          activeCameraId: nextActive,
          selectedKind: store.selectedKind === "camera" && store.selectedId === cameraId ? "object" : store.selectedKind,
          selectedId: store.selectedKind === "camera" && store.selectedId === cameraId ? "" : store.selectedId,
          selectedItem: store.selectedItem,
        };
      }),

    setAspectRatio: (ratio) =>
      set((store) => ({
        state: { ...store.state, revision: store.state.revision + 1, aspectRatio: ratio },
      })),

    setDuration: (seconds) =>
      set((store) => {
        const current = store.state;
        if (!Number.isFinite(seconds)) return {};
        // 下限只取 1s：Scene Duration 是「成片长度」，不是「内容长度」。
        // 以前把它钳到内容末尾（rawContentEnd），于是只要还有片段排在后面就永远调不小，
        // 表现就是「往小了设置不起作用」。调小只是让超出部分不参与播放 / 导出，
        // 片段本身不会被删掉，把时长调回去它们就又回来了。
        const duration = clamp(round1(seconds), 1, 600);
        if (duration === current.duration) return {};
        return {
          state: { ...current, revision: current.revision + 1, duration },
          currentTime: Math.min(store.currentTime, duration),
        };
      }),

    addAction: (objectId, time) => {
      const store = get();
      const { state } = store;
      const start = round1(time ?? store.currentTime);
      const end = round1(Math.min(state.duration, start + 2));
      const clip: ActionClip = {
        id: nextActionId(state),
        object: objectId,
        timeStart: start,
        timeEnd: end,
        kind: "wave",
      };
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          actions: [...(state.actions ?? []), clip],
        },
        selectedKind: "object",
        selectedId: objectId,
        selectedItem: clip.id,
        radialTarget: null,
      });
    },

    setActionTime: (actionId, start, end) => {
      const duration = get().state.duration;
      const nextStart = clamp(round1(start), 0, duration - 0.1);
      const nextEnd = clamp(round1(end), nextStart + 0.1, duration);
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          actions: (store.state.actions ?? []).map((a) =>
            a.id === actionId ? { ...a, timeStart: nextStart, timeEnd: nextEnd } : a,
          ),
        },
      }));
    },

    setActionTimes: (entries) => {
      const duration = get().state.duration;
      if (entries.length === 0) return;
      // 先算好每条的目标区间（逐条夹取，规则与 setActionTime 一致），再一次性写回。
      const targets = new Map<string, { timeStart: number; timeEnd: number }>();
      entries.forEach((entry) => {
        const timeStart = clamp(round1(entry.timeStart), 0, duration - 0.1);
        targets.set(entry.id, {
          timeStart,
          timeEnd: clamp(round1(entry.timeEnd), timeStart + 0.1, duration),
        });
      });
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          actions: (store.state.actions ?? []).map((action) => {
            const target = targets.get(action.id);
            return target ? { ...action, ...target } : action;
          }),
        },
      }));
    },

    updateAction: (actionId, patch) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          actions: (store.state.actions ?? []).map((a) =>
            a.id === actionId ? { ...a, ...patch } : a,
          ),
        },
      })),

    saveCustomAction: (name, joints, id) => {
      const store = get();
      const list = store.state.customActions ?? [];
      const trimmed = name.trim();
      const targetId = id ?? nextCustomActionId(store.state);
      const record = { id: targetId, name: trimmed, joints };
      const next = list.some((p) => p.id === targetId)
        ? list.map((p) => (p.id === targetId ? record : p))
        : [...list, record];
      set({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          customActions: next,
        },
      });
      return targetId;
    },

    deleteCustomAction: (id) =>
      set((store) => {
        const list = store.state.customActions ?? [];
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            customActions: list.filter((p) => p.id !== id),
            // 引用它的片段退回标准站姿，避免出现悬空 customId。
            actions: (store.state.actions ?? []).map((a) =>
              a.customId === id ? { ...a, kind: "stand" as ActionKind, customId: undefined } : a,
            ),
          },
        };
      }),

    deleteAction: (actionId) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          actions: (store.state.actions ?? []).filter((a) => a.id !== actionId),
        },
        selectedItem: store.selectedItem === actionId ? null : store.selectedItem,
      })),

    executeIntent: (objectId, action) => {
      const store = get();
      const { state } = store;
      const object = state.objects.find((o) => o.id === objectId);
      if (!object) return;
      const time = store.currentTime;
      const duration = state.duration;

      if (action === "FOLLOW" || action === "LOOK AT") {
        const target = state.objects.find((o) => o.id !== objectId && o.type === "actor");
        if (!target) return;
        const constraint: Constraint = {
          id: nextConstraintId(state, action === "FOLLOW" ? "FOLLOW" : "LOOK"),
          type: action === "FOLLOW" ? "FOLLOW" : "LOOK_AT",
          subject: objectId,
          target: target.id,
          timeStart: round1(time),
          timeEnd: round1(Math.min(duration, time + 5)),
        };
        set({
          state: {
            ...state,
            revision: state.revision + 1,
            constraints: [...state.constraints, constraint],
          },
          selectedKind: "object",
          selectedId: objectId,
          selectedItem: constraint.id,
          radialTarget: null,
        });
        return;
      }

      if (action === "MOVE") {
        // 团队路线归一：给队员加 MOVE = 给整队加 MOVE，落到锚点那唯一一条路线上。
        const routeId = teamRouteOwner(state, objectId);
        const own = state.segments
          .filter((s) => s.object === routeId)
          .sort((a, b) => a.timeEnd - b.timeEnd);
        const last = own[own.length - 1];
        let start: Vec2 = { x: object.x, z: object.z };
        let timeStart = time;
        const direction: Vec2 = { x: 1, z: 0 };

        if (last && time >= last.timeStart) {
          start = { x: last.endX, z: last.endZ };
          timeStart = Math.max(time, last.timeEnd);
          const dx = last.endX - last.startX;
          const dz = last.endZ - last.startZ;
          const len = Math.hypot(dx, dz);
          if (len > 0.001) {
            direction.x = dx / len;
            direction.z = dz / len;
          }
        }

        const timeEnd = round1(Math.min(duration, Math.max(timeStart + 0.5, timeStart + 2.2)));
        const segment: MoveSegment = {
          id: nextSegmentId(state),
          type: "MOVE",
          object: routeId,
          startX: round1(start.x),
          startZ: round1(start.z),
          endX: round1(start.x + direction.x * 5),
          endZ: round1(start.z + direction.z * 5),
          points: [],
          timeStart: round1(timeStart),
          timeEnd,
          ease: [0, 0, 1, 1],
        };
        set({
          state: {
            ...state,
            revision: state.revision + 1,
            segments: [...state.segments, segment],
          },
          selectedKind: "object",
          selectedId: routeId,
          selectedItem: segment.id,
          radialTarget: null,
        });
        return;
      }

      if (action === "STOP") {
        const active = state.constraints.find(
          (q) => q.subject === objectId && time >= q.timeStart && time <= q.timeEnd,
        );
        if (active) {
          patchConstraint(active.id, { timeEnd: Math.max(active.timeStart + 0.1, round1(time)) });
        }
        set({ radialTarget: null, selectedItem: active?.id ?? null });
        return;
      }

      if (action === "CHANGE PATH") {
        const segment =
          state.segments.find(
            (s) => s.object === objectId && time >= s.timeStart && time <= s.timeEnd,
          ) ?? state.segments.find((s) => s.object === objectId);
        set({ radialTarget: null, selectedItem: segment?.id ?? "CHANGE PATH" });
        return;
      }

      if (action === "ACTION" || action === "ADD ACTION") {
        const start = round1(time);
        const end = round1(Math.min(duration, start + 2));
        const clip: ActionClip = {
          id: nextActionId(state),
          object: objectId,
          timeStart: start,
          timeEnd: end,
          kind: "wave",
        };
        set({
          state: {
            ...state,
            revision: state.revision + 1,
            actions: [...(state.actions ?? []), clip],
          },
          // 互斥选择：新建动作片段后只选中该片段（时间轴轴），清掉对象选中（对象轴）。
          // 否则同一次 set 同时设了两轴，订阅里的互斥清理会把刚建的片段又清掉。
          selectedItem: clip.id,
          selectedKind: undefined,
          selectedId: "",
          radialTarget: null,
        });
        return;
      }

      set({ radialTarget: null, selectedItem: action });
    },

    undo: () => {
      const { past, future, state } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      lastEditTime = 0;
      rawSet({
        state: previous,
        past: past.slice(0, -1),
        future: [state, ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { past, future, state } = get();
      if (future.length === 0) return;
      const nextState = future[0];
      lastEditTime = 0;
      rawSet({
        state: nextState,
        past: [...past, state].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },
  };
});

// —— 互斥选择（对象 / 相机 轴 与 时间轴片段 轴 永远只有一个有效选中）——
// 任一轴被「设成有效选中」时，清空另一轴，避免 Inspector 同时承载两个不同域的选中物
// （如「路中石墩」与「SEG_02」被拼进同一行、误导为同一个选中物）。
// 用订阅统一兜底：所有设置选中态的入口（selectObject / selectItem / 径向菜单 / 导入 等）都自动互斥，
// 不必在每个调用点手动清另轴。订阅内再触发一次 setState 会被上面的分支守卫挡住，不会死循环。
useDirectorStore.subscribe((state, prev) => {
  const idChanged = state.selectedId !== prev.selectedId;
  const itemChanged = state.selectedItem !== prev.selectedItem;
  if (idChanged && state.selectedId) {
    // 对象 / 相机 被新选中 → 清时间轴选中。
    if (state.selectedItem) useDirectorStore.setState({ selectedItem: null, selectedPoint: null });
  } else if (itemChanged && state.selectedItem) {
    // 时间轴片段被新选中 → 清对象 / 相机选中。
    // 但「路径段」(MoveSegment) 是对象路径编辑的一部分（点路径点会 selectItem(segment.id)），
    // 必须保留对象选中，否则 selectedObjectId 变 null、PathHandles 不渲染、CURVE 按钮出不来。
    const isSegment = (state.state?.segments ?? []).some((s) => s.id === state.selectedItem);
    if ((state.selectedId || state.selectedKind) && !isSegment) {
      useDirectorStore.setState({ selectedKind: undefined, selectedId: "" });
    }
  }
});
