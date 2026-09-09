export type ObjectKind = "actor" | "landmark" | "prop";

/**
 * 资产类别：拍摄目标与被拍对象都可以是人 / 动物 / 载具 / 建筑 / 家具 / 自然 / 道具。
 * 抽象为「资产（Asset）」后，凡是能运动的（agent）都能当相机目标 / 拥有 segment；
 * 静态的（set）则是环境遮挡体与路径障碍。
 */
export type AssetCategory =
  | "human"
  | "animal"
  | "vehicle"
  | "building"
  | "furniture"
  | "nature"
  | "prop";

/** agent = 可运动、可作目标；set = 静态环境（遮挡 + 障碍）。 */
export type AssetRole = "agent" | "set";

/** 默认体块尺寸（世界单位）：w=宽(x) d=深(z) h=高(y)。 */
export type Footprint = { w: number; d: number; h: number };

export type PathPointShape = "LINE" | "ARC";

/** cubic-bezier(x1, y1, x2, y2) — 与 CSS 缓动一致。 */
export type EaseCurve = [number, number, number, number];

export interface Vec2 {
  x: number;
  z: number;
}

export type Vec3 = [number, number, number];

/**
 * 人物关节（仅 human 类资产使用）。HumanoidRig 按此树解析本地欧拉角：
 * root(pelvis) → spine → neck/head；spine → shoulder* → elbow*；root → hip* → knee*。
 */
export type JointName =
  | "root"
  | "spine"
  | "neck"
  | "shoulderL"
  | "elbowL"
  | "shoulderR"
  | "elbowR"
  | "hipL"
  | "kneeL"
  | "hipR"
  | "kneeR";

/** 姿势 = 各关节相对父关节的本地欧拉角（弧度，[x, y, z]）。未列出的关节默认为 0。 */
export interface Pose {
  joints: Partial<Record<JointName, Vec3>>;
}

/**
 * Director World 中的对象。V1 使用平面世界（WORLD MODE = PLANAR），
 * 因此对象只保存 x / z，高度由 Proxy 语义决定。
 */
export interface DirectorObject {
  id: string;
  /**
   * 显示名（可在 item list 双击修改）。为空时回退显示 id。
   * id 始终是场景内的稳定标识（被 segment / constraint / camera target 引用），
   * 改名只影响显示，不动 id，因此无需同步任何引用。
   */
  name?: string;
  /** 兼容保留：actor / landmark / prop。新逻辑以 category + role 为主。 */
  type: ObjectKind;
  category: AssetCategory;
  role: AssetRole;
  x: number;
  z: number;
  /** 摆放朝向（yaw，度）。 */
  rotation: number;
  /** 默认体块尺寸。 */
  footprint: Footprint;
  color: string;
  /** 锁定后不可通过拖拽改变位置（防误触）；仍可点选以便解锁。 */
  locked?: boolean;
  /** human 类资产的静态姿势基线（本地欧拉角）；缺省 = 标准站姿。 */
  pose?: Pose;
}

/** 资产显示名：优先用用户改过的 name，未命名则回退 id（id 始终是稳定标识）。 */
export function objectDisplayName(object: { id: string; name?: string }): string {
  return object.name?.trim() || object.id;
}

/** Path Point = 路径控制点。ARC 点是控制点，路径不一定穿过它。 */
export interface PathPoint {
  id: string;
  type: "path";
  shape: PathPointShape;
  x: number;
  z: number;
}

/**
 * MOVE Segment = When + How to travel。
 * Segment 是唯一的时间/空间运动来源（Single Source）。
 */
export interface MoveSegment {
  id: string;
  type: "MOVE";
  object: string;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  points: PathPoint[];
  timeStart: number;
  timeEnd: number;
  ease: EaseCurve;
}

/** 相邻两条 leg 的交接点模式。 */
export type HandoffMode = "stop" | "smooth" | "cut";

/**
 * Handoff = 前腿终点 === 后腿起点 的逻辑连接。
 * 坐标本身仍由两条 leg 各自保存（single source 通过 store 同步保证），
 * Handoff 只记录连接关系与模式。
 */
export interface Handoff {
  id: string;
  prevSeg: string;
  nextSeg: string;
  mode: HandoffMode;
}

/**
 * CameraMove 边界交接点（一镜到底）。
 * 与 actor 的 Handoff 同构：相邻两条 CameraMove 在时间内相接时生成，
 * 记录连接关系与模式（stop / smooth / cut）。
 */
export interface CameraJunction {
  id: string;
  prevMove: string;
  nextMove: string;
  mode: HandoffMode;
}

export type ConstraintType = "FOLLOW" | "LOOK_AT";

/** Constraint = 持续的导演意图（不是一次性 Action）。 */
export interface Constraint {
  id: string;
  type: ConstraintType;
  subject: string;
  target: string;
  timeStart: number;
  timeEnd: number;
}

/* ------------------------------------------------------------- Camera */

/** 导演语言，不直接映射成固定 Lens。 */
export type CameraFraming =
  | "extreme_wide"
  | "wide"
  | "medium"
  | "two_shot"
  | "close_up"
  | "extreme_close_up";

export type CameraView = "eye_level" | "chest" | "low" | "high" | "ground" | "overhead";

export type CameraSide = "front" | "front_3_4" | "side" | "back_3_4" | "back";

/** 过肩镜头（OTS）：镜头越过前景演员的哪一侧肩膀。L = 左肩，R = 右肩。 */
export type OtsSide = "L" | "R";

export type CameraMotionType =
  | "STATIC"
  | "FOLLOW"
  | "ORBIT"
  | "DOLLY"
  | "DOLLY_ZOOM"
  | "CRANE"
  | "DRONE"
  | "OTS"
  | "PAN"
  | "TILT"
  | "TRUCK"
  | "STEADICAM"
  | "HANDHELD";

/** 目标类型：单对象 / 过肩 / 群组 / 主观 / 环境。决定 cameraSolver 如何取景。 */
export type CameraTargetType = "OBJECT" | "OTS" | "GROUP" | "POV" | "LOCATION";

/**
 * 动作片段的种类（与 engine/poses.ts 的 POSE_PRESETS 键一致）。
 * 分两类：
 * - 姿态/手势类（stand/sit/crouch/wave/point/talk）：给出关节角度；
 * - 步态类（walk/run）：本身没有静态关节角度，只决定"怎么走"的节奏与幅度。
 *   注意：MOVE segment 决定"去哪里"，步态只决定身体怎么动，二者互不覆盖。
 */
export type ActionKind =
  | "stand"
  | "sit"
  | "crouch"
  | "wave"
  | "point"
  | "talk"
  | "walk"
  | "run";

/**
 * ActionClip = 一个演员在时间轴上的一段"动作"（sit / wave / talk …）。
 * 与 segments（位移）、constraints（FOLLOW/LOOK_AT）并列，作为第四层叠加：
 * 由 actionPoseAt 在每帧采样，叠加到静态 pose 与走/跑摆动之上。
 */
export interface ActionClip {
  id: string;
  /** 所属演员（DirectorObject.id）。 */
  object: string;
  timeStart: number;
  timeEnd: number;
  kind: ActionKind;
  /** 动作幅度/强度 0..1。 */
  intensity: number;
  /** 关节角度覆盖：在 kind 预设之上微调（未列出的关节沿用预设）。 */
  pose?: Pose;
}

/** Camera 是真正的独立 3D Object：FRAMING / VIEW / LENS / MOTION / TARGET。 */
export interface CameraObject {
  id: string;
  name: string;
  color: string;
  targetId: string;
  framing: CameraFraming;
  view: CameraView;
  side: CameraSide;
  lensMm: number;
  /** 没有 Camera Move Clip 时使用的默认运镜。 */
  motion: CameraMotionType;
  /** 过肩镜头：镜头所越过的演员（前景）；为空则不是过肩。 */
  shoulderId?: string;
  /** 过肩：越过前景演员的哪一侧肩膀（默认 R 右肩）。 */
  otsSide?: OtsSide;
  /**
   * 过肩错位量：主体被推离画面中心的比例（以画面半宽为单位）。
   * 0 = 主体居中（正对，前景糊在主体脸上）；0.35 ≈ 主体落在画面约 1/3 处，前景只露一部分肩膀。
   */
  otsOffset?: number;
  /** 荷兰角：画面滚转角度（度），正值顺时针倾斜。 */
  roll?: number;
  /** 相机平台：ground = 地面机（默认）；drone = 无人机，自带基础飞行高度、不受地面约束。 */
  kind?: "ground" | "drone";
  /** 航拍 / 升降高度（米），暂存为相机数据（cameraSolver 当前用 DRONE 基准高度）。 */
  altitude?: number;
  /** 由模板库创建时记下来源模板 id（便于回看 / 再编辑）。 */
  templateId?: string;
  /** 喂给视频模型的自然语言描述，可在 Inspector 编辑后复制。 */
  prompt?: string;
  /** 目标类型：OBJECT 单对象 / OTS 过肩 / GROUP 多对象同框 / POV 主观视线 / LOCATION 固定环境。默认 OBJECT。 */
  targetType?: CameraTargetType;
  /** GROUP：参与取景的对象集合（双人同框 / 群像），相机自动框住全部。 */
  groupIds?: string[];
  /** 相机级默认：PAN 原地水平旋转角（度）。 */
  panDeg?: number;
  /** 相机级默认：TILT 原地俯仰角（度）。 */
  tiltDeg?: number;
  /** 相机级默认：TRUCK 横向平移距离（米，正负=左右）。 */
  truckDist?: number;
}

/**
 * Camera Move = 一台相机在时间轴上的一段运镜。
 * 每台相机拥有自己的 Camera Track，但共享 World 与 Timeline。
 */
export interface CameraMove {
  id: string;
  camera: string;
  type: CameraMotionType;
  timeStart: number;
  timeEnd: number;
  /** 覆盖该段的目标（为空则沿用相机自身 Target）。 */
  targetId?: string;
  /** OTS：本段所越过的前景演员（为空则沿用相机自身 Shoulder）。 */
  shoulderId?: string;
  /** OTS：越过前景演员的哪一侧肩膀（为空则沿用相机设置）。 */
  otsSide?: OtsSide;
  /** OTS：错位量（为空则沿用相机设置）。 */
  otsOffset?: number;
  /** 荷兰角：本段画面滚转角度（度），为空则沿用相机设置。 */
  roll?: number;
  /** ORBIT：本段内绕目标转过的角度。 */
  orbitDeg: number;
  /** DOLLY：结束时的距离系数（1 = 保持基准取景距离）。 */
  dollyScale: number;
  /** CRANE：结束时相对基准机位的附加高度（米）。 */
  craneHeight: number;
  /** PAN：原地水平旋转角度（度），机位不动、只改注视方向。 */
  panDeg?: number;
  /** TILT：原地俯仰角度（度），机位不动、只改注视方向。 */
  tiltDeg?: number;
  /** TRUCK：纯横向平移距离（米，正负=左右），垂直视线方向。 */
  truckDist?: number;
  /** 段级覆盖：景别 / 视角 / 方位 / 镜头。为空则沿用 CameraObject 默认值。 */
  framing?: CameraFraming;
  view?: CameraView;
  side?: CameraSide;
  lensMm?: number;
  ease: EaseCurve;
}

export type AspectRatio = "16:9" | "2.39:1" | "1.85:1" | "4:3" | "9:16";

/* ------------------------------------------------------ Director State */

/**
 * Director State = 导演意图的唯一来源。
 * Timeline 只是它的一个视图；Playback 读取同一份状态。
 */
export interface DirectorState {
  revision: number;
  duration: number;
  /** 项目级 Master Ratio，Shot 可覆盖。 */
  aspectRatio: AspectRatio;
  objects: DirectorObject[];
  segments: MoveSegment[];
  handoffs: Handoff[];
  constraints: Constraint[];
  cameras: CameraObject[];
  cameraMoves: CameraMove[];
  cameraJunctions: CameraJunction[];
  /** 演员在时间轴上的动作片段（叠加在静态 pose 与走/跑摆动之上）。 */
  actions: ActionClip[];
}

/* ------------------------------------------------------ Stage / Scenes */

/** 场景页（tab）：一个独立 DirectorState 的索引项。 */
export interface SceneTab {
  id: string;
  name: string;
}

/**
 * 片场 = 工程统称 + 场景页索引。
 * 数据不在此持有，每张场景页各自独立存储（见 directorStore 的 per-page key）。
 */
export interface StageManifest {
  name: string;
  order: SceneTab[];
  activeSceneId: string;
}

export type TimelineKind = "segment" | "constraint" | "camera" | "action";

export interface TimelineItem {
  id: string;
  track: string;
  source: string;
  kind: TimelineKind;
  label: string;
}

export type IntentAction =
  | "MOVE"
  | "LOOK AT"
  | "FOLLOW"
  | "ACTION"
  | "STOP"
  | "CHANGE PATH"
  | "ADD ACTION"
  | "TARGET";

export type ViewMode = "director" | "camera";

/* ------------------------------------------------------------- Labels */

export const FRAMING_LABELS: Record<CameraFraming, string> = {
  extreme_wide: "Extreme Wide",
  wide: "Wide",
  medium: "Medium",
  two_shot: "Two Shot",
  close_up: "Close Up",
  extreme_close_up: "Extreme CU",
};

export const VIEW_LABELS: Record<CameraView, string> = {
  eye_level: "Eye Level",
  chest: "Chest 胸高",
  low: "Low",
  high: "High",
  ground: "Ground",
  overhead: "Overhead",
};

export const SIDE_LABELS: Record<CameraSide, string> = {
  front: "Front",
  front_3_4: "3/4 Front",
  side: "Side",
  back_3_4: "3/4 Back",
  back: "Back",
};

export const MOTION_LABELS: Record<CameraMotionType, string> = {
  STATIC: "STATIC",
  FOLLOW: "FOLLOW",
  ORBIT: "ORBIT",
  DOLLY: "DOLLY",
  DOLLY_ZOOM: "DOLLY ZOOM",
  CRANE: "CRANE",
  DRONE: "DRONE",
  OTS: "OTS 过肩",
  PAN: "PAN 平摇",
  TILT: "TILT 俯仰",
  TRUCK: "TRUCK 横移",
  STEADICAM: "STEADICAM 斯坦尼康",
  HANDHELD: "HANDHELD 手持",
};

export const TARGET_TYPE_LABELS: Record<CameraTargetType, string> = {
  OBJECT: "单对象 OBJECT",
  OTS: "过肩 OTS",
  GROUP: "群组 GROUP",
  POV: "主观 POV",
  LOCATION: "环境 LOCATION",
};

export const OTS_SIDE_LABELS: Record<OtsSide, string> = {
  L: "左肩 L",
  R: "右肩 R",
};

export const MOTION_HINTS: Record<CameraMotionType, string> = {
  STATIC: "锁死机位：以片段开始时刻的构图固定不动。",
  FOLLOW: "跟随目标，持续保持取景与机位关系。",
  ORBIT: "跟随并绕目标旋转。",
  DOLLY: "推拉：改变与目标的距离。",
  DOLLY_ZOOM:
    "滑动变焦（希区柯克）：推近的同时同步变焦，主体大小不变、背景透视发生畸变，用于眩晕 / 顿悟。",
  CRANE: "升降：改变机位高度。",
  OTS: "过肩：机位置于前景演员身后，越过其肩膀拍主体，两人移动时自动保持过肩关系。",
  DRONE: "无人机自由飞行：同时绕圈 + 升降 + 推拉。",
  PAN: "原地水平摇（yaw）：机位不动，只旋转注视方向扫过场景，用于甩镜 / 横扫。",
  TILT: "原地俯仰（pitch）：机位不动，只上下旋转注视方向。",
  TRUCK: "横向平移（垂直视线方向的轨道横移）：保持距离与透视，平行掠过主体。",
  STEADICAM: "斯坦尼康式平滑跟随：三维连续跟随目标，比普通 FOLLOW 更顺滑稳定。",
  HANDHELD: "手持微晃：机位叠加细微正弦抖动，模拟手持摄影的不稳定质感。",
};

export const LENS_OPTIONS = [24, 35, 50, 85];

export const ASPECT_OPTIONS: Array<{ label: AspectRatio; value: number }> = [
  { label: "16:9", value: 16 / 9 },
  { label: "2.39:1", value: 2.39 },
  { label: "1.85:1", value: 1.85 },
  { label: "4:3", value: 4 / 3 },
  { label: "9:16", value: 9 / 16 },
];

export function aspectValue(ratio: AspectRatio): number {
  return ASPECT_OPTIONS.find((item) => item.label === ratio)?.value ?? 16 / 9;
}
