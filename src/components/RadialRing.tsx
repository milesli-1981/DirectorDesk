import { useState } from "react";
import { useDirectorStore } from "../state/directorStore";
import { curveToggleEligible } from "../engine/path";
import { camCurveEligible } from "../engine/cameraPath";
import { IntentAction } from "../domain/schema";
import { objectActions } from "../engine/objectActions";

const SECTOR_COLORS = ["#285f86", "#2d765f", "#735c2b", "#6a3d68", "#65402e"];
/** 破坏性动作（删除）用偏红的一档，与其他扇区一眼可分。 */
const DELETE_COLOR = "#7d3742";
/** 不合法时被替换为去饱和的灰，明确「不可点」。 */
const DISABLED_COLOR = "#39434f";

function arcPath(cx: number, cy: number, r1: number, r2: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  const A = p(r1, a0);
  const B = p(r2, a0);
  const C = p(r2, a1);
  const D = p(r1, a1);
  return `M ${A[0]} ${A[1]} L ${B[0]} ${B[1]} A ${r2} ${r2} 0 0 1 ${C[0]} ${C[1]} L ${D[0]} ${D[1]} A ${r1} ${r1} 0 0 0 ${A[0]} ${A[1]} Z`;
}

type RingItem = {
  key: string;
  label: string;
  tip: string;
  color: string;
  /** 非法项仍然渲染（保持布局稳定），但不可点击，靠 tip 说明原因。 */
  disabled?: boolean;
  onClick: () => void;
};

/**
 * 环形菜单直径（px）。SVG 以同一数值作为设计坐标系（1 单位 = 1px），
 * 所以改这一个数就能整体缩放；各半径按 170 设计稿等比换算。
 */
const RING_SIZE = 108;
const R_RING_CENTER = RING_SIZE / 2;
const R_INNER = (RING_SIZE * 25) / 170;
const R_OUTER = (RING_SIZE * 77) / 170;
const R_LABEL = (RING_SIZE * 51) / 170;

/** 环形菜单的通用渲染层：对象与路径转折点共用同一套甜甜圈 UI，只是扇区内容不同。 */
function Donut({ items, centerLabel }: { items: RingItem[]; centerLabel: string }) {
  const [tip, setTip] = useState<string | null>(null);
  const step = (Math.PI * 2) / items.length;

  return (
    // drei 的 Html 浮层挂在 canvas 的父节点上，而 r3f 的事件监听器也挂在同一个节点：
    // 不拦截的话，扇区上的 pointerdown 会冒泡给场景，Interaction.handleDown 看到
    // radialTarget 还在就 closeRing()，环在 click 之前就被摘掉，动作永远不生效。
    // 这里把指针事件截在环形菜单内部（与场景里的 .handoff-badge 同一手法）。
    <div
      className="radialRing show"
      style={{ width: RING_SIZE, height: RING_SIZE }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <svg className="radialSvg" viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
        {items.map((item, index) => {
          const a0 = -Math.PI / 2 + index * step + 0.025;
          const a1 = -Math.PI / 2 + (index + 1) * step - 0.025;
          const mid = (a0 + a1) / 2;
          return (
            <g key={item.key} className={item.disabled ? "radialDisabled" : undefined}>
              <path
                className="radialSector"
                d={arcPath(R_RING_CENTER, R_RING_CENTER, R_INNER, R_OUTER, a0, a1)}
                style={{ fill: item.disabled ? DISABLED_COLOR : item.color }}
                onMouseEnter={() => setTip(item.tip)}
                onMouseLeave={() => setTip(null)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!item.disabled) item.onClick();
                }}
              />
              <text
                className="radialSectorText"
                x={R_RING_CENTER + Math.cos(mid) * R_LABEL}
                y={R_RING_CENTER + Math.sin(mid) * R_LABEL}
              >
                {item.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="radialCenter">{centerLabel}</div>
      <div className={`radialTip ${tip ? "show" : ""}`}>{tip}</div>
    </div>
  );
}

/**
 * 对象环形菜单：轻点（按下未拖动）资产唤起。
 *
 * **内容驱动**：扇区来自 `engine/objectActions` 的清单，列表为空就**整个不出现**
 * （而不是画一个没有扇区的空圈）。于是"该不该弹菜单"与"有哪些动作"是同一个答案；
 * 打开之前调用点也会先问一次（`hasObjectActions`），免得留下一个看不见却仍会
 * 吃掉下一次点击的 `radialTarget`。
 */
export function RadialRing({ objectId }: { objectId: string }) {
  const state = useDirectorStore((s) => s.state);
  const currentTime = useDirectorStore((s) => s.currentTime);
  const executeIntent = useDirectorStore((s) => s.executeIntent);
  const beginStairLink = useDirectorStore((s) => s.beginStairLink);
  const beginWalkPick = useDirectorStore((s) => s.beginWalkPick);
  const closeRing = useDirectorStore((s) => s.closeRing);

  const object = state.objects.find((o) => o.id === objectId);
  if (!object) return null;
  const actions = objectActions(state, object, currentTime);
  if (actions.length === 0) return null;

  const items: RingItem[] = actions.map((action, index) => ({
    key: action.id,
    label: action.label,
    tip: action.tip,
    color: action.destructive ? DELETE_COLOR : SECTOR_COLORS[index % SECTOR_COLORS.length],
    onClick: () => {
      if (action.id === "STAIR_LINK") {
        // 先关菜单再进入"选目标"模式：接下来的一次点击属于画布，不属于菜单。
        closeRing();
        beginStairLink(objectId);
        return;
      }
      if (action.id === "WALK_STAIR" || action.id === "WALK_STAIR_DOWN") {
        closeRing();
        beginWalkPick(objectId, action.id === "WALK_STAIR" ? "up" : "down");
        return;
      }
      executeIntent(objectId, action.id as IntentAction);
    },
  }));

  return <Donut items={items} centerLabel={objectId} />;
}

/** 路径转折点环形菜单：轻点路径点唤起，提供「折线 / 曲线」切换与删除。 */
export function PointRadialRing({ pointId }: { pointId: string }) {
  const state = useDirectorStore((s) => s.state);
  const toggleCurve = useDirectorStore((s) => s.toggleCurve);
  const deletePoint = useDirectorStore((s) => s.deletePoint);
  const closeRing = useDirectorStore((s) => s.closeRing);

  // 点位由所属 segment 承载：需要它才能算出该点在完整路径中的序号与可否转曲线。
  const segment = state.segments.find((s) => (s.points ?? []).some((p) => p.id === pointId));
  const point = (segment?.points ?? []).find((p) => p.id === pointId);
  if (!segment || !point) return null;

  const index = (segment.points ?? []).findIndex((p) => p.id === pointId);
  const isArc = point.shape === "ARC";
  const eligible = curveToggleEligible(segment.points ?? [], index);

  const items: RingItem[] = [
    {
      key: "toggle",
      label: isArc ? "LINE" : "CURVE",
      tip: !eligible
        ? "相邻已是曲线，无法再转为曲线（避免连续三个弯点）"
        : isArc
          ? "转回折线（LINE）"
          : "把这个转折点转成曲线（ARC）",
      color: SECTOR_COLORS[0],
      disabled: !eligible,
      // 切换后菜单保持打开：标签会在 CURVE / LINE 之间翻转，方便来回试。
      onClick: () => toggleCurve(segment.id, pointId),
    },
    {
      key: "delete",
      label: "DEL",
      tip: "删除这个路径点",
      color: DELETE_COLOR,
      // 删除后该点已不存在，先关掉菜单再删，避免菜单指向空点。
      onClick: () => {
        closeRing();
        deletePoint(segment.id, pointId);
      },
    },
  ];

  return <Donut items={items} centerLabel={`#${index + 1}`} />;
}

/** 相机 PATH 中间点环形菜单：轻点唤起，提供「折线 / 曲线」切换与删除（与人物路径点一致）。 */
export function CameraPointRadialRing({ pointId }: { pointId: string }) {
  const state = useDirectorStore((s) => s.state);
  const toggleCurve = useDirectorStore((s) => s.toggleCameraPathCurve);
  const deleteCameraPathPoint = useDirectorStore((s) => s.deleteCameraPathPoint);
  const closeRing = useDirectorStore((s) => s.closeRing);

  const move = state.cameraMoves.find((m) => (m.pathPoints ?? []).some((p) => p.id === pointId));
  const points = move?.pathPoints ?? [];
  const index = points.findIndex((p) => p.id === pointId);
  // 首尾是端点，不能转曲线 / 删除（删了路径就断了）；菜单只对中间点开放。
  const isMiddle = index > 0 && index < points.length - 1;
  if (!move || !isMiddle) return null;

  const point = points[index];
  const isArc = point.shape === "ARC";
  const eligible = camCurveEligible(points, index);

  const items: RingItem[] = [
    {
      key: "toggle",
      label: isArc ? "LINE" : "CURVE",
      tip: !eligible
        ? "相邻已是曲线，无法再转为曲线（避免连续三个弯点）"
        : isArc
          ? "转回折线（LINE）"
          : "把这个中间点转成曲线（ARC）",
      color: SECTOR_COLORS[0],
      disabled: !eligible,
      // 切换后菜单保持打开：标签会在 CURVE / LINE 之间翻转，方便来回试。
      onClick: () => toggleCurve(move.id, pointId),
    },
    {
      key: "delete",
      label: "DEL",
      tip: "删除这个相机路径点",
      color: DELETE_COLOR,
      onClick: () => {
        closeRing();
        deleteCameraPathPoint(move.id, pointId);
      },
    },
  ];

  return <Donut items={items} centerLabel={`#${index}`} />;
}
