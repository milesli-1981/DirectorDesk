import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { objectDisplayName } from "../domain/schema";
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
  const removeAsset = useDirectorStore((s) => s.removeAsset);
  const removeCamera = useDirectorStore((s) => s.removeCamera);

  // 双击改名：只改显示名（name），id 作为稳定标识保持不变。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const startRename = (id: string, current: string) => {
    setEditingId(id);
    setDraft(current);
  };
  const commitRename = () => {
    if (editingId) updateAsset(editingId, { name: draft.trim() || undefined });
    setEditingId(null);
  };

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => (
          <div key={object.id} className="obj-row">
            {editingId === object.id ? (
              <input
                className="obj-rename"
                autoFocus
                value={draft}
                placeholder={object.id}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename();
                  else if (event.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                type="button"
                className={`obj ${selectedKind === "object" && selectedId === object.id ? "sel" : ""}`}
                onClick={() => selectObject(object.id)}
                onDoubleClick={() => startRename(object.id, objectDisplayName(object))}
                title={`${objectDisplayName(object)} · 双击改名`}
              >
                <span className="obj-name">{objectDisplayName(object)}</span>
                <span className="obj-meta">
                  {object.category} / {object.role}
                </span>
              </button>
            )}
            {/* 右上角控制区：删除 + 锁角标浮在这一角，不再占用行内宽度，名字因此能吃满整行 */}
            <div className="obj-actions">
              <button
                type="button"
                className="obj-del"
                title="删除资产"
                onClick={() => removeAsset(object.id)}
              >
                ✕
              </button>
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
          <div key={camera.id} className="obj-row cam-row">
            <button
              type="button"
              className={`obj ${selectedKind === "camera" && selectedId === camera.id ? "sel" : ""}`}
              onClick={() => selectCamera(camera.id)}
            >
              <span className="dot" style={{ background: camera.color }} />
              {camera.name}
              {activeCameraId === camera.id ? " ●" : ""}
            </button>
            <div className="obj-actions">
              <button
                type="button"
                className="obj-del"
                title="删除相机"
                onClick={() => removeCamera(camera.id)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
