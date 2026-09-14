import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useDirectorStore } from "../state/directorStore";
import {
  ASPECT_OPTIONS,
  AspectRatio,
  ActionClip,
  DirectorGroup,
  DirectorObject,
  objectDisplayName,
} from "../domain/schema";
import { LockBadge } from "./LockBadge";
import { stackParentMap } from "../engine/stack";

// 稳定引用：避免 zustand v5 选择器在 `state.groups` 缺失时每帧返回新 `[]` 触发无限重渲染。
const EMPTY_GROUPS: DirectorGroup[] = [];
// 旧场景 JSON 可能缺 actions；zustand 选择器需返回稳定引用，避免每帧新建数组触发无限重渲染。
const EMPTY_ACTIONS: ActionClip[] = [];

/** 左栏宽度边界：抓手拖动范围与「收起」判定阈值（App 与抓手共用同一套）。 */
export const LEFT_RAIL_W = 28;
export const LEFT_MAX_W = 520;
export const LEFT_COLLAPSED_AT = 100;
export const LEFT_DEFAULT_W = 200;

/** 显示 / 隐藏角标：复用锁角标的视觉，睁眼 = 显示，闭眼 = 隐藏。 */
function VisBadge({
  hidden,
  title,
  onClick,
}: {
  hidden: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`lock-icon-btn ${hidden ? "on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={hidden}
      onClick={onClick}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M1.5 8s2.6-4.2 6.5-4.2S14.5 8 14.5 8s-2.6 4.2-6.5 4.2S1.5 8 1.5 8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <circle cx="8" cy="8" r="1.9" fill="currentColor" />
        {hidden ? <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /> : null}
      </svg>
    </button>
  );
}

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
  const addCamera = useDirectorStore((s) => s.addCamera);
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

  // ── 列表折叠（Phase 8）：堆叠链在对象列表里合并成一行 ─────────────────
  // 与上面的「团队行」是同一个模式：一堆东西在导演眼里是一个 unit，就该只占一行。
  // 「谁压在谁身上」由几何现推（见 engine/stack.ts），不存关系记录。
  const stackParent = useMemo(() => stackParentMap(objects), [objects]);
  // 每个对象的直接下层们（父 → 子列表）。用 Map<string, string[]> 支持一棵 infra
  // 一个盒子横跨两块板时，两块板各自展出它 —— 但 stackParentMap 只给它指派了
  // 一个父（最高的那块），所以这里建的是**树**而不是 DAG，不会重复分行。
  const stackChildren = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [upper, lower] of stackParent) {
      const list = map.get(lower);
      if (list) list.push(upper);
      else map.set(lower, [upper]);
    }
    return map;
  }, [stackParent]);
  // 顶层只渲染"不压在任何东西上"的对象；其余的作为子树挂在父行下（见 hiddenUnder）。
  // 整塔成员（含根）：父行的批量操作（隐藏 / 锁定 / 删除）要作用于整条链。
  // visited 防环 —— 相切判定理论上不可能成环，但这里的 map 是从几何推出来的，
  // 手工 JSON 数据里若真出现不一致，宁可早停，也不要让 while 死循环。
  const chainOf = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const child of stackChildren.get(cur) ?? []) stack.push(child);
    }
    return out;
  };

  // 会真正渲染成行的对象（团队已合并成一行，队员不单独出现）。
  const rowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of objects) {
      const g = teamGroups.find((t) => t.members[0] === o.id);
      if (g) {
        ids.add(o.id); // 队首代表整队
        continue;
      }
      if (teamMemberIds.has(o.id)) continue; // 队员被团队行合并掉
      ids.add(o.id);
    }
    return ids;
  }, [objects, teamGroups, teamMemberIds]);

  // **只有当父行真的在列表里时**，这一层才并进父行的子树。
  // 反过来的话（无条件按几何关系隐藏子层）：一座塔压在被团队行合并掉的队员身上时，
  // 它的父行根本不存在，子层却被隐藏 ⇒ 整座塔从列表里彻底消失。
  // 几何关系不能越过"谁被渲染"这个前提。
  const hiddenUnder = (id: string) => {
    const parent = stackParent.get(id);
    return parent !== undefined && rowIds.has(parent);
  };

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

  // 堆叠行单独一套展开状态（键加前缀避免与时间轴片段的展开状态撞key）。
  // **默认收起**：一行 = 一整塔，这正是"折叠"的意义；展开才逐层编辑。
  const stackKey = (id: string) => `stack:${id}`;
  const isStackOpen = (id: string) => expanded[stackKey(id)] ?? false;
  const toggleStack = (id: string) =>
    setExpanded((prev) => ({ ...prev, [stackKey(id)]: !(prev[stackKey(id)] ?? false) }));

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
          // 堆叠：往上还有东西压着它、且那个父行真的在列表里 → 由父行递归渲染出来。
          // 父行不存在的情况见 `hiddenUnder` 的注释（团队行会把父行合并掉）。
          if (!team && hiddenUnder(object.id)) return null;

          // 归属该对象（或团队锚点）的时间轴片段：segment / constraint / action 都挂在对象下。
          const ownerId = team ? team.members[0] : object.id;
          const segs = segments.filter((s) => s.object === ownerId);
          const cons = constraints.filter((c) => c.subject === ownerId);
          const acts = actions.filter((a) => a.object === ownerId);
          const childCount = segs.length + cons.length + acts.length;
          const open = isOpen(ownerId);
          // 堆叠：压在这一层的**直接**上层们（多层塔由 StackChildRow 递归下去）。
          const layerIds = team ? [] : (stackChildren.get(object.id) ?? []);
          const layersOpen = isStackOpen(object.id);
          // 整条链（含自身）。这三个标记只在"确实有上层"时才被子层用到；
          // 没有上层时它们退化成对这个对象自身的判断，行为与折叠前完全一致。
          const chain = layerIds.length > 0 ? chainOf(object.id) : [object.id];
          const chainMembers = chain
            .map((cid) => objects.find((o) => o.id === cid))
            .filter((o): o is DirectorObject => !!o);
          const wholeHidden = chainMembers.length > 0 && chainMembers.every((o) => o.hidden);
          const wholeLocked = chainMembers.length > 0 && chainMembers.every((o) => o.locked);
          if (team) {
            const teamHidden = team.members.every(
              (mid) => objects.find((o) => o.id === mid)?.hidden,
            );
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
                  <VisBadge
                    hidden={teamHidden}
                    title={teamHidden ? "已隐藏整队：画布上不显示（点此显示）" : "隐藏整队：画布上不显示全部队员"}
                    onClick={() => {
                      const next = !teamHidden;
                      for (const mid of team.members) updateAsset(mid, { hidden: next });
                    }}
                  />
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
            {/* 堆叠折叠：有东西压在它上面时给出展开箭头，展开后逐层显示。
                收起态在这一同一行上标出层数，导演一眼知道"这不是一个孤盒子"。 */}
            {layerIds.length > 0 && (
              <button
                type="button"
                className="stack-toggle"
                onClick={() => toggleStack(object.id)}
                title={`展开 / 收起压在上面的 ${layerIds.length} 个对象`}
              >
                {layersOpen ? "▾" : "▸"} {layerIds.length}
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
              {/* 有东西压在上面时，隐藏 / 锁定 / 删除都作用于整条堆叠链 ——
                  这是"折叠成一行"的意义：导演眼里这一行就是那一座塔。
                  没上层时行为与原来完全一致（只动自己）。 */}
              <VisBadge
                hidden={layerIds.length > 0 ? wholeHidden : !!object.hidden}
                title={
                  layerIds.length > 0
                    ? wholeHidden
                      ? `已隐藏整座塔（${chain.length} 个）：点此显示全部`
                      : `隐藏整座塔（含压在上面的 ${layerIds.length} 个）`
                    : object.hidden
                      ? "已隐藏：画布上不显示（点此显示）"
                      : "隐藏：画布上不显示该对象"
                }
                onClick={() => {
                  if (layerIds.length === 0) {
                    updateAsset(object.id, { hidden: !object.hidden });
                    return;
                  }
                  for (const cid of chain) updateAsset(cid, { hidden: !wholeHidden });
                }}
              />
              <LockBadge
                locked={layerIds.length > 0 ? wholeLocked : !!object.locked}
                title={
                  layerIds.length > 0
                    ? wholeLocked
                      ? `已锁定整座塔（${chain.length} 个）：点此解锁`
                      : `锁定整座塔（含压在上面的 ${layerIds.length} 个）：编辑时不可拖拽`
                    : object.locked
                      ? "已锁定初始位置：编辑时不可拖拽（点此解锁）；播放时仍按轨迹移动"
                      : "锁定初始位置：编辑时不可拖拽，播放时仍按轨迹移动"
                }
                onClick={() => {
                  if (layerIds.length === 0) {
                    updateAsset(object.id, { locked: !object.locked });
                    return;
                  }
                  for (const cid of chain) updateAsset(cid, { locked: !wholeLocked });
                }}
              />
              <button
                type="button"
                className="obj-del"
                title={layerIds.length > 0 ? `删除整座塔（${chain.length} 个）` : "删除资产"}
                onClick={() => {
                  if (layerIds.length === 0) {
                    removeAsset(object.id);
                    return;
                  }
                  if (!window.confirm(`删除这座塔的 ${chain.length} 个对象（含它上面的层）？`)) {
                    return;
                  }
                  // **自顶向下删**：先删上面的，最后删根。
                  // 反过来会让上面的层先失去支撑 —— removeAsset 里已加了"上层落位"，
                  // 但那是为了"删底座"的语义，这里要的是"整个删掉"，不该触发下落。
                  for (const cid of [...chain].reverse()) removeAsset(cid);
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
            {layersOpen && layerIds.length > 0 && (
              <div className="stack-children">
                {layerIds.map((lid) => {
                  const child = objects.find((o) => o.id === lid);
                  if (!child) return null;
                  return (
                    <StackChildRow
                      key={lid}
                      child={child}
                      depth={1}
                      objects={objects}
                      stackChildren={stackChildren}
                      selectedId={selectedId}
                      selectedKind={selectedKind}
                      onSelect={selectObject}
                    />
                  );
                })}
              </div>
            )}
          </div>
          );
        })}
      </div>
      </div>

      <div className="sub-group">
      <div
        className="sub-title"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span>CAMERAS</span>
        <button
          type="button"
          className="ghost-button"
          title="新增一台相机（自动取景当前目标）"
          onClick={() => addCamera()}
        >
          ＋ 相机
        </button>
      </div>
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
                  {/* 名字必须包一层可选中的容器：裸文本节点在 flex 里是匿名 flex item，
                      CSS 选不中、无法应用 text-overflow，长相机名会换行而非省略。 */}
                  <span className="obj-name">{camera.name}</span>
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

/**
 * 列表折叠的子行：堆叠链里压在上面的某一层。
 *
 * **递归**：它还可能有自己的上层（多层塔），于是逐层缩进。
 * 只负责"这一层的存在被看见"（点选即可在 Inspector 里编辑它的标高），
 * 批量操作（隐藏 / 删除整塔）在父行的角标上做，避免每层都堆一排按钮。
 */
function StackChildRow({
  child,
  depth,
  objects,
  stackChildren,
  selectedId,
  selectedKind,
  onSelect,
}: {
  child: DirectorObject;
  depth: number;
  objects: DirectorObject[];
  stackChildren: Map<string, string[]>;
  selectedId: string;
  selectedKind: string | undefined;
  onSelect: (id: string) => void;
}) {
  const grandchildren = stackChildren.get(child.id) ?? [];
  return (
    <div className="stack-row" style={{ paddingLeft: depth * 12 }}>
      <button
        type="button"
        className={`obj stack-obj ${selectedKind === "object" && selectedId === child.id ? "sel" : ""}`}
        onClick={() => onSelect(child.id)}
        title={`${objectDisplayName(child)} · 标高 ${(child.baseY ?? 0).toFixed(2)}m`}
      >
        <span className="obj-name">{objectDisplayName(child)}</span>
        <span className="stack-y">{(child.baseY ?? 0).toFixed(2)}m</span>
      </button>
      {grandchildren.map((gid) => {
        const grand = objects.find((o) => o.id === gid);
        if (!grand) return null;
        return (
          <StackChildRow
            key={gid}
            child={grand}
            depth={depth + 1}
            objects={objects}
            stackChildren={stackChildren}
            selectedId={selectedId}
            selectedKind={selectedKind}
            onSelect={onSelect}
          />
        );
      })}
    </div>
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
