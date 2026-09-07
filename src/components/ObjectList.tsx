import { useDirectorStore } from "../state/directorStore";
import { ASSET_ORDER, ASSET_PRESETS } from "../engine/assetPresets";

export function ObjectList() {
  const objects = useDirectorStore((s) => s.state.objects);
  const cameras = useDirectorStore((s) => s.state.cameras);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const addCamera = useDirectorStore((s) => s.addCamera);
  const addAsset = useDirectorStore((s) => s.addAsset);
  const updateAsset = useDirectorStore((s) => s.updateAsset);

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => (
          <div
            key={object.id}
            className={`obj-row ${selectedKind === "object" && selectedId === object.id ? "sel" : ""}`}
          >
            <button type="button" className="obj" onClick={() => selectObject(object.id)}>
              {object.id} · {object.category}
            </button>
            <button
              type="button"
              className={`lock-btn ${object.locked ? "on" : ""}`}
              title={object.locked ? "Unlock position" : "Lock position"}
              onClick={() => updateAsset(object.id, { locked: !object.locked })}
            >
              {object.locked ? "Locked" : "Lock"}
            </button>
          </div>
        ))}
      </div>

      <div className="st asset-st">ADD ASSET</div>
      <div id="assetPalette" className="asset-palette">
        {ASSET_ORDER.map((category) => (
          <button
            key={category}
            type="button"
            className="obj addasset"
            title={`Add ${ASSET_PRESETS[category].label}`}
            onClick={() => addAsset(category)}
          >
            ＋ {ASSET_PRESETS[category].label}
          </button>
        ))}
      </div>

      <div className="st cam-st">CAMERAS</div>
      <button type="button" className="obj addobj" onClick={addCamera}>
        ＋ CAMERA
      </button>
      <div id="cameraList">
        {cameras.map((camera) => (
          <button
            key={camera.id}
            type="button"
            className={`obj ${selectedKind === "camera" && selectedId === camera.id ? "sel" : ""}`}
            onClick={() => selectCamera(camera.id)}
          >
            <span className="dot" style={{ background: camera.color }} />
            {camera.name}
            {activeCameraId === camera.id ? " ●" : ""}
          </button>
        ))}
      </div>
    </aside>
  );
}
