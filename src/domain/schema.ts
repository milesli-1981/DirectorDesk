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
  | "prop"
  /** 台阶 / 平台 / 墙：可站立的静态构筑物。h ≤ maxStep 时人会自动迈上去。 */
  | "structure";

/** 动物物种：决定使用哪个 GLB 模型。来源见 `engine/animalModels.ts`。 */
export type AnimalSpecies =
  | "parrot" | "flamingo" | "stork" | "pigeon" // 鸟
  | "horse" // 马
  | "dog" | "wolf" // 犬科（狗 / 狼）
  | "cat" // 猫
  | "fish"; // 鱼

/** agent = 可运动、可作目标；set = 静态环境（遮挡 + 障碍）。 */
export type AssetRole = "agent" | "set";

/**
 * 世界模式。**planar 是能力表的退化取值**，不是特例分支（见 DirectorState.worldMode）。
 * terrain 表示"几何参与高度"，是本文件里 baseY / bottom / topShape 生效的前提。
 */
export type WorldMode = "planar" | "terrain";

/** 默认体块尺寸（世界单位）：w=宽(x) d=深(z) h=高(y)。 */
export type Footprint = { w: number; d: number; h: number };

export type PathPointShape = "LINE" | "ARC";

/** cubic-bezier(x1, y1, x2, y2) — 与 CSS 缓动一致。 */
export type EaseCurve = [number, number, number, number];

/**
 * 名字显示的场景级三态。**场景是更高一级的权威**：
 * `"on"` / `"off"` 压过个体，只有 `"default"` 才把控制权交给个体。
 * 判定只有一处实现：`engine/nameVisibility.ts` 的 `nameVisible`。
 */
export type NameVisibility = "on" | "off" | "default";

/**
 * 速度曲线关键点 = 一条「何时走到哪儿」的控制点。
 * t = 归一化时刻 0..1（落在片段 [timeStart, timeEnd] 内的比例）
 * v = 该时刻已完成的路径进度 0..1。首点恒为 0、末点恒为 1 —— 进度曲线必须走完全程，
 *     想表达「延迟出发 / 提前到位」只能改这两点的 t，不能改 v。
 * ease = 从上一关键点走到本点所用的缓动
 *
 * 相邻两点之间的斜率就是这段的速度：把首点 t 往后拖 = 起步前先等一会（延迟），
 * 末点 t 往前拖 = 提前到位后停住；中间插点 = 中途加速 / 减速（多段变速）。
 * 数组长度 ≥ 2 时整体接管该片段的运动时序，`ease` 字段退为兜底。
 */
export interface SpeedKey {
  id: string;
  t: number;
  v: number;
  ease: EaseCurve;
}

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
  /**
   * 骨盆（root）的**额外竖直偏移**（米）。默认 0。
   *
   * 这是**作者旋钮**，不是"骨盆高度自适应"的替代品：后者由立足面几何每帧算出
   * （`engine/stance.ts` 的 `pelvisLiftOf`），是几何必然；`rootY` 只用于
   * "蹲在坡上还想把重心再压低一点"这类微调。
   */
  rootY?: number;
}

/**
 * Director World 中的对象。V1 使用平面世界（WORLD MODE = PLANAR），
 * 因此对象只保存 x / z，高度由 Proxy 语义决定。
 */
/**
 * 顶面形状。盒子表达不了斜坡与楼梯，这两种是目前的形状扩展。
 *
 * - `flat`：盒子。
 * - `ramp`：沿局部 +Z 从 `bottom` 升到 `top` 的**斜面**。
 * - `stair`：**抽象楼梯** —— 沿一条可拐弯的折线铺开的若干梯跑 + 平台（见 `StairSpec`）。
 *   与 `ramp` 一样，它是"视觉近似、物理精确"的抽象：物理上是**连续坡面**（不是一级级台阶），
 *   踏步由坡度派生、只用于渲染。
 */
export type TopShape = "flat" | "ramp" | "stair";

/**
 * 抽象楼梯的**路径点**（世界坐标）。作者在 Director View 上拖的就是它 ——
 * 与资产路径（`MoveSegment.points`）/ 相机路径（`CameraMove.pathPoints`）同一套交互。
 */
export interface StairPathPoint {
  id: string;
  x: number;
  z: number;
}

/**
 * 抽象楼梯的参数（`topShape: "stair"` 时生效）。
 *
 * ## 为什么是"路径"而不是"一段段梯跑"
 *
 * 楼梯的**水平路线**和资产的行走路线是同一件事，所以用同一套表达：一条折线，
 * 拖点即塑形，转角即拐弯。作者不需要填"第几段拐多少度"—— 想往哪拐就把点拖过去。
 *
 * 由此三件事都变成**派生量**，不用作者说：
 *
 * - **坡度** = `atan(总高 / 路径水平长度)`（要缓就把路径拉长）；
 * - **每段的高** = 总高 × 该段长度 / 路径总长（按弧长均摊）；
 * - **转角是圆的** = **急转**顶点被内切掉一段等半径圆弧（半径 ≤ 半宽），弧上每段折角都很小 ⇒
 *   按"缓转 = 连续曲面"直接接上：不铺平台、不补角、**转角不会宽出来**，踏步沿弧自然铺开；
 *   接缝处高度连续、无洞（折线近似圆弧的那一丝外侧楔口由相邻段互相重叠填掉）。
 *   圆角放不下（相邻段太短）时才退回"硬角 + 平台 / 补角"兜底。
 * - **平台是从路径里扣除的**（吃掉两侧边各半个宽度）⇒ **水平延伸 = 路径长**、
 *   **末端（最后一个路径点）正好到达总高**。
 *
 * 路径点缺省（或不足 2 点）时退回**一段直跑**：沿对象局部 +Z，长度取 `footprint.d` ——
 * 于是"没画路径"的楼梯与普通斜坡盒子一样好用，`D` 滑杆仍然管用。
 */
export interface StairSpec {
  /** 水平路线（世界坐标）。≥2 点才能生效。 */
  path?: StairPathPoint[];
  /**
   * 是否**填充底面**（把每一级从对象底面砌到该级顶面）。缺省 = `true`（实心楼梯）。
   *
   * 设成 `false` 就只留一块块踏板 —— 楼梯变成**悬空的板**，能看穿底下（露台、钢结构、
   * 挑空处的室外梯都是这个样子）。**物理不变**：顶面仍是同一条连续坡面，可走性、坡度、
   * 拾取全都不受影响 —— 这纯粹是"看起来是实心还是空心"。板厚 = `STAIR_TREAD_THICKNESS`。
   */
  solid?: boolean;
}

/**
 * 运动能力：阈值挂在**运动主体**上，不是障碍上。
 * 同一堵台阶，人上得去、车上去、马跳得更高 —— 所以 maxStep / 跳跃 / 攀爬都按类别取值。
 * 见 `engine/locomotion.ts` 的预设表。
 */
export interface Locomotion {
  /** 单步最大落差（米）：≤ 此值自动迈上去，> 此值视为阻挡或需要跳跃。 */
  maxStep: number;
  /** 最大可行走坡度（度）。超过即"陡坡"，退化为墙面。 */
  maxSlopeDeg: number;
  /** 原地起跳高度（米）。0 = 不会跳。 */
  maxJumpHeight: number;
  /** 平地助跑跳远（米）。 */
  maxJumpReach: number;
  /** 最大攀爬高度（米）。0 = 不会攀爬。 */
  maxClimbHeight: number;
  /** 身高（米），用于头顶净空判定。 */
  height: number;
  /** 脚底尺寸（米），用于落脚面积采样。 */
  foot: { w: number; d: number };
}

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
  /**
   * 实体底面高度（世界米）。默认 0。
   *
   * 这是"3D 化"最关键的一个字段：有了它，盒子才占据 [baseY, baseY + h] 而不是恒从 0 起，
   * 于是「堆叠」成立 —— 把上层对象的 baseY 设成下方对象的顶面即可。
   *
   * agent 的 baseY 是"相对脚下地面的偏移"（悬停飞行、摆在架子上）；
   * set 的 baseY 由拖拽自动吸附到下方支撑面，也可在 Inspector 手工指定。
   */
  baseY?: number;
  /**
   * 实体底面下探高度，默认 = baseY。设成低于 baseY 即"拱洞 / 桥"：
   * 例：桥面 baseY = 2.75、bottom = 2.4 → 下方留 2.4m 净空可穿行。
   */
  bottom?: number;
  /** 顶面形状，默认 "flat"。 */
  topShape?: TopShape;
  /** 抽象楼梯参数（`topShape: "stair"` 时生效）：坡度 + 梯段/拐弯。 */
  stair?: StairSpec;
  /** 是否可站上去。默认 true（由 maxStep 与坡度推导）。水面 / 沼泽设 false。 */
  walkable?: boolean;
  /**
   * 是否显示这个名字（**个体级覆盖**）。缺省 = 跟随场景开关 `DirectorState.showNames`。
   * 三态语义：`true` = 无论如何都显示（哪怕场景关着）；`false` = 无论如何都不显示；
   * 不写 = 跟随场景。于是"少显示几个"和"只突出一个"都能表达。
   */
  showName?: boolean;
  /**
   * 遇障时的**作者意图**：默认（`"auto"`）按能力表决定 —— 迈得上就迈、跳得过就跳
   * （见 docs/3d/04 §3：画了一条直线说明作者想走直线，绕行才是系统自作主张）。
   *
   * 设为 `"walk-around"` 即强制绕行：一片刺丛、一个水坑，你不会想让人跳进去。
   * 这是可达性 UI 里「改为绕行」一键修复写下的那个字段（docs/3d/03 §5 / 04 §12）。
   */
  prefer?: "auto" | "walk-around";
  /** 是否水平阻挡。默认 true。栅栏 / 草丛可设 false。 */
  blocking?: boolean;
  /** 是否遮挡相机视线。默认 true。玻璃可设 false —— 它与 blocking 是独立的语义。 */
  occluding?: boolean;
  /** animal 类资产的物种（决定 GLB 模型）；非 animal 留空。 */
  species?: AnimalSpecies;
  /** 锁定后不可通过拖拽改变位置（防误触）；仍可点选以便解锁。 */
  locked?: boolean;
  /** 隐藏：画布上不渲染、不可拾取（仅视图层，不影响求解 / 导出）。用于减少画布杂乱。 */
  hidden?: boolean;
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

/** 相机自定义路径点（3D）：x/z 平面位置 + y 高度（米），用于 PATH 运镜沿折线运动。 */
export interface CameraPathPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  /** 折线 LINE / 曲线 ARC（仅中间点可切换；首尾是端点，恒为 LINE）。 */
  shape?: PathPointShape;
}

/**
 * 垂直弧线：把「沿路径走」的归一化里程映射到高度。
 *
 * 与水平运动**完全解耦** —— 路径的水平速度曲线（`ease` / `speedKeys`）不需要为跳跃做任何改动，
 * 跳跃自动跟着路径走向走。这是"垂直三级权威"的直接收益（见 docs/3d/02 §4）。
 *
 * 关键设计：**顶点高度 `apex` 是作者旋钮**，不是从物理初速反推的。
 * 系统只做可行性校验（`engine/jump.ts` 的 `checkJumpArc`），不替作者决定轨迹。
 */
export interface VerticalArc {
  /** parabola = 跳上/跳过（抛物线）；fall = 落差下落（加速下坠）；climb = 攀爬（L 形贴墙）。 */
  mode: "parabola" | "fall" | "climb";
  /** 区间起点（归一化里程 0..1）。缺省 0。 */
  from?: number;
  /** 区间终点（归一化里程 0..1）。缺省 1。 */
  to?: number;
  /** 顶点相对「起跳点地面」的高度（米），作者拖拽设定。仅 `parabola` 用。 */
  apex?: number;
  /** 攀爬竖直段时长（秒）。缺省由攀爬速度推算，留作将来微调。 */
  climbSeconds?: number;
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
  /** 多段速度曲线关键点（≥2 时接管时序）。为空 = 单段 cubic-bezier。 */
  speedKeys?: SpeedKey[];
  /** 垂直弧线（跳跃 / 落差 / 攀爬）。缺省 = 无弧线，高度由地面派生（瞬时对齐）。 */
  arc?: VerticalArc;
  /**
   * 本段在 planar 世界也强制按弧线走。缺省 = 只有 terrain 世界才认弧线。
   * 与 Shift 覆盖同理：这是**作者显式意图**，不是世界模式的替代品。
   */
  arcAlways?: boolean;
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

/** 稳定方式 / 拍摄设备质感（风格轴），与 motion 正交：
 * motion 回答「怎么动」，style 回答「什么质感」。例如同样 FOLLOW，
 * locked = 三脚架锁死、gimbal = 手机云台平滑漂浮、handheld = 肩扛微晃、vlog = 走拍 bob。 */
export type CameraStyle = "locked" | "gimbal" | "handheld" | "vlog";

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
  | "PAN"
  | "TILT"
  | "TRUCK"
  | "STEADICAM"
  | "HANDHELD"
  | "PATH";

/** 目标类型：单对象 / 过肩 / 群组 / 主观 / 环境。决定 cameraSolver 如何取景。 */
export type CameraTargetType = "OBJECT" | "OTS" | "GROUP" | "POV" | "LOCATION";

/**
 * 动作片段的种类（= `engine/poses.ts` 的 `AUTHOR_POSE_NAMES` + 步态 walk/run + custom）。
 * **不含阶段姿势**（`jumpTakeoff` / `jumpAir` / `jumpLand` / `climbReach` / `climbUp` / `hang`）——
 * 那些由弧线进度自动挑（`actionPose.ts` 的 `airbornePresetAt`），不是可选项。
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
  | "run"
  /** 自定义动作：关节角完全来自「自定义动作库」里的一条命名记录（见 DirectorState.customActions）。 */
  | "custom";

/**
 * 自定义动作：用户在弹窗里调好关节角、命名后**持久保存**的一条记录。
 * 存在 DirectorState 里随场景自动持久化，可被任意演员的任意动作片段复用
 * （片段只记一个 customId，改一次库、所有引用它的片段同步生效）。
 */
export interface CustomAction {
  id: string;
  /** 用户起的名称，显示在 Kind 下拉与时间轴 clip 标签上。 */
  name: string;
  joints: Pose["joints"];
}

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
  /** 仅当 kind === "custom" 时有效：指向 DirectorState.customActions 里的一条记录。 */
  customId?: string;
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
  /** 稳定方式 / 风格轴（默认 locked）：与 motion 正交。旧场景 motion:"HANDHELD" 仍按 handheld 兼容。 */
  style?: CameraStyle;
  /**
   * 防抖强度 0..1（默认 0 = 关闭）。对机位 / 注视点在过去一小段时间做滑动平均，
   * 使相机对目标的瞬变（转向、绕障让位、扭动）响应滞后一点；瞬变若在窗口内自行消失即被忽略，
   * 类似软件的电子防抖。与 style 正交：style 是「主动晃动质感」，stabilize 是「被动跟随阻尼」。
   */
  stabilize?: number;
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
  /**
   * 是否显示这个相机的名字标签（**个体级覆盖**，与 `DirectorObject.showName` 同语义）。
   * 缺省 = 跟随场景名字开关 `DirectorState.showNames`（"开"全显示 / "关"全隐藏 / "默认"跟随个体）。
   * 场景级下拉框在画布工具条，个体级眼睛图标在选中本相机或资产时点亮。
   */
  showName?: boolean;
  /** 航拍 / 升降高度（米），暂存为相机数据（cameraSolver 当前用 DRONE 基准高度）。 */
  altitude?: number;
  /** 由模板库创建时记下来源模板 id（便于回看 / 再编辑）。 */
  templateId?: string;
  /** 目标类型：OBJECT 单对象 / OTS 过肩 / GROUP 多对象同框 / POV 主观视线 / LOCATION 固定环境。默认 OBJECT。 */
  targetType?: CameraTargetType;
  /** GROUP：参与取景的对象集合（双人同框 / 群像），相机自动框住全部。 */
  groupIds?: string[];
  /** GROUP：直接引用一个组（DirectorGroup.id）；其成员实时参与取景，优于 groupIds。 */
  groupId?: string;
  /** 相机级默认：PAN 原地水平旋转角（度）。 */
  panDeg?: number;
  /** 相机级默认：TILT 原地俯仰角（度）。 */
  tiltDeg?: number;
  /** 相机级默认：TRUCK 横向平移距离（米，正负=左右）。 */
  truckDist?: number;
  /** PATH 默认固定朝向 · 平面方位角（度，0–360）：含义同 CameraMove.fixedYawDeg，段未单独设时沿用。 */
  fixedYawDeg?: number;
  /** PATH 默认固定朝向 · 立面俯仰角（度，0–360）：含义同 CameraMove.fixedPitchDeg。 */
  fixedPitchDeg?: number;
  /**
   * 跟拍目标**跳跃 / 落差**时，是否让相机跟着上下（默认 `true` = 跟随，与扩展前一致）。
   *
   * 设为 `false` 即为 docs/3d/03 §10 的**方案 b**：目标离地期间，相机保持**起跳高度的水平轨道**、
   * **不跟高度** —— 像真实跟拍（摄影师本来就不会跟着人跳），人跳起来冲出画框又落回来。
   *
   * 为什么做成开关而不是"把抖动调小"：这是**电影语言**层面的选择，不是参数调优。
   * 判"离地"用的是 `pathHeightAt`（实际高度）与 `standingHeightFor`（脚下地面）之差，
   * 因此对**段上的弧线**与**走出平台边缘的落差**都生效，而不只是 `arc`。
   */
  followJumpHeight?: boolean;
  /** 自动对焦（默认 true）：无意图主体（自由 PATH 等）时，对焦到画面内最靠近构图中心的演员。 */
  autoFocus?: boolean;
}

/**
 * 相机关键帧：在 CameraMove 运镜基元之上，对「通道」做曲线定制。
 *
 * 只有被显式赋值的通道才被关键帧接管；未赋值的通道继续走该段运镜基元
 * （例如 ORBIT 段只给 craneHeight 打帧 = 一边环绕一边升降）。
 * 于是可以在不新增运镜类型的前提下组合出复杂运镜。
 */
export interface CameraKey {
  id: string;
  /** 归一化时刻 0..1（相对所在 CameraMove 的 [timeStart, timeEnd]），按真实时间线性分布。 */
  t: number;
  /** 从上一关键帧插到本帧所用的缓动（首帧忽略）。 */
  ease: EaseCurve;
  /** 环绕角（度）：叠加在基元方位角之上。 */
  orbitDeg?: number;
  /** 升降（米）：相对基准机位的高度偏移。 */
  craneHeight?: number;
  /** 推拉：距离系数（1 = 基准取景距离）。 */
  dollyScale?: number;
  /** 原地水平摇摄（度）。 */
  panDeg?: number;
  /** 原地俯仰（度）。 */
  tiltDeg?: number;
  /** 横向平移（米，垂直视线方向）。 */
  truckDist?: number;
  /** 焦距（mm）。 */
  lensMm?: number;
  /** 荷兰角 / 画面滚转（度）。 */
  roll?: number;
  /** 过肩错位量（0..1，主体偏离画面中心的比例）。 */
  otsOffset?: number;
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
  /** 取景关系（为空则沿用相机级 targetType）：OBJECT 单对象 / OTS 过肩 / GROUP 群组 / POV 主观 / LOCATION 环境。 */
  targetType?: CameraTargetType;
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
  /** PATH：相机沿可编辑 3D 折线运动（不依赖 placeCamera 反推），点的顺序即行进顺序。 */
  pathPoints?: CameraPathPoint[];
  /** PATH 固定朝向 · 平面方位角（度，0–360，绕竖直轴）。与 fixedPitchDeg 构成旋转系统；设置后机位沿轨道平移、朝向不变（不跟人、不随路径弯曲）。 */
  fixedYawDeg?: number;
  /** PATH 固定朝向 · 立面俯仰角（度，0–360）。0 = 水平，90 = 正上，270 = 正下。 */
  fixedPitchDeg?: number;
  /** 段级覆盖：景别 / 视角 / 方位 / 镜头。为空则沿用 CameraObject 默认值。 */
  framing?: CameraFraming;
  view?: CameraView;
  side?: CameraSide;
  lensMm?: number;
  /** 风格轴：本段稳定方式覆盖（为空沿用相机默认）。 */
  style?: CameraStyle;
  /** 段级覆盖：防抖强度 0..1（为空沿用相机设置，0 = 关闭）。 */
  stabilize?: number;
  ease: EaseCurve;
  /** 多段速度曲线关键点（≥2 时接管时序）。为空 = 单段 cubic-bezier。 */
  speedKeys?: SpeedKey[];
  /** 通道关键帧（≥1 即生效）：在运镜基元之上定制 / 组合通道曲线。 */
  keys?: CameraKey[];
}

export type AspectRatio = "16:9" | "2.39:1" | "1.85:1" | "4:3" | "9:16";

/* ------------------------------------------------------ Director State */

/**
 * Director State = 导演意图的唯一来源。
 * Timeline 只是它的一个视图；Playback 读取同一份状态。
 */
/** 编队预设种类：队员相对锚点（队首）的站位排布。 */
export type FormationKind = "column" | "row" | "wedge" | "ring";

/** 编队切换过渡时长（秒）：切换队形时队员用这段时间从旧阵型滑到新阵型，而非瞬间跳变。 */
export const FORMATION_MORPH_SECONDS = 1.0;

export const FORMATION_LABELS: Record<FormationKind, string> = {
  column: "纵队 Column",
  row: "横队 Row",
  wedge: "楔队 Wedge",
  ring: "环阵 Ring",
};

/**
 * 组（Group Dynamics，Baseline §58）。
 *
 * 一个 team 视作一个 unit：**只 author 一条路线**——由锚点（members[0]，队首）承载。
 * 其余队员按编队预设相对锚点站位：
 * - 匀速直线运动时，锚点加速度≈0 → 弹簧位移≈0 → **编队保持不变**（外加微量自然扰动）；
 * - 突然加速 / 减速 / 变线时，队员因惯性被甩出 → **弹簧拉扯**，随后阻尼回弹、
 *   归零 → **回到原编队槽位**。
 * 这样只需画一条路径就能指挥整队，模拟兽群 / 军队的行进。
 */
export interface DirectorGroup {
  id: string;
  name: string;
  color: string;
  /** 成员对象 id。members[0] 为**锚点**（队首）：它的路径就是整队的唯一路线。 */
  members: string[];
  /** 团队行为开关。关时为纯取景分组（仅供相机 GROUP 取景），不接管队员位置。 */
  dynamics: boolean;
  /** 编队预设：队员相对锚点的站位排布。 */
  formation: FormationKind;
  /** 编队切换前的预设：切换瞬间记录，供求解器按时间插值（现实中变阵需要时间，不能瞬间完成）。 */
  prevFormation?: FormationKind;
  /** 上次切换编队的时刻（秒）。未定义 = 无过渡，沿用旧行为（瞬间到位）。 */
  formationChangeAt?: number;
  /** 编队间距（米）：相邻槽位之间的距离。 */
  spacing: number;
  /** 匀速时的自然微扰强度 0..1：让编队不死板（确定性噪声，可复算）。 */
  noise: number;
  /** 锁定后不可通过拖拽移动整队（防误触）；仍可点选以便解锁。 */
  locked?: boolean;
}

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
  /** 组（Group Dynamics）。旧场景 JSON 无此字段时默认为空数组。 */
  groups: DirectorGroup[];
  /**
   * 自定义动作库（命名的关节姿势）。旧场景 JSON 无此字段时默认为空数组。
   * 随场景自动持久化；customId 悬空的片段按「空姿势」处理，不会报错。
   */
  customActions?: CustomAction[];
  /**
   * 世界模式。缺省 "planar"。
   *
   * 注意：**"planar" 不是一条特例分支，而是能力表的退化取值** —— 等价于
   * maxStep = 0 + 无跳跃 + 无攀爬。此时 top ≤ 0 的面才可站，所有现有 set 资产
   * （建筑 top=24、桌子 top=0.9 …）全部保留为障碍，与 3D 化之前逐像素一致。
   *
   * 因此下游不需要任何 `if (worldMode === "planar")` 特判。
   */
  worldMode?: WorldMode;
  /**
   * 对象名字的**场景级三态**开关。缺省 `"default"`（= 交给个体）。
   *
   * - `"on"` / `"off"`：**场景接管** —— 强制显示 / 强制隐藏，个体的 `showName` 被压过；
   * - `"default"`：控制权交给个体（`DirectorObject.showName`，缺省显示）。
   *
   * 为什么需要它：示例场景为了讲解会给对象起很长的名字，对象一多，名字会盖住画面 ——
   * 编辑时看不清全貌、播放时干扰信息。
   */
  showNames?: NameVisibility;
  /**
   * 场景级能力表 override（按类别覆盖 `engine/locomotion.ts` 的预设）。
   * 用途：骑马的人能跳 1.2m、受伤的人 maxStep 只有 0.2m —— 不必新增资产类别。
   */
  locomotion?: Partial<Record<AssetCategory, Partial<Locomotion>>>;
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
  PAN: "PAN 平摇",
  TILT: "TILT 俯仰",
  TRUCK: "TRUCK 横移",
  STEADICAM: "STEADICAM 斯坦尼康",
  HANDHELD: "HANDHELD 手持",
  PATH: "PATH 自定义轨迹",
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
  DRONE: "无人机自由飞行：同时绕圈 + 升降 + 推拉。",
  PAN: "原地水平摇（yaw）：机位不动，只旋转注视方向扫过场景，用于甩镜 / 横扫。",
  TILT: "原地俯仰（pitch）：机位不动，只上下旋转注视方向。",
  TRUCK: "横向平移（垂直视线方向的轨道横移）：保持距离与透视，平行掠过主体。",
  STEADICAM: "斯坦尼康式平滑跟随：三维连续跟随目标，比普通 FOLLOW 更顺滑稳定。",
  HANDHELD: "手持微晃：机位叠加细微正弦抖动，模拟手持摄影的不稳定质感。",
  PATH: "自定义空间路径：相机沿可编辑折线（任意曲线）运动，不锁定任何目标关系，用于精确复刻手绘运镜。",
};

/** 风格轴 → 底层参数（模板映射，UI 不暴露原始数值）。 */
export interface StyleParams {
  /** 位置抖动幅度（米）。 */
  shakeAmp: number;
  /** 抖动主频系数。 */
  shakeFreq: number;
  /** 上下漂浮幅度（米），用于走拍 bob。 */
  bobAmp: number;
  /** 漂浮主频系数。 */
  bobFreq: number;
  /** 滚转漂移幅度（度），手持 / 走拍常见的轻微歪斜。 */
  rollDrift: number;
  /** 滚转漂移频率系数。 */
  rollFreq: number;
}

/** 五档稳定方式，对应线下流行的拍摄设备质感。 */
export const STYLE_PRESETS: Record<CameraStyle, StyleParams> = {
  // 三脚架锁死：无抖动。
  locked: { shakeAmp: 0, shakeFreq: 0, bobAmp: 0, bobFreq: 0, rollDrift: 0, rollFreq: 0 },
  // 手机云台：极轻微、低频漂浮，几乎察觉不到 —— 当下最流行的「稳定器」观感。
  gimbal: { shakeAmp: 0.015, shakeFreq: 1.1, bobAmp: 0.02, bobFreq: 0.9, rollDrift: 0, rollFreq: 0 },
  // 肩扛手持：有机抖动 + 轻微滚转漂移。
  handheld: { shakeAmp: 0.06, shakeFreq: 7.3, bobAmp: 0.05, bobFreq: 5.7, rollDrift: 1.5, rollFreq: 0.6 },
  // 手机走拍 / vlog：明显上下 bob（走路颠簸）+ 中等抖动。
  vlog: { shakeAmp: 0.05, shakeFreq: 6.0, bobAmp: 0.12, bobFreq: 2.1, rollDrift: 0.8, rollFreq: 0.5 },
};

export const STYLE_LABELS: Record<CameraStyle, string> = {
  locked: "Locked 三脚架",
  gimbal: "Gimbal 手机云台",
  handheld: "Handheld 手持",
  vlog: "Vlog 走拍",
};

export const STYLE_HINTS: Record<CameraStyle, string> = {
  locked: "锁定机位：无抖动，最稳。",
  gimbal: "手机云台：极轻微漂浮，当下最流行的稳定器观感。",
  handheld: "手持肩扛：有机微晃 + 轻微滚转漂移。",
  vlog: "第一人称走拍：明显上下颠簸 + 中等抖动。",
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
