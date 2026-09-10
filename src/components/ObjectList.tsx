import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDirectorStore } from "../state/directorStore";
import { ASPECT_OPTIONS, AspectRatio, DirectorGroup, ActionClip, objectDisplayName } from "../domain/schema";
import { LockBadge } from "./LockBadge";

// 稳定引用：避免 zustand v5 选择器在 `state.groups` 缺失时每帧返回新 `[]` 触发无限重渲染。
const EMPTY_GROUPS: DirectorGroup[] = [];
// 旧场景 JSON 可能缺 actions；zustand 选择器需返回稳定引用，避免每帧新建数组触发无限重渲染。
const EMPTY_ACTIONS: ActionClip[] = [];

/** 左栏宽度边界：抓手拖动范围与「收起」判定阈值（App 与抓手共用同一套）。 */
export const LEFT_RAIL_W = 28;
export const LEFT_MAX_W = 520;
export const LEFT_COLLAPSED_AT = 100;
export const LEFT_DEFAULT_W = 200;

export function ObjectList({
  width,
  collapsed,
  onWidth,
  onToggle,
  onDragging,
}: {
  width: number;
  collapsed: boolean;
  onWidth: (w: number) => void;
  onToggle: () => void;
  onDragging: (d: boolean) => void;
}) {
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
  // 列表里真正会渲染成行的对象：团队成员被合并进「团队」行，不再逐个列出。
  const visibleObjects = objects.filter(
    (o) => !teamMemberIds.has(o.id) || teamGroups.some((g) => g.members[0] === o.id),
  );
  const removeGroup = useDirectorStore((s) => s.removeGroup);

  // 时间轴片段（左侧对象 / 相机树下挂用）：segment→对象、constraint→对象(subject)、
  // action→对象、cameraMove→相机。它们都是 selectedItem 的候选，点选后由 store 互斥订阅清掉对象选中。
  const segments = useDirectorStore((s) => s.state.segments);
  const constraints = useDirectorStore((s) => s.state.constraints);
  const actions = useDirectorStore((s) => s.state.actions ?? EMPTY_ACTIONS);
  const cameraMoves = useDirectorStore((s) => s.state.cameraMoves);
  const selectedItem = useDirectorStore((s) => s.selectedItem);
  const selectItem = useDirectorStore((s) => s.selectItem);

  // 树展开状态：手动展开优先；未手动操作过、且该项正是当前选中片段的归属对象/相机时自动展开，
  // 这样选中片段后其父节点保持展开、子项可见。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 抓手交互：按下记录起点；移动超过阈值才进入拖宽模式（并关掉回弹动画以便跟手），
  // 松开时若从未移动则视为「点击中间胶囊按钮」→ 快速收起 / 展开。
  const dragRef = useRef<{ startX: number; startW: number; moved: boolean } | null>(null);
  const onGripDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startW: width, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onGripMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = event.clientX - st.startX;
    if (!st.moved) {
      if (Math.abs(dx) < 4) return;
      st.moved = true;
      onDragging(true);
    }
    onWidth(Math.max(LEFT_RAIL_W, Math.min(LEFT_MAX_W, st.startW + dx)));
  };
  const onGripUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (st.moved) onDragging(false);
    else onToggle();
  };
  const selectedOwnerId =
    (selectedItem && segments.find((s) => s.id === selectedItem)?.object) ||
    (selectedItem && constraints.find((c) => c.id === selectedItem)?.subject) ||
    (selectedItem && actions.find((a) => a.id === selectedItem)?.object) ||
    (selectedItem && cameraMoves.find((m) => m.id === selectedItem)?.camera) ||
    null;
  const isOpen = (id: string) => expanded[id] ?? id === selectedOwnerId;
  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? id === selectedOwnerId) }));

  // 顶层项目设置：Master 画幅（交付格式），始终显示，不依赖是否选中对象。
  const aspectRatio = useDirectorStore((s) => s.state.aspectRatio);
  const setAspectRatio = useDirectorStore((s) => s.setAspectRatio);

  return (
    <aside className={`left${collapsed ? " is-collapsed" : ""}`}>
      <div className="st">PROJECT</div>
      <div className="field">
        <div className="lab">Master Aspect Ratio</div>
        <select
          value={aspectRatio}
          onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
        >
          {ASPECT_OPTIONS.map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="list-scroll">
      <div className="sub-group">
      <div className="sub-title">OBJECTS</div>
      <div id="objectList">
        {visibleObjects.length === 0 ? <div className="tree-empty">暂无对象</div> : null}
        {objects.map((object) => {
          // 团队（Group）在对象列表里合并为一行：整队是一个 unit，不再逐个列出队员。
          const team = teamGroups.find((g) => g.members[0] === object.id);
          if (teamMemberIds.has(object.id) && !team) return null;

          // 归属该对象（或团队锚点）的时间轴片段：segment / constraint / action 都挂在对象下。
          const ownerId = team ? team.members[0] : object.id;
          const segs = segments.filter((s) => s.object === ownerId);
          const cons = constraints.filter((c) => c.subject === ownerId);
          const acts = actions.filter((a) => a.object === ownerId);
          const childCount = segs.length + cons.length + acts.length;
          const open = isOpen(ownerId);
          if (team) {
            return (
              <div key={object.id} className="obj-row">
                {/* obj-head：只包「第一行」，右上角角标相对它定位；
                    子项（.tree-children）是它的兄弟，展开不会把角标顶下去。 */}
                <div className="obj-head">
                {childCount > 0 && (
                  <button
                    type="button"
                    className="tree-toggle"
                    onClick={() => toggle(ownerId)}
                    title="展开 / 收起该团队的时间轴片段"
                  >
                    {open ? "▾" : "▸"}
                  </button>
                )}
                <button
                  type="button"
                  className={`obj ${
                    selectedKind === "object" && team.members.includes(selectedId) ? "sel" : ""
                  }`}
                  onClick={() => selectObject(team.members[0])}
                >
                  <span className="dot" style={{ background: team.color }} />
                  <span className="obj-name">
                    👥 {team.name} ×{team.members.length}
                  </span>
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
                {open && childCount > 0 && (
                  <div className="tree-children">
                    {segs.map((seg) => (
                      <TreeChild key={seg.id} kind="segment" tag="PATH" label={`${seg.id} · ${seg.type}`} selected={selectedItem === seg.id} onClick={() => selectItem(seg.id)} />
                    ))}
                    {cons.map((c) => (
                      <TreeChild key={c.id} kind="constraint" tag={c.type === "FOLLOW" ? "FOLLOW" : "LOOK"} label={c.type === "FOLLOW" ? `FOLLOW ${c.target}` : `LOOK AT ${c.target}`} selected={selectedItem === c.id} onClick={() => selectItem(c.id)} />
                    ))}
                    {acts.map((a) => (
                      <TreeChild key={a.id} kind="action" tag="ACT" label={a.kind} selected={selectedItem === a.id} onClick={() => selectItem(a.id)} />
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
          <div key={object.id} className="obj-row">
            <div className="obj-head">
            {childCount > 0 && (
              <button
                type="button"
                className="tree-toggle"
                onClick={() => toggle(ownerId)}
                title="展开 / 收起该对象的时间轴片段"
              >
                {open ? "▾" : "▸"}
              </button>
            )}
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
            {open && childCount > 0 && (
              <div className="tree-children">
                {segs.map((seg) => (
                  <TreeChild key={seg.id} kind="segment" tag="PATH" label={`${seg.id} · ${seg.type}`} selected={selectedItem === seg.id} onClick={() => selectItem(seg.id)} />
                ))}
                {cons.map((c) => (
                  <TreeChild key={c.id} kind="constraint" tag={c.type === "FOLLOW" ? "FOLLOW" : "LOOK"} label={c.type === "FOLLOW" ? `FOLLOW ${c.target}` : `LOOK AT ${c.target}`} selected={selectedItem === c.id} onClick={() => selectItem(c.id)} />
                ))}
                {acts.map((a) => (
                  <TreeChild key={a.id} kind="action" tag="ACT" label={a.kind} selected={selectedItem === a.id} onClick={() => selectItem(a.id)} />
                ))}
              </div>
            )}
          </div>
          );
        })}
      </div>
      </div>

      <div className="sub-group">
      <div className="sub-title">CAMERAS</div>
      <div id="cameraList">
        {cameras.length === 0 ? <div className="tree-empty">暂无相机</div> : null}
        {cameras.map((camera) => {
          const moves = cameraMoves.filter((m) => m.camera === camera.id);
          const open = isOpen(camera.id);
          return (
            <div key={camera.id} className="obj-row cam-row">
              <div className="obj-head">
              {moves.length > 0 && (
                <button
                  type="button"
                  className="tree-toggle"
                  onClick={() => toggle(camera.id)}
                  title="展开 / 收起该相机的 Camera Move"
                >
                  {open ? "▾" : "▸"}
                </button>
              )}
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
              {open && moves.length > 0 && (
                <div className="tree-children">
                  {moves.map((m) => (
                    <TreeChild
                      key={m.id}
                      kind="camera"
                      tag="MOVE"
                      label={`${m.type} · ${m.targetId ?? "default"}`}
                      selected={selectedItem === m.id}
                      onClick={() => selectItem(m.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </div>
      </div>

      {/* 右边缘抓手：拖动改宽度；点击中间胶囊按钮快速收起 / 展开 */}
      <div
        className="left-resizer"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        title="拖动调整宽度 · 点击中间按钮收起 / 展开"
      >
        <span
          className="left-grip"
          role="button"
          tabIndex={-1}
          aria-label={collapsed ? "展开对象列表" : "收起对象列表"}
        >
          <span className="grip-dots" />
        </span>
      </div>
    </aside>
  );
}

/** 左侧层级树的子项：segment / constraint / action / cameraMove 一行，左侧带类型标签。 */
function TreeChild({
  kind,
  tag,
  label,
  selected,
  onClick,
}: {
  kind: string;
  tag: string;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`tree-child tree-${kind} ${selected ? "sel" : ""}`}
      onClick={onClick}
      title={label}
    >
      <span className="tree-kind">{tag}</span>
      <span className="tree-label">{label}</span>
    </button>
  );
}
