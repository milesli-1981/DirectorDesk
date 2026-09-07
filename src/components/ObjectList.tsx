import { useDirectorStore } from "../state/directorStore";

export function ObjectList() {
  const objects = useDirectorStore((s) => s.state.objects);
  const cameras = useDirectorStore((s) => s.state.cameras);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const addCamera = useDirectorStore((s) => s.addCamera);

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => (
          <button
            key={object.id}
            type="button"
            className={`obj ${selectedKind === "object" && selectedId === object.id ? "sel" : ""}`}
            onClick={() => selectObject(object.id)}
          >
            {object.id} · {object.type.toUpperCase()}
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
