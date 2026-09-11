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
      {
        id: "CAM_DRONE",
        name: "CAM_DRONE",
        color: "#8ad1ff",
        targetId: "M17",
        // 以 GROUP 方式框住整支小队（TEAM_ALPHA），并实时跟随成员变化。
        targetType: "GROUP",
        groupId: "TEAM_ALPHA",
        framing: "wide",
        view: "high",
        side: "back_3_4",
        lensMm: 24,
        motion: "DRONE",
        kind: "drone",
      },
    ],
    cameraMoves: [
      {
        id: "MOVE_CAM_DRONE_01",
        camera: "CAM_DRONE",
        type: "DRONE",
        timeStart: 0,
        timeEnd: 12,
        targetId: "M17",
        orbitDeg: 180,
        dollyScale: 1.4,
        craneHeight: 8,
        ease: [0.42, 0, 0.58, 1],
      },
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
    actions: [],
    // 演示组（Group Dynamics）：M17 领队，M18/M19 跟随；开启 dynamics 即受引力场影响。
    groups: [
      {
        id: "TEAM_ALPHA",
        name: "TEAM_ALPHA",
        color: "#ff8fab",
        members: ["M17", "M18", "M19"],
        dynamics: true,
        formation: "column",
        spacing: 1.4,
        noise: 0.35,
      },
    ],
  };
}

/**
 * 通勤偶遇（5s）：
 * WALKER 走在上班路上（0–3s 向前走），1.8s 左右 GREETER 从前方的巷口跑出并打招呼，
 * 两人停下、面朝彼此站定聊天（3–5s）。用 LOOK_AT 约束让两人对话时互相对视，
 * 用 ActionClip 标出「打招呼(wave)」与「聊天(talk)」的时间窗。
 *
 * 镜头设计（CAM_A，三段）：
 * ① 0–2.0s 后退跟拍：机位锁在 WALKER 正前方（side=front）中景，胸高、35mm，
 *    随其步行同速后退，保持自然的电影感透视；
 * ② 2.0–3.0s 相聚环绕：GREETER 正跑入，机位绕 WALKER 转到其身后一侧（−90°），
 *    此时几何上已经是「WALKER 前景 + GREETER 在后」的过肩关系，GREETER 被绕进画面；
 * ③ 3.0–5.0s 过肩收尾：WALKER 作前景、GREETER 为主体，硬切进入。
 *    过肩只依赖两人位置、不依赖朝向，因此能稳稳覆盖 3.0s「停下扭头」带来的朝向突变。
 *
 * 说明：当前 human 模型用的是 Xbot.glb（Mixamo / three.js 官方示例，正常人体比例）。
 * 自带 idle / walk / run / agree(点头) / headShake(摇头) / sad_pose / sneak_pose(下蹲) 片段，
 * 因此 walk / run 走跑正常，talk 以 agree 点头、wave 以 agree 作「打招呼」代理，
 * crouch 用 sneak_pose 表现；该模型没有 sitting 片段，sit 只影响步态与关节、不强行依赖 clip。
 * 位置 / 朝向 / 时间逻辑本身是正确的。
 */
export function createCommuteState(): DirectorState {
  return {
    revision: 1,
    duration: 5,
    aspectRatio: "16:9",
    objects: [
      // —— 两个人物 ——
      {
        id: "WALKER",
        type: "actor",
        category: "human",
        role: "agent",
        x: 0,
        z: -7,
        rotation: 0,
        footprint: { w: 0.6, d: 0.6, h: 1.8 },
        color: "#67a7ff",
      },
      {
        id: "GREETER",
        type: "actor",
        category: "human",
        role: "agent",
        x: 3.5,
        z: 1.5,
        rotation: -90,
        footprint: { w: 0.6, d: 0.6, h: 1.8 },
        color: "#f0a35a",
      },
      // —— 街道环境：左右楼体夹出一条「巷子」，GREETER 从巷口走出 ——
      {
        id: "BLD_L",
        type: "landmark",
        category: "building",
        role: "set",
        x: -4.5,
        z: -1,
        rotation: 0,
        footprint: { w: 4, d: 4, h: 14 },
        color: "#9aa7b5",
      },
      {
        id: "BLD_R",
        type: "landmark",
        category: "building",
        role: "set",
        x: 6,
        z: 0,
        rotation: 0,
        footprint: { w: 5, d: 5, h: 18 },
        color: "#8a93a3",
      },
      {
        id: "BLD_FAR",
        type: "landmark",
        category: "building",
        role: "set",
        x: 2.5,
        z: 4,
        rotation: 0,
        footprint: { w: 4, d: 4, h: 10 },
        color: "#9aa7b5",
      },
    ],
    segments: [
      // WALKER 慢悠悠走路上班：约 1.3 m/s（低于跑阈值 1.6 → 走）。
      {
        id: "SEG_WALK",
        type: "MOVE",
        object: "WALKER",
        startX: 0,
        startZ: -5,
        endX: 0,
        endZ: -1,
        points: [],
        timeStart: 0,
        timeEnd: 3.0,
        ease: [0.42, 0, 0.58, 1],
      },
      // GREETER 从巷口（右前方）快步冲出：约 3.5 m/s（高于阈值 → 跑）。
      {
        id: "SEG_GREET",
        type: "MOVE",
        object: "GREETER",
        startX: 3.5,
        startZ: 1.5,
        endX: 1,
        endZ: -1,
        points: [],
        timeStart: 1.8,
        timeEnd: 2.8,
        ease: [0.42, 0, 0.58, 1],
      },
    ],
    handoffs: [],
    constraints: [
      // 停下后两人面朝彼此（对话对视），从走动停止后开始生效。
      {
        id: "LOOK_WALKER",
        type: "LOOK_AT",
        subject: "WALKER",
        target: "GREETER",
        timeStart: 3.0,
        timeEnd: 5,
      },
      {
        id: "LOOK_GREETER",
        type: "LOOK_AT",
        subject: "GREETER",
        target: "WALKER",
        timeStart: 2.8,
        timeEnd: 5,
      },
    ],
    cameras: [
      {
        id: "CAM_A",
        name: "CAM_A",
        color: "#c792ea",
        targetId: "WALKER",
        // 后退跟拍基线：机位锁在 WALKER 正前方（front），胸高略低于眼平、35mm 中景。
        // 每帧按 WALKER 的当前位置重算，于是相机以步行速度同向后退——自然的电影感透视。
        framing: "medium",
        view: "chest",
        side: "front",
        lensMm: 35,
        motion: "FOLLOW",
      },
      {
        id: "CAM_EST",
        name: "ESTABLISH",
        color: "#8ad1ff",
        targetId: "WALKER",
        framing: "extreme_wide",
        view: "high",
        side: "front_3_4",
        lensMm: 24,
        motion: "STATIC",
      },
    ],
    cameraMoves: [
      // ① 后退跟拍：不写死 framing / view / side / lens，完整继承 CAM_A 的相机级 Intent。
      {
        id: "MOVE_CAM_A_01",
        camera: "CAM_A",
        type: "FOLLOW",
        timeStart: 0,
        timeEnd: 2.0,
        targetId: "WALKER",
        orbitDeg: 0,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
      // ② 相聚环绕：负角度 = 往 WALKER 身后一侧绕，绕到位时已是「WALKER 前景、
      // GREETER 在后」的过肩几何，GREETER 被转进画面。
      {
        id: "MOVE_CAM_A_02",
        camera: "CAM_A",
        type: "ORBIT",
        timeStart: 2.0,
        timeEnd: 3.0,
        targetId: "WALKER",
        orbitDeg: -90,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
      // ③ 过肩收尾：WALKER 作前景（shoulder），GREETER 为主体（target）。
      {
        id: "MOVE_CAM_A_03",
        camera: "CAM_A",
        type: "FOLLOW",
        targetType: "OTS",
        timeStart: 3.0,
        timeEnd: 5.0,
        targetId: "GREETER",
        shoulderId: "WALKER",
        otsSide: "R",
        orbitDeg: 0,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
      {
        id: "MOVE_CAM_EST_01",
        camera: "CAM_EST",
        type: "STATIC",
        timeStart: 0,
        timeEnd: 5,
        targetId: "WALKER",
        orbitDeg: 0,
        dollyScale: 1,
        craneHeight: 0,
        ease: [0.42, 0, 0.58, 1],
      },
    ],
    // 跟拍 → 环绕：一镜到底（smooth），机位从正前方连续绕到身后一侧。
    // 环绕 → 过肩：硬切（cut），既符合「切到过肩」，也掩盖 3.0s 停下扭头的朝向突变。
    cameraJunctions: [
      {
        id: "J_CAM_A_01_02",
        prevMove: "MOVE_CAM_A_01",
        nextMove: "MOVE_CAM_A_02",
        mode: "smooth",
      },
      {
        id: "J_CAM_A_02_03",
        prevMove: "MOVE_CAM_A_02",
        nextMove: "MOVE_CAM_A_03",
        mode: "cut",
      },
    ],
    // 动作片段：
    // 1) 显式强制步态——WALKER 走、GREETER 跑，保证直观看到二者区别（不依赖速度自动判定）；
    // 2) GREETER 冲出后挥手打招呼；3) 两人站定聊天。
    // （human 模型为 Xbot.glb：walk/run 直接播放对应片段；talk → agree 点头，
    //   wave → agree 代理打招呼；无 sitting 片段时 sit 仅停止腿部摆动。）
    actions: [
      { id: "ACT_GAIT_WALK", object: "WALKER", timeStart: 0, timeEnd: 3.0, kind: "walk" },
      { id: "ACT_GAIT_RUN", object: "GREETER", timeStart: 1.8, timeEnd: 2.8, kind: "run" },
      {
        id: "ACT_WAVE",
        object: "GREETER",
        timeStart: 2.8,
        timeEnd: 3.5,
        kind: "wave",
      },
      {
        id: "ACT_TALK_W",
        object: "WALKER",
        timeStart: 3.2,
        timeEnd: 5,
        kind: "talk",
      },
      {
        id: "ACT_TALK_G",
        object: "GREETER",
        timeStart: 3.2,
        timeEnd: 5,
        kind: "talk",
      },
    ],
    groups: [],
  };
}

/** 空白场景页：用于「新建场景页」时给一个干净起点。 */
export function createBlankState(): DirectorState {
  return {
    revision: 1,
    duration: 12,
    aspectRatio: "16:9",
    objects: [],
    segments: [],
    handoffs: [],
    constraints: [],
    cameras: [],
    cameraMoves: [],
    cameraJunctions: [],
    actions: [],
    groups: [],
    customActions: [],
  };
}
