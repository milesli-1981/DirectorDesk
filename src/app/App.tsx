import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Inspector } from "../components/Inspector";
import {
  ObjectList,
  LEFT_RAIL_W,
  LEFT_MAX_W,
  LEFT_COLLAPSED_AT,
  LEFT_DEFAULT_W,
} from "../components/ObjectList";
import { SceneTabs } from "../components/SceneTabs";
import { Timeline } from "../components/Timeline";
import { WorldView } from "../components/WorldView";
import { contentEndTime } from "../engine/timeline";
import { exportMultiCamVideos } from "../engine/videoExport";
import { installHeadlessApi } from "../engine/headlessApi";
import { useDirectorStore } from "../state/directorStore";

export function App() {
  const playing = useDirectorStore((s) => s.playing);
  const togglePlay = useDirectorStore((s) => s.togglePlay);
  const setTime = useDirectorStore((s) => s.setTime);
  const undo = useDirectorStore((s) => s.undo);
  const redo = useDirectorStore((s) => s.redo);
  const canUndo = useDirectorStore((s) => s.past.length > 0);
  const canRedo = useDirectorStore((s) => s.future.length > 0);
  const exportProject = useDirectorStore((s) => s.exportProject);
  const importProject = useDirectorStore((s) => s.importProject);
  const persist = useDirectorStore((s) => s.persist);

  // 场景自动保存：场景页内容（revision）或片场结构（manifest）任一变化即落盘。
  useEffect(() => {
    const signature = () => {
      const s = useDirectorStore.getState();
      return `${s.state.revision}#${s.manifest.name}|${s.manifest.activeSceneId}|${s.manifest.order
        .map((t) => `${t.id}:${t.name}`)
        .join(",")}`;
    };
    let last = signature();
    return useDirectorStore.subscribe(() => {
      const now = signature();
      if (now !== last) {
        last = now;
        persist();
      }
    });
  }, [persist]);

  // 无头渲染模式：?headless=1 时挂载 window.previsRender，供 MCP / Playwright 调用。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("headless") === "1") {
      installHeadlessApi();
    }
  }, []);

  // 左栏宽度是唯一数据源：抓手拖动与收起 / 展开都只改它，网格列宽由 CSS 变量 --left-w 跟随。
  // 拖动过程中由 resizing 关掉回弹动画，保证跟手；点击胶囊按钮则走带回弹的过渡。
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT_W);
  const [resizing, setResizing] = useState(false);
  const lastExpandedW = useRef(LEFT_DEFAULT_W);
  const collapsed = leftWidth <= LEFT_COLLAPSED_AT;
  const setLeftW = (next: number) => {
    const w = Math.max(LEFT_RAIL_W, Math.min(LEFT_MAX_W, next));
    if (w > LEFT_COLLAPSED_AT) lastExpandedW.current = w;
    setLeftWidth(w);
  };
  const toggleLeft = () => setLeftW(collapsed ? lastExpandedW.current : LEFT_RAIL_W);

  const handleExport = () => {
    const json = exportProject();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "director-desk-stage.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importProject(String(reader.result));
      reader.readAsText(file);
    };
    input.click();
  };

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleRenderVideo = async () => {
    if (exporting) return;
    setExporting(true);
    setExportStatus("准备中…");
    try {
      await exportMultiCamVideos({ fps: 24, onProgress: setExportStatus });
      setExportStatus("✓ 完成：已下载各相机视频（MP4）");
    } catch (error) {
      setExportStatus("✗ " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExporting(false);
      setTimeout(() => setExportStatus(null), 4000);
    }
  };

  useEffect(() => {
    if (!playing) return undefined;

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      const store = useDirectorStore.getState();
      // 播放到最后一个「有内容的帧」即结束，而不是走到 state.duration。
      const end = contentEndTime(store.state);
      const next = store.currentTime + delta;
      if (next >= end) {
        store.setTime(end);
        store.setPlaying(false);
        // 结束后播放头自动重置回第一帧。
        store.setTime(0);
        return;
      }
      store.setTime(next);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        const store = useDirectorStore.getState();
        if (store.selectedPoint && store.selectedItem) {
          event.preventDefault();
          store.deletePoint(store.selectedItem, store.selectedPoint);
        }
        return;
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        useDirectorStore.getState().toggleViewLocked();
      }
      // 撤销 / 重做：Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做（输入框内不拦截，保留原生文本撤销）。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) useDirectorStore.getState().redo();
        else useDirectorStore.getState().undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        useDirectorStore.getState().redo();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      className={`app${resizing ? " is-resizing" : ""}`}
      style={{ "--left-w": `${leftWidth}px` } as CSSProperties}
    >
      <header>
        <div className="brand">
          DIRECTOR DESK <span>V1.20</span>
        </div>
        <div className="actions">
          <button type="button" id="play" onClick={togglePlay}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button type="button" id="home" onClick={() => setTime(0)}>
            Home
          </button>
          <button type="button" id="undo" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
            ↶ Undo
          </button>
          <button type="button" id="redo" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)">
            ↷ Redo
          </button>
          <button type="button" id="export" onClick={handleExport}>
            Export
          </button>
          <button type="button" id="import" onClick={handleImport}>
            Import
          </button>
          <button type="button" id="render" onClick={handleRenderVideo} disabled={exporting}>
            {exporting ? "Rendering…" : "Render Video"}
          </button>
          {exportStatus && <span className="render-status">{exportStatus}</span>}
        </div>
      </header>

      <SceneTabs />

      <ObjectList
        width={leftWidth}
        collapsed={collapsed}
        onWidth={setLeftW}
        onToggle={toggleLeft}
        onDragging={setResizing}
      />
      <WorldView />
      <Inspector />
      <Timeline />
    </div>
  );
}
