import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";

/**
 * 场景页 tab 栏 + 片场名。
 * 单击切换 / 双击重命名 / 拖动排序；行内 ⧉ 复制、× 删除。
 */
export function SceneTabs() {
  const manifest = useDirectorStore((s) => s.manifest);
  const addScene = useDirectorStore((s) => s.addScene);
  const switchScene = useDirectorStore((s) => s.switchScene);
  const renameScene = useDirectorStore((s) => s.renameScene);
  const renameStage = useDirectorStore((s) => s.renameStage);
  const removeScene = useDirectorStore((s) => s.removeScene);
  const duplicateScene = useDirectorStore((s) => s.duplicateScene);
  const reorderScene = useDirectorStore((s) => s.reorderScene);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <div className="scene-tabs">
      <input
        className="stage-name"
        value={manifest.name}
        onChange={(event) => renameStage(event.target.value)}
        title="片场名称"
        spellCheck={false}
      />
      <div className="tabs">
        {manifest.order.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === manifest.activeSceneId ? "active" : ""}`}
            draggable
            onClick={() => switchScene(tab.id)}
            onDoubleClick={() => setEditingId(tab.id)}
            onDragStart={() => setDragId(tab.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragId) reorderScene(dragId, tab.id);
              setDragId(null);
            }}
            title="单击切换 · 双击重命名 · 拖动排序"
          >
            {editingId === tab.id ? (
              <input
                className="tab-rename"
                autoFocus
                defaultValue={tab.name}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => {
                  renameScene(tab.id, event.target.value.trim() || tab.name);
                  setEditingId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    renameScene(tab.id, (event.target as HTMLInputElement).value.trim() || tab.name);
                    setEditingId(null);
                  }
                }}
              />
            ) : (
              <span className="tab-label">{tab.name}</span>
            )}
            <button
              type="button"
              className="tab-dup"
              title="复制场景页"
              onClick={(event) => {
                event.stopPropagation();
                duplicateScene(tab.id);
              }}
            >
              ⧉
            </button>
            <button
              type="button"
              className="tab-del"
              title="删除场景页"
              onClick={(event) => {
                event.stopPropagation();
                removeScene(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className="tab-add" title="新建场景页" onClick={addScene}>
          ＋
        </button>
      </div>
    </div>
  );
}
