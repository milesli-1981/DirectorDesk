import { useMemo } from "react";
import { useDirectorStore } from "../state/directorStore";
import { EaseEditor } from "./EaseEditor";

export function Inspector() {
  const state = useDirectorStore((s) => s.state);
  const selectedObj = useDirectorStore((s) => s.selectedObj);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);

  const segment = state.segments.find((item) => item.id === selectedItem);
  const constraint = state.constraints.find((item) => item.id === selectedItem);

  const json = useMemo(() => JSON.stringify(state, null, 2), [state]);

  const pointCount = segment ? segment.points.length : 0;
  const selectedPointShape = segment?.points.find((point) => point.id === selectedPoint)?.shape;

  return (
    <aside className="right">
      <div className="st">INSPECTOR</div>
      <div className="title">{selectedObj}</div>
      <div className="sub">Director State</div>

      <div className="field">
        <div className="lab">Current Intent</div>
        <div id="intentInfo">
          {constraint ? (
            <>
              <span className="pill">{constraint.type}</span> {constraint.subject} →{" "}
              {constraint.target} · {constraint.timeStart.toFixed(1)}–
              {constraint.timeEnd.toFixed(1)}s
            </>
          ) : segment ? (
            <>
              <span className="pill">{segment.type}</span> {segment.object} ·{" "}
              {segment.timeStart.toFixed(1)}–{segment.timeEnd.toFixed(1)}s
            </>
          ) : (
            "No timeline intent selected."
          )}
        </div>
      </div>

      <div className="field">
        <div className="lab">Selected Timeline Item</div>
        <div id="itemInfo">
          {selectedItem ?? "—"}
          {segment
            ? ` · ${pointCount} path point${pointCount === 1 ? "" : "s"}`
            : ""}
          {selectedPointShape ? ` · ${selectedPointShape}` : ""}
        </div>
      </div>

      <div className="field" id="easeField" style={{ display: segment ? "" : "none" }}>
        <div className="lab">Speed Curve · cubic-bezier</div>
        {segment ? <EaseEditor segmentId={segment.id} /> : null}
      </div>

      <div className="field">
        <div className="lab">State Revision</div>
        <div id="rev">{state.revision}</div>
      </div>

      <div className="field">
        <div className="lab">Director State JSON</div>
        <pre id="state">{json}</pre>
      </div>

      <div className="field">
        <div className="hint">
          Timeline is a view of Director State. Dragging a clip changes the underlying
          Segment/Constraint directly. Play reads the same state.
        </div>
      </div>
    </aside>
  );
}
