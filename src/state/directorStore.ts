import { create } from "zustand";
import {
  AspectRatio,
  CameraFraming,
  CameraJunction,
  CameraMove,
  CameraMotionType,
  CameraObject,
  CameraSide,
  CameraView,
  Constraint,
  DirectorState,
  EaseCurve,
  Handoff,
  HandoffMode,
  IntentAction,
  MoveSegment,
  PathPoint,
  StageManifest,
  Vec2,
  ViewMode,
} from "../domain/schema";
import { createBlankState, createDemoState } from "../engine/demoShot";
import { normalizePathPointModes, pathInsertIndex } from "../engine/path";
import { contentEndTime } from "../engine/timeline";
import { ASSET_PRESETS } from "../engine/assetPresets";
import { separateSetAsset } from "../engine/collision";
import { AssetCategory, DirectorObject } from "../domain/schema";

const CAMERA_COLORS = ["#c792ea", "#67a7ff", "#63d39b", "#f0a35a", "#ff7b91", "#8ad1ff"];

// 持久化 v3：每张场景页独立 localStorage key，由片场 manifest 索引。
const MANIFEST_KEY = "director-desk-manifest-v3";
const sceneKey = (id: string) => `director-desk-scene-${id}-v3`;
const LEGACY_KEY = "director-desk-scene-v2";

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
    return parsed;
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
 * 启动时装配片场：优先读 manifest；否则迁移旧 v2 单场景，或落一个 demo 场景。
 * 返回的 activeState 直接作为 store 顶层 `state`（= 当前激活场景页的引用）。
 */
function initStage(): { manifest: StageManifest; activeState: DirectorState } {
  const manifest = loadManifest();
  if (manifest && manifest.order.length > 0) {
    const activeId =
      manifest.activeSceneId && manifest.order.some((t) => t.id === manifest.activeSceneId)
        ? manifest.activeSceneId
        : manifest.order[0].id;
    const activeState = loadSceneState(activeId) ?? createBlankState();
    return { manifest: { ...manifest, activeSceneId: activeId }, activeState };
  }

  let state: DirectorState;
  const legacy =
    typeof localStorage !== "undefined" ? localStorage.getItem(LEGACY_KEY) : null;
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as DirectorState;
      state =
        parsed && Array.isArray(parsed.objects) && Array.isArray(parsed.cameraMoves)
          ? parsed
          : createDemoState();
    } catch {
      state = createDemoState();
    }
  } else {
    state = createDemoState();
  }

  const id = genSceneId();
  saveSceneState(id, state);
  const newManifest: StageManifest = {
    name: "未命名片场",
    order: [{ id, name: "场景 1" }],
    activeSceneId: id,
  };
  saveManifest(newManifest);
  return { manifest: newManifest, activeState: state };
}

export type SelectionKind = "object" | "camera";

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
  radialObjectId: string | null;
  viewMode: ViewMode;
  activeCameraId: string | null;
  /** 锁视角：开启后拖拽不再改变 Director View 的机位。 */
  viewLocked: boolean;
  /** 是否正在拖拽场景对象 / 路径点，用于临时接管 OrbitControls。 */
  dragging: boolean;

  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  setZoom: (zoom: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setActiveCamera: (cameraId: string) => void;
  toggleViewLocked: () => void;
  setDragging: (dragging: boolean) => void;

  selectObject: (objectId: string) => void;
  selectCamera: (cameraId: string) => void;
  selectItem: (itemId: string | null) => void;
  selectPoint: (pointId: string | null) => void;
  openRing: (objectId: string) => void;
  closeRing: () => void;

  moveObject: (objectId: string, x: number, z: number) => void;
  /** 调整对象在时间轴 / Scene Tree 中的行顺序：把 dragId 移到 targetId 所在的位置。 */
  reorderObject: (dragId: string, targetId: string) => void;
  /** 锁定 / 解锁资产：锁定后不可通过拖拽移动位置（防误触），仍可点选以便解锁。 */
  toggleLock: (id: string) => void;
  addAsset: (category: AssetCategory) => void;
  updateAsset: (id: string, patch: Partial<DirectorObject>) => void;
  removeAsset: (id: string) => void;
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
  exportProject: () => string;
  importProject: (json: string) => void;
  addPathPoint: (segmentId: string, x: number, z: number) => string | null;
  movePathPoint: (segmentId: string, pointId: string, x: number, z: number) => void;
  moveEndpoint: (segmentId: string, which: "start" | "end", x: number, z: number) => void;
  toggleCurve: (segmentId: string, pointId: string) => void;
  deletePoint: (segmentId: string, pointId: string) => void;
  addSegment: (objectId: string, afterSegmentId?: string) => void;
  setHandoffMode: (handoffId: string, mode: HandoffMode) => void;
  setCameraJunctionMode: (junctionId: string, mode: HandoffMode) => void;
  deleteSegment: (segmentId: string) => void;

  setSegmentTime: (segmentId: string, start: number, end: number) => void;
  setConstraintTime: (constraintId: string, start: number, end: number) => void;
  setSegmentEase: (segmentId: string, ease: EaseCurve) => void;

  addCamera: () => void;
  addDroneCamera: () => void;
  updateCamera: (
    cameraId: string,
    patch: Partial<Pick<CameraObject, "targetId" | "framing" | "view" | "side" | "lensMm" | "motion" | "name" | "kind">>,
  ) => void;
  addCameraMove: (cameraId: string, type: CameraMotionType) => void;
  setCameraMoveTime: (moveId: string, start: number, end: number) => void;
  setCameraMoveEase: (moveId: string, ease: EaseCurve) => void;
  patchCameraMove: (moveId: string, patch: Partial<CameraMove>) => void;
  deleteCameraMove: (moveId: string) => void;
  setAspectRatio: (ratio: AspectRatio) => void;

  executeIntent: (objectId: string, action: IntentAction) => void;
  reset: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

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

export const useDirectorStore = create<DirectorStore>((set, get) => {
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

  const init = initStage();
  return {
    state: init.activeState,
    manifest: init.manifest,
    currentTime: 0,
    playing: false,
    zoom: 1,
    selectedKind: "object",
    selectedId: "M17",
    selectedItem: null,
    selectedPoint: null,
    radialObjectId: null,
    viewMode: "director",
    activeCameraId: "CAM_A",
    viewLocked: false,
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
        selectedPoint: null,
      }),

    selectItem: (itemId) => set({ selectedItem: itemId }),

    selectPoint: (pointId) => set({ selectedPoint: pointId }),

    openRing: (objectId) => set({ radialObjectId: objectId }),

    closeRing: () => set({ radialObjectId: null }),

    moveObject: (objectId, x, z) =>
      set((store) => {
        const state = store.state;
        const target = state.objects.find((o) => o.id === objectId);
        // 锁定对象不可通过拖拽移动位置（防误触）。
        if (target && target.locked) return {};
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

    addAsset: (category) => {
      const store = get();
      const { state } = store;
      const preset = ASSET_PRESETS[category];
      let count = state.objects.filter((o) => o.category === category).length + 1;
      let id = `AST_${category.toUpperCase()}_${String(count).padStart(2, "0")}`;
      while (state.objects.some((o) => o.id === id)) {
        count += 1;
        id = `AST_${category.toUpperCase()}_${String(count).padStart(2, "0")}`;
      }
      const angle = (state.objects.length * 137.5 * Math.PI) / 180;
      const radius = 2 + state.objects.length * 0.6;
      const spawnX = Math.round(Math.cos(angle) * radius * 10) / 10;
      const spawnZ = Math.round(Math.sin(angle) * radius * 10) / 10;
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
          },
          selectedItem:
            store.selectedItem && store.state.segments.some((s) => s.id === store.selectedItem)
              ? store.selectedItem
              : null,
          selectedPoint: null,
        };
      }),

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
          state: { ...parsed, revision: (parsed.revision ?? 0) + 1 },
          currentTime: 0,
          playing: false,
          selectedKind: "object",
          selectedId: parsed.objects[0]?.id ?? "",
          selectedItem: null,
          selectedPoint: null,
          radialObjectId: null,
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
            radialObjectId: null,
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
          state: { ...single, revision: (single.revision ?? 0) + 1 },
          currentTime: 0,
          playing: false,
          selectedKind: "object",
          selectedId: single.objects[0]?.id ?? "",
          selectedItem: null,
          selectedPoint: null,
          radialObjectId: null,
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
        radialObjectId: null,
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
        radialObjectId: null,
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
          radialObjectId: null,
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
        radialObjectId: null,
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
      const objectSegments = state.segments
        .filter((segment) => segment.object === objectId)
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
        object: objectId,
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
        selectedId: objectId,
        selectedItem: segment.id,
        selectedPoint: null,
      });
    },

    setHandoffMode: (handoffId, mode) => {
      const store = get();
      const state = store.state;
      const handoff = state.handoffs.find((item) => item.id === handoffId);
      if (!handoff) return;
      // mode 本质是 Speed Curve 边界的便捷配置：不另写物理。
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
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameras: [...state.cameras, camera],
        },
        selectedKind: "camera",
        selectedId: id,
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

    updateCamera: (cameraId, patch) =>
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          cameras: store.state.cameras.map((camera) =>
            camera.id === cameraId ? { ...camera, ...patch } : camera,
          ),
        },
      })),

    addCameraMove: (cameraId, type) => {
      const store = get();
      const { state } = store;
      const start = round1(store.currentTime);
      const move: CameraMove = {
        id: nextCameraMoveId(state, cameraId),
        camera: cameraId,
        type,
        timeStart: start,
        timeEnd: round1(Math.min(state.duration, Math.max(start + 1, start + 3))),
        orbitDeg: 90,
        dollyScale: type === "DOLLY" ? 0.55 : 1,
        craneHeight: type === "CRANE" ? 3 : 0,
        ease: [0.42, 0, 0.58, 1],
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
        selectedId: cameraId,
        selectedItem: move.id,
      });
    },

    setCameraMoveTime: (moveId, start, end) => {
      const duration = get().state.duration;
      const nextStart = clamp(round1(start), 0, duration - 0.1);
      const nextEnd = clamp(round1(end), nextStart + 0.1, duration);
      patchCameraMove(moveId, { timeStart: nextStart, timeEnd: nextEnd });
    },

    setCameraMoveEase: (moveId, ease) => patchCameraMove(moveId, { ease }),

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

    setAspectRatio: (ratio) =>
      set((store) => ({
        state: { ...store.state, revision: store.state.revision + 1, aspectRatio: ratio },
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
          radialObjectId: null,
        });
        return;
      }

      if (action === "MOVE") {
        const own = state.segments
          .filter((s) => s.object === objectId)
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
          object: objectId,
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
          selectedId: objectId,
          selectedItem: segment.id,
          radialObjectId: null,
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
        set({ radialObjectId: null, selectedItem: active?.id ?? null });
        return;
      }

      if (action === "CHANGE PATH") {
        const segment =
          state.segments.find(
            (s) => s.object === objectId && time >= s.timeStart && time <= s.timeEnd,
          ) ?? state.segments.find((s) => s.object === objectId);
        set({ radialObjectId: null, selectedItem: segment?.id ?? "CHANGE PATH" });
        return;
      }

      set({ radialObjectId: null, selectedItem: action });
    },

    reset: () =>
      set((store) => ({
        state: { ...createDemoState(), revision: store.state.revision + 1 },
        currentTime: 0,
        playing: false,
        zoom: 1,
        selectedKind: "object",
        selectedId: "M17",
        selectedItem: null,
        selectedPoint: null,
        radialObjectId: null,
        viewMode: "director",
        activeCameraId: "CAM_A",
        viewLocked: false,
        dragging: false,
      })),
  };
});
