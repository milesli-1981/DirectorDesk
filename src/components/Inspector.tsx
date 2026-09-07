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
  HandoffMode,
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
  const setHandoffMode = useDirectorStore((s) => s.setHandoffMode);
  const setCameraJunctionMode = useDirectorStore((s) => s.setCameraJunctionMode);
  const deleteSegment = useDirectorStore((s) => s.deleteSegment);
  const updateAsset = useDirectorStore((s) => s.updateAsset);
  const removeAsset = useDirectorStore((s) => s.removeAsset);

  const object = selectedKind === "object" ? state.objects.find((o) => o.id === selectedId) : undefined;
  const camera = selectedKind === "camera" ? state.cameras.find((c) => c.id === selectedId) : undefined;
  const segment = state.segments.find((item) => item.id === selectedItem);
  const constraint = state.constraints.find((item) => item.id === selectedItem);
  const move = state.cameraMoves.find((item) => item.id === selectedItem);
  // 该相机上被 CameraMove 写死的段级覆盖：相机级同名属性在那些时间段内不生效。
  const overriddenByMoves = camera
    ? (["framing", "view", "side", "lensMm"] as const).filter((key) =>
        state.cameraMoves.some((item) => item.camera === camera.id && item[key] !== undefined),
      )
    : [];
  const handoff = segment
    ? state.handoffs.find((h) => h.prevSeg === segment.id) ??
      state.handoffs.find((h) => h.nextSeg === segment.id)
    : undefined;

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

      {object ? (
        <div className="field">
          <div className="lab">Asset — {object.category}</div>
          <div className="row2">
            <label>Role</label>
            <select
              value={object.role}
              onChange={(event) => updateAsset(object.id, { role: event.target.value as "agent" | "set" })}
            >
              <option value="agent">agent（可运动 / 可作目标）</option>
              <option value="set">set（环境 / 遮挡体）</option>
            </select>
          </div>
          <div className="row2">
            <label>Rotation</label>
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={object.rotation}
              onChange={(event) => updateAsset(object.id, { rotation: Number(event.target.value) })}
            />
            <span className="val">{object.rotation}°</span>
          </div>
          <div className="row2">
            <label>Block</label>
            <span className="val">W</span>
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={object.footprint.w}
              onChange={(event) =>
                updateAsset(object.id, { footprint: { ...object.footprint, w: Number(event.target.value) } })
              }
            />
            <span className="val">D</span>
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={object.footprint.d}
              onChange={(event) =>
                updateAsset(object.id, { footprint: { ...object.footprint, d: Number(event.target.value) } })
              }
            />
            <span className="val">H</span>
            <input
              type="number"
              step={0.1}
              min={0.1}
              value={object.footprint.h}
              onChange={(event) =>
                updateAsset(object.id, { footprint: { ...object.footprint, h: Number(event.target.value) } })
              }
            />
          </div>
          <div className="row2">
            <label>Lock</label>
            <button
              type="button"
              className={`ghost-button ${object.locked ? "on" : ""}`}
              onClick={() => updateAsset(object.id, { locked: !object.locked })}
            >
              {object.locked ? "Unlock" : "Lock position"}
            </button>
          </div>
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              onClick={() => removeAsset(object.id)}
            >
              Delete Asset
            </button>
          </div>
          <p className="hint">锁定后不可通过拖拽移动位置（防误触），仍可点选以便解锁；agent = 可运动、可作相机目标，set = 环境遮挡体与路径障碍</p>
        </div>
      ) : null}

      {segment && handoff ? (
        <div className="field">
          <div className="lab">
            Leg Handoff → {handoff.prevSeg === segment.id ? "next" : "prev"} ({handoff.id})
          </div>
          <div className="mini-btns">
            {(["stop", "smooth", "cut"] as HandoffMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`ghost-button ${handoff.mode === mode ? "on" : ""}`}
                onClick={() => setHandoffMode(handoff.id, mode)}
              >
                {mode}
              </button>
            ))}
          </div>
          <div className="mini-btns">
            <button
              type="button"
              className="ghost-button danger-button"
              onClick={() => deleteSegment(segment.id)}
            >
              Delete Leg
            </button>
          </div>
          <p className="hint">stop = pause then go · smooth = continuous (一镜到底) · cut = allow teleport</p>
        </div>
      ) : null}

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
            {overriddenByMoves.length > 0 ? (
              <p className="hint">
                ⚠ {overriddenByMoves.join(" / ")} 已被某些 CameraMove 段级覆盖，相机级同名属性在那些时间段内不生效（段级留空即继承此处）。
              </p>
            ) : null}
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

          <Field label="Framing">
            <select
              value={move.framing ?? ""}
              onChange={(event) =>
                patchCameraMove(move.id, { framing: (event.target.value || undefined) as CameraFraming | undefined })
              }
            >
              <option value="">(camera default)</option>
              {(Object.keys(FRAMING_LABELS) as CameraFraming[]).map((value) => (
                <option key={value} value={value}>
                  {FRAMING_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="View">
            <select
              value={move.view ?? ""}
              onChange={(event) =>
                patchCameraMove(move.id, { view: (event.target.value || undefined) as CameraView | undefined })
              }
            >
              <option value="">(camera default)</option>
              {(Object.keys(VIEW_LABELS) as CameraView[]).map((value) => (
                <option key={value} value={value}>
                  {VIEW_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Side">
            <select
              value={move.side ?? ""}
              onChange={(event) =>
                patchCameraMove(move.id, { side: (event.target.value || undefined) as CameraSide | undefined })
              }
            >
              <option value="">(camera default)</option>
              {(Object.keys(SIDE_LABELS) as CameraSide[]).map((value) => (
                <option key={value} value={value}>
                  {SIDE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Lens">
            <select
              value={move.lensMm ?? ""}
              onChange={(event) =>
                patchCameraMove(move.id, { lensMm: event.target.value ? Number(event.target.value) : undefined })
              }
            >
              <option value="">(camera default)</option>
              {LENS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}mm
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

          {(() => {
            const junction = state.cameraJunctions.find(
              (j) => j.prevMove === move.id || j.nextMove === move.id,
            );
            if (!junction) return null;
            return (
              <div className="field" style={{ marginTop: 8 }}>
                <div className="lab">
                  Move Junction → {junction.prevMove === move.id ? "next" : "prev"} ({junction.id})
                </div>
                <div className="mini-btns">
                  {(["stop", "smooth", "cut"] as HandoffMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`ghost-button ${junction.mode === mode ? "on" : ""}`}
                      onClick={() => setCameraJunctionMode(junction.id, mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <p className="hint">stop = pause then go · smooth = continuous (一镜到底) · cut = allow jump</p>
              </div>
            );
          })()}

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
