import { create } from "zustand";
import {
  AspectRatio,
  CameraFraming,
  CameraMove,
  CameraMotionType,
  CameraObject,
  CameraSide,
  CameraView,
  Constraint,
  DirectorState,
  EaseCurve,
  IntentAction,
  MoveSegment,
  PathPoint,
  Vec2,
  ViewMode,
} from "../domain/schema";
import { createDemoState } from "../engine/demoShot";
import { normalizePathPointModes, pathInsertIndex } from "../engine/path";

const CAMERA_COLORS = ["#c792ea", "#67a7ff", "#63d39b", "#f0a35a", "#ff7b91", "#8ad1ff"];

export type SelectionKind = "object" | "camera";

interface DirectorStore {
  state: DirectorState;
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
  addPathPoint: (segmentId: string, x: number, z: number) => string | null;
  movePathPoint: (segmentId: string, pointId: string, x: number, z: number) => void;
  moveEndpoint: (segmentId: string, which: "start" | "end", x: number, z: number) => void;
  toggleCurve: (segmentId: string, pointId: string) => void;
  deletePoint: (segmentId: string, pointId: string) => void;

  setSegmentTime: (segmentId: string, start: number, end: number) => void;
  setConstraintTime: (constraintId: string, start: number, end: number) => void;
  setSegmentEase: (segmentId: string, ease: EaseCurve) => void;

  addCamera: () => void;
  updateCamera: (
    cameraId: string,
    patch: Partial<Pick<CameraObject, "targetId" | "framing" | "view" | "side" | "lensMm" | "motion" | "name">>,
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

export const useDirectorStore = create<DirectorStore>((set, get) => {
  const patchSegment = (segmentId: string, patch: Partial<MoveSegment>) =>
    set((store) => ({
      state: {
        ...store.state,
        revision: store.state.revision + 1,
        segments: store.state.segments.map((segment) =>
          segment.id === segmentId ? { ...segment, ...patch } : segment,
        ),
      },
    }));

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
    set((store) => ({
      state: {
        ...store.state,
        revision: store.state.revision + 1,
        cameraMoves: store.state.cameraMoves.map((move) =>
          move.id === moveId ? { ...move, ...patch } : move,
        ),
      },
    }));

  return {
    state: createDemoState(),
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

    togglePlay: () => set((store) => ({ playing: !store.playing })),

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
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          objects: store.state.objects.map((object) =>
            object.id === objectId ? { ...object, x, z } : object,
          ),
        },
      })),

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
      if (which === "start") patchSegment(segmentId, { startX: x, startZ: z });
      else patchSegment(segmentId, { endX: x, endZ: z });
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
      set({
        state: {
          ...state,
          revision: state.revision + 1,
          cameraMoves: [...state.cameraMoves, move],
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
      set((store) => ({
        state: {
          ...store.state,
          revision: store.state.revision + 1,
          cameraMoves: store.state.cameraMoves.filter((move) => move.id !== moveId),
        },
        selectedItem: store.selectedItem === moveId ? null : store.selectedItem,
      })),

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
      set({
        state: createDemoState(),
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
      }),
  };
});
