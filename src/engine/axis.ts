import { DirectorState } from "../domain/schema";
import { objectPosition } from "./solver";
import { activeCameraMove } from "./cameraSolver";

/** 动作轴线：由两个「互视 / 过肩关系」的演员连线定义，机位须留在其同一侧。 */
export interface ActionAxis {
  a: string;
  b: string;
  pa: { x: number; z: number };
  pb: { x: number; z: number };
}

/** 机位位于轴线的哪一侧：+1 / -1，0 = 正好压在轴线上。 */
export type AxisSide = -1 | 0 | 1;

/**
 * 求动作轴线（180° 规则的分界线）：
 * 1) 过肩（OTS）：前景演员 shoulder 与主体 target 的连线；
 * 2) 否则：若主体与某演员之间存在 LOOK_AT 约束（互视/对视），以二者连线为轴。
 */
export function actionAxisFor(
  state: DirectorState,
  time: number,
  targetId?: string,
  shoulderId?: string,
): ActionAxis | null {
  if (!targetId) return null;

  let aId: string | undefined;
  let bId: string | undefined;

  if (shoulderId && shoulderId !== targetId) {
    aId = shoulderId;
    bId = targetId;
  } else {
    // 找与主体互视的演员：主体看对方，或对方看主体。
    const link =
      state.constraints.find(
        (c) => c.type === "LOOK_AT" && c.subject === targetId && c.target !== targetId,
      ) ??
      state.constraints.find(
        (c) => c.type === "LOOK_AT" && c.target === targetId && c.subject !== targetId,
      );
    if (!link) return null;
    aId = targetId;
    bId = link.subject === targetId ? link.target : link.subject;
  }

  const exists = (id: string) => state.objects.some((o) => o.id === id);
  if (!aId || !bId || !exists(aId) || !exists(bId)) return null;

  // 轴线是「无向」直线：统一端点顺序。否则正反打互换前景/主体时轴线方向会反转，
  // 两侧机位明明在同一侧，算出的符号却相反，会被误判成越轴。
  if (aId > bId) {
    const tmp = aId;
    aId = bId;
    bId = tmp;
  }

  return {
    a: aId,
    b: bId,
    pa: objectPosition(state, aId, time),
    pb: objectPosition(state, bId, time),
  };
}

/** 当前时刻某台相机的动作轴线（优先取生效中的 CameraMove 的过肩 / 目标覆盖）。 */
export function cameraAxis(
  state: DirectorState,
  cameraId: string,
  time: number,
): ActionAxis | null {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return null;
  const move = activeCameraMove(state, cameraId, time);
  const targetId = move?.targetId ?? camera.targetId;
  const shoulderId = move?.shoulderId ?? camera.shoulderId;
  return actionAxisFor(state, time, targetId, shoulderId);
}

/** 判断机位位于轴线的哪一侧。 */
export function axisSide(axis: ActionAxis, cam: { x: number; z: number }): AxisSide {
  const ux = axis.pb.x - axis.pa.x;
  const uz = axis.pb.z - axis.pa.z;
  const vx = cam.x - axis.pa.x;
  const vz = cam.z - axis.pa.z;
  const cross = ux * vz - uz * vx;
  if (Math.abs(cross) < 1e-6) return 0;
  return cross > 0 ? 1 : -1;
}

/** 是否越轴：前后两侧符号相反（任一侧压线则不判越轴）。 */
export function isCrossed(prev: AxisSide, next: AxisSide): boolean {
  return prev !== 0 && next !== 0 && prev !== next;
}
