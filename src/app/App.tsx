import { useEffect } from "react";
import { Inspector } from "../components/Inspector";
import { ObjectList } from "../components/ObjectList";
import { Timeline } from "../components/Timeline";
import { WorldView } from "../components/WorldView";
import { useDirectorStore } from "../state/directorStore";

export function App() {
  const playing = useDirectorStore((s) => s.playing);
  const togglePlay = useDirectorStore((s) => s.togglePlay);
  const setTime = useDirectorStore((s) => s.setTime);
  const reset = useDirectorStore((s) => s.reset);

  useEffect(() => {
    if (!playing) return undefined;

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      const store = useDirectorStore.getState();
      const next = store.currentTime + delta;
      if (next >= store.state.duration) {
        store.setTime(store.state.duration);
        store.setPlaying(false);
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
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const store = useDirectorStore.getState();
      if (store.selectedPoint && store.selectedItem) {
        event.preventDefault();
        store.deletePoint(store.selectedItem, store.selectedPoint);
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
        </div>
      </header>

      <ObjectList />
      <WorldView />
      <Inspector />
      <Timeline />
    </div>
  );
}
