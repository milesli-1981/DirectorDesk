import { useDirectorStore } from "../state/directorStore";

export function ObjectList() {
  const objects = useDirectorStore((s) => s.state.objects);
  const selectedObj = useDirectorStore((s) => s.selectedObj);
  const selectObject = useDirectorStore((s) => s.selectObject);

  return (
    <aside className="left">
      <div className="st">OBJECTS</div>
      <div id="objectList">
        {objects.map((object) => (
          <button
            key={object.id}
            type="button"
            className={`obj ${object.id === selectedObj ? "sel" : ""}`}
            onClick={() => selectObject(object.id)}
          >
            {object.id} · {object.type.toUpperCase()}
          </button>
        ))}
      </div>
    </aside>
  );
}
