import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { DirectorGroup, objectDisplayName } from "../domain/schema";
import { LockBadge } from "./LockBadge";

// 稳定引用：避免 zustand v5 选择器在 `state.groups` 缺失时每帧返回新 `[]` 触发无限重渲染。
const EMPTY_GROUPS: DirectorGroup[] = [];

export function ObjectList() {
  const objects = useDirectorStore((s) => s.state.objects);
  const cameras = useDirectorStore((s) => s.state.cameras);
  const selectedKind = useDirectorStore((s) => s.selectedKind);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const activeCameraId = useDirectorStore((s) => s.activeCameraId);
  const selectObject = useDirectorStore((s) => s.selectObject);
  const selectCamera = useDirectorStore((s) => s.selectCamera);
  const updateAsset = useDirectorStore((s) => s.updateAsset);
  const updateCamera = useDirectorStore((s) => s.updateCamera);
  const removeAsset = useDirectorStore((s) => s.removeAsset);
  const removeCamera = useDirectorStore((s) => s.removeCamera);
  const updateGroup = useDirectorStore((s) => s.updateGroup);

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

  // 相机双击改名（独立于资产改名状态）。
  const [camEditingId, setCamEditingId] = useState<string | null>(null);
  const [camDraft, setCamDraft] = useState("");
  const startCamRename = (id: string, current: string) => {
    setCamEditingId(id);
    setCamDraft(current);
  };
  const commitCamRename = () => {
    if (camEditingId) updateCamera(camEditingId, { name: camDraft.trim() || camEditingId });
    setCamEditingId(null);
  };

  // 组（Group Dynamics）作为对象的一类，直接在 OBJECTS 列表里以「团队」行呈现，
  // 选中队首即在右下 Inspector 配置整队，不单独成类、不在本面板放新建按钮。
  const groups = useDirectorStore((s) => s.state.groups ?? EMPTY_GROUPS);
  // 开启引力场的组 = 团队：在 OBJECTS 列表里合并成一行，不再逐个列出队员。
  const teamGroups = groups.filter((g) => g.dynamics && g.members.length >= 2);
  const teamMemberIds = new Set(teamGroups.flatMap((g) => g.members));
  const removeGroup = useDirectorStore((s) => s.removeGroup);

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => {
          // 团队（Group）在对象列表里合并为一行：整队是一个 unit，不再逐个列出队员。
          const team = teamGroups.find((g) => g.members[0] === object.id);
          if (teamMemberIds.has(object.id) && !team) return null;
          if (team) {
            return (
              <div key={team.id} className="obj-row team-row">
                <button
                  type="button"
                  className={`obj ${
                    selectedKind === "object" && team.members.includes(selectedId) ? "sel" : ""
                  }`}
                  onClick={() => selectObject(team.members[0])}
                  title={`团队 ${team.name} · ${team.members.length} 人（整队共用一条路线）· 点击选中队首以便画路径`}
                >
                  <span className="dot" style={{ background: team.color }} />
                  <span className="obj-name">
                    👥 {team.name} ×{team.members.length}
                  </span>
                  <span className="obj-meta">team / unit</span>
                </button>
                <div className="obj-actions">
                  <LockBadge
                    locked={!!team.locked}
                    title={
                      team.locked
                        ? "已锁定整队初始位置：编辑时不可拖拽队首移动整队（点此解锁）；播放时仍按轨迹行进"
                        : "锁定整队初始位置：编辑时不可拖拽队首移动整队，播放时仍按轨迹行进"
                    }
                    onClick={() => updateGroup(team.id, { locked: !team.locked })}
                  />
                  <button
                    type="button"
                    className="obj-del"
                    title="删除整个团队（含所有队员）"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `删除团队「${team.name}」及其 ${team.members.length} 个成员？`,
                        )
                      ) {
                        return;
                      }
                      for (const mid of team.members) removeAsset(mid);
                      removeGroup(team.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          }
          return (
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
            {/* 右上角控制区：锁角标 + 删除浮在这一角，不再占用行内宽度，名字因此能吃满整行 */}
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
              <button
                type="button"
                className="obj-del"
                title="删除资产"
                onClick={() => removeAsset(object.id)}
              >
                ✕
              </button>
            </div>
          </div>
          );
        })}
      </div>

      <div className="st cam-st">CAMERAS</div>
      <div id="cameraList">
        {cameras.map((camera) => (
          <div key={camera.id} className="obj-row cam-row">
            {camEditingId === camera.id ? (
              <input
                className="obj-rename"
                autoFocus
                value={camDraft}
                onChange={(event) => setCamDraft(event.target.value)}
                onBlur={commitCamRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitCamRename();
                  else if (event.key === "Escape") setCamEditingId(null);
                }}
              />
            ) : (
              <button
                type="button"
                className={`obj ${selectedKind === "camera" && selectedId === camera.id ? "sel" : ""}`}
                onClick={() => selectCamera(camera.id)}
                onDoubleClick={() => startCamRename(camera.id, camera.name)}
                title={`${camera.name} · 双击改名`}
              >
                <span className="dot" style={{ background: camera.color }} />
                {camera.name}
                {activeCameraId === camera.id ? " ●" : ""}
              </button>
            )}
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
