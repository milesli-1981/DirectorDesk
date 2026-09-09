import { useDirectorStore } from "../state/directorStore";
import { LockBadge } from "./LockBadge";

export function ObjectList() {
  const objects = useDirectorStore((s) => s.state.objects);
  const cameras = useDirectorStore((s) => s.state.cameras);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const updateAsset = useDirectorStore((s) => s.updateAsset);

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => (
          <div key={object.id} className="obj-row">
            <button
              type="button"
              className={`obj ${selectedKind === "object" && selectedId === object.id ? "sel" : ""}`}
              onClick={() => selectObject(object.id)}
            >
              <span className="obj-name">{object.id}</span>
              <span className="obj-meta">
                {object.category} / {object.role}
              </span>
            </button>
            {/* 右上角控制区：锁角标浮在这一角，不再占用行内宽度，名字因此能吃满整行 */}
            <div className="obj-actions">
              <LockBadge
                locked={!!object.locked}
                title={
                  object.locked
                    ? "已锁定初始位置：编辑时不可拖拽（点此解锁）；播放时仍按轨迹移动"
                    : "锁定初始位置：编辑时不可拖拽，播放时仍按轨迹移动"
                }
                onClick={() => updateAsset(object.id, { locked: !object.locked })}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="st cam-st">CAMERAS</div>
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
