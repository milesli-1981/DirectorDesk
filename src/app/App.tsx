import { useEffect, useState } from "react";
import { Inspector } from "../components/Inspector";
import { ObjectList } from "../components/ObjectList";
import { SceneTabs } from "../components/SceneTabs";
import { Timeline } from "../components/Timeline";
import { WorldView } from "../components/WorldView";
import { contentEndTime } from "../engine/timeline";
import { exportMultiCamVideos } from "../engine/videoExport";
import { useDirectorStore } from "../state/directorStore";

export function App() {
  const playing = useDirectorStore((s) => s.playing);
  const togglePlay = useDirectorStore((s) => s.togglePlay);
  const setTime = useDirectorStore((s) => s.setTime);
  const reset = useDirectorStore((s) => s.reset);
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
      setExportStatus("✓ 完成：已下载各相机 WebM");
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
    <div className="app">
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
          <button type="button" id="reset" onClick={reset}>
            Reset
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

      <ObjectList />
      <WorldView />
      <Inspector />
      <Timeline />
    </div>
  );
}
