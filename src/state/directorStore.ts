import { create } from "zustand";
import {
  AspectRatio,
  CameraFraming,
  CameraJunction,
  CameraKey,
  CameraMove,
  CameraMotionType,
  CameraObject,
  CameraPathPoint,
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
  NameVisibility,
  OtsSide,
  PathPoint,
  SpeedKey,
  StageManifest,
  ActionClip,
  ActionKind,
  Pose,
  Vec2,
  VerticalArc,
  ViewMode,
  WorldMode,
} from "../domain/schema";
import { createBlankState } from "../engine/demoShot";
import { normalizePathPointModes, pathInsertIndex, simplifyPath } from "../engine/path";
import { normalizeCamPathShapes } from "../engine/cameraPath";
import { contentEndTime } from "../engine/timeline";
import { normalizeCameraKeys, normalizeEase, normalizeSpeedKeys } from "../engine/ease";
import { ASSET_PRESETS } from "../engine/assetPresets";
import { objectTop } from "../engine/ground";
import { nameVisible } from "../engine/nameVisibility";
import { placeObject } from "../engine/place";
import { DEFAULT_STAIR_WIDTH, insertBend, planStairLink } from "../engine/stairLink";
import { planStairWalk, StairWalkDirection } from "../engine/stairWalk";
import { settleStack, stackChain } from "../engine/stack";
import { arraySlots, ArraySpec } from "../engine/array";
import { DragReachHint } from "../engine/reach";
import { JUMP_EASE, rewriteArcApex } from "../engine/arc";
import { ANIMAL_MODELS, DEFAULT_ANIMAL_SPECIES } from "../engine/animalModels";
import {
  AnimalSpecies,
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

/**
 * 顶面形状（flat / ramp / stair）与抽象楼梯是**盒子几何**的一部分，只对环境资产
 * （`role: "set"`）有意义：它和 `bottom` 一起定义那个盒子怎么占空间，下游由
 * `ground` / `raycast` / `occlusion` / `stack` / `stair*` 一起读。
 *
 * human / animal / vehicle 是人物与载具，渲染走骨骼 / 模型（`WorldView` 的 `blockBody`），
 * 挂着 `topShape` / `stair` 只会让"看到的盒子"和"实际的物理"两套说法打架
 * （载具甚至会被真画成一段楼梯网格）。UI 已不再提供入口，这里把**任何来源**的历史数据
 * 一并清掉，使下游不必再各自判一次。
 */
function stripAgentTopShape(objects: DirectorObject[]): DirectorObject[] {
  let changed = false;
  const next = objects.map((object) => {
    if (object.role === "set" || (object.topShape === undefined && object.stair === undefined)) {
      return object;
    }
    changed = true;
    return { ...object, topShape: undefined, stair: undefined };
  });
  // 没脏数据就返回原引用：zustand 选择器按引用比较，凭空造新数组会引发整树重渲染。
  return changed ? next : objects;
}

/** 上面那条规则的**状态级**包装：没有脏数据时不产生新对象。 */
function stripAgentTopShapeFromState(s: DirectorState): DirectorState {
  if (!Array.isArray(s.objects)) return s;
  const objects = stripAgentTopShape(s.objects);
  return objects === s.objects ? s : { ...s, objects };
}

function saveSceneState(id: string, state: DirectorState): void {
  try {
    if (typeof localStorage !== "undefined") {
      // 写盘是**唯一**出口：在这一刀清干净，任何来源的脏数据都进不了存档
      // （读盘侧 `sanitizeState` 再清一道，两边各自独立成立，不互相依赖）。
      localStorage.setItem(sceneKey(id), JSON.stringify(stripAgentTopShapeFromState(state)));
    }
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
      // 示例源也过一遍清洗：老示例若带脏数据，写进存档的内容才与记录的"写入指纹"一致
      // （否则 saveSceneState 那一刀会让指纹与实际内容对不上，被误判成"用户改过"）。
      scenes[tab.id] = stripAgentTopShapeFromState(st);
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
 * 本地场景一次性清扫：历史版本允许给**任意**对象设「顶面形状 / 抽象楼梯」，而它只对环境资产
 * （`role: "set"`）有意义（见 `stripAgentTopShape`）。这里把 manifest 里的**每一页**都过一遍 ——
 * 只清"当前打开的那一页"会把其它页面的脏数据留着。
 *
 * **只动真的脏了的页**：干净的页一个字都不写。重写内容会让示例页的"写入指纹"对不上，
 * 而 `syncExamples` 正是据此判定"用户改过"并**永久停止自动同步** —— 一个纯粹的清理动作
 * 不该有这个副作用。
 *
 * 标记位保证只跑一次；此后新数据在写盘那一刻就被 `saveSceneState` 清掉了。
 */
const TOP_SHAPE_SWEEP_KEY = "director-desk-sweep-topshape-v1";

function sweepAgentTopShape(order: StageManifest["order"]): void {
  if (lsGet(TOP_SHAPE_SWEEP_KEY)) return;
  for (const tab of order) {
    const raw = lsGet(sceneKey(tab.id));
    if (raw === null) continue;
    let parsed: DirectorState;
    try {
      parsed = JSON.parse(raw) as DirectorState;
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.objects)) continue;
    const objects = stripAgentTopShape(parsed.objects);
    if (objects === parsed.objects) continue; // 干净 → 一个字都不动
    saveSceneState(tab.id, { ...parsed, objects });
  }
  lsSet(TOP_SHAPE_SWEEP_KEY, "1");
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
    // 历史存档里「非环境资产却带顶面形状 / 楼梯」的脏页一次性清掉（只跑一次，见该函数）。
    sweepAgentTopShape(order);
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
export type RadialTarget = { kind: "object" | "point" | "cameraPoint"; id: string };

/** 光标当前悬停的路径标记（转折点 / 起终点把手）。
 *  纯视觉反馈：让「这个把手现在能不能点中」先看得见，命中判定仍由 WorldView 决定。 */
export type MarkerHover =
  | { kind: "point"; segmentId: string; id: string }
  | { kind: "endpoint"; segmentId: string; id: "start" | "end" }
  | { kind: "cameraPoint"; id: string }
  | { kind: "stairPoint"; id: string };

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
  /** 当前选中的相机关键帧 id（时间轴 / Inspector 共享；纯 UI 状态，不进历史）。 */
  selectedKeyId: string | null;
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
  /**
   * 拖拽 / 拖放途中按住了 Shift = 本次操作强制按 3D 语义落位。
   *
   * 纯 UI 提示用（点亮 3D 开关、显示徽标），**不参与几何** —— 真正的覆盖
   * 由画布把这个按键状态直接传给 `moveObject` / `addAsset`（见 `engine/worldMode`）。
   * 之所以不进 `state`：它是手势的瞬时状态，不该被存盘、也不该进 undo 历史。
   */
  terrainGesture: boolean;
  /**
   * 拖拽途中的可达性即时反馈（docs/3d/03 §6）。
   *
   * 纯 UI 状态：不进 `state`、不进 undo 历史（与 `hoverMarker` 同样的理由）。
   * 之所以挂在 store 而不是画布组件内部：判定的**输入**在 `Interaction`（它知道
   * 拖的是哪个把手），而**消费方**在 `PathHandles` / tooltip / 外层光标 ——
   * 跨组件共享一次判定，比让三处各算一遍可靠得多（这正是 `reach.ts` 存在的理由）。
   */
  dragReach: DragReachHint | null;

  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  setZoom: (zoom: number) => void;
  setViewMode: (mode: ViewMode) => void;
  /** 切换平面 / 立体世界。planar = 老行为（一切在 y=0），terrain = 启用堆叠与落脚高度。 */
  setWorldMode: (mode: WorldMode) => void;
  /**
   * 场景级名字开关（三态，见 `DirectorState.showNames`）：
   * `"on"` / `"off"` = 场景接管；`"default"` = 把控制权交给个体。
   */
  setShowNames: (show: NameVisibility) => void;
  /** 个体级：切换某个对象的 `showName`（三态里只写 true / false，不写回"跟随场景"）。 */
  toggleShowName: (objectId: string) => void;
  /** 个体级：切换某个相机的 `showName`（与对象同语义，见 CameraObject.showName）。 */
  toggleCameraShowName: (cameraId: string) => void;
  setActiveCamera: (cameraId: string) => void;
  toggleViewLocked: () => void;
  togglePathDraw: () => void;
  setDragging: (dragging: boolean) => void;
  /** 设置「本次手势按住 Shift」提示状态。只在值变化时写入，避免拖拽途中刷爆 store。 */
  setTerrainGesture: (on: boolean) => void;
  /** 更新拖拽可达性提示。拖拽结束传 null。 */
  setDragReach: (hint: DragReachHint | null) => void;

  selectObject: (objectId: string) => void;
  selectCamera: (cameraId: string) => void;
  selectItem: (itemId: string | null) => void;
  selectPoint: (pointId: string | null) => void;
  selectCameraKey: (keyId: string | null) => void;
  setHoverMarker: (marker: MarkerHover | null) => void;
  openRing: (objectId: string) => void;
  /** 轻点路径转折点打开环形菜单（Line/Curve 切换 + 删除），与对象环形菜单共用同一套 UI。 */
  openPointRing: (pointId: string) => void;
  /** 轻点相机 PATH 路径点打开环形菜单（删除），与人物路径点一致。 */
  openCameraPointRing: (pointId: string) => void;
  closeRing: () => void;

  /**
   * 拖动对象到 (x, z)。
   * @param layerY 画布射线拾取到的"指针正指着的那一层"（优先于按 x/z 反查）。
   * @param forceTerrain 本次拖拽强制按 3D 语义落位（按住 Shift）。见 `engine/worldMode`。
   */
  moveObject: (objectId: string, x: number, z: number, layerY?: number, forceTerrain?: boolean) => void;
  /** 调整对象在时间轴 / Scene Tree 中的行顺序：把 dragId 移到 targetId 所在的位置。 */
  reorderObject: (dragId: string, targetId: string) => void;
  /** 锁定 / 解锁资产：锁定后不可通过拖拽移动位置（防误触），仍可点选以便解锁。 */
  toggleLock: (id: string) => void;
  /**
   * 新增资产。
   * @param at 落点。`y` = 射线拾取到的层高；`terrain` = 本次拖放强制按 3D 语义（按住 Shift）。
   */
  addAsset: (
    category: AssetCategory,
    at?: { x: number; z: number; y?: number; terrain?: boolean },
    species?: AnimalSpecies,
  ) => void;
  /**
   * 拖入一个「团队 Group」：一次生成 count 个同类资产并建组，整队共用一条路线
   * （锚点 = members[0]），队员按 formation 跟随。
   *
   * `at.terrain` = 松手时按着 Shift（手势级 3D 覆盖，见 `engine/worldMode`）：
   * 每个队员都按 terrain 语义落到落点处最高的可站立面上。
   */
  addGroupAt: (
    category: AssetCategory,
    count: number,
    formation: FormationKind,
    at?: { x: number; z: number; y?: number; terrain?: boolean },
    species?: AnimalSpecies,
  ) => void;
  /**
   * 阵列：把指定对象批量复制成一排 / 一片 / 一圈 / 一段台阶。
   *
   * `spec.count` 是**总数（含源对象自身）** —— 与 Blender 数组修改器同义：
   * count=3 会产出"源 + 2 个副本"共 3 个。每个副本独立走 `placeObject` 落位，
   * 所以它们在地形世界里会自动各自贴到脚下的台面上，不会悬空也不会陷进地里。
   *
   * @param sourceId 源对象。它自己不动，副本从 lineup 的第 2 个槽位开始。
   * @param spec 阵列规格，见 `engine/array.ts`。
   */
  arrayAsset: (sourceId: string, spec: ArraySpec) => void;
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
  /**
   * 手绘路径（**抽象楼梯**）：抽稀后写成这条楼梯自己的水平路线（`stair.path`）。
   *
   * 与 `drawAssetPath` **同一套手势、同一个抽稀器**，区别只在"写进哪里"：
   * 资产画的是"它要走的路"（MOVE segment），楼梯画的是"它自己"（见 docs/3d/00 §9.15）。
   */
  drawStairPath: (objectId: string, points: { x: number; z: number }[]) => void;

  /**
   * 环形菜单「台阶」选中后进入的**选目标**模式：值 = 起点高台的 id，`null` = 未进入。
   * 进入后画布上的一次点击就是目标（另一个高台或地面），由 `linkStairTo` 生成台阶。
   */
  stairLinkFrom: string | null;
  /**
   * 选目标模式下的提示 / 拒绝理由（挂在那一处上方）。`null` = 无。
   * `tone` 只决定画成提示（蓝）还是拒绝（红）—— 拒绝不是失败态，改一下落点就继续。
   */
  pickHint: { at: [number, number, number]; text: string; tone: "hint" | "refuse" } | null;
  /** 进入选目标模式（环形菜单的「台阶」）。 */
  beginStairLink: (objectId: string) => void;
  /** 退出（Esc / 生成完成 / 起点已被删）：模式与草稿一起清掉。 */
  cancelStairLink: () => void;
  /**
   * 「走上去 / 走下来」选目标模式：值 = 要安排走路的演员 + 方向，`null` = 未进入。
   * 进入后画布上的一次点击就是**楼梯**，路线由 `planStairWalk` 生成
   * （坡度 / 宽度按**他自己的**能力表判，所以同一条楼梯对不同主体结论可能不同）。
   */
  walkPick: { actorId: string; direction: StairWalkDirection } | null;
  /** 进入走楼梯模式（环形菜单的「走上去」/「走下来」挂在演员上）。 */
  beginWalkPick: (actorId: string, direction: StairWalkDirection) => void;
  /**
   * 让 `walkPick` 里那个演员走这条楼梯：复用/新建它最后一条 MOVE 段并写入路线，
   * 同时把他的**层高**设成路线起点的高度 —— 不设的话向下走会从地面起步、整段穿过楼梯
   * （见 `engine/stairWalk` 的模块说明）。
   */
  assignStairWalk: (stairId: string) => void;
  /**
   * 选定目标：`targetId` 非空 = 另一个高台，空 = 地面上的 `(x, z)`。
   *
   * 选定后进入**预览**（虚线 + 可加点）而不是直接生成 —— 生成是 `commitStair`。
   * 只有**语义**问题会挡住（目标是自己 / 可运动资产 / 已是楼梯）；几何问题（太陡等）
   * 照样进预览，因为"加个转折点拉长它"正是解决它的方式。
   */
  pickStairTarget: (targetId: string | null, x: number, z: number) => void;
  /** 预览里加一个转折点（插在离它最近的那一段之后，与路径点"线上加点"同一手感）。 */
  addStairBend: (x: number, z: number) => void;
  /** 改台阶宽度（米）。比人的脚宽还窄会被 `planStairLink` 拒绝生成。 */
  setStairWidth: (width: number) => void;
  /** 按当前折线生成台阶。几何不合法时只报告，模式与折线都不变。 */
  commitStair: () => void;
  /**
   * 预览草稿：目标 + 落点 + 作者加的转折点 + 宽度。
   *
   * **折线不在这里存** —— 它是 `planStairLink` 每次由这四样重算出来的，于是
   * "看到的虚线"与"生成的楼梯"不可能分叉（同一样东西只能有一个出处）。
   */
  stairDraft: {
    targetId: string | null;
    point: { x: number; z: number };
    bends: Array<{ x: number; z: number }>;
    /** 走廊宽度（米）= 落库时的 `footprint.w`。人能通过的基本条件。 */
    width: number;
  } | null;
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
  /**
   * 写入 / 清除垂直弧线（跳跃 / 落差 / 攀爬）。
   *
   * 传 `null` 表示清除弧线（退回"高度由地面派生"的瞬时对齐）。
   * 写入弧线时**同时把该段 ease 覆盖成准线性**（`JUMP_EASE`）——
   * 默认 cubic-bezier 在 u=0 处斜率为 0，人会在原地弹起原地落下，看起来不像跳跃。
   * 这是"跳跃段内强制准线性水平速度"落地为**一个原子 store 动作**的地方（docs/3d/02 §5）。
   */
  setSegmentArc: (segmentId: string, arc: VerticalArc | null) => void;

  /**
   * 仅改写抛物线弧线的顶点高度 `apex`（作者旋钮），**不动 ease**、不清其他字段。
   * 时间轴 mini 弓形的顶点拖拽走这里 —— 每次 pointermove 都触发，所以必须轻量：
   * 不能像 `setSegmentArc` 那样顺手把 ease 覆盖成 JUMP_EASE（那会拖一下就清掉作者调过的手感）。
   */
  setSegmentArcApex: (segmentId: string, apex: number) => void;

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
        | "followJumpHeight"
        | "autoFocus"
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
  addCameraPathPoint: (moveId: string, x: number, y: number, z: number) => void;
  /** 在指定位置插入一个相机路径点（按住路径拖动加点），返回新点 id。 */
  insertCameraPathPoint: (
    moveId: string,
    x: number,
    y: number,
    z: number,
    insertAt: number,
  ) => string | null;
  moveCameraPathPoint: (moveId: string, pointId: string, x: number, y: number, z: number) => void;
  deleteCameraPathPoint: (moveId: string, pointId: string) => void;
  /** 切换相机路径中间点的折线 / 曲线（首尾端点不可）。 */
  toggleCameraPathCurve: (moveId: string, pointId: string) => void;
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

/* ---------------------------------------- 高台连台阶（对象环形菜单的「台阶」） */

/** 连出来的台阶的 id（与 `addAsset` 同一套前缀风格，一眼看得出是"连出来的"）。 */
function nextStairId(state: DirectorState): string {
  let index = state.objects.filter((o) => o.id.startsWith("AST_STAIR_")).length + 1;
  let id = `AST_STAIR_${String(index).padStart(2, "0")}`;
  while (state.objects.some((o) => o.id === id)) {
    index += 1;
    id = `AST_STAIR_${String(index).padStart(2, "0")}`;
  }
  return id;
}

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

/** PATH 段的初始折线：横跨相机目标前方的一条 2 点直线（无目标时以原点为锚）。 */
function seedCameraPathPoints(moveId: string, cameraId: string, state: DirectorState): CameraPathPoint[] {
  const target = state.objects.find((o) => o.id === state.cameras.find((c) => c.id === cameraId)?.targetId);
  const bx = target?.x ?? 0;
  const bz = target?.z ?? 0;
  return [
    { id: `${moveId}_P1`, x: bx + 4, y: 1.6, z: bz + 3 },
    { id: `${moveId}_P2`, x: bx - 4, y: 1.6, z: bz + 3 },
  ];
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
    // 非环境资产不该带顶面形状 / 抽象楼梯（见 stripAgentTopShape）：历史存档与手工 JSON 都可能残留。
    objects: stripAgentTopShape(s.objects),
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

/*
 * 「放在 (x, z)，该落在多高的面上」以及「按该层高做水平分离」——
 * 这两件事连同它们的**先后顺序**一起搬到了 `engine/place.ts` 的 `placeObject`。
 *
 * 搬走的原因不是分层洁癖，而是这里原本抄了三份（moveObject / addAsset / updateAsset），
 * 三份都把 separate 放在定高之前 —— 于是同层时垂直必然相交，盒子一靠近平台就被推开，
 * "叠上去"永远走不到。不变量只留一处，才不会再次跑偏。
 */

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
      const cameraMoves = store.state.cameraMoves.map((move) => {
        if (move.id !== moveId) return move;
        const next = { ...move, ...patch };
        // 切到 PATH 但还没有路径点 → 种一条可用折线，避免出现「空 PATH」无从下手（旧实现只改 type）。
        // 反方向（PATH → 其它）保留 pathPoints，切回来即可复原。
        if (patch.type === "PATH" && (next.pathPoints?.length ?? 0) < 2) {
          return { ...next, pathPoints: seedCameraPathPoints(next.id, next.camera, store.state) };
        }
        return next;
      });
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
    selectedKeyId: null,
    hoverMarker: null,
    radialTarget: null,
    viewMode: "director",
    activeCameraId: "CAM_A",
    viewLocked: false,
    pathDrawMode: false,
    stairLinkFrom: null,
    pickHint: null,
    stairDraft: null,
    walkPick: null,
    dragging: false,
    terrainGesture: false,
    dragReach: null,

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

    setWorldMode: (mode) =>
      set((store) => ({
        state: { ...store.state, revision: store.state.revision + 1, worldMode: mode },
      })),

    setShowNames: (show) =>
      set((store) => ({
        state: { ...store.state, revision: store.state.revision + 1, showNames: show },
      })),

    toggleShowName: (objectId) =>
      set((store) => {
        const target = store.state.objects.find((o) => o.id === objectId);
        if (!target) return {};
        // 反相写入时从"当前实际是否可见"出发 —— 否则在场景处于「默认」且个体没写时，
        // 点一下会写成 false 却看不出变化。判定走唯一出口 engine/nameVisibility（场景三态优先）。
        const current = nameVisible(store.state.showNames, target);
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            objects: store.state.objects.map((o) =>
              o.id === objectId ? { ...o, showName: !current } : o,
            ),
          },
        };
      }),

    toggleCameraShowName: (cameraId) =>
      set((store) => {
        const target = store.state.cameras.find((c) => c.id === cameraId);
        if (!target) return {};
        const current = nameVisible(store.state.showNames, target);
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            cameras: store.state.cameras.map((c) =>
              c.id === cameraId ? { ...c, showName: !current } : c,
            ),
          },
        };
      }),

    setActiveCamera: (cameraId) => set({ activeCameraId: cameraId }),

    toggleViewLocked: () => set((store) => ({ viewLocked: !store.viewLocked })),

    togglePathDraw: () => set((store) => ({ pathDrawMode: !store.pathDrawMode })),

    setDragging: (dragging) => set({ dragging }),

    setTerrainGesture: (on) =>
      set((store) => (store.terrainGesture === on ? {} : { terrainGesture: on })),

    setDragReach: (hint) => set({ dragReach: hint }),

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

    selectItem: (itemId) =>
      set((store) => {
        const move = itemId ? store.state.cameraMoves.find((m) => m.id === itemId) : undefined;
        // 选中一段相机运镜时，把「镜头视图」同步到它的相机：
        // 否则会出现「director view 里机位在动、camera view 仍是另一台相机」的脱节。
        return move
          ? { selectedItem: itemId, activeCameraId: move.camera }
          : { selectedItem: itemId };
      }),

    selectPoint: (pointId) => set({ selectedPoint: pointId }),

    selectCameraKey: (keyId) => set({ selectedKeyId: keyId }),

    setHoverMarker: (marker) => set({ hoverMarker: marker }),

    openRing: (objectId) => set({ radialTarget: { kind: "object", id: objectId } }),

    openPointRing: (pointId) => set({ radialTarget: { kind: "point", id: pointId } }),

    openCameraPointRing: (pointId) => set({ radialTarget: { kind: "cameraPoint", id: pointId } }),

    closeRing: () => set({ radialTarget: null }),

    moveObject: (objectId, x, z, layerY, forceTerrain) =>
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
        // 落位：定层高 → 按该层高分离（顺序见 engine/place 的 placeObject）。
        // 拖到平台上就叠上去（set）／站上去（agent），拖开就落回基准面。
        const placed = placeObject(state, objectId, x, z, layerY, forceTerrain);
        const nx = placed.x;
        const nz = placed.z;
        const baseY = placed.baseY;

        // ── 堆叠传播（见 engine/stack.ts）──────────────────────────────
        // 拖的是 set 时，压在它上面的整条堆叠链跟着一起走：
        //   水平：按根的水平位移 (Δx, Δz) 平移，相对位置不变；
        //   垂直：按根的层高变化 Δy 同步抬高 / 降低 —— 否则根部被抬上平台后
        //         上层还停在旧高度，会嵌进根部里（塔被压扁），
        //         settleStack 只会"掉"不会"抬"，修不了。
        // 平移完再自下而上复位各层 baseY（整体踩空就一起落）。
        //
        // 只在 terrain 生效：planar 世界没有堆叠（placeObject 也不写 baseY），
        // 此时必须逐像素走老路径。`baseY === undefined` 正是"非 terrain"的判据。
        const stackMode = target?.role === "set" && baseY !== undefined;
        const chainIds = stackMode ? stackChain(state, objectId).map((o) => o.id) : [objectId];
        const followers = new Set(chainIds.slice(1));
        const rootDX = nx - (target?.x ?? nx);
        const rootDZ = nz - (target?.z ?? nz);
        const rootDY = baseY !== undefined ? baseY - (target?.baseY ?? 0) : 0;

        let objects = state.objects.map((object) => {
          if (object.id === objectId) {
            return { ...object, x: nx, z: nz, ...(baseY !== undefined ? { baseY } : {}) };
          }
          // 上层：跟随平移与抬升。bottom（拱洞下探）也要同步位移，见 engine/stack.ts。
          if (followers.has(object.id)) {
            return {
              ...object,
              x: object.x + rootDX,
              z: object.z + rootDZ,
              ...(baseY !== undefined ? { baseY: (object.baseY ?? 0) + rootDY } : {}),
              ...(object.bottom !== undefined ? { bottom: object.bottom + rootDY } : {}),
            };
          }
          return object;
        });
        // 平移后自下而上复位各层 baseY：整体踩空就一起落，落在新平台上就一起抬。
        // settleStack 用 { ...state, objects } 的临时 state，这样它看到的已是平移后的坐标。
        if (stackMode) {
          objects = settleStack({ ...state, objects }, chainIds);
        }

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
            objects,
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

    addAsset: (category, at, species) => {
      const store = get();
      const { state } = store;
      const preset = ASSET_PRESETS[category];
      // 动物：用物种定义覆盖默认体块 / 颜色（缺省物种走注册表默认）。
      const animal = category === "animal" ? ANIMAL_MODELS[species ?? DEFAULT_ANIMAL_SPECIES] : undefined;
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
        footprint: animal ? { ...animal.footprint } : { ...preset.footprint },
        color: animal ? animal.color : preset.color,
        ...(animal ? { species: animal.species } : {}),
      };
      // 落位：定层高 → 按该层高分离（顺序见 engine/place 的 placeObject）。
      // 新建资产直接落在落点处最高的可站立面上（terrain 模式）；set 叠起来，
      // agent 站上去 —— 落点语义一致。拖放携带了射线拾取的高度时以它为准。
      // placeObject 需要对象已在 objects 里，所以先把它并进一份临时视图。
      const staged: DirectorState = { ...state, objects: [...state.objects, asset] };
      const placed = placeObject(staged, id, spawnX, spawnZ, at?.y, at?.terrain);
      const next: DirectorObject = {
        ...asset,
        x: placed.x,
        z: placed.z,
        ...(placed.baseY !== undefined ? { baseY: placed.baseY } : {}),
      };
      set({
        state: { ...state, revision: state.revision + 1, objects: [...state.objects, next] },
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
    addGroupAt: (category, count, formation, at, species) => {      const store = get();
      const { state } = store;
      const preset = ASSET_PRESETS[category];
      if (!preset) return;
      // 动物团队：用物种定义覆盖默认体块 / 颜色（缺省物种走注册表默认）。
      const animal = category === "animal" ? ANIMAL_MODELS[species ?? DEFAULT_ANIMAL_SPECIES] : undefined;
      const total = Math.max(1, Math.min(24, Math.round(count) || 1));
      const spacing = 1.3;
      const baseX = at ? Math.round(at.x * 10) / 10 : 0;
      const baseZ = at ? Math.round(at.z * 10) / 10 : 0;

      const created: DirectorObject[] = [];
      const members: string[] = [];
      // 整队一起落位：每生成一个就先并进 `staged`，再走 `placeObject`。
      // 逐个落位而不是"先生成全部再统一摆"很关键 —— 后面的队员要能看见前面的，
      // 这样他们既会各自吸附到脚下的台面，也会互相避免挤在同一点。
      // 不给 layerY：队员散在编队槽位上，锚点头顶拾到的那一层不代表每个队员脚下那一层，
      // 各自按自己的 (x, z) 反查才是对的（这正是 `restingBaseY` 的 fallback 路径）。
      let staged: DirectorState = { ...state };
      for (let i = 0; i < total; i += 1) {
        let n = state.objects.filter((o) => o.category === category).length + created.length + 1;
        let id = `AST_${category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        while ([...state.objects, ...created].some((o) => o.id === id)) {
          n += 1;
          id = `AST_${category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        }
        // 初始摆放沿用求解器同一套编队槽位（本地坐标 forward = +z, right = +x）。
        const slot = formationSlotOf(formation, spacing, i, total);
        const spawnX = Math.round((baseX + slot.right) * 10) / 10;
        const spawnZ = Math.round((baseZ + slot.fwd) * 10) / 10;
        const member: DirectorObject = {
          id,
          type: preset.role === "agent" ? "actor" : "prop",
          category,
          role: preset.role,
          x: spawnX,
          z: spawnZ,
          rotation: 0,
          footprint: animal ? { ...animal.footprint } : { ...preset.footprint },
          color: animal ? animal.color : preset.color,
          ...(animal ? { species: animal.species } : {}),
        };
        staged = { ...staged, objects: [...staged.objects, member] };
        const placed = placeObject(staged, id, spawnX, spawnZ, undefined, at?.terrain);
        const next: DirectorObject = {
          ...member,
          x: placed.x,
          z: placed.z,
          ...(placed.baseY !== undefined ? { baseY: placed.baseY } : {}),
        };
        staged = { ...staged, objects: [...staged.objects.slice(0, -1), next] };
        created.push(next);
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

    arrayAsset: (sourceId, spec) => {
      const store = get();
      const { state } = store;
      const source = state.objects.find((o) => o.id === sourceId);
      if (!source) return;
      // 第 0 个槽位与源对象当前位置重合 → 丢掉，源留在原处，副本从偏移 1 开始。
      const slots = arraySlots(source, spec).slice(1);
      if (slots.length === 0) return;

      const created: DirectorObject[] = [];
      // id 沿用 addAsset / addGroupAt 的同类计数规则，并保持全局唯一。
      let n = state.objects.filter((o) => o.category === source.category).length + 1;
      const nextId = () => {
        let id = `AST_${source.category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        while ([...state.objects, ...created].some((o) => o.id === id)) {
          n += 1;
          id = `AST_${source.category.toUpperCase()}_${String(n).padStart(2, "0")}`;
        }
        n += 1;
        return id;
      };

      // 逐个"先并进 staged 再 placeObject" —— 与 addGroupAt 同一模式：
      // 后面的副本要能看见前面的，否则它们会在同一个 x/z 上互相重叠。
      // 每个副本都由 placeObject 反查自己脚下的支撑面（terrain），planar 下不写 baseY。
      let staged: DirectorState = { ...state };
      for (const slot of slots) {
        const cid = nextId();
        // 拱洞：`bottom` 是绝对高度，落位前先按"下探量"给个初值（可能还要被 placeObject 改），
        // 落位后用真实 baseY 重算一次。普通对象没有 bottom，走展开路径自然不带。
        const sink = (source.baseY ?? 0) - (source.bottom ?? source.baseY ?? 0);
        const seedY = slot.baseY ?? source.baseY ?? 0;
        const draft: DirectorObject = {
          ...source,
          id: cid,
          x: slot.x,
          z: slot.z,
          ...(source.bottom !== undefined ? { bottom: seedY - sink } : {}),
        };
        staged = { ...staged, objects: [...staged.objects, draft] };
        // stair 的 slot.baseY 是作者的显式意图 → 作为 layerY 传进去，它是权威。
        const placed = placeObject(staged, cid, slot.x, slot.z, slot.baseY);
        const copy: DirectorObject = {
          ...draft,
          x: placed.x,
          z: placed.z,
          ...(placed.baseY !== undefined ? { baseY: placed.baseY } : {}),
        };
        if (source.bottom !== undefined && placed.baseY !== undefined) {
          // 与 settleStack 同一条不变量：保持"下探量"而非 bottom 的绝对值。
          copy.bottom = placed.baseY - sink;
        }
        staged = { ...staged, objects: [...staged.objects.slice(0, -1), copy] };
        created.push(copy);
      }

      // 源若是某个堆叠的根，它上面压着的塔**不会**被复制 —— 阵列复制的是那一个对象。
      // 副本各自独立落位，源自己的堆叠链完全不受影响。
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          objects: [...state.objects, ...created],
        },
        selectedKind: "object",
        selectedId: created[created.length - 1].id,
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
        const effectivePatch: Partial<DirectorObject> = { ...patch };
        // 改 footprint（尤其 h）会移动"支撑面"的高度 —— 压在上面的对象必须重新落一遍，
        // 否则薄板变厚，上面的盒子就嵌进板里、薄板变薄就悬空（INV-3D-04）。
        // 收集当前压在这个对象上的直接上层；改完几何后再 settle。
        const touchedStack =
          target && target.role === "set" && patch.footprint !== undefined
            ? [...stackChain(state, id).map((o) => o.id)]
            : [];
        if (merged) {
          // 落位统一走 placeObject（定层高 → 按层高分离，顺序见 engine/place）。
          // `patch.baseY` 作为 layerY 传进去：调用方显式给了标高时它就是权威，
          // 不该被几何反查覆盖 —— 与"指针拾取到的那一层优先"是同一条规则。
          const placed = placeObject(state, id, merged.x, merged.z, patch.baseY);
          // 沿用原有语义：只回写调用方实际改过的那一根轴，避免波及其它编辑路径。
          // （当前 UI 只有 Block 尺寸会走到这里，x / z 分支是留给将来的。）
          if (patch.x !== undefined) effectivePatch.x = placed.x;
          else if (patch.z !== undefined) effectivePatch.z = placed.z;
          if (patch.baseY === undefined && placed.baseY !== undefined) {
            effectivePatch.baseY = placed.baseY;
          }
        }
        let objects = state.objects.map((o) =>
          o.id === id ? { ...o, ...effectivePatch } : o,
        );
        // 几何变了 → 自下而上复位整条堆叠链的 baseY（见 engine/stack.ts 的 settleStack）。
        // 传 `touchedStack` 而非 `[id]`：改的是支撑面本身，要重算的是压在它上面的层。
        if (touchedStack.length > 0) {
          objects = settleStack({ ...state, objects }, touchedStack);
        }
        return {
          state: {
            ...state,
            revision: state.revision + 1,
            objects,
          },
        };
      }),

    removeAsset: (id) =>
      set((store) => {
        const cameraMoves = store.state.cameraMoves.map((m) =>
          m.targetId === id ? { ...m, targetId: undefined } : m,
        );
        const objects = store.state.objects.filter((o) => o.id !== id);
        // 删掉的是"被压着的"底座时，压在上面的整条链失去支撑 → 必须向下重新落位，
        // 否则它们会悬在原来那条链的高度上（INV-3D-04）。删前先取链，删后再 settle。
        const orphanChain = stackChain(store.state, id)
          .map((o) => o.id)
          .filter((cid) => cid !== id);
        const settled =
          orphanChain.length > 0
            ? settleStack({ ...store.state, objects }, orphanChain)
            : objects;
        return {
          state: {
            ...store.state,
            revision: store.state.revision + 1,
            objects: settled,
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

    drawStairPath: (objectId, points) => {
      const object = get().state.objects.find((o) => o.id === objectId);
      if (!object) return;
      // 与 `drawAssetPath` 同一个抽稀器、同一个容差 —— 两处的手感必须一致。
      const thin = simplifyPath(points, HAND_DRAW_EPSILON);
      if (thin.length < 2) return;
      const stamp = Date.now().toString(36);
      get().updateAsset(objectId, {
        // 手绘路径 = 作者在说"这是楼梯"：顶面形状一并在**这个唯一写入点**改掉。
        // 新拖进来的「台阶」默认是平顶，少了这一步就是"画了不生效"。
        topShape: "stair",
        stair: {
          path: thin.map((p, i) => ({
            id: `SP_${stamp}_${i}`,
            x: round1(p.x),
            z: round1(p.z),
          })),
        },
      });
    },

    beginStairLink: (objectId) => {
      const source = get().state.objects.find((o) => o.id === objectId);
      if (!source) return;
      set({
        stairLinkFrom: objectId,
        // 进入模式立刻给一句"下一步点哪儿、怎么退"，否则画布上没有任何"我已经在等目标"的信号。
        pickHint: {
          at: [source.x, objectTop(source), source.z],
          text: "台阶：点另一个高台或地面生成 · Esc 取消",
          tone: "hint",
        },
      });
    },

    cancelStairLink: () =>
      set({ stairLinkFrom: null, pickHint: null, stairDraft: null, walkPick: null }),

    pickStairTarget: (targetId, x, z) => {
      const store = get();
      const { state } = store;
      const source = state.objects.find((o) => o.id === store.stairLinkFrom);
      // 起点已经不存在（被删 / 换了场景）→ 顺手退出模式，别把菜单挂在空气上。
      if (!source) {
        set({ stairLinkFrom: null, pickHint: null, stairDraft: null });
        return;
      }
      const target = targetId ? state.objects.find((o) => o.id === targetId) : undefined;
      // 几何、拒绝文案、折线都在 engine（可被守卫，见 engine/stairLink.ts）—— store 只管落库。
      const result = planStairLink(state, source, target, x, z);
      // 语义问题：没有可画的折线，只报告，留在"选目标"状态让作者重点。
      if (!result.ok && !result.plan) {
        set({
          pickHint: { at: result.problem.at, text: result.problem.text, tone: "refuse" },
        });
        return;
      }
      // 进预览。几何问题（太陡）也进 —— 预览里加个转折点就能把它拉缓，这是唯一的修法。
      set({
        stairDraft: {
          targetId: target?.id ?? null,
          point: { x: round1(x), z: round1(z) },
          bends: [],
          width: DEFAULT_STAIR_WIDTH,
        },
        pickHint: result.ok
          ? null
          : { at: result.problem.at, text: result.problem.text, tone: "refuse" },
      });
    },

    addStairBend: (x, z) => {
      const store = get();
      const { state, stairLinkFrom, stairDraft } = store;
      if (!stairDraft) return;
      const source = state.objects.find((o) => o.id === stairLinkFrom);
      if (!source) return;
      const target = stairDraft.targetId
        ? state.objects.find((o) => o.id === stairDraft.targetId)
        : undefined;
      const result = planStairLink(
        state,
        source,
        target,
        stairDraft.point.x,
        stairDraft.point.z,
        stairDraft.bends,
        stairDraft.width,
      );
      if (!result.plan) return;
      set({
        stairDraft: { ...stairDraft, bends: insertBend(result.plan, { x: round1(x), z: round1(z) }) },
        pickHint: result.ok
          ? null
          : { at: result.problem.at, text: result.problem.text, tone: "refuse" },
      });
    },

    setStairWidth: (width) => {
      const { stairDraft } = get();
      if (!stairDraft) return;
      // 夹在一个说得通的区间里：太窄的不是台阶，太宽的只是白费几何。
      set({ stairDraft: { ...stairDraft, width: Math.min(6, Math.max(0.2, round1(width))) } });
    },

    commitStair: () => {
      const store = get();
      const { state, stairLinkFrom, stairDraft } = store;
      if (!stairDraft) return;
      const source = state.objects.find((o) => o.id === stairLinkFrom);
      if (!source) {
        set({ stairLinkFrom: null, pickHint: null, stairDraft: null });
        return;
      }
      const target = stairDraft.targetId
        ? state.objects.find((o) => o.id === stairDraft.targetId)
        : undefined;
      const result = planStairLink(
        state,
        source,
        target,
        stairDraft.point.x,
        stairDraft.point.z,
        stairDraft.bends,
        stairDraft.width,
      );
      if (!result.ok) {
        set({
          pickHint: { at: result.problem.at, text: result.problem.text, tone: "refuse" },
        });
        return;
      }
      const { start, startY, rise, run, points, width } = result.plan;

      const id = nextStairId(state);
      const stamp = Date.now().toString(36);
      const stair: DirectorObject = {
        id,
        name: `台阶：${source.name || source.id} → ${target ? target.name || target.id : "地面"}`,
        type: "prop",
        category: "structure",
        role: "set",
        x: round1(start.x),
        z: round1(start.z),
        rotation: 0,
        topShape: "stair",
        stair: {
          // **预览里看到的那条折线**（含作者加的转折点）原样落库 —— 不重算，免得两者分叉。
          path: points.map((p, i) => ({ id: `SP_${stamp}_${i}`, x: round1(p.x), z: round1(p.z) })),
        },
        // h = 两端**实测**高差（派生量，不是作者填的）；w = 作者在预览里定的宽度；
        // D = 折线水平长（没画路径时的退路）。
        footprint: { w: round1(width), d: round1(run), h: round1(rise) },
        // 底面 = 起点处的地面高度：于是楼梯从这一步的地面起、正好爬到目标面。
        baseY: round1(startY),
        color: "#8b9bb0",
      };
      // 刻意**不做水平分离**：台阶两端本来就贴住两座高台的墙，被推开就断了。
      set({
        state: { ...state, revision: state.revision + 1, objects: [...state.objects, stair] },
        selectedKind: "object",
        selectedId: id,
        selectedItem: null,
        selectedPoint: null,
        stairLinkFrom: null,
        pickHint: null,
        stairDraft: null,
      });
    },

    beginWalkPick: (actorId, direction) => {
      const actor = get().state.objects.find((o) => o.id === actorId);
      if (!actor) return;
      set({
        walkPick: { actorId, direction },
        // 与连台阶同一套提示：先说清"下一步点哪儿、怎么退"。
        pickHint: {
          at: [actor.x, objectTop(actor), actor.z],
          text: `${direction === "up" ? "走上去" : "走下来"}：点一条楼梯 · Esc 取消`,
          tone: "hint",
        },
      });
    },

    assignStairWalk: (stairId) => {
      const store = get();
      const { state, walkPick } = store;
      const actor = state.objects.find((o) => o.id === walkPick?.actorId);
      const stair = state.objects.find((o) => o.id === stairId);
      if (!actor || !stair || !walkPick) {
        set({ walkPick: null, pickHint: null });
        return;
      }
      const result = planStairWalk(state, stair, actor, walkPick.direction);
      if (!result.ok) {
        // 拒绝 = 报告：模式保持不动，作者换一条楼梯即可。
        set({
          pickHint: { at: [stair.x, objectTop(stair), stair.z], text: result.text, tone: "refuse" },
        });
        return;
      }
      // 复用它最后一条 MOVE 段（没有就新建）—— 与手绘路径 `drawAssetPath` 同一套：
      // "这个演员要走的路"只有一条，反复安排应当覆盖它，而不是堆出第二条。
      const moves = get()
        .state.segments.filter((s) => s.object === actor.id && s.type === "MOVE")
        .sort((a, b) => a.timeStart - b.timeStart);
      let segment = moves[moves.length - 1];
      if (!segment) {
        get().addSegment(actor.id, undefined);
        const after = get()
          .state.segments.filter((s) => s.object === actor.id)
          .sort((a, b) => a.timeStart - b.timeStart);
        segment = after[after.length - 1];
      }
      if (!segment) return;
      // **层高必须跟着路线起点的落脚面**：向下走时起点在楼顶，`baseY` 若留在地面，
      // 落脚链条会从 0 起步 ⇒ 人贴地穿过整座楼梯（见 engine/stairWalk 模块说明）。
      get().updateAsset(actor.id, { baseY: round1(result.plan.startY) });
      // 路线点直接来自楼梯的路径（含接近段）—— 没有第二份几何。
      get().setSegmentPoints(segment.id, result.plan.points);
      set({
        walkPick: null,
        pickHint: null,
        selectedKind: "object",
        selectedId: actor.id,
        selectedItem: segment.id,
        selectedPoint: null,
      });
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

    setSegmentArc: (segmentId, arc) =>
      // 有弧线 → 准线性 ease（保证起跳瞬间有水平速度）；清除弧线 → 恢复默认缓动由调用方决定，
      // 这里只把 arc 抹掉、ease 留原样（免得"取消跳跃"把作者调过的手感也一起改掉）。
      patchSegment(segmentId, arc ? { arc, ease: [...JUMP_EASE] } : { arc: undefined }),

    // 顶点拖拽专用：只动 apex，保留作者 ease 与弧线其它字段。
    setSegmentArcApex: (segmentId, apex) => {
      const seg = get().state.segments.find((s) => s.id === segmentId);
      if (!seg || !seg.arc) return;
      patchSegment(segmentId, { arc: rewriteArcApex(seg.arc, apex) });
    },

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
      // 新段从播放头接管，一直铺到下一条更晚的片段起点（没有则铺到片尾）。
      // 关键：不留空档——空档会让相机掉回「默认机位」（placeCamera 反推的构图位，不在路径上），
      // 那正是「相机默认位置不在路径点上 / 播放到后面会跳到奇怪位置」的来源。
      const atTime = clamp(round1(store.currentTime), 0, Math.max(0, duration - 0.5));
      const camera = state.cameras.find((c) => c.id === cameraId);
      const siblings = state.cameraMoves
        .filter((m) => m.camera === cameraId)
        .sort((a, b) => a.timeStart - b.timeStart);
      const later = siblings.find((m) => m.timeStart > atTime);
      const newStart = atTime;
      const newEnd = round1(later ? later.timeStart : duration);

      // 与新段重叠的旧段：裁掉被覆盖的一侧；整段落在新段内则丢弃（新段接管这段时间）。
      const cameraMoves: CameraMove[] = [];
      for (const m of state.cameraMoves) {
        if (m.camera !== cameraId || m.timeEnd <= newStart || m.timeStart >= newEnd) {
          cameraMoves.push(m);
          continue;
        }
        if (m.timeStart < newStart) cameraMoves.push({ ...m, timeEnd: newStart });
        else if (m.timeEnd > newEnd) cameraMoves.push({ ...m, timeStart: newEnd });
      }

      const moveId = nextCameraMoveId(state, cameraId);
      // PATH：种子一条横跨主体前方的 2 点折线，用户可在 Director View 拖拽塑形。
      const pathPoints: CameraPathPoint[] | undefined =
        type === "PATH" ? seedCameraPathPoints(moveId, cameraId, state) : undefined;
      const move: CameraMove = {
        id: moveId,
        camera: cameraId,
        type,
        targetId: camera?.targetId,
        timeStart: newStart,
        timeEnd: newEnd,
        orbitDeg: 90,
        dollyScale: type === "DOLLY" ? 0.55 : 1,
        craneHeight: type === "CRANE" ? 3 : 0,
        ease: [0.42, 0, 0.58, 1],
        ...(pathPoints ? { pathPoints } : {}),
      };
      cameraMoves.push(move);
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          // 新段可能被顺延到片尾之后：同步抬高片长，避免片段被时间轴截掉。
          duration: Math.max(state.duration, newEnd),
          cameraMoves,
          cameraJunctions: reconcileCameraJunctions(cameraMoves, state.cameraJunctions),
        },
        selectedKind: "camera",
        selectedId: cameraId,
        selectedItem: move.id,
        // 新增运镜即进入导演视图：PATH 的路径线与可拖拽把手只在导演视图可见，否则会像「没反应」。
        viewMode: "director",
      });
    },

    addCameraPathPoint: (moveId, x, y, z) => {
      const move = get().state.cameraMoves.find((m) => m.id === moveId);
      if (!move) return;
      const pts = move.pathPoints ?? [];
      const node: CameraPathPoint = {
        id: `${moveId}_P_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`,
        x,
        y,
        z,
        shape: "LINE",
      };
      const pathPoints = normalizeCamPathShapes([...pts, node]);
      set((s) => ({
        state: {
          ...s.state,
          revision: s.state.revision + 1,
          cameraMoves: s.state.cameraMoves.map((m) =>
            m.id === moveId ? { ...m, pathPoints } : m,
          ),
        },
      }));
    },

    insertCameraPathPoint: (moveId, x, y, z, insertAt) => {
      const move = get().state.cameraMoves.find((m) => m.id === moveId);
      if (!move) return null;
      const pts = [...(move.pathPoints ?? [])];
      const node: CameraPathPoint = {
        id: `${moveId}_P_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`,
        x,
        y,
        z,
        shape: "LINE",
      };
      // 只插在中间：不能跑到 START 之前或 END 之后。
      const at = Math.max(1, Math.min(pts.length - 1, insertAt));
      pts.splice(at, 0, node);
      const pathPoints = normalizeCamPathShapes(pts);
      set((s) => ({
        state: {
          ...s.state,
          revision: s.state.revision + 1,
          cameraMoves: s.state.cameraMoves.map((m) =>
            m.id === moveId ? { ...m, pathPoints } : m,
          ),
        },
      }));
      return node.id;
    },

    moveCameraPathPoint: (moveId, pointId, x, y, z) => {
      const move = get().state.cameraMoves.find((m) => m.id === moveId);
      if (!move) return;
      set((s) => ({
        state: {
          ...s.state,
          revision: s.state.revision + 1,
          cameraMoves: s.state.cameraMoves.map((m) =>
            m.id === moveId
              ? {
                  ...m,
                  pathPoints: (m.pathPoints ?? []).map((p) =>
                    p.id === pointId ? { ...p, x, y, z } : p,
                  ),
                }
              : m,
          ),
        },
      }));
    },

    deleteCameraPathPoint: (moveId, pointId) => {
      const move = get().state.cameraMoves.find((m) => m.id === moveId);
      if (!move) return;
      const pathPoints = normalizeCamPathShapes(
        (move.pathPoints ?? []).filter((p) => p.id !== pointId),
      );
      set((s) => ({
        state: {
          ...s.state,
          revision: s.state.revision + 1,
          cameraMoves: s.state.cameraMoves.map((m) =>
            m.id === moveId ? { ...m, pathPoints } : m,
          ),
        },
      }));
    },

    toggleCameraPathCurve: (moveId, pointId) => {
      const move = get().state.cameraMoves.find((m) => m.id === moveId);
      if (!move) return;
      const points = move.pathPoints ?? [];
      const index = points.findIndex((p) => p.id === pointId);
      if (index <= 0 || index >= points.length - 1) return; // 只中间点可转
      const next = points.map((p, i) =>
        i === index ? { ...p, shape: p.shape === "ARC" ? "LINE" : "ARC" } : p,
      ) as CameraPathPoint[];
      const pathPoints = normalizeCamPathShapes(next);
      set((s) => ({
        state: {
          ...s.state,
          revision: s.state.revision + 1,
          cameraMoves: s.state.cameraMoves.map((m) =>
            m.id === moveId ? { ...m, pathPoints } : m,
          ),
        },
      }));
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
