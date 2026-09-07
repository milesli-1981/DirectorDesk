import { useEffect } from "react";
import { Inspector } from "../components/Inspector";
import { ObjectList } from "../components/ObjectList";
import { Timeline } from "../components/Timeline";
import { WorldView } from "../components/WorldView";
import { contentEndTime } from "../engine/timeline";
import { useDirectorStore } from "../state/directorStore";

export function App() {
  const playing = useDirectorStore((s) => s.playing);
  const togglePlay = useDirectorStore((s) => s.togglePlay);
  const setTime = useDirectorStore((s) => s.setTime);
  const reset = useDirectorStore((s) => s.reset);
  const exportScene = useDirectorStore((s) => s.exportScene);
  const importScene = useDirectorStore((s) => s.importScene);
  const persist = useDirectorStore((s) => s.persist);

  // 场景自动保存：仅在 revision 变化（即编辑意图变更）时写入 localStorage。
  useEffect(() => {
    let last = useDirectorStore.getState().state.revision;
    return useDirectorStore.subscribe((s) => {
      if (s.state.revision !== last) {
        last = s.state.revision;
        persist();
      }
    });
  }, [persist]);

  const handleExport = () => {
    const json = exportScene();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "director-desk-scene.json";
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
      reader.onload = () => importScene(String(reader.result));
      reader.readAsText(file);
    };
    input.click();
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
          <button type="button" id="reset" onClick={reset}>
            Reset
          </button>
          <button type="button" id="export" onClick={handleExport}>
            Export
          </button>
          <button type="button" id="import" onClick={handleImport}>
            Import
          </button>
        </div>
      </header>

      <ObjectList />
      <WorldView />
      <Inspector />
      <Timeline />
    </div>
  );
}
