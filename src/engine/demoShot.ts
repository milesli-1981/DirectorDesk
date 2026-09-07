import { DirectorState } from "../domain/schema";

/**
 * M17 Killer Test（原型 V1.20 初始状态）：
 * M17 → RUN（MOVE）→ VALLEY 方向
 * M18 / M19 → FOLLOW → M17
 * CAM_A → MEDIUM / 3-4 BACK / FOLLOW → M17
 */
export function createDemoState(): DirectorState {
  return {
    revision: 1,
    duration: 12,
    aspectRatio: "2.39:1",
    objects: [
      { id: "M17", type: "actor", x: -6, z: 4, color: "#67a7ff" },
      { id: "M18", type: "actor", x: -3, z: 2, color: "#63d39b" },
      { id: "M19", type: "actor", x: 1, z: 4, color: "#f0a35a" },
    ],
    segments: [
      {
        id: "SEG_01",
        type: "MOVE",
        object: "M17",
        startX: -6,
        startZ: 4,
        endX: 0.5,
        endZ: 0.5,
        points: [],
        timeStart: 2,
        timeEnd: 4.2,
        ease: [0, 0, 1, 1],
      },
      {
        id: "SEG_02",
        type: "MOVE",
        object: "M17",
        startX: 0.5,
        startZ: 0.5,
        endX: 7,
        endZ: -5,
        points: [],
        timeStart: 4.2,
        timeEnd: 6.5,
        ease: [0, 0, 1, 1],
      },
    ],
    constraints: [
      {
        id: "FOLLOW_01",
        type: "FOLLOW",
        subject: "M18",
        target: "M17",
        timeStart: 2.2,
        timeEnd: 7.4,
      },
      {
        id: "FOLLOW_02",
        type: "FOLLOW",
        subject: "M19",
        target: "M17",
        timeStart: 2.5,
        timeEnd: 7.8,
      },
    ],
    cameras: [
      {
        id: "CAM_A",
        name: "CAM_A",
        color: "#c792ea",
        targetId: "M17",
        framing: "medium",
        view: "eye_level",
        side: "back_3_4",
        lensMm: 50,
        motion: "FOLLOW",
      },
    ],
    cameraMoves: [],
  };
}
