import { DirectorObject, DirectorState, IntentAction } from "../domain/schema";
import { planStairWalk, StairWalkDirection } from "./stairWalk";
import { worldModeOf } from "./worldMode";

/**
 * 一个对象此刻**可操作的内容**。
 *
 * 环形菜单（`components/RadialRing`）只画这里列出的动作 —— 于是"画几个扇区"与
 * "**该不该出现这个菜单**"是同一件事：**列表为空就不出现**（见 `RadialRing` 的提前
 * return 与 `components/WorldView` 的 `hasObjectActions` 门禁）。菜单不再是一张固定的
 * 三格图，而是"这个对象现在能做什么"。
 *
 * 为什么把清单从 UI 里挪到 engine：这样它**可被守卫**（`scripts/check-3d` §33）——
 * "菜单里出现什么"不该只能靠肉眼确认，尤其"台阶"这种只在特定对象上才该出现的项。
 *
 * ## 与既有意图的关系
 *
 * 演员那两套（空闲 / 有约束）**原样保留** —— 那是已经调过的编排入口，行为不能变。
 * 这里只做两件新事：
 * - 静态环境（`role: "set"`）**不再提供 MOVE / ACTION**：set 不参与运动，与工具栏
 *   手绘路径对 set 的门禁（`components/WorldView` 的 `pathDrawMode` 分支）同一条理由；
 * - 能给"高台连台阶"的对象（见 `canHostStair`）多一项 **`STAIR_LINK`**。
 */
export type ObjectActionId = IntentAction | "STAIR_LINK" | "WALK_STAIR" | "WALK_STAIR_DOWN";

export interface ObjectAction {
  /** 稳定 id：UI 用它做 key 与分派，守卫也按它断言。 */
  id: ObjectActionId;
  label: string;
  tip: string;
  /** 破坏性动作（删除类）用偏红的一档。 */
  destructive?: boolean;
}

/** 意图动作的文案（原先散在 `RadialRing` 的 `TIPS` 里）。 */
const INTENT_TEXT: Partial<Record<IntentAction, { label: string; tip: string }>> = {
  MOVE: { label: "MOVE", tip: "创建一条 MOVE（移动）意图" },
  FOLLOW: { label: "FOLLOW", tip: "让这个对象跟随另一个演员" },
  "LOOK AT": { label: "LOOK AT", tip: "让它一直看向另一个演员" },
  ACTION: { label: "ACTION", tip: "插入一个动作片段（走 / 站 / 挥手…）" },
  STOP: { label: "STOP", tip: "终止当前行为" },
  "CHANGE PATH": { label: "CHANGE PATH", tip: "改这条移动路线" },
  "ADD ACTION": { label: "ADD ACTION", tip: "在此刻插入一个动作" },
  TARGET: { label: "TARGET", tip: "把它设成目标点" },
};

function intent(id: IntentAction): ObjectAction {
  const text = INTENT_TEXT[id];
  return { id, label: text?.label ?? id, tip: text?.tip ?? id };
}

/**
 * 这个对象能不能当「台阶」的起点（高台）。
 *
 * 条件是三条，缺一不可：
 * - `category === "building"`（"高台"的语义载体）；
 * - 自己**不是楼梯**（楼梯再连一条台阶没有意义，且会互相压住）；
 * - 世界是 terrain（planar 没有高度，台阶无从谈起 —— 与 `topShape` / `baseY` 的生效前提一致）。
 */
export function canHostStair(object: DirectorObject, state: DirectorState): boolean {
  if (object.category !== "building") return false;
  if (object.topShape === "stair") return false;
  return worldModeOf(state) === "terrain";
}

/** 该对象此刻的动作清单。**空数组 = 不显示环形菜单**。 */
export function objectActions(
  state: DirectorState,
  object: DirectorObject,
  time: number,
): ObjectAction[] {
  const actions: ObjectAction[] = [];

  if (object.type === "actor") {
    const active = state.constraints.some(
      (q) => q.subject === object.id && time >= q.timeStart && time <= q.timeEnd,
    );
    const ids: IntentAction[] = active
      ? ["STOP", "LOOK AT", "CHANGE PATH", "ADD ACTION"]
      : ["MOVE", "LOOK AT", "FOLLOW", "ACTION"];
    actions.push(...ids.map(intent));

    // 「走上去 / 走下来」只在**真的有一条它走得成的楼梯**时出现（"内容驱动"的本意）：
    // 太陡、太窄、或坡脚悬在它迈不上的高度 —— 都不在此列，点了也只会换来一句拒绝。
    // 判据就是 `planStairWalk` 本身，于是"菜单里有没有这一项"与"点了能不能成"永远是同一个答案。
    // 方向分开判：抬高的楼梯常常**只能下来不能上去**（从地面一步迈不上 3 m 的坡脚）。
    const stairs = state.objects.filter((o) => o.topShape === "stair");
    const canWalk = (direction: StairWalkDirection) =>
      stairs.some((s) => planStairWalk(state, s, object, direction).ok);
    if (canWalk("up")) {
      actions.push({
        id: "WALK_STAIR",
        label: "走上去",
        tip: "点一条楼梯，让它照那条路径从坡脚走到坡顶（坡度 / 宽度按它自己的能力表判）",
      });
    }
    if (canWalk("down")) {
      actions.push({
        id: "WALK_STAIR_DOWN",
        label: "走下来",
        tip: "点一条楼梯，让它从坡顶走到坡脚（会把它摆到楼顶那一层再往下走）",
      });
    }
  } else if (object.role === "agent") {
    // 载具等可运动资产：可以安排移动，也能当目标。
    actions.push(intent("MOVE"), intent("TARGET"), intent("ACTION"));
  } else {
    // 静态环境（set）：不提供 MOVE / ACTION —— 它不参与运动。
    actions.push(intent("TARGET"));
  }

  if (canHostStair(object, state)) {
    actions.push({
      id: "STAIR_LINK",
      label: "台阶",
      tip: "连一条台阶到这个高台之外：点另一个高台或地面即可生成（坡度超限会拒绝并说明）",
    });
  }

  return actions;
}

/**
 * 是否显示环形菜单。
 *
 * 与 `objectActions(...).length > 0` 同义，单独给一个名字是因为它是**调用点要问的问题**：
 * 菜单为空时不该打开（否则会留下一个"看不见但吃掉一次点击"的 `radialTarget`）。
 */
export function hasObjectActions(
  state: DirectorState,
  object: DirectorObject,
  time: number,
): boolean {
  return objectActions(state, object, time).length > 0;
}
