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
      { id: "M17", type: "actor", category: "human", role: "agent", x: -6, z: 4, rotation: 0, footprint: { w: 0.6, d: 0.6, h: 1.8 }, color: "#67a7ff" },
      { id: "M18", type: "actor", category: "human", role: "agent", x: -3, z: 2, rotation: 0, footprint: { w: 0.6, d: 0.6, h: 1.8 }, color: "#63d39b" },
      { id: "M19", type: "actor", category: "human", role: "agent", x: 1, z: 4, rotation: 0, footprint: { w: 0.6, d: 0.6, h: 1.8 }, color: "#f0a35a" },
      // 静态环境资产（遮挡体 + 路径障碍）
      { id: "BLD_A", type: "landmark", category: "building", role: "set", x: 6, z: -2, rotation: 0, footprint: { w: 10, d: 10, h: 24 }, color: "#9aa7b5" },
      { id: "TBL_01", type: "prop", category: "furniture", role: "set", x: 2, z: 1, rotation: 0, footprint: { w: 1.2, d: 1.2, h: 0.9 }, color: "#b9a07a" },
      // 演示遮挡：刻意放在 CAM_A → M17 的视线中点，刷新即可见 BLOCKED
      { id: "BLD_B", type: "landmark", category: "building", role: "set", x: -8.9, z: 3.1, rotation: 0, footprint: { w: 4, d: 4, h: 8 }, color: "#8a93a3" },
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
        ease: [0, 0, 0.58, 1],
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
        ease: [0.42, 0, 1, 1],
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
    handoffs: [
      {
        id: "H_SEG_01_SEG_02",
        prevSeg: "SEG_01",
        nextSeg: "SEG_02",
        mode: "stop",
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
    cameraMoves: [
      {
        id: "MOVE_CAM_A_01",
        camera: "CAM_A",
        type: "FOLLOW",
        timeStart: 0,
        timeEnd: 6,
        targetId: "M17",
        // 不设段级 framing / view / side / lens —— 完整继承 CAM_A 的相机级 Intent。
        // （一旦在这里写死，相机级的 Framing / View / Side / Lens 就会被段级覆盖屏蔽。）
        orbitDeg: 0,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
      {
        id: "MOVE_CAM_A_02",
        camera: "CAM_A",
        type: "ORBIT",
        timeStart: 6,
        timeEnd: 12,
        targetId: "M17",
        // 仅在此演示「段级覆盖」：这一段把构图改成 close_up，
        // 其余（view / side / lens）仍继承相机级 Intent。
        framing: "close_up",
        orbitDeg: 120,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
    ],
    // 一镜到底：相邻 CameraMove 时间相接处自动生成 CameraJunction。
    cameraJunctions: [
      {
        id: "J_MOVE_CAM_A_01_MOVE_CAM_A_02",
        prevMove: "MOVE_CAM_A_01",
        nextMove: "MOVE_CAM_A_02",
        mode: "smooth",
      },
    ],
  };
}
