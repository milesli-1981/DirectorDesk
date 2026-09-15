import { DirectorObject, DirectorState, Vec3 } from "../domain/schema";
import { standingHeightFor, supportUnder } from "./ground";
import { locomotionOf } from "./locomotion";
import { topPlaneOf } from "./raycast";
import { airborneLiftAt, pathHeightAt, arcActive, activeSegmentAt, arcEndHeights } from "./pathHeight";
import { arcVerticalSpeed } from "./arc";
import { objectPosition } from "./solver";

/**
 * 姿态层（Phase 7）：**身体怎么贴在那块面上**。
 *
 * Phase 0–6 解决的是"人在哪"（位置 / 高度 / 可达性 / 镜头）。本模块解决另一半：
 * 站在 30° 坡上的人，若躯干仍竖直、双脚仍水平，看起来就是"悬在坡前"。
 *
 * ## 三条不变量
 *
 * 1. **姿态是渲染层的派生量，不进 `state`。** 它每帧由几何算出，不写进对象、进不了
 *    undo、不需要同步。把结果缓存进 `state` 会立刻产生两个真相来源（几何变了、
 *    缓存的姿态没变）。所以本模块是**纯函数**，签名只有 `(state, objectId, time, x, z)`。
 * 2. **面法线只有一个出处：`raycast.ts` 的 `topPlaneOf`。** 它同时是"画在哪"
 *    与"能站哪"的同一个平面（由 `topAt` 的线性式反推）。渲染侧另写一份坡面法线
 *    会重演红线 5 的坑。
 * 3. **planar 恒等**：planar 下 `supportUnder` 只返回基准面（`maxStep = 0`、
 *    顶面 ≤ 0 才可达），所以恒为水平面 ⇒ pitch = roll = 0、骨盆不抬。
 *    另有**一处显式短路**兜底（`surfaceAt` 开头）—— 因为 `topPlaneOf` 读 `topShape`
 *    而不看世界模式，planar 场景里若残留一个 ramp 就会凭空倾斜。两者合起来
 *    保证红线 1（planar 逐像素等于扩展前）。
 *
 * ## 时间无关性（红线 10）
 *
 * `surfaceAt` / `stanceOf` 只读 `state.objects` 与传入的 `time`（弧线需要它求 `u`），
 * 不读 `currentTime`。同一 revision 内对同一 `time` 恒定。
 */

/** 判"离地"的容差（米）。与 `cameraSolver.ts` 的 `AIRBORNE_EPS` 同值 —— 见 `airborneOf`。 */
export const AIRBORNE_EPS = 0.01;

/** 双脚采样点相对骨盆中心的前后偏移（米）。按 footprint.d 的一半取，见 `pelvisLiftOf`。 */
export const FOOT_SPAN_RATIO = 0.5;

export interface SurfaceInfo {
  /** 支撑对象 id（null = 基准面）。 */
  supportId: string | null;
  /** 该面在 (x, z) 处的高度。 */
  y: number;
  /** 面法线（单位向量，世界系，朝上）。水平面 = [0, 1, 0]。 */
  normal: Vec3;
  /** 沿"上坡方向"的坡度角（度）。0 = 水平。 */
  slopeDeg: number;
  /** 坡的朝向（世界系 yaw，度）：+pitch 是绕它转的。 */
  aspectDeg: number;
}

/**
 * 该对象此刻站立处的**立足面**（含法线 / 坡度）。
 *
 * 法线来自 `topPlaneOf`（= 顶面所在平面），是"画在哪 / 能站哪"的同一个平面。
 * planar 与 flat 顶面都返回水平面 —— 于是下游的姿态全退化成恒等。
 */
export function surfaceAt(
  state: DirectorState,
  object: DirectorObject | undefined,
  x: number,
  z: number,
): SurfaceInfo {
  const flat: SurfaceInfo = {
    supportId: null,
    y: 0,
    normal: [0, 1, 0],
    slopeDeg: 0,
    aspectDeg: 0,
  };
  if (!object || object.role === "set") return flat;

  // planar：`schema.ts` 明写「topShape / baseY 只在 terrain 生效」——
  // 拓扑上 planar 的场景里不该有坡。但 `topPlaneOf` 本身读 `topShape`，
  // 不区分世界模式，所以这里**显式短路**：planar 一律水平面。
  // 少了这一句，planar 场景里残留一个 ramp 就会让姿态凭空倾斜 ——
  // 违反红线 1（planar 必须逐像素等于扩展前）。守卫：§31「planar 无视坡」。
  if ((state.worldMode ?? "planar") === "planar") return flat;

  const loco = locomotionOf(state, object);
  const fromY = object.baseY ?? 0;
  const hit = supportUnder(state, x, z, fromY, loco.maxStep, object.id);
  if (!hit.supportId) {
    // 基准面（或脚下没有任何够得着的面）：水平面。
    return { ...flat, y: hit.y };
  }
  const support = state.objects.find((o) => o.id === hit.supportId);
  if (!support) return { ...flat, y: hit.y };

  // 带上 (x, z)：抽象楼梯是折线顶面，姿态要取**该点所在那一段**的平面。
  const plane = topPlaneOf(support, x, z);
  if (!plane) return { supportId: hit.supportId, y: hit.y, normal: [0, 1, 0], slopeDeg: 0, aspectDeg: 0 };

  // 法线 = 平面系数的前三个分量（未归一化的有符号平面 (nx,ny,nz,c)）。
  const len = Math.hypot(plane.nx, plane.ny, plane.nz) || 1;
  const normal: Vec3 = [plane.nx / len, plane.ny / len, plane.nz / len];
  // 顶面法线必须朝上（ny > 0）：俯视一个 ramp 时平面系数的 ny 恒为 +1（见 topPlaneOf）。
  const slopeDeg = (Math.acos(Math.max(-1, Math.min(1, normal[1]))) * 180) / Math.PI;
  // aspect：上坡方向的 yaw。法线的水平分量指向下坡，所以取它的反方向。
  const aspectDeg = (Math.atan2(-normal[0], -normal[2]) * 180) / Math.PI;
  return { supportId: hit.supportId, y: hit.y, normal, slopeDeg, aspectDeg };
}

/**
 * 坡面 pitch / roll（弧度）：把身体对齐到立足面法线。
 *
 * 把 `normal` 投到「行进方向 forward × 世界 up」这组基底里，**不做欧拉角猜谜**：
 *
 *   forward = (sin yaw, 0, cos yaw)      // 行进方向（水平投影）
 *   right   = (cos yaw, 0, −sin yaw)     // 右手
 *   pitch   = asin(dot(normal, forward)) // **面向坡上时为负**（后仰，见下）
 *   roll    = asin(dot(normal, right))   // 侧倾角（向右倾为正）
 *
 * `pitch` 的符号曾经在注释里写反过：上坡面的法线朝**上后方**，所以对齐法线
 * ⇒ `dot(n, forward) < 0` ⇒ **后仰**。这不是算错，是"抬起前脚"的唯一手段：
 * 面向坡上时把整个身体后仰一个坡度角，前脚（局部 +Z）就被抬起、正好踩到高出去的那块坡面。
 * §31 用「面向坡上 → pitch < 0（前脚抬起）」「面向坡下 → pitch > 0」两条钉住。
 *
 * **代价（可见后果）**：人和方块没法只靠整体旋转既贴坡又立直 —— 上坡时整个人会后仰一个
 * 坡度角（示例里 16.2° 的楼梯就是后仰 16.2°）。这是"没有逐脚 IK"下的必然取舍：
 * 想同时要「脚贴坡」与「躯干立直」，得让腿 / 踝单独反向旋转，姿态层目前不做。
 *
 * ## 欧拉序必须是 `YXZ`（**不是** three.js 默认的 `XYZ`）
 *
 * 这里的 pitch / roll 是**角色自己的轴**上的角度（pitch 绕角色右手、roll 绕角色正前方）。
 * 默认序 `XYZ` 会把 `rotation.x` 施加在**世界轴**上 —— 于是只有 yaw = 0 的角色恰好对；
 * 朝 +X 的角色（抽象楼梯的第二段就是这样）会被绕世界 X 转，画面上是**侧倾**，即"人歪了"。
 * 渲染层因此把角色 group 的 `rotation.order` 设成 `"YXZ"`（`R = Ry·Rx·Rz`，yaw 先作用）。
 *
 * 于是 `R·(0,1,0) = n`（身体上轴 = 立足面法线）对**任意朝向**都成立：
 *
 *   R·(0,1,0) = Ry(yaw)·(−sin roll, cos roll·cos pitch, cos roll·sin pitch)
 *
 * 逐项与"法线在角色局部系的分量"对齐，正是下面两式：
 *
 *   pitch = asin(dot(n, forward))、roll = −asin(dot(n, right))
 *
 * `roll` 取负号不是自由的：局部前方是 +Z、局部右方是 +X，而 `rotation.z = +a`
 * 把 +X 那一侧抬高。§31 现在有两条：一条拿矩阵验证"YXZ 下任意 yaw 的上轴 = 法线"，
 * 一条钉住"面向坡上 / 横切坡"的符号（单测一个 yaw 会把符号写反却看起来通过）。
 *
 * **只处理 pitch + roll，不做 yaw 对齐** —— 朝向仍由求解器（`objectFacing`）唯一定，
 * 姿态不许染指"面朝哪"（否则"边走边转头"会被坡面歪掉）。
 *
 * @param yaw 行进方向（弧度；取不到速度方向时传 `objectFacing`）
 */
export function tiltFor(
  normal: Vec3,
  yaw: number,
): { pitch: number; roll: number } {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
  const pitch = Math.asin(clamp1(normal[0] * fx + normal[2] * fz));
  // 负号见上方推导（three.js `Euler("XYZ")` ⇒ R = Rx·Ry·Rz）。
  const roll = -Math.asin(clamp1(normal[0] * rx + normal[2] * rz));
  return { pitch, roll };
}

/**
 * 骨盆高度自适应：**让脚底落在坡面上**，而不是让原点落在坡面上。
 *
 * ## 为什么需要它
 *
 * 方块人的原点在脚下（`groupRef` 的 y = `pathHeightAt` = 骨盆中心处的地面高度），
 * 而 `tiltFor` 让身体绕这个原点转 pitch。旋转后：
 * - 局部 `z = +span` 的前脚被转到 `y = −span·sin(pitch)`；
 * - 局部 `z = −span` 的后脚被转到 `y = +span·sin(pitch)`。
 *
 * ## 关键：**平面坡上这个量恒为 0**
 *
 * 若立足面是**一个平面**、且 pitch 正好等于坡度，那么"绕中点旋转"本身就
 * 恰好把两只脚都贴在平面上 —— 前脚被压低 `span·sin(pitch)`，而该处地面
 * 也正好高出 `span·k = span·sin(pitch)`，两两抵消。代入本式：
 *
 *   needFront = (mid + span·k) − mid + span·sin(pitch) = 0
 *   needBack  = (mid − span·k) − mid − span·sin(pitch) = 0
 *
 * （`k = tan(pitch)`、小角下 `≈ sin(pitch)`；实测残差是 1e-4 量级浮点噪声。）
 *
 * 所以这个函数的**真正职责是处理"平面假设失效"的场合**：
 * - 坡**顶 / 坡脚**：前脚已经走出坡面（`topUnderfoot` 落回基准面或下一级台阶），
 *   而身体仍按坡面 pitch 倾斜 ⇒ 前脚悬空，此时抬升量非 0；
 * - 立足面**不是平面**（两级台阶、箱子边缘）：中点与前后脚的支撑面各不同；
 * - pitch 被弧线 / 作者姿势改写过（载具不适用 —— 见 `stanceOf`，它传 0）。
 *
 * 平面坡上恒为 0 也让 planar 自动恒等（planar 只有水平面 ⇒ pitch = 0 ⇒ 抬升 0）。
 *
 * 取 `span = footprint.d / 2` 是因为方块人的"脚"就是盒子底面的前后边缘。
 */
export function pelvisLiftOf(
  state: DirectorState,
  object: DirectorObject | undefined,
  x: number,
  z: number,
  yaw: number,
  pitch: number,
): number {
  if (!object || object.role === "set") return 0;
  const span = (object.footprint.d || 0.6) * FOOT_SPAN_RATIO;
  if (span <= 1e-6) return 0;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const s = Math.sin(pitch);
  const frontGround = topUnderfoot(state, object, x + fx * span, z + fz * span);
  const backGround = topUnderfoot(state, object, x - fx * span, z - fz * span);
  const midGround = topUnderfoot(state, object, x, z);
  // 抬升 lift 后，脚的世界高度 = midGround + lift + (旋转位移)，要求 ≥ 该处地面。
  //   front: midGround + lift − span·s ≥ frontGround  ⇒  lift ≥ frontGround − midGround + span·s
  //   back : midGround + lift + span·s ≥ backGround   ⇒  lift ≥ backGround  − midGround − span·s
  // 两只脚都不许埋/悬 ⇒ 取两者所需的最大值（负值截到 0；平面坡上两者都是 0）。
  const needFront = frontGround - midGround + span * s;
  const needBack = backGround - midGround - span * s;
  return Math.max(needFront, needBack, 0);
}

/** (x,z) 处脚下够得着的最高的面（用该对象自己的能力表，排除自身）。 */
function topUnderfoot(
  state: DirectorState,
  object: DirectorObject,
  x: number,
  z: number,
): number {
  const loco = locomotionOf(state, object);
  const fromY = object.baseY ?? 0;
  return supportUnder(state, x, z, fromY, loco.maxStep, object.id).y;
}

export interface Stance {
  /** 立足面。 */
  surface: SurfaceInfo;
  /** 坡面 pitch（弧度，前倾为正）。 */
  pitch: number;
  /** 坡面 roll（弧度，右倾为正）。 */
  roll: number;
  /** 骨盆相对原点的抬升（米）。 */
  pelvisLift: number;
  /** 此刻是否离地（跳跃 / 落差弧线中）。 */
  airborne: boolean;
  /** 相对脚下滑面的离地量（米）。0 = 贴地。 */
  lift: number;
}

/**
 * 对象此刻的**完整姿态**（立足面 + pitch/roll + 骨盆抬升 + 离地）。
 *
 * 这是渲染层唯一该调的入口 —— 它内部把 `surfaceAt` / `tiltFor` / `pelvisLiftOf`
 * 串起来，保证三者的几何同源。
 *
 * @param x,z  当前的**水平位置**（由求解器给，不是读 `state`）
 */
export function stanceOf(
  state: DirectorState,
  objectId: string,
  time: number,
  x: number,
  z: number,
): Stance {
  const object = state.objects.find((o) => o.id === objectId);
  if (!object) {
    return {
      surface: { supportId: null, y: 0, normal: [0, 1, 0], slopeDeg: 0, aspectDeg: 0 },
      pitch: 0,
      roll: 0,
      pelvisLift: 0,
      airborne: false,
      lift: 0,
    };
  }

  // 行进方向：站立时用朝向，移动中用当前朝向（渲染层传入的 yaw 与它一致）。
  const yaw = facingAt(state, objectId);
  const surface = surfaceAt(state, object, x, z);
  const { pitch: basePitch, roll } = tiltFor(surface.normal, yaw);
  // 载具：弧线中的仰 / 俯叠加到坡面 pitch 上（人不需要 —— 跳跃时身体由三段姿势表达）。
  const isVehicle = object.category === "vehicle";
  const pitch = isVehicle ? basePitch + arcPitchOf(state, objectId, time) : basePitch;
  // 载具四轮贴地：**不做骨盆高度自适应** —— 车轴位置是刚体，
  // 不该为"前后脚高差"抬车身（那会让车悬浮）。
  const pelvisLift = isVehicle ? 0 : pelvisLiftOf(state, object, x, z, yaw, pitch);
  const { airborne, lift } = airborneOf(state, object, x, z, time);
  return { surface, pitch, roll, pelvisLift, airborne, lift };
}

/**
 * 坡面姿态补偿的强度：0 = 不补偿（整个人跟着坡歪）、1 = 躯干完全竖直。
 *
 * 真人站坡是骨盆 / 腿跟坡、躯干立直，所以默认 1。想留一点"上坡自然前倾"就调小它。
 */
export const SLOPE_TORSO_COMP = 1;

/**
 * 坡面姿态补偿（关节角，加到 `spine` 上）：把**上半身**相对坡面 pitch/roll 反向转回来。
 *
 * ## 为什么需要
 *
 * `stanceOf` 让整个 group 对齐立足面法线 —— 那一步是为了让**脚**贴在坡面上（没有逐脚
 * IK，只能整体转）。但人不会跟着坡歪：真人站在坡上是骨盆 / 腿跟坡、**躯干立直**。
 * 少了这一步，走上坡的人会整体后仰一个坡度角（示例里 16.2° 的楼梯就后仰 16.2°），
 * 侧视角看过去就是"人歪了"；站在坡上正对下坡的人则整体前倾同一个角。
 *
 * ## 轴向：实测自 `public/models/Xbot.glb` 的 `mixamorigSpine`，不是猜的
 *
 * - `rotation.x` 为正 ⇒ 颈 / 头朝 **+Z**（前方）移动 = 前倾；
 * - `rotation.z` 为正 ⇒ 颈 / 头朝 **−X**（左侧）移动 = 向左倾。
 *
 * 与本项目「模型正面 = 本地 +Z、右手 = +X」**同号**，所以补偿就是 `(−pitch, −roll)`：
 * `tiltFor` 面向坡上时给的 pitch 为负（后仰），补 `−pitch` 即正（前倾）⇒ 躯干回到竖直。
 *
 * 平地 / planar：pitch = roll = 0 ⇒ 返回 `null`，调用方不叠加任何关节角（逐像素不变）。
 */
export function torsoCompensation(
  stance: { pitch: number; roll: number } | null | undefined,
): Vec3 | null {
  if (!stance) return null;
  const x = -stance.pitch * SLOPE_TORSO_COMP;
  const z = -stance.roll * SLOPE_TORSO_COMP;
  if (Math.abs(x) < 1e-4 && Math.abs(z) < 1e-4) return null;
  return [x, 0, z];
}

/**
 * 该对象此刻是否**离地**（跳跃 / 落差弧线中），以及离地量。
 *
 * 判据来自 `pathHeightAt` 的 `airborneLiftAt`（只在该段有生效弧线时才可能非零）。
 *
 * **判据只该有一个出处** —— `cameraSolver.ts` 的跟跳防抖、本模块的跳跃姿势、
 * 时间轴离地底纹都是同一件事（"人在空中"）。所以这里导出、那两处复用。
 */
export function airborneOf(
  state: DirectorState,
  object: DirectorObject | undefined,
  x: number,
  z: number,
  time: number,
): { airborne: boolean; lift: number } {
  if (!object || object.role === "set") return { airborne: false, lift: 0 };
  const lift = airborneLiftAt(state, object, x, z, time);
  return { airborne: lift > AIRBORNE_EPS, lift: Math.max(0, lift) };
}

/**
 * 弧线中的俯仰附加量（弧度）：上升仰视、下降俯冲。载具用。
 *
 * 用 `arc.ts` 的 `arcVerticalSpeed`（纯函数，与弧线本体同源）取竖直速度方向，
 * 起落面高度取 `arcEndHeights`（与渲染 / 可达性同源，不自己算一遍）。
 * 不在弧线上（无活跃弧线段）→ 0。
 */
export function arcPitchOf(
  state: DirectorState,
  objectId: string,
  time: number,
): number {
  const seg = activeSegmentAt(state, objectId, time);
  if (!seg || !seg.arc || !arcActive(state, seg)) return 0;
  // 起落面高度取 `arcEndHeights`（与渲染 / 轨迹线同源），不自己用 pathHeightAt 再算一遍。
  const ends = arcEndHeights(state, seg);
  if (!ends) return 0;
  const speed = arcVerticalSpeed(seg.arc, segmentS(seg, time), ends.y0, ends.y1);
  // 软限幅：上升仰、下降俯，幅度随竖直速度增大但不会翻车。
  return Math.atan(speed * 0.35);
}

/** 段进度（0..1）。俯仰只需要方向，不需要精确里程，所以按时间线性即可。 */
function segmentS(seg: { timeStart: number; timeEnd: number }, time: number): number {
  const span = seg.timeEnd - seg.timeStart || 1;
  return Math.max(0, Math.min(1, (time - seg.timeStart) / span));
}

/**
 * 时间轴 mini 弓形 / 离地底纹：**一段移动里"哪一段在空中"以及"飞多高"**。
 *
 * 采样 16 次 `pathHeightAt − standingHeightFor`（即 `airborneOf` 的同一个量），
 * 于是时间轴上画的弧线与画面里飞的弧线**同一个来源** —— 这正是红线 5 的做法
 * （渲染与显示必须同源）。planar / 无弧线时 `lift` 恒 0 ⇒ 返回 null，
 * 时间轴不会多出任何底纹（逐像素不变）。
 *
 * @param times 采样时刻（应覆盖该片段的 [timeStart, timeEnd]）
 */
export function flightProfileOf(
  state: DirectorState,
  objectId: string,
  times: readonly number[],
): { peak: number; lifts: number[] } | null {
  const object = state.objects.find((o) => o.id === objectId);
  if (!object || times.length === 0) return null;
  const lifts: number[] = [];
  let peak = 0;
  for (const time of times) {
    const { x, z } = objectPosition(state, objectId, time);
    const { lift } = airborneOf(state, object, x, z, time);
    lifts.push(lift);
    if (lift > peak) peak = lift;
  }
  return peak > AIRBORNE_EPS ? { peak, lifts } : null;
}

/**
 * 站立 / 行进朝向（**弧度**）。
 *
 * 用对象的 `rotation` —— 与渲染层 `groupRef.rotation.y` 的最终值同源
 * （渲染侧把 `objectFacing` 结果写进 `rotation`，见 WorldView 的 `facingRef`）。
 * 渲染层把 `stanceOf` 的结果直接用在同一个 group 上，所以两边必须读同一个 yaw。
 */
function facingAt(state: DirectorState, objectId: string): number {
  const object = state.objects.find((o) => o.id === objectId);
  if (!object) return 0;
  return (object.rotation * Math.PI) / 180;
}

/** 便捷：该对象此刻的立足面坡度（度）。渲染 / UI 读数共用。 */
export function slopeDegOf(state: DirectorState, objectId: string, x: number, z: number): number {
  const object = state.objects.find((o) => o.id === objectId);
  return surfaceAt(state, object, x, z).slopeDeg;
}
