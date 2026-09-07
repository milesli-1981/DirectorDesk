import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { DirectorState, IntentAction } from "../domain/schema";

const SECTOR_COLORS = ["#285f86", "#2d765f", "#735c2b", "#6a3d68", "#65402e"];

const TIPS: Record<string, string> = {
  MOVE: "Create a MOVE intent.",
  FOLLOW: "Create FOLLOW against a target.",
  "LOOK AT": "Create a LOOK AT intent.",
  ACTION: "Create an action intent.",
  STOP: "Stop the current behavior.",
  "CHANGE PATH": "Edit the current movement path.",
  "ADD ACTION": "Insert an action at this time.",
  TARGET: "Set a target.",
};

function arcPath(cx: number, cy: number, r1: number, r2: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const A = p(r1, a0);
  const B = p(r2, a0);
  const C = p(r2, a1);
  const D = p(r1, a1);
  return `M ${A[0]} ${A[1]} L ${B[0]} ${B[1]} A ${r2} ${r2} 0 0 1 ${C[0]} ${C[1]} L ${D[0]} ${D[1]} A ${r1} ${r1} 0 0 0 ${A[0]} ${A[1]} Z`;
}

function ringActions(state: DirectorState, objectId: string, time: number): IntentAction[] {
  const object = state.objects.find((o) => o.id === objectId);
  const active = state.constraints.some(
    (q) => q.subject === objectId && time >= q.timeStart && time <= q.timeEnd,
  );
  if (object?.type === "actor") {
    return active
      ? ["STOP", "LOOK AT", "CHANGE PATH", "ADD ACTION"]
      : ["MOVE", "LOOK AT", "FOLLOW", "ACTION"];
  }
  return ["MOVE", "TARGET", "ACTION"];
}

export function RadialRing({ objectId }: { objectId: string }) {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const executeIntent = useDirectorStore((s) => s.executeIntent);
  const [tip, setTip] = useState<string | null>(null);

  const actions = ringActions(state, objectId, currentTime);
  const step = (Math.PI * 2) / actions.length;

  return (
    <div className="radialRing show">
      <svg className="radialSvg" viewBox="0 0 170 170">
        {actions.map((action, index) => {
          const a0 = -Math.PI / 2 + index * step + 0.025;
          const a1 = -Math.PI / 2 + (index + 1) * step - 0.025;
          const mid = (a0 + a1) / 2;
          return (
            <g key={action}>
              <path
                className="radialSector"
                d={arcPath(85, 85, 25, 77, a0, a1)}
                style={{ fill: SECTOR_COLORS[index % SECTOR_COLORS.length] }}
                onMouseEnter={() => setTip(TIPS[action] ?? action)}
                onMouseLeave={() => setTip(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  executeIntent(objectId, action);
                }}
              />
              <text
                className="radialSectorText"
                x={85 + Math.cos(mid) * 51}
                y={85 + Math.sin(mid) * 51}
              >
                {action}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="radialCenter">{objectId}</div>
      <div className={`radialTip ${tip ? "show" : ""}`}>{tip}</div>
    </div>
  );
}
