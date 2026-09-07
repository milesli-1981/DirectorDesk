import { useMemo } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  ASPECT_OPTIONS,
  AspectRatio,
  CameraFraming,
  CameraMotionType,
  CameraSide,
  CameraView,
  EaseCurve,
  FRAMING_LABELS,
  LENS_OPTIONS,
  MOTION_HINTS,
  MOTION_LABELS,
  SIDE_LABELS,
  VIEW_LABELS,
} from "../domain/schema";
import { EaseEditor } from "./EaseEditor";

const MOTION_TYPES: CameraMotionType[] = ["STATIC", "FOLLOW", "ORBIT", "DOLLY", "CRANE"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="inspector-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Inspector() {
  const state = useDirectorStore((s) => s.state);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectedPoint = useDirectorStore((s) => s.selectedPoint);
  const viewMode = useDirectorStore((s) => s.viewMode);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const setViewMode = useDirectorStore((s) => s.setViewMode);
  const setActiveCamera = useDirectorStore((s) => s.setActiveCamera);
  const updateCamera = useDirectorStore((s) => s.updateCamera);
  const addCameraMove = useDirectorStore((s) => s.addCameraMove);
  const patchCameraMove = useDirectorStore((s) => s.patchCameraMove);
  const deleteCameraMove = useDirectorStore((s) => s.deleteCameraMove);
  const setSegmentEase = useDirectorStore((s) => s.setSegmentEase);
  const setCameraMoveEase = useDirectorStore((s) => s.setCameraMoveEase);
  const setAspectRatio = useDirectorStore((s) => s.setAspectRatio);

  const object = selectedKind === "object" ? state.objects.find((o) => o.id === selectedId) : undefined;
  const camera = selectedKind === "camera" ? state.cameras.find((c) => c.id === selectedId) : undefined;
  const segment = state.segments.find((item) => item.id === selectedItem);
  const constraint = state.constraints.find((item) => item.id === selectedItem);
  const move = state.cameraMoves.find((item) => item.id === selectedItem);

  const json = useMemo(() => JSON.stringify(state, null, 2), [state]);

  const pointCount = segment ? segment.points.length : 0;
  const selectedPointShape = segment?.points.find((point) => point.id === selectedPoint)?.shape;

  const easeTarget = segment
    ? {
        title: segment.id,
        ease: segment.ease,
        timeStart: segment.timeStart,
        timeEnd: segment.timeEnd,
        onChange: (ease: EaseCurve) => setSegmentEase(segment.id, ease),
      }
    : move
      ? {
          title: move.id,
          ease: move.ease,
          timeStart: move.timeStart,
          timeEnd: move.timeEnd,
          onChange: (ease: EaseCurve) => setCameraMoveEase(move.id, ease),
        }
      : null;

  const title = camera ? camera.name : (object?.id ?? "—");

  return (
    <aside className="right">
      <div className="st">INSPECTOR</div>
      <div className="title">{title}</div>
      <div className="sub">{camera ? "Camera Intent" : "Director State"}</div>

      <div className="field">
        <div className="lab">Current Intent</div>
        <div id="intentInfo">
          {camera ? (
            <>
              <span className="pill">CAMERA</span> TARGET {camera.targetId} ·{" "}
              {FRAMING_LABELS[camera.framing]} / {SIDE_LABELS[camera.side]} /{" "}
              {VIEW_LABELS[camera.view]} · {camera.lensMm}mm
            </>
          ) : constraint ? (
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
          ) : move ? (
            <>
              <span className="pill">{move.type}</span> {move.camera} ·{" "}
              {move.timeStart.toFixed(1)}–{move.timeEnd.toFixed(1)}s
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
          {segment ? ` · ${pointCount} path point${pointCount === 1 ? "" : "s"}` : ""}
          {selectedPointShape ? ` · ${selectedPointShape}` : ""}
        </div>
      </div>

      <div className="field" id="easeField" style={{ display: easeTarget ? "" : "none" }}>
        <div className="lab">Speed Curve · cubic-bezier</div>
        {easeTarget ? (
          <EaseEditor
            title={easeTarget.title}
            ease={easeTarget.ease}
            timeStart={easeTarget.timeStart}
            timeEnd={easeTarget.timeEnd}
            onChange={easeTarget.onChange}
          />
        ) : null}
      </div>

      {camera ? (
        <>
          <div className="field">
            <div className="lab">Camera Intent</div>
            <Field label="Target">
              <select
                value={camera.targetId}
                onChange={(event) => updateCamera(camera.id, { targetId: event.target.value })}
              >
                {state.objects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </select>
            </Field>
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
            <Field label="Lens">
              <select
                value={camera.lensMm}
                onChange={(event) => updateCamera(camera.id, { lensMm: Number(event.target.value) })}
              >
                {LENS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}mm
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default Motion">
              <select
                value={camera.motion}
                onChange={(event) =>
                  updateCamera(camera.id, { motion: event.target.value as CameraMotionType })
                }
              >
                {MOTION_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {MOTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
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
            <p className="hint">{MOTION_HINTS[camera.motion]}</p>
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
                  {item.id}
                </option>
              ))}
            </select>
          </Field>

          {move.type === "ORBIT" ? (
            <Field label={`Orbit ${move.orbitDeg.toFixed(0)}°`}>
              <input
                type="range"
                min={-360}
                max={360}
                step={5}
                value={move.orbitDeg}
                onChange={(event) => patchCameraMove(move.id, { orbitDeg: Number(event.target.value) })}
              />
            </Field>
          ) : null}

          {move.type === "DOLLY" ? (
            <Field label={`Dolly ×${move.dollyScale.toFixed(2)}`}>
              <input
                type="range"
                min={0.3}
                max={2}
                step={0.05}
                value={move.dollyScale}
                onChange={(event) =>
                  patchCameraMove(move.id, { dollyScale: Number(event.target.value) })
                }
              />
            </Field>
          ) : null}

          {move.type === "CRANE" ? (
            <Field label={`Crane +${move.craneHeight.toFixed(1)}m`}>
              <input
                type="range"
                min={-6}
                max={8}
                step={0.1}
                value={move.craneHeight}
                onChange={(event) =>
                  patchCameraMove(move.id, { craneHeight: Number(event.target.value) })
                }
              />
            </Field>
          ) : null}

          <div className="mini-btns">
            <button type="button" className="ghost-button danger-button" onClick={() => deleteCameraMove(move.id)}>
              Delete Move
            </button>
          </div>
        </div>
      ) : null}

      <div className="field">
        <div className="lab">Master Aspect Ratio</div>
        <select
          value={state.aspectRatio}
          onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
        >
          {ASPECT_OPTIONS.map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
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
          Segment/Constraint/CameraMove directly. Play reads the same state.
        </div>
      </div>
    </aside>
  );
}
