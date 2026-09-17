/* 3D 空间扩展的几何自检。用 `npm run check:3d` 运行。 */
import * as THREE from "three";
import { createBlankState } from "../src/engine/demoShot";
import {
  coversXZ,
  groundHeightAt,
  objectBottom,
  objectTop,
  pathGroundAt,
  restingHeightAt,
  snapElevation,
  stairHeightFromPlanes,
  standingHeightFor,
  supportUnder,
  topAt,
} from "../src/engine/ground";
import { footprintsOverlap, separateSetAsset, solidOverlap, verticalOverlap } from "../src/engine/collision";
import { locomotionOf, locomotionOfId } from "../src/engine/locomotion";
import { blockingRects, blockingRectsFor, routeHeightFor } from "../src/engine/avoidance";
import { blockingAssets, setRects } from "../src/engine/occlusion";
import { placeObject, restingBaseY, Placement } from "../src/engine/place";
import { effectiveState } from "../src/engine/worldMode";
import { raycastGround, rayObjectBox, topSlopeDeg } from "../src/engine/raycast";
import {
  jumpReach,
  jumpReachOf,
  speedScale,
  classifyGap,
  dropLimit,
  checkJumpArc,
  checkClimb,
  sampleArcHits,
  standingAt,
} from "../src/engine/jump";
import {
  arcHeightAt,
  arcAtU,
  arcVerticalSpeed,
  arcIsFlat,
  runupAdjusted,
  runupMarginU,
  JUMP_EASE,
  rewriteArcApex,
} from "../src/engine/arc";
import { pathHeightAt, segmentProgressAt, arcActive } from "../src/engine/pathHeight";
import { objectsOnTop, restsOn, settleStack, stackChain, translateStack, stackParentMap, isStackBottom } from "../src/engine/stack";
import { arraySlots, arrayCount, ArraySpec } from "../src/engine/array";
import {
  dragReachHint,
  isRouteAnchor,
  previewArc,
  reachMessage,
  scanReachability,
  segmentFindings,
  segmentSpans,
  takeoffSpeedRatio,
  tierOfGap,
  worstTier,
} from "../src/engine/reach";
import { CAMERA_EYE_REF, cameraAnchorHeight, solveCamera, VIEW_PITCH_DEG } from "../src/engine/cameraSolver";
import { objectPosition } from "../src/engine/solver";
import {
  helixStairPath,
  STAIR_HANDLE_LIFT,
  STAIR_VISUAL_STEP,
  stairBounds,
  stairHandleY,
  stairRunLength,
  stairRuns,
  stairSlopeDeg,
  stairTreads,
  stairWalkPathOf,
} from "../src/engine/stair";
import { simplifyPath } from "../src/engine/path";
import { ObjectAction, objectActions } from "../src/engine/objectActions";
import {
  DEFAULT_STAIR_WIDTH,
  insertBend,
  offsetPolyline,
  planStairLink,
} from "../src/engine/stairLink";
import { planStairWalk } from "../src/engine/stairWalk";
import { hitStairPathPointScreen } from "../src/engine/pick";
import {
  AIRBORNE_EPS,
  airborneOf,
  arcPitchOf,
  pelvisLiftOf,
  slopeDegOf,
  stanceOf,
  surfaceAt,
  tiltFor,
  torsoCompensation,
} from "../src/engine/stance";
import {
  ActionClip,
  ActionKind,
  CameraFraming,
  CameraMove,
  CameraObject,
  CameraView,
  DirectorObject,
  DirectorState,
  Locomotion,
  MoveSegment,
  Pose,
  VerticalArc,
} from "../src/domain/schema";
import { contentEndCause, rawContentEnd } from "../src/engine/timeline";
import { BLOCKED_OPTIONS } from "../src/engine/reach";
import { nameVisible, sceneTakesOverNames } from "../src/engine/nameVisibility";
import { AUTHOR_POSE_NAMES, POSE_PRESETS, POSE_PRESET_NAMES, STANCE_POSE_NAMES } from "../src/engine/poses";
import { actionPoseAt, clipJointAngles } from "../src/engine/actionPose";
import { MODEL_CONFIG } from "../src/engine/modelConfig";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n        实际 ${a}\n        期望 ${e}`);
  }
}

/** 六位小数取整：浮点比较的常规手法（§26 起的地形用例大量使用，故提到模块级）。 */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** 弧度 → 度（保留 6 位），姿态断言用。 */
const deg = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1e6) / 1e6;

function box(id: string, x: number, z: number, w: number, d: number, h: number, baseY?: number): DirectorObject {
  return {
    id,
    type: "prop",
    category: "structure",
    role: "set",
    x,
    z,
    rotation: 0,
    footprint: { w, d, h },
    color: "#8b9bb0",
    ...(baseY !== undefined ? { baseY } : {}),
  };
}

function actor(id: string, x: number, z: number, baseY?: number): DirectorObject {
  return {
    id,
    type: "actor",
    category: "human",
    role: "agent",
    x,
    z,
    rotation: 0,
    footprint: { w: 0.6, d: 0.6, h: 1.8 },
    color: "#67a7ff",
    ...(baseY !== undefined ? { baseY } : {}),
  };
}

function scene(objects: DirectorObject[], worldMode?: "planar" | "terrain"): DirectorState {
  return { ...createBlankState(), objects, ...(worldMode ? { worldMode } : {}) };
}

/** 建一个 MOVE 段（直线，默认 1 秒，线性缓动）。 */
function seg(
  id: string,
  object: string,
  from: [number, number],
  to: [number, number],
  extra?: Partial<MoveSegment>,
): MoveSegment {
  return {
    id,
    type: "MOVE",
    object,
    startX: from[0],
    startZ: from[1],
    endX: to[0],
    endZ: to[1],
    points: [],
    timeStart: 0,
    timeEnd: 1,
    ease: [0, 0, 1, 1],
    ...extra,
  };
}

/** 一个带段 + 可选弧线的场景。 */
function sceneWith(
  objects: DirectorObject[],
  segments: MoveSegment[],
  worldMode?: "planar" | "terrain",
): DirectorState {
  return { ...scene(objects, worldMode), segments };
}

console.log("\n[1] 几何基元");
const a = box("A", 0, 0, 2, 2, 1);
const b = box("B", 0, 0, 2, 2, 1, 1);
check("A 底面 / 顶面", [objectBottom(a), objectTop(a)], [0, 1]);
check("A、B 相切 → verticalOverlap false", verticalOverlap(a, b), false);
check("A、B 相切 → solidOverlap false", solidOverlap(a, b), false);
check("A、B 水平确实重叠", footprintsOverlap(a, b), true);
const overlapping = box("C", 0, 0, 2, 2, 1, 0.5);
check("真实相交 → verticalOverlap true", verticalOverlap(a, overlapping), true);

console.log("\n[2] 平面模式必须退化回原行为（回归保护）");
{
  const state = scene([box("P", 0, 0, 4, 4, 1), box("D", 0, 0, 1, 1, 1)]);
  check("planar：groundHeightAt 恒 0", groundHeightAt(state, 0, 0, 0, locomotionOfId(state, "D").maxStep), 0);
  check("planar：restingHeightAt 恒 0（不吸附）", restingHeightAt(state, 0, 0, "D"), 0);
  // set 资产仍会被水平推开 —— 与扩展前逐字一致
  const sep = separateSetAsset(state.objects, "D", 0, 0);
  check("planar：set 仍被推开（y 轴分离）", Math.round(sep.z * 100) / 100, 2.55);
}

console.log("\n[3] 立体模式：堆叠");
{
  const state = scene([box("P", 0, 0, 4, 4, 1), box("D", 0, 0, 1, 1, 1)], "terrain");
  // 关键回归：两个盒子上下叠（底面 == 顶面），不该被水平推开
  const stacked = box("S", 0, 0, 1, 1, 1, 1);
  const sep = separateSetAsset([...state.objects, stacked], "S", 0, 0);
  check("terrain：堆叠对象不被水平推开", [sep.x, sep.z], [0, 0]);
  check("terrain：落点吸附到平台顶面", restingHeightAt(state, 0, 0, "D"), 1);
  check("terrain：第二层顶面 = 2", objectTop({ ...stacked, baseY: 1 } as DirectorObject), 2);
}

console.log("\n[4] 台阶 / 高低差由同一条规则涌现");
{
  const step = scene([box("STEP", 3, 0, 1, 1, 0.3), actor("H", 0, 0)], "terrain");
  check(
    "0.3m 台阶：人可达（0.3 ≤ 0 + 0.35）",
    groundHeightAt(step, 3, 0, 0, locomotionOfId(step, "H").maxStep, "H"),
    0.3,
  );
  const wall = scene([box("WALL", 3, 0, 1, 1, 3), actor("H", 0, 0)], "terrain");
  check(
    "3m 墙：人不可达 → 留在地面",
    groundHeightAt(wall, 3, 0, 0, locomotionOfId(wall, "H").maxStep, "H"),
    0,
  );
  check(
    "站上 3m 平台后，同一堵墙变可达（fromY 上限的作用）",
    groundHeightAt(wall, 3, 0, 3, locomotionOfId(wall, "H").maxStep, "H"),
    3,
  );
  const car = scene([box("STEP", 3, 0, 1, 1, 0.3), actor("H", 0, 0)], "terrain");
  car.objects = [...car.objects, { ...actor("CAR", 0, 0), category: "vehicle" }];
  check(
    "同一级台阶：车（maxStep 0.15）上不去 —— 阈值挂在主体上",
    groundHeightAt(car, 3, 0, 0, locomotionOfId(car, "CAR").maxStep, "CAR"),
    0,
  );
}

console.log("\n[5] 桥下穿行：bottom 给出净空");
{
  const bridge = box("BR", 0, 0, 6, 2, 0.3, 2.75);
  bridge.bottom = 2.4;
  const state = scene([bridge], "terrain");
  check("桥体底面 = 2.4（净空）", objectBottom(bridge), 2.4);
  check("桥顶面 = 3.05", objectTop(bridge), 3.05);
  // 地面查询只看"够得着的最高的面"，桥面 3.05 够不着 → 仍报地面。
  // （真正放行"从桥下走"的是水平障碍测试，属 Phase 3。）
  check(
    "地面查询：桥面够不着 → 报地面 0",
    supportUnder(state, 0, 0, 0, 0.35, "H").y,
    0,
  );
}

console.log("\n[6] 演员站到平台上");
{
  const state = scene([box("P", 0, 0, 4, 4, 1), actor("H", 0, 0, 1)], "terrain");
  check("演员落脚高度 = 平台顶面", standingHeightFor(state, state.objects[1], 0, 0), 1);
  const planar = scene([box("P", 0, 0, 4, 4, 1), actor("H", 0, 0)], "planar");
  check("planar 下演员恒在 0（不吸平台）", standingHeightFor(planar, planar.objects[1], 0, 0), 0);
}

console.log("\n[7] 坡道（ramp）顶面");
{
  const ramp = box("R", 0, 0, 2, 4, 1);
  ramp.topShape = "ramp";
  const state = scene([ramp], "terrain");
  check("坡脚 z=-2 → 0", objectBottom(ramp), 0);
  check("坡道局部 z=-2 处高度 0", Math.round(groundHeightAt(state, 0, -2, 9, 0.35, "H") * 100) / 100, 0);
  check("坡道局部 z=0 处高度 0.5", Math.round(groundHeightAt(state, 0, 0, 9, 0.35, "H") * 100) / 100, 0.5);
  check("坡顶 z=+2 → 1", Math.round(groundHeightAt(state, 0, 2, 9, 0.35, "H") * 100) / 100, 1);
}

console.log("\n[8] 桶索引缓存");
{
  const state = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  check("初次查询 → 1", groundHeightAt(state, 0, 0, 9, 0.35, "H"), 1);
  // 移动平台（objects 换数组）→ 缓存必须重建
  const moved = { ...state, revision: state.revision + 1, objects: [box("P", 20, 0, 4, 4, 1)] };
  check("移动后 → 0（缓存已失效）", groundHeightAt(moved, 0, 0, 9, 0.35, "H"), 0);
  check("新位置 → 1", groundHeightAt(moved, 20, 0, 9, 0.35, "H"), 1);
  // 回归保护：两份 revision 相同、几何不同的场景（切场景页 / 导入存档会发生）不能互相污染。
  const sceneA = scene([box("RAMP", 0, 0, 2, 4, 1)], "terrain");
  (sceneA.objects[0] as DirectorObject).topShape = "ramp";
  check("场景 A（坡道，rev=1）中点 → 0.5", groundHeightAt(sceneA, 0, 0, 9, 0.35, "H"), 0.5);
  const sceneB = { ...scene([box("PLAT", 0, 0, 4, 4, 1)], "terrain"), revision: 1 };
  check("场景 B（平顶平台，同样 rev=1）→ 1，不被 A 污染", groundHeightAt(sceneB, 0, 0, 9, 0.35, "H"), 1);
}

console.log("\n[9] 射线拾取可站立面（Phase 1）");
{
  const down = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  const state = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  const hit = raycastGround(state, down);
  check("垂直向下：命中平台顶面 y=1", [hit?.y, hit?.objectId, hit?.distance], [1, "P", 9]);
  // planar 必须与扩展前一致：只测 y=0 平面
  const planar = scene([box("P", 0, 0, 4, 4, 1)], "planar");
  const planarHit = raycastGround(planar, down);
  check("planar：恒命中基准面 y=0", [planarHit?.y, planarHit?.objectId, planarHit?.distance], [0, null, 10]);
  // 空场景 → 基准面
  const empty = raycastGround(scene([], "terrain"), down);
  check("空场景 → 基准面", [empty?.y, empty?.objectId], [0, null]);
}

console.log("\n[10] 射线拾取：堆叠分层 / 坡道 / 遮挡");
{
  const down = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  // 上下叠两个盒子：指向顶面必须拿到**上层**
  const stack = scene([box("P", 0, 0, 4, 4, 1), box("S", 0, 0, 4, 4, 1, 1)], "terrain");
  const stackHit = raycastGround(stack, down);
  check("堆叠：命中最上层 S，y=2", [stackHit?.y, stackHit?.objectId], [2, "S"]);

  // 坡道：按局部坐标插值，与 topAt 同源
  const ramp = box("R", 0, 0, 2, 4, 1);
  ramp.topShape = "ramp";
  const rampState = scene([ramp], "terrain");
  const rampDown = new THREE.Ray(new THREE.Vector3(0, 10, 1), new THREE.Vector3(0, -1, 0));
  check("坡道 z=+1（局部 0.75）→ y=0.75", raycastGround(rampState, rampDown)?.y, 0.75);
  check("坡道坡度 = atan(1/4) ≈ 14.04°", Math.round(topSlopeDeg(ramp) * 100) / 100, 14.04);

  // 遮挡：一堵 8m 高墙挡在路上，射线够不到后面的地面 → 回退到最近候选而不是 null
  const wall = scene([box("W", 0, 2, 4, 4, 8)], "terrain");
  const oblique = new THREE.Ray(
    new THREE.Vector3(0, 10, 10),
    new THREE.Vector3(0, -9, -10).normalize(),
  );
  const occluded = raycastGround(wall, oblique);
  check("被高墙遮挡 → 仍返回落点（不返回 null）", occluded !== null, true);
  check("回退值为基准面", occluded?.y, 0);
}

console.log("\n[11] rotation 生效：coversXZ / 射线-盒");
{
  const wall = box("W", 0, 0, 10, 1, 3);
  const state0 = scene([wall], "terrain");
  // 10×1 的墙未旋转时，(0, 4) 在它外面
  check("未旋转：(0,4) 不在墙上", groundHeightAt(state0, 0, 4, 9, 0.35, "H"), 0);
  // 转 90° 后，墙沿 Z 铺开，(0, 4) 落在墙上
  const rotated = { ...box("W", 0, 0, 10, 1, 3), rotation: 90 };
  const state90 = scene([rotated], "terrain");
  check("旋转 90°：(0,4) 落在墙上 → 顶面 3", groundHeightAt(state90, 0, 4, 9, 0.35, "H"), 3);
  // 射线-盒同样要认旋转：从 (0,10,4) 向下打，旋转后应命中，未旋转不该命中
  const down = new THREE.Ray(new THREE.Vector3(0, 10, 4), new THREE.Vector3(0, -1, 0));
  check("射线-盒：未旋转 → 不命中 (0,4)", raycastGround(state0, down)?.objectId, null);
  check("射线-盒：旋转 90° → 命中墙", raycastGround(state90, down)?.objectId, "W");
  // rayObjectBox 的 padding 生效（抓取容差）。
  // 沿墙的长轴方向飞、但在 z 上偏出墙面 → 不加容差不命中，加够容差才命中。
  const miss = new THREE.Ray(new THREE.Vector3(0, 1.5, 0.9), new THREE.Vector3(1, 0, 0));
  check("射线-盒：擦边未加容差 → 不命中", rayObjectBox(miss, wall, 0, 3, 0), null);
  check("射线-盒：擦边加 0.5 容差 → 命中", rayObjectBox(miss, wall, 0, 3, 0.5) !== null, true);
  check("射线-盒：容差不足（墙面在 z=0.5）→ 仍不命中", rayObjectBox(miss, wall, 0, 3, 0.3), null);
}

console.log("\n[12] 标高吸附与路径贴地");
{
  const state = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  check("吸附：1.12 → 平台顶面 1", snapElevation(state, 1.12, 0.35, "D"), 1);
  check("吸附：1.5 超出阈值 → 原值", snapElevation(state, 1.5, 0.35, "D"), 1.5);
  check("吸附：0.2 → 基准面 0", snapElevation(state, 0.2, 0.35, "D"), 0);
  check("吸附：阈值 0 = 关闭", snapElevation(state, 1.12, 0, "D"), 1.12);
  // 排除自身：0.9 靠近 P 的顶面 1，但把 P 排除后只剩基准面 0，超出阈值 → 保持原值。
  // 这正是"抬高一个盒子时不能吸到它自己原来的顶面"这条要求。
  check("吸附：不排除自身 → 吸到 1", snapElevation(state, 0.9, 0.35, "D"), 1);
  check("吸附：排除自身 → 保持 0.9", snapElevation(state, 0.9, 0.35, "P"), 0.9);

  // 路径贴地：渲染与拾取共用同一个函数
  const withActor = scene([box("P", 0, 0, 4, 4, 1), actor("H", 0, 0, 1)], "terrain");
  check("路径贴地：演员在平台上 → 1", pathGroundAt(withActor, "H", 0, 0), 1);
  const planarActor = scene([box("P", 0, 0, 4, 4, 1), actor("H", 0, 0)], "planar");
  check("路径贴地：planar → 0", pathGroundAt(planarActor, "H", 0, 0), 0);
  check("路径贴地：对象不存在 → 0", pathGroundAt(withActor, "NOPE", 0, 0), 0);
}

console.log("\n[13] 落位：先定层高、再分离（顺序回归）");
{
  // 平台：4×4、高 1，坐在地面。D 从远处被拖过来。
  const state = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  const staged: DirectorState = { ...state, objects: [...state.objects, box("D", 6, 0, 1, 1, 1)] };

  // ① 反证：旧实现是「先分离、后定高」。分离时 D 的 baseY 还是 0，
  //    与 P 同层 → 垂直必然相交 → 被沿最小穿透轴推到平台外面。
  //    这条断言故意保留，让这个回归测试能解释自己为什么存在：
  //    定高本身算对了（1），问题只在于用得太晚。
  const lateHeight = restingHeightAt(staged, 0, 0, "D");
  const oldOrder = separateSetAsset(staged.objects, "D", 0, 0);
  check("反证：定高算对了（1）", lateHeight, 1);
  check("反证：旧顺序会把盒子水平推开", oldOrder.x !== 0 || oldOrder.z !== 0, true);

  // ② 现在的顺序：先定高 → 带新层高分离 → 相切不推开，稳稳叠上去。
  const placed = placeObject(staged, "D", 0, 0);
  check("拖到平台上方 → 叠在顶面", [placed.x, placed.z, placed.baseY], [0, 0, 1]);
  // ③ 带 layerY（画布真实拖拽路径：指针拾到平台顶面）结论必须一致。
  const placedByLayer = placeObject(staged, "D", 0, 0, 1);
  check("带 layerY 拖到平台 → 同样叠上去", [placedByLayer.x, placedByLayer.z, placedByLayer.baseY], [0, 0, 1]);

  // ④ 拖向平台**侧壁**：指针落在地面（layerY = 0）→ 不该穿进去，应被分离到地面。
  const side = placeObject(staged, "D", 0.2, 0, 0);
  check("拖向侧壁 → 层高保持地面 0", side.baseY, 0);
  check("拖向侧壁 → 水平确实被推开", side.x !== 0.2 || side.z !== 0, true);

  // ⑤ planar 逐像素不变：不写 baseY，但仍参与水平分离（高度不豁免碰撞）。
  const planar = scene([box("P", 0, 0, 4, 4, 1), box("D", 6, 0, 1, 1, 1)], "planar");
  const flat = placeObject(planar, "D", 0, 0);
  check("planar：不写 baseY", flat.baseY, undefined);
  check("planar：仍与平台水平分离", flat.x !== 0 || flat.z !== 0, true);
}

console.log("\n[14] Shift 手势级 3D 覆盖");
{
  const state = scene([box("P", 0, 0, 4, 4, 1)], "planar");
  const down = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));

  // 拾取：planar 下按住 Shift 才看得见"平台顶面"这一层。
  check("planar：不按 Shift → 拾取基准面 y=0", raycastGround(state, down)?.y, 0);
  check("planar：按住 Shift → 拾取平台顶面 y=1", raycastGround(state, down, true)?.y, 1);
  check("planar：Shift 拾取到的层归属平台", raycastGround(state, down, true)?.objectId, "P");

  // 落位：Shift 让 planar 也写 baseY，且仍是"先定高再分离"的正确顺序。
  const staged: DirectorState = { ...state, objects: [...state.objects, box("D", 6, 0, 1, 1, 1)] };
  check("planar：不按 Shift → 不写 baseY", restingBaseY(staged, 0, 0, "D"), undefined);
  check("planar：按住 Shift → 写平台顶面 1", restingBaseY(staged, 0, 0, "D", undefined, true), 1);
  const forced = placeObject(staged, "D", 0, 0, undefined, true);
  check("planar + Shift：叠到平台顶面且不被推开", [forced.x, forced.z, forced.baseY], [0, 0, 1]);

  // 覆盖是"视图"，不改动世界模式本身。
  const terrainState = scene([], "terrain");
  check("已是 terrain → 原样返回同一引用（零分配）", effectiveState(terrainState, true), terrainState);
  check("planar 被覆盖成 terrain", effectiveState(state, true).worldMode, "terrain");

  // 覆盖**不进运动学**：planar 下演员的 maxStep 仍是 0。
  // 画布只把 forceTerrain 交给 raycastGround / placeObject，从不交给 locomotionOf，
  // 所以按住 Shift 不会让场上演员一起跳到台阶上 —— 覆盖是"操作级"的，不是世界级的。
  const stepState = scene([box("STEP", 3, 0, 1, 1, 0.3), actor("H", 0, 0)], "planar");
  check("planar：演员 maxStep 仍为 0", locomotionOfId(stepState, "H").maxStep, 0);

  // 覆盖写下的高度是"真"高度：松开 Shift 之后渲染 / 站立 / 路径贴地都照它走，
  // 不需要任何额外的模式判断 —— planar 的 maxStep = 0 恰好等于"只在自己那一层走动"。
  const built = scene(
    [box("P", 0, 0, 4, 4, 1), box("D", 0, 0, 1, 1, 1, 1), actor("H", 0, 0, 1)],
    "planar",
  );
  check("planar：垫高的盒子按 baseY 渲染", objectBottom(built.objects[1]), 1);
  check("planar：演员站在垫高的盒子上", standingHeightFor(built, built.objects[2], 0, 0), 1);
  check("planar：路径标记贴到同一高度", pathGroundAt(built, "H", 0, 0), 1);
}

console.log("\n[15] 自激振荡：拾取必须排除正在被移动的对象");
{
  // 症状：拖着盒子去"检测重叠"时疯狂抖动、永远放不下来。
  //
  // 根源是"自指"：拖动时物体跟着指针走 ⇒ 指针总压在它身上 ⇒ 拾取到的是**它自己的顶面**
  // ⇒ `baseY = 自己的顶面 = baseY + h`，每帧把自己的身高再加一遍。
  // 它**不是 Shift 的锅**：只要被拖的对象参与拾取，terrain 模式（3D 开关）下的普通拖拽
  // 也犯同一个错 —— 下面 ③ 里两种模式各测一遍就是为了钉死这一点。

  // ① 单对象：指针压在它自己正上方。
  const lone = scene([box("D", 6, 0, 1, 1, 1)], "planar");
  const overSelf = new THREE.Ray(new THREE.Vector3(6, 10, 0), new THREE.Vector3(0, -1, 0));
  const withSelf = raycastGround(lone, overSelf, true);
  const withoutSelf = raycastGround(lone, overSelf, true, new Set(["D"]));
  check("不排除自己 → 拾到自己的顶面", [withSelf?.y, withSelf?.objectId], [1, "D"]);
  check("排除自己 → 射线穿过去落到基准面", [withoutSelf?.y, withoutSelf?.objectId], [0, null]);

  // ② 已叠在平台上（D 的 baseY=1 ⇒ 顶面 2；平台顶面 1），指针压在上面。
  //    排除自己后拾到的是**脚下的平台**（1）⇒ baseY 写回 1 ⇒ 停住；
  //    不排除则拾到自己的顶面（2）⇒ baseY 每帧再涨一次。
  const stacked = scene([box("P", 0, 0, 4, 4, 1), box("D", 0, 0, 1, 1, 1, 1)], "planar");
  const overTop = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
  check("叠在平台上：不排除 → 拾到自己的顶面 y=2", raycastGround(stacked, overTop, true)?.y, 2);
  check("叠在平台上：排除 → 拾到平台顶面 y=1", raycastGround(stacked, overTop, true, new Set(["D"]))?.y, 1);

  // ③ 连续帧模拟：把"每帧拾取 → 落位 → 写回"跑 8 轮，看高度序列会不会收敛。
  //    俯视相机（射线垂直于顶面）→ 一路向上爬；斜视相机 → 抬高 h/tan(俯角) 后漂出
  //    自己的 footprint，下一帧又落回地面，于是 1→0→1→0 每帧翻转 —— 那就是"抖动"。
  const dragTrace = (mode: "planar" | "terrain", tilted: boolean, exclude: boolean): number[] => {
    const base = scene([box("P", 0, 0, 4, 4, 1), box("D", 6, 0, 1, 1, 1)], mode);
    const cam = new THREE.Vector3(6, 12, 14);
    const excl = exclude ? new Set(["D"]) : undefined;
    // 强制按 3D 语义拾取：planar 不按 Shift 的话拾取恒 0，压根不会振荡（也就测不到）。
    const force = mode === "planar";
    let cur: { x: number; z: number; baseY?: number } = { x: 6, z: 0 };
    const trace: number[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      const s: DirectorState = {
        ...base,
        objects: base.objects.map((o) =>
          o.id === "D"
            ? { ...o, x: cur.x, z: cur.z, ...(cur.baseY !== undefined ? { baseY: cur.baseY } : {}) }
            : o,
        ),
      };
      const ray = tilted
        ? new THREE.Ray(new THREE.Vector3(cur.x, 10, cur.z), new THREE.Vector3(0, -1, 0))
        : new THREE.Ray(cam, new THREE.Vector3(cur.x, 1, cur.z).sub(cam).normalize());
      const hit = raycastGround(s, ray, force, excl);
      const placed = placeObject(s, "D", cur.x, cur.z, hit?.y, force);
      trace.push(placed.baseY ?? 0);
      cur = { x: placed.x, z: placed.z, baseY: placed.baseY };
    }
    return trace;
  };

  const climb = dragTrace("planar", true, false);
  check("俯视 + 不排除：8 帧 8 个不同高度（一路向上飞）", new Set(climb).size, 8);
  const flip = dragTrace("planar", false, false);
  check("斜视 + 不排除：高度在 0/1 间翻转（= 疯狂抖动）", [new Set(flip).size, flip[0] !== flip[1]], [2, true]);
  check("terrain + 不排除：同样爬升 —— 证明这**不是** Shift 独有", new Set(dragTrace("terrain", true, false)).size, 8);
  check("俯视 + 排除：第一帧就定住，此后恒定", new Set(dragTrace("planar", true, true)).size, 1);
  check("斜视 + 排除：不再翻转", new Set(dragTrace("planar", false, true)).size, 1);
  check("terrain + 排除：同样定住", new Set(dragTrace("terrain", true, true)).size, 1);

  // ④ 团队：整队平移，任一成员都可能是指针身下那一块，所以集合必须给全。
  const team = scene([box("A", 0, 0, 1, 1, 1), box("B", 1.5, 0, 1, 1, 1)], "planar");
  const overB = new THREE.Ray(new THREE.Vector3(1.5, 10, 0), new THREE.Vector3(0, -1, 0));
  check("团队：只排锚点 → 仍拾到队员自己", raycastGround(team, overB, true, new Set(["A"]))?.objectId, "B");
  check("团队：整队都排 → 落到基准面", raycastGround(team, overB, true, new Set(["A", "B"]))?.objectId, null);
}

console.log("\n[16] 团队整队落位（addGroupAt 的 Shift 覆盖）");
{
  // 团队落位复用 §15 的同一条规则：**每个队员都不该拾取到自己**。
  // 这里测的是"逐个落位 + 各自吸附"这条流程，而不是判据本身 —— 层次与 §13 之于 §3 相同。
  //
  // 注意 `placeObject` 要求对象**已经在 `state.objects` 里**（`addAsset` / `addGroupAt`
  // 都要先并进去）—— 忘了这一步就会静默返回 `{x, z}`（无 baseY），
  // 这正是下面 ① 第一版不小心踩到的坑，用例也顺便把这个契约钉住。
  const stage = (s: DirectorState, o: DirectorObject): DirectorState => ({
    ...s,
    objects: [...s.objects, o],
  });

  // ① 平台只盖住部分队员：只有站在平台 footprint 里的那个该被抬起来。
  const plat = scene([box("P", 0, 0, 3, 3, 1)], "terrain");
  const on = placeObject(stage(plat, box("M0", 0, 0, 1, 1, 1)), "M0", 0, 0);
  const offPlate = placeObject(stage(plat, box("M2", 0, 2.6, 1, 1, 1)), "M2", 0, 2.6);
  check("队员在平台上 → baseY 抬到 1", on.baseY, 1);
  check("队员在平台外（3×3 之外）→ baseY 保持 0", offPlate.baseY, 0);
  // 契约：不在 objects 里 → 只回原坐标、不写 baseY。
  check("契约：对象不在 objects 里 → 不写 baseY", placeObject(plat, "GHOST", 0, 0).baseY, undefined);

  // ② 整队逐个落位：后来的队员要能"看见"先落好的队员。
  //    这里刻意叠了两层 —— 说明"同点再来一个 set"并不是被水平推开，而是**叠上去**
  //    （这才是 §13 那条顺序不变量的正常表现）。真机上队员散在编队槽位，不会同点；
  //    这条用例只用来钉住"逐个落位时后面的能看见前面的"这个流程。
  let staged = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  const seats: Placement[] = [];
  for (const id of ["T0", "T1"]) {
    staged = stage(staged, box(id, 0, 0, 1, 1, 1));
    const p = placeObject(staged, id, 0, 0);
    seats.push(p);
    staged = {
      ...staged,
      objects: staged.objects.map((o) =>
        o.id === id ? { ...o, x: p.x, z: p.z, ...(p.baseY !== undefined ? { baseY: p.baseY } : {}) } : o,
      ),
    };
  }
  check("首个 set 队员落在平台顶面", [seats[0].x, seats[0].z, seats[0].baseY], [0, 0, 1]);
  check("同点的第二个 set 队员叠到它上面（看见前一个）", seats[1].baseY, 2);

  // ③ 真人队员不参与水平分离（agent 可自由摆放），但仍按各自落点吸附层高。
  const actors = scene([box("P", 0, 0, 4, 4, 1), actor("H0", 0, 0)], "terrain");
  const h1 = placeObject(stage(actors, actor("H1", 0, 0)), "H1", 0, 0);
  check("真人队员不被水平推开（可自由摆放）", [h1.x, h1.z], [0, 0]);
  check("真人队员同样吸附到平台顶面", h1.baseY, 1);

  // ④ planar（不按 Shift）：整队都不写 baseY —— 团队落位也必须逐像素退化。
  const flat = scene([box("P", 0, 0, 4, 4, 1)], "planar");
  check("planar：团队队员不写 baseY", placeObject(stage(flat, actor("H1", 0, 0)), "H1", 0, 0).baseY, undefined);
}

console.log("\n[17] 可达性过滤 blockingRects（Phase 3 的支点）");
{
  // 回归保护：planar 下 blockingRects 必须**恒等于** setRects。
  // 这不是"差不多相等"，而是集合同一份 —— 因为 fromY 恒 0、maxStep 恒 0，
  // 唯一会被排除的是 top ≤ 0 的退化盒，而实践中不存在。
  const flat = scene([box("W", 0, 0, 2, 2, 3), actor("H", 5, 0)], "planar");
  const flatRects = blockingRects(flat, "H", routeHeightFor(flat, "H"), locomotionOfId(flat, "H"));
  check("planar：blockingRects === setRects", flatRects, setRects(flat));
  check("planar：routeHeightFor 恒 0", routeHeightFor(flat, "H"), 0);

  // terrain：0.3m 台阶该被"迈上去"接管 → 不算阻挡。
  const step = scene([box("STEP", 0, 0, 2, 2, 0.3), actor("H", 5, 0)], "terrain");
  check("terrain：0.3m 台阶被过滤掉（迈得上去）", blockingRectsFor(step, "H"), []);

  // terrain：3m 墙拦得住人 → 保留。
  const wall = scene([box("WALL", 0, 0, 2, 2, 3), actor("H", 5, 0)], "terrain");
  check("terrain：3m 墙保留为阻挡", blockingRectsFor(wall, "H").length, 1);

  // 同一级台阶：人过得去，车（maxStep 0.15）过不去 —— 阈值挂在主体上。
  const carStep = scene([box("STEP", 0, 0, 2, 2, 0.3), actor("H", 5, 0)], "terrain");
  carStep.objects = [...carStep.objects, { ...actor("CAR", 5, 0), category: "vehicle" }];
  check("terrain：同一级 0.3m 台阶挡住车", blockingRectsFor(carStep, "CAR").length, 1);
  check("terrain：同一级台阶不挡人", blockingRectsFor(carStep, "H"), []);

  // 语义开关：blocking=false 的草丛不挡路。
  const bush = scene([{ ...box("BUSH", 0, 0, 2, 2, 1), blocking: false }, actor("H", 5, 0)], "terrain");
  check("terrain：blocking=false 不挡路", blockingRectsFor(bush, "H"), []);

  // 桥下穿行：bottom 抬到 2.4m，人（身高 1.8 + 净空 0.15）从下面走过 → 不挡。
  const bridge = box("BR", 0, 0, 6, 2, 0.3, 2.4);
  bridge.bottom = 2.4;
  const under = scene([bridge, actor("H", 5, 0)], "terrain");
  check("terrain：2.4m 净空的桥 → 从下方穿过，不挡", blockingRectsFor(under, "H"), []);
  // 但净空只有 1.2m 时人过不去 → 保留。
  const low = box("LOW", 0, 0, 6, 2, 0.3, 2.0);
  low.bottom = 1.2;
  const lowState = scene([low, actor("H", 5, 0)], "terrain");
  check("terrain：1.2m 净空 → 人过不去，保留", blockingRectsFor(lowState, "H").length, 1);

  // 太陡的坡等同墙：不享受"迈上去"的豁免。
  const ramp = box("RAMP", 0, 0, 2, 0.6, 0.3, 0);
  ramp.topShape = "ramp";
  const rampState = scene([ramp, actor("H", 5, 0)], "terrain");
  // 坡高 0.3、进深 0.6 → 坡度 atan(0.3/0.6) ≈ 26.6°，人对 45° 容忍 → 仍然可迈。
  check("terrain：缓坡（26.6° < 45°）可迈 → 不挡", blockingRectsFor(rampState, "H"), []);
  const cliff = box("CLIFF", 0, 0, 2, 0.35, 0.3, 0);
  cliff.topShape = "ramp";
  const carCliff = scene([cliff, actor("H", 5, 0), { ...actor("CAR", 5, 0), category: "vehicle" }], "terrain");
  // 坡度 atan(0.3/0.35) ≈ 40.6°；车 maxSlopeDeg 20 → 太陡，等同墙（即便 0.3 在车的 maxStep 0.15 之上）。
  check("terrain：陡坡（40.6° > 车 20°）挡车", blockingRectsFor(carCliff, "CAR").length, 1);

  // fromY 抬升后，原本挡路的台面变成可迈 —— 「我在几层」决定谁挡我。
  const plat = scene([box("P", 0, 0, 4, 4, 1), actor("H", 5, 0)], "terrain");
  check("terrain：地面上看 1m 平台挡路", blockingRects(plat, "H", 0, locomotionOfId(plat, "H")).length, 1);
  check("terrain：站上 1m 后它不再挡（相切）", blockingRects(plat, "H", 1, locomotionOfId(plat, "H")), []);

  // 自己不算自己的障碍。
  const self = scene([box("A", 0, 0, 2, 2, 3)], "terrain");
  check("自身被排除（不挡自己）", blockingRects(self, "A", 0, locomotionOfId(self, "A")), []);
}

console.log("\n[19] routeHeightFor 必须与时间无关（缓存不变量的守卫）");
{
  // 这是"不要给缓存 key 加量化 fromY"这条判断的**唯一依据**：
  // routeHeightFor 只读 objects / segments，与 currentTime 无关，
  // 所以它在一次 revision 内是常量 → 现有 `${revision}|${objectId}` 的缓存 key 依然正确。
  //
  // 一旦有人往里加了读时间的逻辑，§19 会立刻红 —— 那时必须改成把 fromY 量化进 key，
  // 否则障碍集合逐帧变化、缓存全废（每帧重跑可见图 + Dijkstra）。
  const state = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  state.segments = [
    {
      id: "SEG1", type: "MOVE", object: "H",
      startX: 0, startZ: 0, endX: 8, endZ: 0,
      points: [], timeStart: 0, timeEnd: 4,
      ease: [0, 0, 1, 1],
    },
    {
      id: "SEG2", type: "MOVE", object: "H",
      startX: 8, startZ: 0, endX: 16, endZ: 0,
      points: [], timeStart: 4, timeEnd: 8,
      ease: [0, 0, 1, 1],
    },
  ];
  state.objects = [...state.objects, actor("H", 0, 0, 1)];

  const y0 = routeHeightFor(state, "H");
  // 段起点 (0,0) 在平台上 → 1；(8,0) 在平台外 → 0。取**最小** → 0（保守方向）。
  check("取所有段起始高度的最小值（保守）", y0, 0);
  // 关键断言：同一个 state 反复问、以及"时间"推进后问，答案完全一样。
  check("同一 state 重复调用 → 同值", routeHeightFor(state, "H"), y0);
  const later = { ...state, revision: state.revision + 1 };
  check("只改 revision（模拟时间轴推进）→ 同值", routeHeightFor(later, "H"), y0);

  // 段起点在平台上时，fromY 就该是平台高度（第二段从平台外出发 → 最小值仍 0）。
  const onPlat = scene([box("P", 0, 0, 4, 4, 1)], "terrain");
  onPlat.objects = [...onPlat.objects, actor("H", 0, 0, 1)];
  onPlat.segments = [
    {
      id: "S", type: "MOVE", object: "H",
      startX: 0, startZ: 0, endX: 2, endZ: 0,
      points: [], timeStart: 0, timeEnd: 4,
      ease: [0, 0, 1, 1],
    },
  ];
  check("段起点在平台上 → fromY = 平台顶面 1", routeHeightFor(onPlat, "H"), 1);
  // 没有段的对象（静止障碍）：取它自己脚下那一层。
  check("无段对象 → 用 objectBottom", routeHeightFor(onPlat, "P"), 0);
  const lifted = scene([box("L", 0, 0, 2, 2, 1, 3)], "terrain");
  check("垫高的静止对象 → fromY = 3", routeHeightFor(lifted, "L"), 3);
}

console.log("\n[18] 遮挡的 3D 化（高处掠过 / 桥下穿过）");
{
  // 矮墙（3m）挡不住 20m 高机位俯拍到地面的视线 —— 纯 2D 判定会误报。
  // 注意机位要**真的**够高：从 (0,20,8) 望向 (0,0,0) 时，视线在墙所在的 z=2 处已到 y=5，
  // 从 3m 墙顶上方掠过。（12m 机位在 z=2 处恰好 y=3，是相切命中 —— 判遮挡也是对的。）
  const state = scene([box("WALL", 0, 2, 8, 1, 3)], "terrain");
  const high = blockingAssets(state, { x: 0, y: 20, z: 8 }, { x: 0, y: 0, z: 0 });
  check("高机位俯拍：视线从矮墙上方掠过 → 不判遮挡", high.length, 0);
  // 低机位（1.7m）在同一位置望向同一目标 → 3m 墙确实挡住。
  const low = blockingAssets(state, { x: 0, y: 1.7, z: 8 }, { x: 0, y: 1.5, z: 0 });
  check("低机位平视：3m 墙确实遮挡", low.map((o) => o.id), ["WALL"]);

  // 桥下视线穿过桥体下方 → 不判遮挡。
  const bridge = box("BR", 0, 2, 8, 1, 0.3, 2.75);
  bridge.bottom = 2.4;
  const bs = scene([bridge], "terrain");
  check(
    "桥下穿视（1.5m 高度）→ 不判遮挡",
    blockingAssets(bs, { x: 0, y: 1.5, z: 8 }, { x: 0, y: 1.5, z: 0 }).length,
    0,
  );
  // 但抬高到 3m（看得见桥体）→ 判遮挡。
  check(
    "视线抬到 3m 撞上桥体 → 判遮挡",
    blockingAssets(bs, { x: 0, y: 3, z: 8 }, { x: 0, y: 3, z: 0 }).length,
    1,
  );

  // occluding=false（玻璃）不遮挡视线，与 blocking 独立。
  const glass = scene([{ ...box("GLASS", 0, 2, 8, 1, 3), occluding: false }], "terrain");
  check(
    "occluding=false 不遮挡（玻璃 ≠ 墙）",
    blockingAssets(glass, { x: 0, y: 1.7, z: 8 }, { x: 0, y: 1.5, z: 0 }).length,
    0,
  );

  // planar 回归：y 缺省 0 时退化回 2D 判定，与扩展前一致。
  const flatWall = scene([box("WALL", 0, 2, 8, 1, 3)], "planar");
  check(
    "planar：不传 y 时退化为 2D 判定",
    blockingAssets(flatWall, { x: 0, z: 8 } as { x: number; z: number }, { x: 0, z: 0 }).length,
    1,
  );
}

console.log("\n[20] 跳跃包络 reach(Δh) = R/2·(1+√(1−Δh/H))");
{
  // human 默认旋钮：H = 0.9、R = 2.5。
  const H = 0.9;
  const R = 2.5;
  // 性质表（docs/3d/02 §3）——四个都手算过：
  //   Δh = 0  → R/2·(1+1) = R
  //   Δh = +H → R/2·(1+0) = R/2
  //   Δh = −H → R/2·(1+√2) ≈ 1.2071·R
  check("Δh = 0（平地基准）→ R", Math.round(jumpReach(0, H, R) * 1e6) / 1e6, R);
  check("Δh = +H（跳到极限高度）→ R/2", Math.round(jumpReach(H, H, R) * 1e6) / 1e6, R / 2);
  check(
    "Δh = −H（往下跳一个身位）→ ≈ 1.2071·R",
    Math.round((jumpReach(-H, H, R) / R) * 1e4) / 1e4,
    Math.round((0.5 * (1 + Math.SQRT2)) * 1e4) / 1e4,
  );
  check("Δh > H（高差超能力）→ 不可达 0", jumpReach(H + 0.01, H, R), 0);
  // 单调递减：逐点严格下降。
  let mono = true;
  let prev = Infinity;
  for (let dh = -2; dh <= H; dh += 0.1) {
    const r = jumpReach(dh, H, R);
    if (!(r < prev)) mono = false;
    prev = r;
  }
  check("单调递减（Δh 越大跳得越近）", mono, true);
  // 不会跳的主体（H = 0）恒 0。
  check("H = 0（不会跳）→ 恒 0", jumpReach(0, 0, R), 0);
  // 落差越大摔得越远：Δh = −0.9 的 reach 必须大于 Δh = −0.3 的。
  check("落差越大摔得越远", jumpReach(-H, H, R) > jumpReach(-0.3, H, R), true);
}

console.log("\n[21] 三种垂直弧线的形状（parabola / fall / climb）");
{
  // parabola：顶点在 s=0.5，高度 = groundAtStart + apex。
  const para = { mode: "parabola" as const, apex: 0.9 };
  check("parabola：起步 s=0 → 地面", arcHeightAt(para, 0, 0, 0.9), 0);
  check("parabola：顶点 s=0.5 → ground + apex", arcHeightAt(para, 0.5, 0, 0.9), 0.9);
  check("parabola：落地 s=1 → 地面", arcHeightAt(para, 1, 0, 0.9), 0);
  check("parabola：对称（s=0.25 与 s=0.75 同高）", arcHeightAt(para, 0.25, 0, 0.9) === arcHeightAt(para, 0.75, 0, 0.9), true);

  // fall：s² 加速下坠 —— s=0.5 只走完 1/4 的落差（不是线性的一半）。
  const fall = { mode: "fall" as const };
  check("fall：s=0 → 起跳面", arcHeightAt(fall, 0, 3, 0), 3);
  check("fall：s=1 → 落点面", arcHeightAt(fall, 1, 3, 0), 0);
  check("fall：s=0.5 → 1/4 落差（加速感，非线性）", arcHeightAt(fall, 0.5, 3, 0), 2.25);
  // 加速：前半段下降量 < 后半段下降量。
  check(
    "fall：后半段降得更多（加速）",
    arcHeightAt(fall, 0.5, 3, 0) - arcHeightAt(fall, 1, 3, 0) >
      arcHeightAt(fall, 0, 3, 0) - arcHeightAt(fall, 0.5, 3, 0),
    true,
  );

  // climb：L 形折线 —— 两端水平，中段竖直。
  const climb = { mode: "climb" as const };
  check("climb：s=0 还在起始面", arcHeightAt(climb, 0, 0, 1.6), 0);
  check("climb：s=0.2 仍水平（竖直段前）", arcHeightAt(climb, 0.2, 0, 1.6), 0);
  check("climb：s=0.8 已上到落点面", arcHeightAt(climb, 0.8, 0, 1.6), 1.6);
  check("climb：中点约在竖直段中（smoothstep 0.5）", Math.round(arcHeightAt(climb, 0.5, 0, 1.6) * 1e6) / 1e6, 0.8);
  check("climb：单调不降", arcHeightAt(climb, 0.45, 0, 1.6) <= arcHeightAt(climb, 0.55, 0, 1.6), true);

  // arcAtU：整条路径里程映射（区间缺省 0..1）。
  check("arcAtU：u=0.5 落到弧顶", arcAtU(para, 0.5, 0, 0.9), 0.9);
  check("arcAtU：区间 [0,0.5] 内 u=0.25 → s=0.5 顶点", arcAtU({ ...para, from: 0, to: 0.5 }, 0.25, 0, 0.9), 0.9);
  // arcIsFlat：
  check("arcIsFlat：apex=0 的抛物线算平", arcIsFlat({ mode: "parabola", apex: 0 }, 0, 0), true);
  check("arcIsFlat：起落同高的 fall 算平", arcIsFlat({ mode: "fall" }, 2, 2), true);
  check("arcIsFlat：有顶高的抛物线不算平", arcIsFlat(para, 0, 0.9), false);
  // 竖直速度符号：上升为正、下降为负。
  check("parabola：前半段竖直速度 > 0", arcVerticalSpeed(para, 0.25, 0, 0.9) > 0, true);
  check("parabola：后半段竖直速度 < 0", arcVerticalSpeed(para, 0.75, 0, 0.9) < 0, true);
}

console.log("\n[22] 校验三条 + 落地 / 轨迹 / 助跑 + planar 退化");
{
  // 注意：locomotionOf 在 planar 下会整体退化成 PLANAR_LOCOMOTION（maxStep 0、不会跳），
  // 所以这里必须建 **terrain** 场景才能拿到人 / 车的真实能力表。§17 踩过同一个坑。
  const humanObj = actor("A", 0, 0);
  const vehicleObj = { ...actor("V", 0, 0), category: "vehicle" as const };
  const human = locomotionOf(scene([humanObj], "terrain"), humanObj);
  const vehicle = locomotionOf(scene([vehicleObj], "terrain"), vehicleObj);
  // ③ 校验三条（docs/3d/02 §4）：
  // 弧顶低于落点 → 自动抬到 Δh，并报 issue。
  const low = checkJumpArc({ dh: 0.6, dx: 1.0, apex: 0.3, loco: human });
  check("校验①：弧顶 0.3 < 落点 0.6 → 报 apex-below-landing", low.issues.some((i) => i.code === "apex-below-landing"), true);
  check("校验①：并自动把顶点抬到 Δh", low.apex, 0.6);
  // 顶点超能力 → apex-over-capability（不可自动修正）。
  const over = checkJumpArc({ dh: 0.6, dx: 1.0, apex: 3.0, loco: human });
  check("校验②：顶点 3.0 > H 0.9 → 报 apex-over-capability", over.issues.some((i) => i.code === "apex-over-capability"), true);
  // 跨度超包络：Δh=0 时 reach = R = 2.5，dx=3.0 跳不过去。
  const far = checkJumpArc({ dh: 0, dx: 3.0, apex: 0.9, loco: human });
  check("校验③：跨度 3.0 > 包络 2.5 → 报 span-too-far", far.issues.some((i) => i.code === "span-too-far"), true);
  // 全部合法 → ok。
  const good = checkJumpArc({ dh: 0.3, dx: 1.5, apex: 0.6, loco: human });
  check("三条全过 → ok", good.ok, true);
  check("三条全过 → 无 issue", good.issues.length, 0);

  // 助跑缩放：站着跳只有一半 —— speedRatio 0 → reach ×0.5。
  const idle = checkJumpArc({ dh: 0, dx: 2.0, apex: 0.9, loco: human, speedRatio: 0 });
  check("助跑：无速度 → 有效跳远减半（1.25）", Math.round(idle.reach * 1e6) / 1e6, 1.25);
  check("助跑：无速度 → 跨 2.0m 跳不过去", idle.issues.some((i) => i.code === "span-too-far"), true);
  check("助跑：无速度 → 报 needsRunup", idle.needsRunup, true);
  check("助跑：全速 → needsRunup false", checkJumpArc({ dh: 0, dx: 2.0, apex: 0.9, loco: human, speedRatio: 1 }).needsRunup, false);
  check("speedScale：0 → 0.5", speedScale(0), 0.5);
  check("speedScale：1 → 1", speedScale(1), 1);
  check("speedScale：夹取越界", speedScale(5), 1);

  // 分档判定（阈值挂在主体上）。
  check("classifyGap：0 → flat", classifyGap(0, human), "flat");
  check("classifyGap：+0.3（≤ maxStep）→ step", classifyGap(0.3, human), "step");
  check("classifyGap：+0.6（> step，≤ H）→ jump", classifyGap(0.6, human), "jump");
  check("classifyGap：+1.2（> H，≤ climb 1.6）→ climb", classifyGap(1.2, human), "climb");
  check("classifyGap：+3.0（超全部）→ blocked", classifyGap(3.0, human), "blocked");
  check("classifyGap：−0.3（≤ step）→ step", classifyGap(-0.3, human), "step");
  check("classifyGap：−1.5（在 dropLimit 1.9 内）→ drop", classifyGap(-1.5, human), "drop");
  check("classifyGap：0.3 台阶对人 step", classifyGap(0.3, human), "step");
  check("classifyGap：0.3 台阶对车 blocked（车 maxStep 0.15）", classifyGap(0.3, vehicle), "blocked");
  check("dropLimit：车 = maxStep（不会跳）", dropLimit(vehicle), vehicle.maxStep);

  // 攀爬校验：因为盒的侧面永远竖直，只要有盒就给抓手。
  check("攀爬：1.2m 贴墙 → 无 issue", checkClimb(1.2, 0.3, true, human).length, 0);
  check("攀爬：2.0m 超能力 → 报错", checkClimb(2.0, 0.3, true, human).length > 0, true);
  check("攀爬：坡道无抓手 → 报错", checkClimb(1.2, 0.3, false, human).some((i) => i.code === "hits-geometry"), true);
  check("攀爬：不会爬的主体 → 报错", checkClimb(1.2, 0.3, true, vehicle).length > 0, true);

  // 轨迹相交（§7a）：跳过一堵 0.5m 高、位于路径中点的墙，但弧顶只有 0.4 → 撞墙。
  const wall = box("WALL", 0, 0, 1, 0.4, 0.5); // 位于 (0,0)，高 0.5
  const moveA = actor("A", -2, 0);
  const st1 = sceneWith([moveA, wall], [
    seg("S1", "A", [-2, 0], [2, 0], { arc: { mode: "parabola", apex: 0.4 } }),
  ], "terrain");
  const pathAt = (s: number) => ({ x: -2 + 4 * s, z: 0 });
  const hitLow = sampleArcHits(st1, "A", pathAt, (s) => arcHeightAt({ mode: "parabola", apex: 0.4 }, s, 0, 0.5));
  check("轨迹相交：弧顶 0.4 撞上 0.5m 墙", hitLow?.object.id, "WALL");
  // 抬高到 0.9 就掠过去了。
  const hitHigh = sampleArcHits(st1, "A", pathAt, (s) => arcHeightAt({ mode: "parabola", apex: 0.9 }, s, 0, 0.5));
  check("轨迹相交：弧顶 0.9 从墙顶掠过", hitHigh, null);

  // 落点站得住（§7b）：终点处有个 1m 平台 → 站到 1。
  const plat = box("P", 2, 0, 2, 2, 1);
  const st2 = sceneWith([actor("A", -2, 0), plat], [seg("S2", "A", [-2, 0], [2, 0])], "terrain");
  check("落点站得住：终点在 1m 平台上 → 1", standingAt(st2, "A", 2, 0), 1);
  check("落点站得住：终点在空地 → 基准面 0", standingAt(st2, "A", -2, 0), 0);

  // runup 提前量：起跳点应早于边缘、落点应晚于边缘。
  check("runupMarginU：总里程 4m → 0.25/4", runupMarginU(4), 0.0625);
  check("runupMarginU：总里程 0 → 0（防除零）", runupMarginU(0), 0);
  const adj = runupAdjusted({ mode: "parabola", apex: 0.9, from: 0, to: 1 }, 0.1);
  check("runup：起跳点内收（from > 0）", adj.from > 0, true);
  check("runup：落点内收（to < 1）", adj.to < 1, true);

  // planar 退化：段有弧线，但 planar 且未标 arcAlways → 弧线不生效，高度回到地面派生。
  const planarArc = { ...seg("S3", "A", [-2, 0], [2, 0], { arc: { mode: "parabola", apex: 0.9 } }) };
  const stPlanar = sceneWith([actor("A", -2, 0)], [planarArc], "planar");
  check("planar：arc 未生效（arcActive false）", arcActive(stPlanar, planarArc), false);
  check("planar：高度仍由地面派生 → 0", pathHeightAt(stPlanar, actor("A", -2, 0), 0, 0, 0.5), 0);
  // arcAlways 显式打开 → 生效。
  const planarAlways = { ...seg("S4", "A", [-2, 0], [2, 0], { arc: { mode: "parabola", apex: 0.9 }, arcAlways: true }) };
  const stAlways = sceneWith([actor("A", -2, 0)], [planarAlways], "planar");
  check("planar + arcAlways：弧线生效（arcActive true）", arcActive(stAlways, planarAlways), true);
  check(
    "planar + arcAlways：中点高度 = 0.9",
    Math.round(pathHeightAt(stAlways, actor("A", -2, 0), 0, 0, 0.5) * 1e6) / 1e6,
    0.9,
  );

  // terrain + 弧线：pathHeightAt 走弧线（跳跃中的人真的离地了）。
  const jumpSeg = seg("S5", "A", [-2, 0], [2, 0], { arc: { mode: "parabola", apex: 0.9 } });
  const stJump = sceneWith([actor("A", -2, 0)], [jumpSeg], "terrain");
  check("terrain + 弧线：起跳瞬间在地面", pathHeightAt(stJump, actor("A", -2, 0), -2, 0, 0), 0);
  check("terrain + 弧线：中段离地到 0.9", Math.round(pathHeightAt(stJump, actor("A", -2, 0), 0, 0, 0.5) * 1e6) / 1e6, 0.9);
  check("terrain + 弧线：落地回到地面", Math.round(pathHeightAt(stJump, actor("A", -2, 0), 2, 0, 1) * 1e6) / 1e6, 0);
  // 无弧线的 terrain 段：仍是瞬时对齐（老行为）。
  const plainSeg = seg("S6", "A", [-2, 0], [2, 0]);
  const stPlain = sceneWith([actor("A", -2, 0)], [plainSeg], "terrain");
  check("terrain 无弧线：仍走地面派生（老路径）", pathHeightAt(stPlain, actor("A", -2, 0), 0, 0, 0.5), 0);

  // JUMP_EASE 是准线性（u=0 处有速度）—— 与默认 cubic-bezier(0,0,1,1) 的零斜率对比。
  check("JUMP_EASE 首控制点 y 不为 0（起跳有水平速度）", JUMP_EASE[1] > 0, true);
  // segmentProgressAt：线性缓动 + 时间中点 → 0.5。
  check("segmentProgressAt：线性中点 = 0.5", Math.round(segmentProgressAt(plainSeg, 0.5) * 1e6) / 1e6, 0.5);
}

// ════════════════════════════════════════════════════════════════════════════
// §23 堆叠传播（拖动传播 / 失支撑即落）—— engine/stack.ts 的回归守卫
// ────────────────────────────────────────────────────────────────────────────
// 用户报的 bug：「堆叠后移动最下层，上层没跟着动，悬空也没落下」。
// 根因：moveObject 只改被拖的那一个对象 → 上层 (x,z)/baseY 都留在原地，
// 违反 INV-3D-04（baseY 必须等于下方支撑面顶面）。
// 本节覆盖：① 链检测 ② 拖动传播（相对偏移不变）③ 失支撑即落 ④ planar 无堆叠。
{
  // 三层塔：A(底) B(中) C(顶)，逐层相切叠起来。
  const A = box("A", 0, 0, 2, 2, 1, 0); // [0,1]
  const B = box("B", 0, 0, 2, 2, 1, 1); // [1,2]
  const C = box("C", 0, 0, 2, 2, 1, 2); // [2,3]
  const tower = scene([A, B, C], "terrain");

  // ① 链检测：相切 + 水平重叠 = 堆叠（INV-3D-05）。
  check("§23 相切 → restsOn 成立", restsOn(B, A), true);
  check("§23 相切 → restsOn 反向不成立", restsOn(A, B), false);
  check("§23 悬空 0.5 → 不构成堆叠", restsOn(box("X", 0, 0, 2, 2, 1, 1.5), A), false);
  check("§23 水平不重叠 → 不构成堆叠", restsOn(box("Y", 9, 0, 2, 2, 1, 1), A), false);
  check("§23 agent 之间不构成堆叠", restsOn(actor("H1", 0, 0, 1), actor("H2", 0, 0, 2.8)), false);
  check("§23 直接上层只有 B（不含 C）", objectsOnTop(tower, "A").map((o) => o.id), ["B"]);
  check("§23 链：根在前，自下而上 A→B→C", stackChain(tower, "A").map((o) => o.id), ["A", "B", "C"]);
  check("§23 从中间取链：B→C（不含 A）", stackChain(tower, "B").map((o) => o.id), ["B", "C"]);
  check("§23 塔顶无上层", stackChain(tower, "C").map((o) => o.id), ["C"]);

  // ② 拖动传播：平移整条链，层间相对偏移不变。
  const shifted = translateStack(tower, "A", 5, -3);
  const sA = shifted.find((o) => o.id === "A") as DirectorObject;
  const sB = shifted.find((o) => o.id === "B") as DirectorObject;
  const sC = shifted.find((o) => o.id === "C") as DirectorObject;
  check("§23 平移：上层 B 跟随（同一偏移）", [sB.x, sB.z], [5, -3]);
  check("§23 平移：上层 C 也跟随", [sC.x, sC.z], [5, -3]);
  check("§23 平移：baseY 不动（相对高度不变）", [sB.baseY, sC.baseY], [1, 2]);
  check("§23 平移：链仍在同一格 → 仍互相压着", restsOn(sB, sA), true);
  // 刚性平移后塔是完整的 → settleStack 不该改动它（各层仍被下层接住）。
  const settledAfterMove = settleStack({ ...tower, objects: shifted }, ["A", "B", "C"]);
  check(
    "§23 塔整体平移后保持完整（层间相对高度不变）",
    settledAfterMove.map((o) => o.baseY ?? 0),
    [0, 1, 2],
  );
  check(
    "§23 刚性平移：settleStack 零改动（引用相等）",
    settledAfterMove === shifted,
    true,
  );

  // ③ 失支撑即落（本 bug 的核心）：底座被"抽走"，上面的层必须重新落。
  //    模拟 removeAsset 的效果：删掉 A，再对 B/C 跑 settleStack。
  const withoutA = { ...tower, objects: [B, C] };
  const dropped = settleStack(withoutA, ["B", "C"]);
  check("§23 删底座：中层 B 落到基准面 0", (dropped.find((o) => o.id === "B") as DirectorObject).baseY, 0);
  check("§23 删底座：顶层 C 也随之落到 B 之上（=1）", (dropped.find((o) => o.id === "C") as DirectorObject).baseY, 1);
  check("§23 删底座：落完后 B、C 仍相切", restsOn(
    dropped.find((o) => o.id === "C") as DirectorObject,
    dropped.find((o) => o.id === "B") as DirectorObject,
  ), true);

  // ③b 只抽走中层：顶层 C 应越过 B 落到 A 上（=1），而不是停在 2。
  const skipB = { ...tower, objects: [A, C] };
  const regrounded = settleStack(skipB, ["C"]);
  check("§23 抽走中层：顶层 C 越过空洞落到 A 顶面", (regrounded.find((o) => o.id === "C") as DirectorObject).baseY, 1);

  // ③c 整塔移到 1m 平台上 —— 这条走的是 moveObject 的真实语义：
  //     ① 根部 placeObject 定新层高（这里 = 平台顶面 1）
  //     ② 上层按同一 Δy 同步抬升（不只是水平平移！否则上层嵌进根部 = 塔被压扁）
  //     ③ 最后 settleStack 兜底（只"掉"不"抬"）。
  const plateau = box("PLT", 8, 0, 4, 4, 1, 0);
  const withPlateau = [...tower.objects, plateau];
  const rootPlaced = placeObject({ ...tower, objects: withPlateau }, "A", 8, 0);
  check("§23 整塔搬到 1m 平台上：根部被抬到 1", rootPlaced.baseY, 1);
  const rootDY = (rootPlaced.baseY ?? 0) - (A.baseY ?? 0); // 0 → 1
  const lifted = translateStack({ ...tower, objects: withPlateau }, "A", 8, 0).map((o) => {
    if (o.id === "A") return { ...o, baseY: rootPlaced.baseY as number };
    if (o.id === "B" || o.id === "C") return { ...o, baseY: (o.baseY ?? 0) + rootDY };
    return o;
  });
  const liftedSettled = settleStack({ ...tower, objects: lifted }, ["A", "B", "C"]);
  check(
    "§23 整塔搬到平台：三层 = 1/2/3（根部抬高、上层同步抬 Δy）",
    ["A", "B", "C"].map((cid) => (liftedSettled.find((o) => o.id === cid) as DirectorObject).baseY),
    [1, 2, 3],
  );
  check(
    "§23 搬到平台后仍是完整塔（逐层相切）",
    [
      restsOn(
        liftedSettled.find((o) => o.id === "B") as DirectorObject,
        liftedSettled.find((o) => o.id === "A") as DirectorObject,
      ),
      restsOn(
        liftedSettled.find((o) => o.id === "C") as DirectorObject,
        liftedSettled.find((o) => o.id === "B") as DirectorObject,
      ),
    ],
    [true, true],
  );

  // ③d 桥/拱的"下探量"必须保留：bottom 是绝对高度，改 baseY 时要同步平移 bottom，
  //    否则净空被静默改写。落回地面后：baseY = 0.65、bottom = 0（下探量仍是 0.65）。
  //    （box() 不带 bottom，用展开补上；baseY 2.4、bottom 1.75 → 下探 0.65。）
  const arch: DirectorObject = { ...box("ARC", 0, 0, 2, 2, 1), baseY: 2.4, bottom: 1.75 };
  const archScene = scene([arch], "terrain");
  const archArc = archScene.objects[0];
  check("§23 拱洞：初始下探量 0.65", [
    Math.round(((archArc.baseY as number) - (archArc.bottom as number)) * 1e6) / 1e6,
  ], [0.65]);
  const archArc2 = settleStack(archScene, ["ARC"])[0];
  check("§23 拱洞：落回地面后 baseY = 0.65", Math.round((archArc2.baseY as number) * 1e6) / 1e6, 0.65);
  check("§23 拱洞：落回地面后 bottom = 0（实体贴地）", archArc2.bottom, 0);
  check(
    "§23 拱洞：下探量不变量保持（0.65）",
    Math.round(((archArc2.baseY as number) - (archArc2.bottom as number)) * 1e6) / 1e6,
    0.65,
  );

  // ③e 拱洞叠到 1m 平台上 → baseY = 1.65、bottom = 1（下探量仍 0.65）。
  const platform = box("PLAT", 0, 0, 2, 2, 1, 0);
  const archOnPlate = settleStack({ ...archScene, objects: [arch, platform] }, ["ARC"]);
  const archUp = archOnPlate.find((o) => o.id === "ARC") as DirectorObject;
  check("§23 拱洞在平台上：baseY = 1.65", archUp.baseY, 1.65);
  check("§23 拱洞在平台上：bottom = 1", archUp.bottom, 1);

  // ④ planar 无堆叠：几何上仍"相切"，但 planar 世界不该产生堆叠语义。
  //    守卫方式与 moveObject 一致 —— 只有 terrain 下才跑 settle/传播。
  //    （planar 下 baseY 恒 undefined，所以"有没有 baseY"就是开关。）
  const planarTower = scene([box("A", 0, 0, 2, 2, 1), box("B", 0, 0, 2, 2, 1)], "planar");
  check(
    "§23 planar：对象不写 baseY（堆叠语义不生效）",
    planarTower.objects.map((o) => o.baseY),
    [undefined, undefined],
  );

  // ⑤ 空链 / 不存在的 id 是安全的 no-op（面板删对象时会走到）。
  check("§23 空链 settle → 原样", settleStack(tower, []), tower.objects);
  check("§23 不存在的 id → 空链", stackChain(tower, "GHOST"), []);
}

// ════════════════════════════════════════════════════════════════════════════
// §24 阵列落点（engine/array.ts）—— Phase 8 的"批量复制"
// ────────────────────────────────────────────────────────────────────────────
// engine/array.ts 只算落点，是纯函数；真正的落地由 store 逐个 placeObject 完成。
// 本节钉死落点几何：直线 / 网格 / 台阶 / 环绕的量级关系、
// alongRotation 的方向语义、以及"第 0 个槽位 = 源位置"这条契约。
{
  const src = box("S", 2, -1, 1, 1, 1); // 任意非零起点，顺带验"不是从原点起算"

  // ① line：第 0 个槽位必须与源重合（store 靠 slice(1) 丢掉它）。
  const line = arraySlots(src, { kind: "line", count: 4, spacing: 1.5 });
  check("§24 line：份数 = count", line.length, 4);
  check("§24 line：第 0 槽 = 源位置", [line[0].x, line[0].z], [2, -1]);
  check("§24 line：沿世界 X 逐格推进", line.map((s) => s.x), [2, 3.5, 5, 6.5]);
  check("§24 line：Z 不变", line.map((s) => s.z), [-1, -1, -1, -1]);
  check("§24 line：不给 baseY（交给 placeObject 反查）", line.map((s) => s.baseY), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);

  // ② alongRotation：旋转 90° 时"前进方向"应与 +Z 平行（不是继续沿 +X）。
  const turned = { ...src, rotation: 90 };
  const lineTurned = arraySlots(turned, { kind: "line", count: 3, spacing: 2, alongRotation: true });
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  check("§24 alongRotation：方向转到 +Z", lineTurned.map((s) => [round(s.x), round(s.z)]), [
    [2, -1],
    [2, 1],
    [2, 3],
  ]);
  // 没开 alongRotation 时，即使对象有 rotation 也必须沿世界 X —— 两者互相独立。
  const turnedOff = arraySlots(turned, { kind: "line", count: 2, spacing: 2 });
  check("§24 未开 alongRotation：rotation 不影响排布", [turnedOff[1].x, turnedOff[1].z], [4, -1]);

  // ③ grid：行沿法线（Y 轴旋转后的 -dir.z/+dir.x），列沿前进方向。
  const grid = arraySlots(src, { kind: "grid", rows: 2, cols: 3, spacing: 2 });
  check("§24 grid：总数 = rows×cols", grid.length, 6);
  check("§24 grid：首格 = 源位置", [grid[0].x, grid[0].z], [2, -1]);
  check("§24 grid：第二列在 +X", [grid[1].x, grid[1].z], [4, -1]);
  check("§24 grid：换行到 +Z（法线方向）", [grid[3].x, grid[3].z], [2, 1]);

  // ④ stair：标高按 i×rise 抬升，且水平只走 run。这是"作者的显式意图"，必须真给 baseY。
  const stair = arraySlots(src, { kind: "stair", count: 4, rise: 0.15, run: 0.3 });
  check("§24 stair：baseY 逐级抬高", stair.map((s) => round(s.baseY ?? 0)), [0, 0.15, 0.3, 0.45]);
  check("§24 stair：水平每级进深 run", stair.map((s) => round(s.x)), [2, 2.3, 2.6, 2.9]);
  check("§24 stair：Z 不动", stair.map((s) => s.z), [-1, -1, -1, -1]);
  // 源本身已垫高到 1m 时，台阶从 1 起算（而不是从 0）。
  const raised = arraySlots({ ...src, baseY: 1 }, { kind: "stair", count: 3, rise: 0.2, run: 0.3 });
  check("§24 stair：从源标高起算", raised.map((s) => round(s.baseY ?? 0)), [1, 1.2, 1.4]);

  // ⑤ ring：半径恒定、角度均匀，且第 0 个落在源的方位角上（不跳一下）。
  const ring = arraySlots(src, { kind: "ring", count: 4, radius: 5 });
  const radii = ring.map((s) => round(Math.hypot(s.x, s.z)));
  check("§24 ring：份数 = count", ring.length, 4);
  check("§24 ring：所有点等半径 5", radii, [5, 5, 5, 5]);
  // 相邻夹角 = 90°（4 份绕一圈）。用点积转角度，避开 atan2 的象限噪声。
  const a0 = Math.atan2(ring[0].z, ring[0].x);
  const a1 = Math.atan2(ring[1].z, ring[1].x);
  let turnDeg = ((a1 - a0) * 180) / Math.PI;
  if (turnDeg < 0) turnDeg += 360;
  check("§24 ring：相邻夹角 90°", round(turnDeg), 90);

  // ⑥ arrayCount 与 arraySlots 必须同源 —— UI 预览不能跟实际生成不一致。
  const specs: ArraySpec[] = [
    { kind: "line", count: 5 },
    { kind: "grid", rows: 3, cols: 4 },
    { kind: "ring", count: 7 },
    { kind: "stair", count: 6 },
  ];
  check(
    "§24 arrayCount 与 arraySlots 同源",
    specs.map((spec) => [arrayCount(spec), arraySlots(src, spec).length]),
    [[5, 5], [12, 12], [7, 7], [6, 6]],
  );
  // 病态输入：0 / 负数也要稳（UI 滑杆下限是 2，但手工 JSON 可以更低）。
  check("§24 count=1 → 只有源位置一份", arraySlots(src, { kind: "line", count: 1 }).length, 1);
  check("§24 count=0 → 夹到 1 份（不返回空数组）", arraySlots(src, { kind: "line", count: 0 }).length, 1);

  // ⑦ planar 守卫：非 stair 一律不给 baseY —— 有了 baseY 就会绕过 placeObject 的
  //   "非 terrain 不写 baseY" 那条判据，planar 就不再逐像素不变了。
  const allBaseYUndefined = [
    ...arraySlots(src, { kind: "line", count: 3 }),
    ...arraySlots(src, { kind: "grid", rows: 2, cols: 2 }),
    ...arraySlots(src, { kind: "ring", count: 3 }),
  ].every((s) => s.baseY === undefined);
  check("§24 非 stair 一律不带 baseY（planar 逐像素不变的守卫）", allBaseYUndefined, true);
}

// ════════════════════════════════════════════════════════════════════════════
// §25 列表折叠的树结构（stackParentMap / isStackBottom）
// ────────────────────────────────────────────────────────────────────────────
// ObjectList 靠这套把堆叠链折叠成一行。它是**树**而不是 DAG：一个盒子横跨两块板时
// 只认最高的那块当父节点，否则同一阶段会在列表里出现两次。
{
  const A = box("A", 0, 0, 2, 2, 1, 0); // [0,1]
  const B = box("B", 0, 0, 2, 2, 1, 1); // [1,2]
  const C = box("C", 0, 0, 2, 2, 1, 2); // [2,3]
  const solo = box("SOLO", 20, 0, 1, 1, 1);
  const tower = [A, B, C, solo];

  // ① 三层塔 → B/A、C/B 两条父子关系；塔底与孤立对象不出现在 map 的 key 里。
  const parents = stackParentMap(tower);
  check("§25 父子关系：B 压在 A 上", parents.get("B"), "A");
  check("§25 父子关系：C 压在 B 上", parents.get("C"), "B");
  check("§25 塔底不出现在 map 的 key 里", parents.get("A"), undefined);
  check("§25 孤立对象不进 map", parents.has("SOLO"), false);
  check("§25 map 里只有堆叠着的那两条关系", parents.size, 2);

  // ② agent 不是几何的一部分：站在同一位置的演员不参与堆叠树。
  const withActor = [...tower, actor("H", 0, 0, 1)];
  check("§25 agent 不参与堆叠树", stackParentMap(withActor).size, 2);

  // ③ isStackBottom：只有塔底为真，这条决定"拖动时谁带着谁"。
  check("§25 塔底 A：是底", isStackBottom(tower, "A"), true);
  check("§25 中层 B：不为底", isStackBottom(tower, "B"), false);
  check("§25 顶层 C：不为底", isStackBottom(tower, "C"), false);
  check("§25 孤立对象：同样算底", isStackBottom(tower, "SOLO"), true);
  check("§25 不在场景里的 id：false", isStackBottom(tower, "GHOST"), false);

  // ④ 多条塔并存时互不干扰 —— 树必须能一次装下几棵。
  const otherBase = box("X", 50, 0, 2, 2, 1, 0);
  const otherTop = box("Y", 50, 0, 2, 2, 1, 1);
  const twoTowers = stackParentMap([...tower, otherBase, otherTop]);
  check("§25 两座塔：各自成链", [twoTowers.get("Y"), twoTowers.get("B")], ["X", "A"]);
  check("§25 两座塔：互不粘连", twoTowers.get("X"), undefined);

  // ⑤ 一个盒子横跨两块等高板：只认一个父（保持树的形状），不能出现在列表两处。
  const slabL = box("L", -1, 0, 2, 2, 1, 0);
  const slabR = box("R", 1, 0, 2, 2, 1, 0);
  const spanning = box("TOP", 0, 0, 4, 2, 1, 1); // 底面 1 = 两块板的顶面
  const crossSpan = stackParentMap([slabL, slabR, spanning]);
  check("§25 横跨两块板：指派了父", crossSpan.get("TOP") !== undefined, true);
  check("§25 横跨两块板：父是两者之一（Tree 而非 DAG）", ["L", "R"].includes(crossSpan.get("TOP") ?? ""), true);
}

// §26 可达性分档（engine/reach.ts）—— Phase 5 的判定核心
// ────────────────────────────────────────────────────────────────────────────
// §27 之前先用探针把真实取值打出来，据此写断言（避免把"期望写错"当成代码 bug）。
{
  const flat = sceneWith([actor("H", -4, 0)], [seg("s1", "H", [-4, 0], [6, 0])], "terrain");
  const crateScene = sceneWith(
    [actor("H", -4, 0), box("C", 2, 0, 1, 1, 0.6)],
    [seg("s1", "H", [-4, 0], [6, 0])],
    "terrain",
  );
  const dropScene = sceneWith(
    [actor("H", 0, 0, 1.5), box("P", 0, 0, 4, 4, 1.5)],
    [seg("s1", "H", [0, 0], [10, 0])],
    "terrain",
  );
  const tallScene = sceneWith(
    [actor("H", 0, 0, 3), box("P", 0, 0, 4, 4, 3)],
    [seg("s1", "H", [0, 0], [10, 0])],
    "terrain",
  );
  const bridgeScene = sceneWith(
    [actor("H", -4, 0), box("BR", 0, 0, 4, 4, 0.6, 2.4)],
    [seg("s1", "H", [-4, 0], [6, 0])],
    "terrain",
  );
  const planarScene = sceneWith(
    [actor("H", 0, 0, 3), box("P", 0, 0, 4, 4, 3)],
    [seg("s1", "H", [0, 0], [10, 0])],
    "planar",
  );
  const tiers = (st: DirectorState) => segmentSpans(st, st.segments[0]).map((s) => s.tier);
  const loco = locomotionOf(flat, actor("H", 0, 0));

  // ① 平地：整条路线就是一段"可走"，不冒出任何新东西。
  const flatSpans = segmentSpans(flat, flat.segments[0]);
  check("§26 平地：只有一段", flatSpans.length, 1);
  check("§26 平地：档 0", flatSpans[0].tier, 0);
  check("§26 平地：折线点数 = 采样点数（没被重采样）", flatSpans[0].points.length, 17);

  // ② planar / 非 agent：判定不参与，返回空 —— 画布上不会多出任何一条线。
  check("§26 planar：不判定（空数组）", segmentSpans(planarScene, planarScene.segments[0]), []);
  check(
    "§26 非 agent 的段：不判定",
    segmentSpans(
      sceneWith([box("S", 0, 0, 2, 2, 3)], [seg("s1", "S", [0, 0], [10, 0])], "terrain"),
      seg("s1", "S", [0, 0], [10, 0]),
    ),
    [],
  );

  // ③ 0.6m 箱子：跳上去（档 1）→ 站在顶上（档 0）→ 跳下来（档 6）。
  check("§26 0.6m 箱：档位序列", tiers(crateScene), [0, 1, 0, 6, 0]);
  const jumpSpan = segmentSpans(crateScene, crateScene.segments[0])[1];
  check("§26 0.6m 箱：跳跃段 dh = 0.6", round6(jumpSpan.dh), 0.6);
  // 弧顶 = min(Δh + 0.15, H) = 0.75，加抬升 0.13 → 0.88。两端是 0.13。
  const jumpYs = jumpSpan.points.map((p) => round6(p[1]));
  check("§26 跳跃段：中点最高（弓形可见）", Math.max(...jumpYs), 0.88);
  check("§26 跳跃段：两端贴地", [jumpYs[0], jumpYs[jumpYs.length - 1]], [0.13, 0.13]);
  check("§26 跳跃段：重采样成 17 点（否则弓形看不见）", jumpYs.length, 17);
  const dropYs = segmentSpans(crateScene, crateScene.segments[0])[3].points.map((p) => round6(p[1]));
  check(
    "§26 落差段：单调下降（fall 是加速下坠，不反弹）",
    dropYs.every((y, i) => i === 0 || y <= dropYs[i - 1] + 1e-9),
    true,
  );

  // ④ 走下高台：1.5m 是"落差"，3m 是"不可达"（超过 dropLimit = H + 1.0 = 1.9）。
  check("§26 走下 1.5m 台：档 6（落差）", tiers(dropScene), [0, 6, 0]);
  check("§26 走下 3m 台：档 3（不可达）", tiers(tallScene), [0, 3, 0]);

  // ⑤ 桥下穿行**不能**被误判成"要爬 3 米" —— 头顶上方的面不是脚下的面。
  check("§26 桥下穿行：全段可走（不误报）", tiers(bridgeScene), [0]);

  // ⑥ 跨度是第二个判据：跳得上去、但差 3 米一样过不去。
  check("§26 跨度 1.0m ≤ 包络 → 档 1", tierOfGap(0.5, 1.0, loco).tier, 1);
  check("§26 跨度 3.0m > 包络 → 档 3", tierOfGap(0.5, 3.0, loco).tier, 3);
  check("§26 平地不给 reach（没有落差就谈不到跨度）", tierOfGap(0, 2.5, loco).reach, 0);
  // reach(0.5) = R/2·(1+√(1−0.5/0.9)) = 1.25·(1+0.6667) ≈ 2.0833
  check("§26 包络随高差收缩", round6(tierOfGap(0.5, 1.0, loco).reach), 2.083333);

  // ⑦ 预览弧线 = 按下「生成弧线」后真正写进去的那条，所以形状必须对得上。
  check("§26 预览：跳跃 → parabola，apex = Δh + 0.15", previewArc("jump", 0.6, loco), {
    mode: "parabola",
    apex: 0.75,
  });
  check("§26 预览：apex 被夹到跳跃上限 H（跳不上去也要画出来）", previewArc("jump", 1.2, loco), {
    mode: "parabola",
    apex: 0.9,
  });
  check("§26 预览：落差 → fall", previewArc("drop", -1.5, loco), { mode: "fall" });
  check("§26 预览：攀爬 → climb", previewArc("climb", 1.2, loco), { mode: "climb" });
  check("§26 预览：平地不需要弧线", previewArc("flat", 0, loco), null);

  // ⑧ 已有弧线时按**真实弧线**取 y，不按预览 —— 顶点就是作者设的 apex。
  const arced = sceneWith(
    [actor("H", -4, 0), box("C", 2, 0, 1, 1, 0.6)],
    [seg("s1", "H", [-4, 0], [6, 0], { arc: { mode: "parabola", apex: 0.5 } })],
    "terrain",
  );
  const arcYs = segmentSpans(arced, arced.segments[0])[1].points.map((p) => round6(p[1]));
  check("§26 已有弧线：顶点 = 作者设的 apex 0.5 + 抬升", Math.max(...arcYs), 0.63);

  // ⑨ 体检清单：只收档位 > 0 的，并按开始时间排序。
  check("§26 一条段的问题清单：跳跃 + 落差两条", segmentFindings(crateScene, crateScene.segments[0]).length, 2);
  const scanScene = sceneWith(
    [actor("H", 0, 0, 3), box("P", 0, 0, 4, 4, 3)],
    [
      seg("late", "H", [0, 0], [10, 0], { timeStart: 5, timeEnd: 6 }),
      seg("early", "H", [0, 0], [10, 0], { timeStart: 1, timeEnd: 2 }),
    ],
    "terrain",
  );
  const scan = scanReachability(scanScene);
  check("§26 全局体检：两条段各一处", scan.length, 2);
  check("§26 全局体检：按开始时间排序", scan.map((f) => f.segmentId), ["early", "late"]);
  // 往下掉 3m 报的是"太高会摔"（dropLimit = H + 1.0 = 1.9），不是"超过攀爬能力"。
  // 3 档（过不去）除了数字，还必须给出**三条出路** —— 这是影视工具不是仿真器：
  // 文案常量与引擎共用一份，见 docs/3d/00「速度与镜头：世界是舞台，不是地图」。
  check("§26 不可达文案：说人话带数字", scan[0].message, `下落 3.00 米太高，最多 1.90 米${BLOCKED_OPTIONS}`);
  check(
    "§26 不可达文案：给出三条出路（改路由 / 换主体 / 特效段）",
    ["改路由", "换主体", "特效段"].every((word) => scan[0].message.includes(word)),
    true,
  );
  check("§26 落差文案：", reachMessage(6, -1.5, 0.6, 0, loco), "下落 1.50m");
  check(
    "§26 往上不可达文案：点名攀爬能力",
    reachMessage(3, 2.5, 0.3, 0, loco),
    `这里落差 2.50 米，超过攀爬能力 1.60 米${BLOCKED_OPTIONS}`,
  );

  // ⑩ 编队归并：徽标只画在锚点的段上，否则一队 5 人冒出 5 个徽标。
  const squad = {
    ...scene([actor("A1", 0, 0), actor("A2", 1, 0)], "terrain"),
    groups: [
      {
        id: "g1",
        name: "小队",
        color: "#67a7ff",
        members: ["A1", "A2"],
        dynamics: true,
        formation: "column" as const,
        spacing: 1.2,
        noise: 0.3,
      },
    ],
  };
  check("§26 锚点 A1：画徽标", isRouteAnchor(squad, "A1"), true);
  check("§26 队员 A2：不画徽标", isRouteAnchor(squad, "A2"), false);
  check("§26 不在任何队里：画徽标", isRouteAnchor(squad, "OTHER"), true);

  check("§26 worstTier：不可达压过一切", worstTier([0, 1, 6, 2, 3]), 3);
  check("§26 worstTier：全可走 → 0", worstTier([0, 0]), 0);

  // ⑪ 障碍集合的"跳过去"排除（04 §2）—— 可达性 UI 的前提：路径不绕开，
  //    才报得出"需跳跃"。这是 Phase 4 弧线落地后补上的那一行。
  const jumpable = box("J", 2, 0, 1, 1, 0.6); // 0.6m ≤ H=0.9，对角线 1.41 ≤ R=2.5
  const tooHigh = box("T", 2, 0, 1, 1, 1.2); // 1.2m > H
  const tooWide = box("W", 2, 0, 4, 4, 0.6); // 对角线 5.66 > R
  const sJumpable = scene([jumpable, actor("H", -4, 0)], "terrain");
  const sTooHigh = scene([tooHigh, actor("H", -4, 0)], "terrain");
  const sTooWide = scene([tooWide, actor("H", -4, 0)], "terrain");
  const sPrefer = scene([{ ...jumpable, prefer: "walk-around" }, actor("H", -4, 0)], "terrain");
  const rectIds = (st: DirectorState) => blockingRects(st, "H", 0, loco).length;
  check("§26 0.6m 小箱：跳得过去 → 不是障碍", rectIds(sJumpable), 0);
  check("§26 1.2m 箱：超过跳跃高度 → 仍是障碍", rectIds(sTooHigh), 1);
  check("§26 0.6m 但 4×4：跨度超包络 → 仍是障碍", rectIds(sTooWide), 1);
  check("§26 prefer walk-around：作者要求绕行 → 恢复为障碍", rectIds(sPrefer), 1);
}

// §27 拖拽即时反馈 + 起跳瞬时速度接线（docs/3d/03 §6 / 02 §13）
// ────────────────────────────────────────────────────────────────────────────
{
  const flat = sceneWith([actor("H", -4, 0)], [seg("s1", "H", [-4, 0], [6, 0])], "terrain");
  const crateScene = sceneWith(
    [actor("H", -4, 0), box("C", 2, 0, 1, 1, 0.6)],
    [seg("s1", "H", [-4, 0], [6, 0])],
    "terrain",
  );
  const tallScene = sceneWith(
    [actor("H", 0, 0, 3), box("P", 0, 0, 4, 4, 3)],
    [seg("s1", "H", [0, 0], [10, 0])],
    "terrain",
  );

  // ① 没问题就是没提示 —— 平地上拖来拖去不该冒出任何红字。
  check("§27 平地拖拽：无提示", dragReachHint(flat, "s1", "end"), null);
  check("§27 不存在的段：无提示", dragReachHint(flat, "GHOST", "end"), null);

  // ② 0.6m 箱：档位 [0,1,0,6,0] → 最严重是"需跳跃"（1 比 6 严重），marker 原样透传。
  const crateHint = dragReachHint(crateScene, "s1", "end");
  check("§27 拖到箱子上：报需跳跃", crateHint?.tier, 1);
  check("§27 拖到箱子上：段 id 正确", crateHint?.segmentId, "s1");
  check("§27 拖到箱子上：marker 原样透传", crateHint?.marker, "end");
  check("§27 拖到箱子上：带位置（挂 tooltip 用）", crateHint?.at.length, 3);

  // ③ 不可达优先于其它一切，且文案与 Inspector / 徽标同源。
  const tallHint = dragReachHint(tallScene, "s1", "start");
  check("§27 拖下 3m 台：报不可达", tallHint?.tier, 3);
  check("§27 拖下 3m 台：文案说人话带数字", tallHint?.message, `下落 3.00 米太高，最多 1.90 米${BLOCKED_OPTIONS}`);

  // ④ 不带 segmentId = 全场景扫描（拖 set 对象时那块一动，所有 agent 的路都可能被改）。
  const scanHint = dragReachHint(
    sceneWith(
      [actor("H", -4, 0), box("C", 2, 0, 1, 1, 0.6), actor("G", -4, 6, 3), box("P", -4, 6, 4, 4, 3)],
      [seg("jump", "H", [-4, 0], [6, 0]), seg("drop", "G", [-4, 6], [10, 6])],
      "terrain",
    ),
    null,
    null,
  );
  check("§27 全场景扫描：挑最严重的那条（不可达）", scanHint?.tier, 3);
  check("§27 全场景扫描：指向出问题的那一段", scanHint?.segmentId, "drop");

  // ⑤ **只报告、绝不干预**：这是 §6 的硬要求（允许放下）。
  //    判定跑完之后，几何必须一字未改 —— 否则"报告"就变成了"偷偷改剧本"。
  const before = JSON.stringify(crateScene.segments);
  dragReachHint(crateScene, "s1", "end");
  dragReachHint(crateScene, null, null);
  check("§27 判定不写回几何（不硬阻止落位）", JSON.stringify(crateScene.segments), before);

  // ⑥ 起跳瞬时速度 = d(弧长)/dt ÷ 跑步速度。线性缓动 + 10m/1s = 10m/s → 满速。
  check("§27 10m/1s 线性：满速", takeoffSpeedRatio(flat, flat.segments[0]), 1);
  // 10m/12.5s = 0.8m/s = 半速 → 恰好是"站着跳只能跳到一半远"的那个 0.5。
  const slow = sceneWith(
    [actor("H", -4, 0)],
    [seg("s1", "H", [-4, 0], [6, 0], { timeEnd: 12.5 })],
    "terrain",
  );
  check("§27 10m/12.5s：半速", round6(takeoffSpeedRatio(slow, slow.segments[0])), 0.5);
  // 零时长段：速度无从谈起，按全速处理 —— 不凭空造一条"没有助跑"的假警告。
  const zero = sceneWith(
    [actor("H", -4, 0)],
    [seg("s1", "H", [-4, 0], [6, 0], { timeStart: 2, timeEnd: 2 })],
    "terrain",
  );
  check("§27 零时长段：按全速（不告警）", takeoffSpeedRatio(zero, zero.segments[0]), 1);

  // ⑦ 02 §5 的那个既有陷阱：默认缓动在 u=0 斜率为 0 → 起跳瞬间水平速度≈0 → 站着跳。
  const easeInOut = sceneWith(
    [actor("H", -4, 0)],
    [seg("s1", "H", [-4, 0], [6, 0], { ease: [0.42, 0, 0.58, 1] })],
    "terrain",
  );
  const stagnant = takeoffSpeedRatio(easeInOut, easeInOut.segments[0]);
  check("§27 ease-in-out 在 u=0：几乎零速（0.6 以下）", stagnant < 0.6, true);
  // 端到端：把它接进 checkJumpArc，应当触发"没有助跑"，且有效跳远被砍到 ~50%。
  const loco = locomotionOf(flat, actor("H", 0, 0));
  const wired = checkJumpArc({ dh: 0.5, dx: 0.4, apex: 0.65, loco, speedRatio: stagnant });
  check("§27 接线后：报没有助跑", wired.needsRunup, true);
  check("§27 接线后：有效跳远按速度缩放（≈50%）", round6(wired.reach / jumpReachOf(0.5, loco)), round6(speedScale(stagnant)));
  // 反过来：全速时不报助跑，也不缩放。
  const full = checkJumpArc({ dh: 0.5, dx: 0.4, apex: 0.65, loco, speedRatio: 1 });
  check("§27 全速：不报助跑", full.needsRunup, false);
  check("§27 全速：不缩放", round6(full.reach / jumpReachOf(0.5, loco)), 1);
}

/* ================================ 相机（Phase 6） ================================ */

/** 建一台相机。 */
function cam(id: string, targetId: string, extra?: Partial<CameraObject>): CameraObject {
  return {
    id,
    name: id,
    color: "#c792ea",
    targetId,
    framing: "medium",
    view: "eye_level",
    side: "back_3_4",
    lensMm: 50,
    motion: "FOLLOW",
    ...extra,
  };
}

/** 带相机的场景。 */
function camScene(
  objects: DirectorObject[],
  cameras: CameraObject[],
  segments: MoveSegment[] = [],
  worldMode?: "planar" | "terrain",
): DirectorState {
  return { ...sceneWith(objects, segments, worldMode), cameras };
}

console.log("\n[28] 相机体系相对化");
{
  // ① **视角 View = 名义俯仰角**（2026-09-16 语义变更）。
  //    "机位 y = 1.7 / 1.35"那类断言属于**旧语义**（绝对机位高度），正是要换掉的东西，
  //    因此作废；新语义要钉的是：对**任意景别**，机位到注视点的俯仰角 = 该档的名义角
  //    （`VIEW_PITCH_DEG`）。唯一允许的偏差是长焦远景下的仰拍被**地面下限**抬平 ——
  //    物理上做不到更强的仰角（18m 外 −12° 要站到地下 2m），此时只许更平、不许更陡。
  {
    const views: CameraView[] = ["ground", "low", "chest", "eye_level", "high", "overhead"];
    const framings: CameraFraming[] = [
      "extreme_wide",
      "wide",
      "two_shot",
      "medium",
      "close_up",
      "extreme_close_up",
    ];
    const off: string[] = [];
    for (const view of views) {
      const nominal = VIEW_PITCH_DEG[view];
      for (const framing of framings) {
        const s = camScene([actor("H", 0, 0)], [cam("C", "H", { view, framing })]);
        const r = solveCamera(s, "C", 0)!;
        const dxz = Math.hypot(r.position[0] - r.target[0], r.position[2] - r.target[2]);
        // 正 = 机位高于支点（俯拍），与 `VIEW_PITCH_DEG` 同号。
        // 平地站定 ⇒ 支点 = 锚线(0) + CAMERA_EYE_REF。
        const pitch = (Math.atan2(r.position[1] - CAMERA_EYE_REF, dxz) * 180) / Math.PI;
        if (pitch < nominal - 1) off.push(`${view}/${framing} 过陡 ${pitch.toFixed(1)}°`);
        // 名义角 ≥ 0（平视 / 俯拍）时不许被抬平 —— 抬平只可能发生在仰拍档。
        if (nominal >= 0 && pitch > nominal + 1) off.push(`${view}/${framing} 过平 ${pitch.toFixed(1)}°`);
      }
    }
    check("§28 视角 = 名义俯仰角（任意景别误差 < 1°，仰拍被地面抬平除外）", off, []);

    // 地面下限：长焦远景的 `ground` 按角度推算要站到地下，必须被抬到地面之上（0.05m）。
    const groundWide = camScene(
      [actor("H", 0, 0)],
      [cam("C", "H", { view: "ground", framing: "extreme_wide" })],
    );
    check(
      "§28 长焦远景仰拍不钻地下（抬到地面下限）",
      round6(solveCamera(groundWide, "C", 0)!.position[1]),
      0.05,
    );

    check(
      "§28 planar：注视点 y = 1.55（演员眼高）",
      round6(solveCamera(camScene([actor("H", 0, 0)], [cam("C", "H")]), "C", 0)!.target[1]),
      1.55,
    );
  }

  // ② 非演员目标：注视点 = 脚下 + 1（原值 1 的相对版本）。
  {
    const s = camScene([box("P", 0, 0, 2, 2, 1)], [cam("C", "P")]);
    check("§28 planar 道具：注视点 y = 1", round6(solveCamera(s, "C", 0)!.target[1]), 1);
  }

  // ③ 演员站在 3m 平台上（terrain）→ 机位与注视点一起抬 3m。
  {
    const s = camScene(
      [box("P", 0, 0, 4, 4, 3, 0), actor("H", 0, 0, 3)],
      [cam("C", "H")],
      [],
      "terrain",
    );
    const r = solveCamera(s, "C", 0)!;
    // eye_level 的名义俯仰角是 0 ⇒ 机位高度 = 锚线 + 眼平参照 = 3 + 1.7（与旧设计逐值相同）。
    check("§28 站在 3m 平台：eye_level → 机位 y = 3 + 1.7", round6(r.position[1]), 4.7);
    check("§28 站在 3m 平台：注视点 y = 3 + 1.55", round6(r.target[1]), 4.55);
  }

  // ④ 景别距离的语义：机位到**支点**（锚线 + 眼平参照）的距离**恒等于景别距离** ——
  //    于是"选 High 不会顺带把主体缩小"。旧做法只给高度、水平距离固定，实际距离会随视角变大。
  {
    const s = camScene(
      [box("P", 0, 0, 4, 4, 3, 0), actor("H", 0, 0, 3)],
      [cam("C", "H", { view: "high" })],
      [],
      "terrain",
    );
    const r = solveCamera(s, "C", 0)!;
    // 支点在 3m 平台上 = 3 + CAMERA_EYE_REF（**不是**注视点的 3 + 1.55）。
    const dist = Math.hypot(
      r.position[0] - r.target[0],
      r.position[1] - (3 + CAMERA_EYE_REF),
      r.position[2] - r.target[2],
    );
    check("§28 机位到支点距离 = 景别距离（medium 6m）", round6(dist), 6);
  }

  // ⑤ POV 眼高相对化。
  {
    const s = camScene(
      [box("P", 0, 0, 4, 4, 3, 0), actor("H", 0, 0, 3)],
      [cam("C", "H", { targetType: "POV" })],
      [],
      "terrain",
    );
    const r = solveCamera(s, "C", 0)!;
    check("§28 POV 在 3m 平台：眼高 = 3 + 1.55", round6(r.position[1]), 4.55);
  }

  // ⑥ 平地（terrain 但地面 0）与 planar **同值** —— 证明"相对化"在无高差时是恒等变换。
  {
    const t = camScene([actor("H", 0, 0)], [cam("C", "H")], [], "terrain");
    const p = camScene([actor("H", 0, 0)], [cam("C", "H")]);
    check(
      "§28 terrain 平地 == planar（恒等）",
      round6(solveCamera(t, "C", 0)!.position[1]),
      round6(solveCamera(p, "C", 0)!.position[1]),
    );
  }
}

console.log("\n[29] 跟跳防抖（followJumpHeight）");
{
  // 一条"起跳后飞出去"的段：弧线 apex 1.5。
  // 注意 schema 字段是 `mode`（不是 `kind`）—— 写错会被结构化类型静默忽略，
  // 于是段上根本没有弧线、所有断言都退化成平地。这正是 §29 曾经假失败的原因。
  const jumpSeg = seg("s1", "H", [-3, 0], [3, 0], {
    timeEnd: 2,
    arc: { mode: "parabola", apex: 1.5 },
  } as Partial<MoveSegment>);
  const terrain = camScene([actor("H", -3, 0)], [cam("C", "H")], [jumpSeg], "terrain");

  // ① 默认（跟随）：机位跟弧线一起起伏 —— 起跳前低、最高点高。
  const before = solveCamera(terrain, "C", 0)!.position[1];
  const peak = solveCamera(terrain, "C", 1)!.position[1];
  check("§29 默认跟随：最高点机位高于起点", peak > before + 0.5, true);

  // ② 关掉跟随：最高点机位 == 起跳点机位（锁在同一水平面上）。
  const lockedState: DirectorState = {
    ...terrain,
    cameras: [cam("C", "H", { followJumpHeight: false })],
  };
  const lockedBefore = solveCamera(lockedState, "C", 0)!.position[1];
  const lockedPeak = solveCamera(lockedState, "C", 1)!.position[1];
  check("§29 关掉跟随：离地期间机位高度不变", round6(lockedPeak), round6(lockedBefore));

  // ③ 锚线就是"起跳高度"：关掉跟随后，任何一个离地时刻的锚线都 == 起跳点锚线。
  //    （用 cameraAnchorHeight 直接对拍，保证两边同源。）
  const anchorPeak = cameraAnchorHeight(terrain, "H", 1, 0, 0, false);
  const anchorStart = cameraAnchorHeight(terrain, "H", 0, -3, 0, false);
  check("§29 锚线：离地期间 == 起跳高度", round6(anchorPeak), round6(anchorStart));

  // ③b 二分取的是**贴地侧**端点，不是离地侧。抛物线起点斜率极大（apex 1.5 / 半程 1s
  //     → 起步 ~6 m/s），取错一侧会让锚线凭空高 1cm 量级，而且**越晚的采样越漂**，
  //     表现为锁定期间镜头缓慢上抬 —— 正是这个功能要消除的东西。10mm 是回归守卫。
  check("§29 锚线：起跳高度不偏高（二分取贴地侧）", anchorPeak < 0.01, true);

  // ④ 落地后锚线回到地面（不应该"锁"到天荒地老）。
  //    该段终点是平地（起点/终点地面都是 0），所以落点锚线就是 0。
  const landed = cameraAnchorHeight(terrain, "H", 2, 3, 0, false);
  check("§29 锚线：落地后回到落点地面", round6(landed), 0);

  // ⑤ 默认（跟随）下锚线 == 实际高度（定义式），保证与扩展前一致。
  check(
    "§29 默认跟随：锚线 == 实际高度",
    round6(cameraAnchorHeight(terrain, "H", 1, 0, 0, true)),
    round6(pathHeightAt(terrain, terrain.objects[0], 0, 0, 1)),
  );

  // ⑥ 缓坡步行（不离地）：关掉跟随**也照跟** —— 否则山坡上会跟丢。
  //
  //    关键：坡度必须**缓**。`maxStep = 0.35`（human）意味着每走一步只能抬 0.35m；
  //    8m 深、2m 高的坡在 1.5m 的水平步幅里要抬 0.75m，人直接走出坡面 →
  //    `supportUnder` 退回基准面 0，于是"上坡"变成了"掉下坡"，断言毫无意义。
  //    这里改成 12m 深、1m 高的缓坡（d 方向是坡轴），步幅内抬升 0.29m < 0.35m。
  {
    // 缓坡**不需要任何魔法字段**：`isPassable` 对坡面 / 楼梯看的是**坡脚**（不是坡顶），
    // 坡脚够得着 + 坡度在能力表内 ⇒ 沿坡走上去。这条曾经是坑：拿坡顶去比 `maxStep` 的话，
    // 任何像样的坡都会被判成墙，演员绕坡而行而不是走上去。§33 把这条钉住了。
    const walk = sceneWith(
      [
        { ...box("R", 0, 0, 8, 12, 1, -0.5), topShape: "ramp" } as DirectorObject,
        actor("H", 0, -4, 0),
      ],
      [seg("s1", "H", [0, -4], [0, 4], { timeEnd: 2 })],
      "terrain",
    );
    const a0 = cameraAnchorHeight(walk, "H", 0, 0, -4, false);
    const a1 = cameraAnchorHeight(walk, "H", 2, 0, 4, false);
    check("§29 缓坡步行：关掉跟随后仍跟着升高", a1 > a0 + 0.5, true);

    // 且全程**不离地、不锁高度**。
    // 判据走 `airborneOf`（= `airborneLiftAt`，唯一出处）：它只在该段有生效弧线时
    // 才可能非零，所以缓坡恒 0；而"关掉跟随"在非离地时等价于"照跟实际高度"。
    // 位置一律取**对象的真实位置**（`objectPosition`）：高度是沿它自己走过的路径派生的，
    // 手工假造 (x,z) 会取到"另一条路径上"的高度（这正是本用例曾有的隐患）。
    const obj = walk.objects[1];
    let maxAir = 0;
    let maxLockGap = 0;
    for (let i = 0; i <= 10; i += 1) {
      const t = (i / 10) * 2;
      const p = objectPosition(walk, "H", t);
      maxAir = Math.max(maxAir, airborneOf(walk, obj, p.x, p.z, t).lift);
      maxLockGap = Math.max(
        maxLockGap,
        Math.abs(
          cameraAnchorHeight(walk, "H", t, p.x, p.z, false) - pathHeightAt(walk, obj, p.x, p.z, t),
        ),
      );
    }
    check("§29 缓坡步行：全程不离地", round6(maxAir), 0);
    check("§29 缓坡步行：锚线全程 == 实际高度（不锁在起跳高度）", round6(maxLockGap), 0);
  }
}

console.log("\n[30] 相机避障");
{
  // 一堵墙正好压住默认机位（eye_level = 1.7 的高处盒子）。
  // back_3_4 方位角 135°，机位落在 target + sin/cos(135°)*distance —— 用一个包住它的盒子。
  const wall = box("W", 0, 0, 30, 30, 8);
  const s = camScene([actor("H", 0, 0), wall], [cam("C", "H")], [], "terrain");
  const r = solveCamera(s, "C", 0)!;
  // 机位必须被推到盒子外（盒内任何一点都判失败）。
  const inside =
    Math.abs(r.position[0]) < 15 - 1e-6 &&
    Math.abs(r.position[2]) < 15 - 1e-6 &&
    r.position[1] > 0 &&
    r.position[1] < 8;
  check("§30 机位被推出遮挡体", inside, false);

  // planar 短路：同样的几何在 planar 下机位**保持原样**（不被推走）。
  const p = camScene([actor("H", 0, 0), wall], [cam("C", "H")]);
  const rp = solveCamera(p, "C", 0)!;
  check("§30 planar：不避障（机位保持原样）", round6(rp.position[1]), 1.7);

  // 无遮挡物时，避障必须是恒等变换（否则每次求解都会漂）。
  const clean = camScene([actor("H", 0, 0)], [cam("C", "H")], [], "terrain");
  const rc = solveCamera(clean, "C", 0)!;
  check("§30 无遮挡：恒等（不动）", round6(rc.position[1]), 1.7);

  // 没有 occluding 的对象（玻璃）不该触发避障。
  const glass = { ...box("G", 0, 0, 30, 30, 8), occluding: false } as DirectorObject;
  const gs = camScene([actor("H", 0, 0), glass], [cam("C", "H")], [], "terrain");
  check("§30 玻璃（occluding:false）：不避障", round6(solveCamera(gs, "C", 0)!.position[1]), 1.7);
}

console.log("\n[31] 姿态：坡面 pitch / roll + 骨盆高度自适应（Phase 7）");
{
  // ⚠ 用例前提（红线 27）：坡度必须在能力表内。
  //   12m 深、1m 高的坡 ⇒ slope = atan(1/12) = 4.76°，步幅 0.3m 内只抬 0.025m，
  //   远小于 human 的 maxStep = 0.35 ⇒ 人真的站在坡面上，不是走出坡面掉下去。
  //   坡轴沿 +Z：坡脚在 z = −6（bottom = −0.5），坡顶在 z = +6（top = 0.5）。
  const ramp = { ...box("R", 0, 0, 8, 12, 1, -0.5), topShape: "ramp" } as DirectorObject;
  const SLOPE_DEG = 4.763642;

  // ① 立足面法线同源：来自 topPlaneOf，且与解析坡度一致。
  {
    const st = scene([ramp, actor("H", 0, 0)], "terrain");
    const info = surfaceAt(st, st.objects[1], 0, 0);
    check("§31 立足面坡度 = atan(h/d)", round6(info.slopeDeg), round6(SLOPE_DEG));
    check("§31 法线朝上（ny > 0）", info.normal[1] > 0, true);
    // 上坡是 +Z，所以法线水平分量指向 −Z（下坡）。
    check("§31 法线水平分量指向下坡（nz < 0）", info.normal[2] < 0, true);
    check("§31 aspect = 上坡方向 yaw = 0", round6(info.aspectDeg), 0);
    // planar / 平地：法线恒为水平面 ⇒ 下游姿态全退化成恒等。
    const flat = scene([box("P", 0, 0, 6, 6, 1), actor("H", 0, 0)], "terrain");
    const fi = surfaceAt(flat, flat.objects[1], 0, 0);
    check("§31 平顶面 → 水平面法线", fi.normal, [0, 1, 0]);
    check("§31 平顶面 → slope 0", fi.slopeDeg, 0);
  }

  // ② pitch 符号：面向坡上与面向坡下必须反号。
  //    单测一个 yaw 会把符号写反却看起来通过，所以两个方向都钉。
  {
    const up = scene([ramp, actor("H", 0, 0)], "terrain");       // rotation 0 → 面向 +Z（上坡）
    const down = scene([ramp, { ...actor("H", 0, 0), rotation: 180 } as DirectorObject], "terrain");
    const iUp = surfaceAt(up, up.objects[1], 0, 0);
    const iDown = surfaceAt(down, down.objects[1], 0, 0);
    const tUp = tiltFor(iUp.normal, 0);
    const tDown = tiltFor(iDown.normal, Math.PI);
    // three.js：rotation.x < 0 ⇒ 前方(+Z)抬起。上坡就该抬前脚。
    check("§31 面向坡上 → pitch < 0（前脚抬起）", tUp.pitch < 0, true);
    check("§31 面向坡上 → |pitch| = 坡度", round6(-deg(tUp.pitch)), round6(SLOPE_DEG));
    check("§31 面向坡下 → pitch > 0（前脚下沉）", tDown.pitch > 0, true);
    check("§31 面向坡下 → |pitch| = 坡度", round6(deg(tDown.pitch)), round6(SLOPE_DEG));
    check("§31 面向坡上/坡下：roll 都是 0（沿坡轴无侧倾）", [round6(tUp.roll), round6(tDown.roll)], [0, 0]);
  }

  // ③ roll 符号：横切坡。**这一条是关键** —— three.js 的 Euler("XYZ") 是 R = Rx·Ry·Rz，
  //    所以 `roll = −asin(dot(n, right))` 要取负。写反了画面里车会朝上坡侧翻。
  //    面向 +X（yaw = 90°）时右手是 −Z（下坡方向）⇒ 右侧低 ⇒ rotation.z < 0。
  {
    const st = scene([ramp, actor("H", 0, 0)], "terrain");
    const info = surfaceAt(st, st.objects[1], 0, 0);
    const t = tiltFor(info.normal, Math.PI / 2);
    check("§31 横切坡 → pitch = 0（沿等高线走）", round6(deg(t.pitch)), 0);
    check("§31 横切坡 → |roll| = 坡度", round6(-deg(t.roll)), round6(SLOPE_DEG));
    // 右手朝 −Z = 下坡 ⇒ 右侧必须**降低** ⇒ rotation.z < 0。
    check("§31 横切坡 → roll < 0（右手在下坡侧，压低）", t.roll < 0, true);
    // 反方向横切（yaw = −90°）：右手朝 +Z = 上坡 ⇒ 右侧抬高 ⇒ roll > 0。
    const tOther = tiltFor(info.normal, -Math.PI / 2);
    check("§31 反向横切 → roll > 0（右手在上坡侧，抬高）", tOther.roll > 0, true);
    check("§31 两个横切方向 roll 反号", round6(t.roll + tOther.roll), 0);
  }

  // ④ 平面坡上 pelvisLift 必须 ≈ 0（关键的非直觉点）：
  //    身体已按坡度 pitch，"绕中点旋转"恰好让两只脚都贴在平面上 ——
  //    前脚被压低 span·sin(pitch)，而该处地面也正好高出 span·tan(pitch)，两两抵消。
  {
    const st = scene([ramp, actor("H", 0, 0)], "terrain");
    const s = stanceOf(st, "H", 0, 0, 0);
    check("§31 平面坡上：pitch 生效", round6(deg(s.pitch)), -round6(SLOPE_DEG));
    check("§31 平面坡上：pelvisLift ≈ 0（平面抵消）", Math.abs(s.pelvisLift) < 1e-3, true);

    // 坡面姿态补偿（`torsoCompensation`）：整个 group 为了"脚贴坡"而倾，上半身必须反向补回，
    // 否则走上坡的人整体后仰一个坡度角（侧看就是"人歪了"）。这两条钉住"躯干回到竖直"
    // 与"平地恒为 null"（planar 逐像素不变）。
    {
      const comp = torsoCompensation(s);
      check("§31 坡面补偿：spine 补回 pitch（补偿 + pitch = 0 ⇒ 躯干竖直）", round6((comp?.[0] ?? 0) + s.pitch), 0);
      check(
        "§31 坡面补偿：平地 / planar 恒为 null（不叠加任何关节角）",
        torsoCompensation({ pitch: 0, roll: 0 }),
        null,
      );
    }

    // 渲染层的欧拉序：`tiltFor` 的角度是**角色自己的轴**上的，所以角色 group 必须用 YXZ 序
    // （yaw 先作用）。默认的 XYZ 把 rotation.x 施加在世界轴上 —— 朝 +X 的角色因此被"侧倾"，
    // 画面上就是"人歪了"。这里直接拿 three 的矩阵验：`R·(0,1,0)` 必须等于立足面法线，
    // 且对任意 yaw 都成立（单测 yaw = 0 会漏掉这个 bug）。
    {
      const slopeRad = (30 * Math.PI) / 180;
      // 沿 +X 上坡：法线 = (−sin, cos, 0)。
      const n: [number, number, number] = [-Math.sin(slopeRad), Math.cos(slopeRad), 0];
      const upOf = (yawRad: number): THREE.Vector3 => {
        const t = tiltFor(n, yawRad);
        return new THREE.Vector3(0, 1, 0).applyMatrix4(
          new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(t.pitch, yawRad, t.roll, "YXZ")),
        );
      };
      // 沿坡 / 横切坡（pitch 或 roll 之一为 0）时是**精确**的：
      for (const yawDeg of [0, 90, 180]) {
        const up = upOf((yawDeg * Math.PI) / 180);
        check(
          `§31 欧拉序 YXZ：yaw=${yawDeg}° 时身体上轴 = 立足面法线`,
          [round6(up.x), round6(up.y), round6(up.z)],
          [round6(n[0]), round6(n[1]), round6(n[2])],
        );
      }
      // 斜切坡（pitch 与 roll 同时不为 0）：`tiltFor` 是**小角近似**，只要求不差得离谱。
      // 要精确对齐得把姿态改成四元数（`setFromUnitVectors`），目前不做。
      const oblique = upOf(Math.PI / 4);
      const errDeg =
        (Math.acos(Math.max(-1, Math.min(1, oblique.dot(new THREE.Vector3(...n))))) * 180) /
        Math.PI;
      check("§31 斜切坡：小角近似误差 < 4°", round6(errDeg) < 4, true);
    }
    check("§31 平面坡上：不判离地", s.airborne, false);
  }

  // ⑤ 平面假设失效时才真正抬升：**坡脚**。人站在 z = −5.9、面向 +Z 上坡时，
  //    前脚已经伸出坡外（落在基准面 0），身体却仍按坡面 pitch 倾斜 ⇒ 前脚悬空。
  {
    const st = scene([ramp, actor("H", 0, -5.9)], "terrain");
    const info = surfaceAt(st, st.objects[1], 0, -5.9);
    const t = tiltFor(info.normal, 0);
    check("§31 坡脚：立足面仍是坡", round6(info.slopeDeg), round6(SLOPE_DEG));
    const lift = pelvisLiftOf(st, st.objects[1], 0, -5.9, 0, t.pitch);
    check("§31 坡脚：pelvisLift > 0（前脚伸出坡外）", lift > 0.3, true);
    check("§31 坡脚：pelvisLift = 实测值", round6(lift), 0.51658);
  }

  // ⑥ planar 恒等 —— 姿态层不许让 planar 逐像素改变（红线 1）。
  //    靠的是能力表退化：planar 下 supportUnder 只返回基准面 ⇒ 水平面 ⇒ pitch/roll/lift 全 0。
  {
    const flat = scene([box("P", 0, 0, 6, 6, 1), actor("H", 0, 0)], "planar");
    const s = stanceOf(flat, "H", 0, 0, 0);
    check("§31 planar：pitch = 0", s.pitch, 0);
    check("§31 planar：roll = 0", s.roll, 0);
    check("§31 planar：pelvisLift = 0", s.pelvisLift, 0);
    check("§31 planar：不判离地", s.airborne, false);
    check("§31 planar：法线是水平面", s.surface.normal, [0, 1, 0]);
    // 就算场景里有个坡，planar 也够不着它 —— 显式短路（`topPlaneOf` 读 topShape
    // 却不看世界模式，所以这里必须有守卫；见 stance.ts 不变量 3）。
    const pRamp = scene([ramp, actor("H", 0, 0)], "planar");
    const ps = stanceOf(pRamp, "H", 0, 0, 0);
    check("§31 planar 无视坡：pitch = 0", ps.pitch, 0);
    check("§31 planar 无视坡：roll = 0", ps.roll, 0);
    check("§31 planar 无视坡：法线仍是水平面", surfaceAt(pRamp, pRamp.objects[1], 0, 0).normal, [0, 1, 0]);
  }

  // ⑦ 载具：跟 pitch/roll，但**不做骨盆高度自适应**（车轴是刚体，抬车身会悬浮）。
  {
    const car = { ...actor("V", 0, 0), category: "vehicle", type: "prop" } as DirectorObject;
    const st = scene([ramp, car], "terrain");
    const s = stanceOf(st, "V", 0, 0, 0);
    check("§31 载具：拿到坡面 pitch", round6(deg(s.pitch)), -round6(SLOPE_DEG));
    check("§31 载具：pelvisLift 恒 0", s.pelvisLift, 0);
    // 横切的载具（rotation 90）拿到 roll。
    const carT = { ...car, rotation: 90 } as DirectorObject;
    const stT = scene([ramp, carT], "terrain");
    const sT = stanceOf(stT, "V", 0, 0, 0);
    check("§31 载具横切：roll ≠ 0", Math.abs(sT.roll) > 0.01, true);
    check("§31 载具横切：pelvisLift 仍恒 0", sT.pelvisLift, 0);
  }

  // ⑧ 离地判据（airborneOf）—— 跳跃姿势 / 相机跟跳 / 时间轴底纹三处共用的唯一出处。
  {
    const crate = box("K", 0, 2, 1, 1, 0.6);
    const st: DirectorState = {
      ...scene([crate, actor("H", 0, 0)], "terrain"),
      segments: [seg("s1", "H", [0, 0], [0, 2], { timeEnd: 1.5, arc: { mode: "parabola", apex: 0.75 } } as Partial<MoveSegment>)],
    };
    const obj = st.objects[1];
    check("§31 跳跃：起跳瞬间贴地", airborneOf(st, obj, 0, 0, 0).airborne, false);
    check("§31 跳跃：弧顶离地", airborneOf(st, obj, 0, 1, 0.75).airborne, true);
    check("§31 跳跃：弧顶离地量 = apex（地面 0）", round6(airborneOf(st, obj, 0, 1, 0.75).lift), 0.75);
    check("§31 跳跃：落地贴地", airborneOf(st, obj, 0, 2, 1.5).airborne, false);
    check("§31 落地后姿态不离地", stanceOf(st, "H", 1.5, 0, 2).airborne, false);
    check("§31 容差常数：1cm（与 cameraSolver 同值）", AIRBORNE_EPS, 0.01);
  }

  // ⑧b 坡上行走无弧线：全程不离地（"站在坡上"不该被判成"在空中"）。
  //     用与 §29 同一个缓坡（12m 深 1m 高），确保步幅内抬升在 maxStep 内。
  {
    const walk: DirectorState = {
      ...scene([ramp, actor("H", 0, -4)], "terrain"),
      segments: [seg("s1", "H", [0, -4], [0, 4], { timeEnd: 2 })],
    };
    const wobj = walk.objects[1];
    let maxAir = 0;
    for (let i = 0; i <= 10; i += 1) {
      const t = (i / 10) * 2;
      const z = -4 + 8 * (i / 10);
      maxAir = Math.max(maxAir, airborneOf(walk, wobj, 0, z, t).lift);
    }
    check("§31 坡上步行：全程不离地", round6(maxAir), 0);
    check("§31 坡上步行：立足面仍是坡", round6(slopeDegOf(walk, "H", 0, 0)), round6(SLOPE_DEG));
  }

  // ⑨ 弧线俯仰（载具专用）：抛物线上升段仰、下降段俯。
  {
    const crate = box("K", 0, 2, 1, 1, 0.6);
    const st: DirectorState = {
      ...scene([crate, actor("V", 0, 0)], "terrain"),
      segments: [seg("s1", "V", [0, 0], [0, 2], { timeEnd: 1.5, arc: { mode: "parabola", apex: 0.75 } } as Partial<MoveSegment>)],
    };
    const rising = arcPitchOf(st, "V", 0.2);
    const falling = arcPitchOf(st, "V", 1.3);
    check("§31 弧线上升段：仰（> 0）", rising > 0.05, true);
    check("§31 弧线下降段：俯（< 0）", falling < -0.05, true);
    check("§31 不在弧线上（段外）→ 0", arcPitchOf(st, "V", 5), 0);
    // 人（非载具）不吃弧线俯仰 —— 跳跃姿态由三段预设表达。
    const stH: DirectorState = { ...st, segments: [{ ...st.segments[0], object: "H" }] };
    const sH = stanceOf(stH, "H", 0.2, 0, 0.3);
    check("§31 人的 stance 不含弧线俯仰", round6(sH.pitch), 0);
  }

  // ⑩ 顶点拖拽（时间轴 mini 弓形把手）的契约：改写只动 apex，不动 mode / 其它弧线字段，
  //    且不就地修改（返回新对象）。store 的 setSegmentArcApex 直接委托这个函数，所以钉死
  //    它就等于钉死了"拖顶点不会顺手清掉作者手感 / 不会改坏弧线语义"这条红线。
  {
    const arc: VerticalArc = { mode: "parabola", apex: 1.5, from: 0.1, to: 0.9 };
    const next = rewriteArcApex(arc, 3.2);
    check("§31 apex 改写保留 mode", next.mode, "parabola");
    check("§31 apex 改写保留 from/to", [next.from, next.to], [0.1, 0.9]);
    // `apex` 在类型里是可选的（只有 parabola 用），所以用 `NaN` 兜底：万一改写把 apex 丢了，
    // 这里会直接变红，而不是"undefined 悄悄通过"。
    check("§31 apex 改写只改 apex 值", round6(next.apex ?? Number.NaN), 3.2);
    check("§31 apex 改写返回新对象（不就地改）", next !== arc, true);
    check("§31 apex 改写不污染原对象", round6(arc.apex ?? Number.NaN), 1.5);
    // 下限钳到 0：作者把顶点拖到地面以下没有物理意义。
    const neg = rewriteArcApex(arc, -4);
    check("§31 apex 拖到负 → 钳到 0", round6(neg.apex ?? Number.NaN), 0);
    // fall / climb 的其它字段也一并保留（这些模式没有 apex，但顶点把手只挂在 parabola 上，
    // 这里只是确认纯函数对其它 mode 同样"只动 apex"）。
    // 用 `climbSeconds`（类型里真有这个字段）—— 早先这里写的是 `fallTo`：那个字段全项目
    // 只有 `engine/arc.ts` 一句注释提过，代码与类型都没有，守卫其实在测一个**幻影字段**。
    const climb: VerticalArc = { mode: "climb", climbSeconds: 1.4 };
    const climbed = rewriteArcApex(climb, 0);
    check("§31 climb 改写保留 mode", climbed.mode, "climb");
    check("§31 climb 改写保留 climbSeconds", climbed.climbSeconds, 1.4);
  }
}

console.log("\n[32] 相机高度时间低通（走台阶防抖）");
{
  // 一级 0.3m 的台阶：人从地面（z<0）走上台面（z>0）。
  // eye_level 的名义俯仰角是 0 ⇒ 机位高度 = 锚线 + 眼平参照 1.7。
  // 台上 = 台面 0.3 + 1.7 = 2.0；台下 = 1.7。
  const step = box("S", 0, 4, 8, 8, 0.3);
  const objs = [step, actor("H", 0, -4)];
  const walk = seg("W", "H", [0, -4], [0, 6], { timeEnd: 2 });

  const terrain = camScene(objs, [cam("C", "H")], [walk], "terrain");
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxDelta = 0;
  let prevY = solveCamera(terrain, "C", 0)!.position[1];
  for (let i = 0; i <= 200; i += 1) {
    const y = solveCamera(terrain, "C", (i / 200) * 2)!.position[1];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (i > 0) maxDelta = Math.max(maxDelta, Math.abs(y - prevY));
    prevY = y;
  }
  check("§32 台下机位高度 = 1.7", round6(minY), 1.7);
  check("§32 台上机位高度 = 2.0（0.3 台阶 + 1.7）", round6(maxY), 2.0);
  // 这条是守卫：没有低通时跨台阶会是一整跳 0.3m，这里立刻红。
  check("§32 走台阶：机位高度无逐帧跳变（< 0.05m）", maxDelta < 0.05, true);

  // planar：地面恒 0 ⇒ 没有台阶可抖，且低通短路 ⇒ Y 恒定 1.7（逐像素回归）。
  const planar = camScene(objs, [cam("C", "H")], [walk]);
  let pMin = Number.POSITIVE_INFINITY;
  let pMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i <= 200; i += 1) {
    const y = solveCamera(planar, "C", (i / 200) * 2)!.position[1];
    pMin = Math.min(pMin, y);
    pMax = Math.max(pMax, y);
  }
  check("§32 planar：机位高度恒 1.7（低通短路）", [round6(pMin), round6(pMax)], [1.7, 1.7]);

  // —— 身体侧：台阶的落差必须被抹成**短坡**，而不是瞬跳 ——
  //
  // 这是"台阶 y 低通"的另一半。只平滑镜头不平滑身体，主体会在画框里每级瞬跳
  // （实测 6m/50mm 取景下约占画面高 10%）；两者都平滑且同源，主体才真正稳住。
  {
    const body = terrain.objects[1];
    let maxBody = 0;
    let maxGround = 0;
    let prevBody: number | null = null;
    let prevGround: number | null = null;
    for (let i = 0; i <= 200; i += 1) {
      const t = (i / 200) * 2;
      const p = objectPosition(terrain, "H", t);
      const y = pathHeightAt(terrain, body, p.x, p.z, t);
      const g = standingHeightFor(terrain, body, p.x, p.z);
      if (prevBody !== null) maxBody = Math.max(maxBody, Math.abs(y - prevBody));
      if (prevGround !== null) maxGround = Math.max(maxGround, Math.abs(g - prevGround));
      prevBody = y;
      prevGround = g;
    }
    check("§32 身体：台阶落差被抹成短坡（单帧 < 0.1m）", maxBody < 0.1, true);
    check("§32 对照：瞬时地面本身仍是整跳 0.3m", round6(maxGround), 0.3);

    // planar 逐值恒等：地面恒 0 ⇒ 低通必须没有任何副作用。
    const flat = camScene(objs, [cam("C", "H")], [walk]);
    let gap = 0;
    for (let i = 0; i <= 200; i += 1) {
      const t = (i / 200) * 2;
      const p = objectPosition(flat, "H", t);
      gap = Math.max(
        gap,
        Math.abs(
          pathHeightAt(flat, flat.objects[1], p.x, p.z, t) -
            standingHeightFor(flat, flat.objects[1], p.x, p.z),
        ),
      );
    }
    check("§32 身体：planar 逐值恒等（低通无副作用）", round6(gap), 0);
  }

  // —— 画面级不变量：台阶抖的**可见形式**是俯仰角跳，不是高度跳 ——
  //
  // 机位 Y 与瞄准点 Y 必须**同拍**（一起平移、一起被平滑）。只平滑机位、不同步平滑瞄准点，
  // 两者就会错拍：镜头在每级台阶处先仰后俯。实测这个回归曾让俯仰角一帧跳 ~2.7°，
  // 比完全不平滑还难看（不平滑时两者同跳、俯仰角恒定，画面只是整体平移）。
  {
    const pitchAt = (state: DirectorState, camId: string, t: number): number => {
      const r = solveCamera(state, camId, t)!;
      const dx = r.target[0] - r.position[0];
      const dz = r.target[2] - r.position[2];
      return (Math.atan2(r.target[1] - r.position[1], Math.hypot(dx, dz)) * 180) / Math.PI;
    };
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    let maxDP = 0;
    let prevP = pitchAt(terrain, "C", 0);
    for (let i = 1; i <= 200; i += 1) {
      const p = pitchAt(terrain, "C", (i / 200) * 2);
      minP = Math.min(minP, p);
      maxP = Math.max(maxP, p);
      maxDP = Math.max(maxDP, Math.abs(p - prevP));
      prevP = p;
    }
    check("§32 走台阶：俯仰角全程恒定（画面不俯仰抖）", maxP - minP < 0.01, true);
    check("§32 走台阶：单帧俯仰跳变 < 0.05°", maxDP < 0.05, true);
  }

  // 开启防抖后同样同拍 —— 这条同时守住"作者的防抖没有被默认高度低通覆盖掉"：
  // 覆盖时两者按各自不同的窗平滑，高度差会在整段行走中来回摆。
  {
    const stab = camScene(objs, [cam("C2", "H", { stabilize: 0.9 })], [walk], "terrain");
    let minD = Number.POSITIVE_INFINITY;
    let maxD = Number.NEGATIVE_INFINITY;
    for (let i = 0; i <= 200; i += 1) {
      const r = solveCamera(stab, "C2", (i / 200) * 2)!;
      const d = r.target[1] - r.position[1];
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
    }
    check("§32 开启防抖：机位与瞄准点同拍（高度差恒定）", maxD - minD < 0.01, true);
  }
}

console.log("\n[33] 抽象楼梯（整体建模：坡度 + 总高 + 拐弯）");
{
  const DEG = Math.PI / 180;
  /** 造一座直跑楼梯：路径从 `(x, z)` 沿 +Z 走 `run` 米，总高 `h`。 */
  const stair = (id: string, x: number, z: number, w: number, h: number, run: number) =>
    ({
      ...box(id, x, z, w, run, h),
      topShape: "stair",
      stair: {
        path: [
          { id: `${id}_a`, x, z },
          { id: `${id}_b`, x, z: z + run },
        ],
      },
    }) as DirectorObject;

  // ① 直跑：路径水平长 3.1177m、总高 1.8 ⇒ **派生**坡度 30°。
  const dep = 1.8 / Math.tan(30 * DEG);
  const straight = stair("ST", 0, 3, 2, 1.8, dep);
  check("§33 直跑：坡脚高度 = 底", round6(topAt(straight, 0, 3)), 0);
  check("§33 直跑：中点 = 半高", round6(topAt(straight, 0, 3 + dep / 2)), 0.9);
  check("§33 直跑：坡顶 = 总高", round6(topAt(straight, 0, 3 + dep)), 1.8);
  check("§33 直跑：坡度是**派生量** = atan(高 / 路径水平长)", round6(stairSlopeDeg(straight)), 30);
  // 沿路径的进深 = 路径长；**顶端再外铺一块边长 = 宽度的到达平台**（接在路径之外）。
  check(
    "§33 直跑：进深 = 路径长 + 顶端到达平台（一个梯宽）",
    round6(stairBounds(straight).maxZ - 3),
    round6(dep + 2),
  );

  // 缺省路径（没画）：退回沿局部 +Z 的一段直跑，长度 = `footprint.d`。
  const plain = { ...box("SP", 0, 0, 2, 3, 1.8), topShape: "stair" } as DirectorObject;
  check("§33 缺省路径：退回一段直跑（D = 水平长）", round6(stairRunLength(plain)), 3);
  check(
    "§33 缺省路径：坡度 = atan(h / d)",
    round6(stairSlopeDeg(plain)),
    round6((Math.atan2(1.8, 3) * 180) / Math.PI),
  );
  // 路径是**世界坐标**：`rotation` 只影响"缺省直跑"的方向，不影响已画好的路径。
  const rotated = { ...straight, rotation: 90 } as DirectorObject;
  check("§33 路径是世界坐标：rotation 不改路径长", round6(stairRunLength(rotated)), round6(dep));
  check("§33 路径是世界坐标：高度也不受影响", round6(topAt(rotated, 0, 3 + dep / 2)), 0.9);

  // ② **连续坡面**，不是一级级台阶：这正是"整体建模"要解决的问题（否则身体一级一跳）。
  {
    let maxJump = 0;
    let prev = topAt(straight, 0, 3);
    for (let i = 1; i <= 100; i += 1) {
      const y = topAt(straight, 0, 3 + (dep * i) / 100);
      maxJump = Math.max(maxJump, Math.abs(y - prev));
      prev = y;
    }
    // 对照：0.3m 一级的盒子在此处会是 0.3 的整跳（见 §32 的「瞬时地面本身仍是整跳 0.3m」）。
    check("§33 直跑：全程无整级跳变（< 0.03m）", maxJump < 0.03, true);
  }

  // ③ 水平占用面 = 梯跑本身，不是 footprint 那个盒子。
  check("§33 占用面：段内为真", coversXZ(straight, 0, 3 + dep / 2), true);
  // **顶端到达平台**：路线终点之外一个梯宽仍然有面 —— 站在终点上的人整个脚印才站得住。
  check("§33 占用面：顶端平台内为真（站终点上不会半个身子悬空）", coversXZ(straight, 0, 3 + dep + 0.5), true);
  check("§33 占用面：平台之外为假", coversXZ(straight, 0, 3 + dep + 2 + 0.5), false);
  check("§33 占用面：横向出界为假", coversXZ(straight, 1.5, 3 + dep / 2), false);

  // ④ 可走：**不需要标 blocking:false** —— 坡脚够得着、坡度在能力表内就不是障碍。
  {
    const st: DirectorState = {
      ...scene([straight, actor("H", 0, -2)], "terrain"),
      segments: [seg("s1", "H", [0, -2], [0, 3 + dep + 1], { timeEnd: 4 })],
    };
    check("§33 可走：楼梯不算障碍（不必标 blocking:false）", blockingRectsFor(st, "H").length, 0);
    // 太陡：路径只给 1.04m ⇒ 派生坡度 60° > maxSlope 45° ⇒ 仍算墙。
    const steep = stair("SX", 0, 3, 2, 1.8, 1.8 / Math.tan(60 * DEG));
    const stSteep: DirectorState = {
      ...scene([steep, actor("H", 0, -2)], "terrain"),
      segments: [seg("s1", "H", [0, -2], [0, 3 + dep + 1], { timeEnd: 4 })],
    };
    check("§33 太陡（60° > maxSlope 45°）：仍算障碍", blockingRectsFor(stSteep, "H").length, 1);
    // planar：能力表 maxSlopeDeg = 0 ⇒ 一切坡都"太陡" ⇒ 楼梯仍是障碍（planar 逐像素不变）。
    const stPlanar: DirectorState = {
      ...scene([straight, actor("H", 0, -2)]),
      segments: [seg("s1", "H", [0, -2], [0, 3 + dep + 1], { timeEnd: 4 })],
    };
    check("§33 planar：楼梯仍算障碍（maxSlopeDeg = 0）", blockingRectsFor(stPlanar, "H").length, 1);
  }

  // ⑤ 拐弯：**急转自动圆角**（既不铺平台，也不做硬角）。
  //
  // 作者的原话是"楼梯的转折，不要做硬转，做弧度"。做法：把折线的每个急转顶点**内切**成
  // 一段等半径圆弧（`filletPath`），弧上每段的折角都很小 ⇒ 直接落进"缓转 = 连续曲面"
  // 那条既有通道：不铺平台、不补角、转角也不会宽出来，踏步沿弧自然铺开。
  {
    // 路径：先沿 +Z 爬，再拐 90° 沿 +X 爬（转角处自动圆成一段圆弧）。
    const L = {
      ...box("SL", 0, 0, 2, 2, 2.4),
      topShape: "stair",
      stair: {
        path: [
          { id: "L_a", x: 0, z: 0 },
          { id: "L_b", x: 0, z: 2 },
          { id: "L_c", x: 2, z: 2 },
        ],
      },
    } as DirectorObject;
    const runs = stairRuns(L);
    const walk = stairWalkPathOf(L);

    // ① 圆弧：半径 = 半个梯宽（两段各 2m，放得下）⇒ 切点 (0,1) / (1,2)、圆心 (1,1)。
    //    弧上的点**等距圆心**，且两头的端点仍是作者画的那两个点（圆角不吃两头）。
    const onArc = walk.filter((p) => Math.abs(Math.hypot(p.x - 1, p.z - 1) - 1) < 1e-9).length;
    check("§33 弯梯：弧上点等距圆心（半径 = 半宽，圆角是内切等半径弧）", onArc, walk.length - 2);
    check(
      "§33 弯梯：首尾仍是作者画的端点（圆角只吃拐角）",
      [round6(walk[0].x), round6(walk[0].z), round6(walk[walk.length - 1].x), round6(walk[walk.length - 1].z)],
      [0, 0, 2, 2],
    );
    // ② 走线 = 两段直跑各去掉一个切距 + 一段弧 ⇒ **比折线短**（内切弧 < 折角）。
    //    注意用的是**离散弦长和**（与几何、坡度同源），所以与理论弧长差在 0.1% 内。
    check("§33 弯梯：走线长 = (2−1) + 弧 + (2−1)（圆角把折角切短了）", Math.abs(stairRunLength(L) - (2 + Math.PI / 2)) < 0.002, true);

    // ③ 转弯处**不再有平台**：唯一水平的段是顶端到达平台；转弯段逐段上升。
    check("§33 弯梯：转弯不铺平台（唯一的水平段是顶端到达平台）", runs.filter((r) => Math.abs(r.y1 - r.y0) <= 1e-9).length, 1);
    check("§33 弯梯：转弯段逐段上升（连续弧度，不是平台）", runs.slice(0, -1).every((r) => r.y1 > r.y0), true);
    // ④ 走线每一点都落在某段上（接缝无洞），且相邻走线段的夹角 ≤ 离散粒度 5°
    //    （所以转弯不会触发平台）。注意段与段在拐角处是**故意重叠**的（叠出 miter 填缝），
    //    所以"后一段起点 = 前一段终点"不再是这里的不变量 —— 不变量是**走线被覆盖**。
    let maxTurn = 0;
    let onStair = true;
    const headingAt = (k: number) =>
      Math.atan2(walk[k].x - walk[k - 1].x, walk[k].z - walk[k - 1].z);
    for (let k = 0; k < walk.length; k += 1) {
      if (!coversXZ(L, walk[k].x, walk[k].z)) onStair = false;
    }
    for (let k = 2; k < walk.length; k += 1) {
      const d = headingAt(k) - headingAt(k - 1);
      maxTurn = Math.max(maxTurn, Math.abs(((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI));
    }
    check("§33 弯梯：走线每一点都有面可站（接缝用重叠段补角，无洞）", onStair, true);
    // 离散粒度 8°（`ROUND_STEP_DEG`）：90° 拐角切成 11 段 ⇒ 弧上相邻段夹角约 8.2°，
    // 远低于急转门槛 40° —— 所以转弯永远不会触发"平台 / 补角"那条兜底分支。
    check("§33 弯梯：走线相邻段夹角 ≤ 10°（离散粒度量级，不触发平台）", maxTurn <= 10 * DEG + 1e-9, true);
    // ⑤ 转过去的**总量** = 90°（圆角没有把拐弯改小）。
    const flights = runs.filter((r) => Math.abs(r.y1 - r.y0) > 1e-9);
    check(
      "§33 弯梯：首末梯跑的朝向差 = 90°（圆角没有把拐弯改小）",
      round6((Math.abs(flights[flights.length - 1].heading - flights[0].heading) * 180) / Math.PI),
      90,
    );

    // ⑥ 沿**走线**密集采样（每 2cm —— 不是沿各段轴线顺次采：段与段在拐角处重叠，
    //    顺着轴线走会来回跳，那不是几何的问题）：全程有面、高度单调、无整级跳变。
    //    单调用 1mm 容差：重叠处取两块里的最高面，两块坡度差一丝，允许毫米级的起伏。
    let covered = true;
    let monotone = true;
    let maxJump = 0;
    let prevY = -Infinity;
    for (let k = 1; k < walk.length; k += 1) {
      const segLen = Math.hypot(walk[k].x - walk[k - 1].x, walk[k].z - walk[k - 1].z);
      const n = Math.max(1, Math.ceil(segLen / 0.02));
      for (let j = 0; j <= n; j += 1) {
        const t = j / n;
        const x = walk[k - 1].x + (walk[k].x - walk[k - 1].x) * t;
        const z = walk[k - 1].z + (walk[k].z - walk[k - 1].z) * t;
        if (!coversXZ(L, x, z)) covered = false;
        const y = topAt(L, x, z);
        if (!Number.isFinite(y)) maxJump = Number.NaN;
        else if (prevY > -Infinity) maxJump = Math.max(maxJump, Math.abs(y - prevY));
        if (y < prevY - 1e-3) monotone = false;
        prevY = y;
      }
    }
    check("§33 弯梯：沿走线全程有面可站", covered, true);
    check("§33 弯梯：沿走线高度单调不减（不会中途下陷）", monotone, true);
    check("§33 弯梯：沿走线无整级跳变（每 2cm 抬升 < 0.03m）", maxJump < 0.03, true);
    check("§33 弯梯：末端达到总高", round6(topAt(L, 2, 2)), 2.4);

    // ⑦ **作者画的那个转折点必须还在梯段上**：路径点把手就钉在它上面，它一旦掉出梯段，
    //    把手就会"看得见却点不中"。这条钉住 `filletPath` 里那个半径上限（0.85 × 半宽）。
    const cornerY = topAt(L, 0, 2);
    check("§33 弯梯：转折点仍在梯段上（把手的落点有着落）", Number.isFinite(cornerY) && cornerY > 0.1 && cornerY < 2.3, true);
    check("§33 弯梯：把手贴在表面（不是退回到顶面）", [round6(stairHandleY(L, 0, 2)), stairHandleY(L, 0, 2) < 2.3], [round6(cornerY), true]);
  }

  // ⑤b **任意角度拐角的接缝**（作者报的"转角处有很大的缝隙 / 宽出来这么多"）。
  //
  // 迭代史：按"边长 = 宽度"铺方形平台 ⇒ 非 90° 盖不住端面（Δ=60°、w=4 时缺口约 0.7m）；
  // 把平台放大到"够包住接缝" ⇒ 比梯跑还宽（Δ=45° 时宽 41%），画面上就是"转角宽出来一块"。
  // 现在改为**急转圆角**：走线本身就是一条弧，两段梯跑与弧切向相接 —— 于是
  //   (a) 沿走线（每段的中线）全程有面可站；
  //   (b) 作者画的**转折点仍在梯段上**（把手就钉在那儿，掉出去就"看得见却点不中"）；
  //   (c) **没有哪块比梯跑宽**（转角不再宽出来）；
  //   (d) 站在转折点上、整个脚印的支撑比例（外缘只剩多边形近似啃掉的一丝，与缓转同一口径）。
  {
    const misses: string[] = [];
    const support: number[] = [];
    for (const turn of [45, 60, 90, 120, 135, 150]) {
      const rad = turn * DEG;
      const s = {
        ...box("TT", 0, 0, 4, 4, 2),
        topShape: "stair",
        stair: {
          path: [
            { id: "T_a", x: 0, z: 0 },
            { id: "T_b", x: 0, z: 4 },
            { id: "T_c", x: 4 * Math.sin(rad), z: 4 + 4 * Math.cos(rad) },
          ],
        },
      } as DirectorObject;
      const runs = stairRuns(s);
      const corridor = runs.length > 0 ? runs[0].halfWidth : 0;
      // (a) 沿走线采样（弧的中点线——外缘是折线近似，中线才是"一定有面"的那条）。
      for (const r of runs) {
        for (let i = 0; i <= 10; i += 1) {
          const a = (r.length * i) / 10;
          if (!coversXZ(s, r.x + Math.sin(r.heading) * a, r.z + Math.cos(r.heading) * a)) {
            misses.push(`${turn}°:走线`);
          }
        }
      }
      // (b) 转折点仍在梯段上，且高度在 0 与总高之间。
      const corner = topAt(s, 0, 4);
      if (!Number.isFinite(corner) || corner <= 0 || corner >= 2) misses.push(`${turn}°:转折点悬空`);
      // (c) 没有一个盒子比梯跑宽。
      for (const r of runs) {
        if (r.halfWidth > corridor + 1e-9) misses.push(`${turn}°:宽出来`);
      }
      // (d) 转折点上整个脚印（0.6 见方，7×7）的支撑比例。
      let ok = 0;
      for (let i = -3; i <= 3; i += 1) {
        for (let j = -3; j <= 3; j += 1) {
          if (coversXZ(s, (i * 0.3) / 3, 4 + (j * 0.3) / 3)) ok += 1;
        }
      }
      support.push(ok / 49);
    }
    check("§33 拐角：走线全程有面、转折点不悬空、不比梯跑宽", misses, []);
    // 实测：填缝之前转角脚印只站得住 27%（折线近似圆弧的外缘楔口把它啃掉了）；填上之后
    // 45°~150° 六种转角**全部 100%**。门槛留 95%，给多边形近似一点余量。
    check("§33 拐角：转折点脚印支撑 ≥ 95%（外缘楔口已用重叠段填掉）", Math.round(Math.min(...support) * 100) >= 95, true);
  }

  // ⑤c **几何缓存必须跟着对象失效**。
  //
  // 热路径（演员落地 / 绕障 / 拾取每帧都在问）不能每次查询都重跑圆角 + 重建段表，
  // 所以几何是缓存的；失效判据 = 对象引用（+ 路径数组引用）。本项目的写入点全是不可变的
  // `{...object}`（见 store 的 `updateAsset`），所以"改了就得算新的"这条必须钉住 ——
  // 缓存陈旧 = 渲染与物理一起错，而且不会有任何报错。
  {
    const a = {
      ...box("SC", 0, 0, 2, 2, 2),
      topShape: "stair",
      stair: {
        path: [
          { id: "C_a", x: 0, z: 0 },
          { id: "C_b", x: 0, z: 2 },
          { id: "C_c", x: 2, z: 2 },
        ],
      },
    } as DirectorObject;
    const hit = topAt(a, 0, 1);
    // 同一对象重复问：命中缓存不能改变结果。
    check("§33 缓存：同一对象重复查询结果一致", [round6(topAt(a, 0, 1)), round6(stairRunLength(a))], [round6(hit), round6(stairRunLength(a))]);
    check("§33 缓存：转折点仍在梯段上", Number.isFinite(topAt(a, 0, 2)), true);
    // 拖长一段（新 path 数组 + 新对象，与画布拖点同一条路）：几何必须跟着变。
    const longer = {
      ...a,
      stair: {
        path: [
          { id: "C_a", x: 0, z: 0 },
          { id: "C_b", x: 0, z: 2 },
          { id: "C_c", x: 4, z: 2 },
        ],
      },
    } as DirectorObject;
    check("§33 缓存：改了路径就有新几何", stairRunLength(longer) > stairRunLength(a) + 1, true);
    check("§33 缓存：末端仍正好到总高", round6(topAt(longer, 4, 2)), 2);
    // 改宽度（圆角半径的上限是半宽）：走线必须重算 —— 半径变小 ⇒ 切得少 ⇒ 走线更长。
    const narrow = { ...a, footprint: { ...a.footprint, w: 1 } } as DirectorObject;
    check("§33 缓存：改宽度会重算圆角（半径上限 = 半宽）", stairRunLength(narrow) > stairRunLength(a), true);
  }

  // ⑥ 画布拾取（拖拽入口）：把手球心必须与**渲染高度同源**，否则"看得见却点不中"。
  {
    const s2 = stair("SH", 0, 0, 2, 1.8, dep);
    const stHit: DirectorState = scene([s2], "terrain");
    const p1 = s2.stair!.path![1];
    const y = stairHandleY(s2, p1.x, p1.z) + STAIR_HANDLE_LIFT;
    const down = new THREE.Vector3(0, -1, 0);
    const hit = hitStairPathPointScreen(
      stHit,
      "SH",
      new THREE.Ray(new THREE.Vector3(p1.x, y + 6, p1.z), down),
      12,
      800,
    );
    check("§33 拾取：射线指向把手 → 命中该点", hit?.pointId, p1.id);
    const miss = hitStairPathPointScreen(
      stHit,
      "SH",
      new THREE.Ray(new THREE.Vector3(p1.x + 1.5, y + 6, p1.z), down),
      12,
      800,
    );
    check("§33 拾取：偏开 1.5m → 不命中", miss, null);
    check("§33 拾取：球心高度 = 楼梯表面 + 抬升", round6(y - stairHandleY(s2, p1.x, p1.z)), round6(STAIR_HANDLE_LIFT));
  }

  // ⑦ 路径的来源之「螺旋生成」：它产出的就是一条**普通路径**，不是第二套机制。
  {
    const s3 = { ...box("SH2", 0, 0, 2, 3, 1.8), topShape: "stair" } as DirectorObject;
    const R = 2.5;
    const T = 1.5;
    const helix = helixStairPath(s3, R, T);
    // rotation = 0 ⇒ 圆心在 (R, 0)。
    let maxErr = 0;
    for (const p of helix) maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.x - R, p.z) - R));
    check("§33 螺旋：所有点到圆心距离 = 半径", maxErr < 1e-6, true);
    check("§33 螺旋：起点 = 对象原点（切向进入，无折角）", [round6(helix[0].x), round6(helix[0].z)], [0, 0]);

    const spiral = { ...s3, stair: { path: helix } } as DirectorObject;
    // 精确：折线长度 = 弦长和（每段圆心角 2πT/n ⇒ 弦长 2R·sin(πT/n)）。
    const segs = helix.length - 1;
    const chordSum = segs * 2 * R * Math.sin((Math.PI * T) / segs);
    check("§33 螺旋：路径长 = 折线弦长和", Math.abs(stairRunLength(spiral) - chordSum) < 1e-6, true);
    // 并且逼近理论弧长（离散化误差 < 1%）。
    const arc = 2 * Math.PI * R * T;
    check("§33 螺旋：与理论弧长 2π·半径·圈数 相差 < 1%", Math.abs(chordSum - arc) / arc < 0.01, true);
    // 圈数越多 ⇒ 路径越长 ⇒ 同样的总高下坡度越缓（坡度是派生量）。
    const half = { ...s3, stair: { path: helixStairPath(s3, R, 0.5) } } as DirectorObject;
    check("§33 螺旋：圈数少 ⇒ 坡度更陡（派生量随之变）", stairSlopeDeg(half) > stairSlopeDeg(spiral), true);
  }

  // ⑧ 高度的来源之「两端平面高差」：连接有高低差的两层时不必自己量。
  {
    const plat = box("PL", 0, 6, 4, 4, 2); // 终点落在 2m 平台上
    const st = {
      ...box("SH3", 0, 0, 2, 6, 0.5),
      topShape: "stair",
      stair: {
        path: [
          { id: "a", x: 0, z: 0 },
          { id: "b", x: 0, z: 6 },
        ],
      },
    } as DirectorObject;
    const sceneH = scene([plat, st], "terrain");
    check("§33 取高差：终点平台 2m − 起点地面 0 = 2m", round6(stairHeightFromPlanes(sceneH, st)), 2);
    // 排除自身：没有别的支撑面时不该量到楼梯自己头上。
    const lone = scene([st], "terrain");
    check("§33 取高差：排除自身（什么都没有 → 0）", round6(stairHeightFromPlanes(lone, st)), 0);
  }

  // ⑨ 手绘（工具栏 ✏️ Path 按住拖）：轨迹 → 抽稀 → 楼梯路径。
  //    抽稀这一环是手绘能不能用的关键：不抽稀就会在画布上冒出几十个控制点，
  //    抽稀过头又会把拐角抹平成一条直线（整座 L 形楼梯直接消失）。
  {
    const line = Array.from({ length: 40 }, (_, i) => ({ x: 0, z: i * 0.15 }));
    const thinnedLine = simplifyPath(line, 0.35);
    check("§33 手绘：直线轨迹抽稀成 2 点", thinnedLine.length, 2);
    check(
      "§33 手绘：首尾与原始轨迹一致",
      [round6(thinnedLine[0].z), round6(thinnedLine[1].z)],
      [0, round6(39 * 0.15)],
    );

    const lStroke = [
      ...Array.from({ length: 10 }, (_, i) => ({ x: 0, z: i * 0.15 })),
      ...Array.from({ length: 10 }, (_, i) => ({ x: (i + 1) * 0.15, z: 1.35 })),
    ];
    const thinnedL = simplifyPath(lStroke, 0.35);
    check("§33 手绘：拐角被保住（L 形 → 3 点）", thinnedL.length, 3);
    check("§33 手绘：拐点就是画的那个角", [round6(thinnedL[1].x), round6(thinnedL[1].z)], [0, 1.35]);

    // 抽稀后的轨迹直接喂给楼梯：转角处照样自动生成休息平台、坡度照样是派生量。
    const drawn = {
      ...box("SD", 0, 0, 2, 4, 1.8),
      topShape: "stair",
      stair: { path: thinnedL.map((p, i) => ({ id: `D_${i}`, x: p.x, z: p.z })) },
    } as DirectorObject;
    const drawnRuns = stairRuns(drawn);
    // 拐角被圆成一段弧 ⇒ 走线是一串小段，**唯一的水平段是顶端到达平台**。
    check(
      "§33 手绘：手绘出的 L 形 → 转弯被圆成弧（不再铺转角平台）",
      [drawnRuns.filter((r) => Math.abs(r.y1 - r.y0) <= 1e-9).length, drawnRuns.length > 4],
      [1, true],
    );
    // 沿走线（含拐角弧）采样：高度连续、单调、没有整级跳变。
    // 注意采的是**走线**（弧的中点线），不是作者那条折线 —— 折线在弧的外侧，靠外缘有
    // 多边形近似的楔口（与缓转同一条既定口径：中线始终被覆盖，见 §33 螺旋）。
    const cornerY = topAt(drawn, 0, 1.35);
    const drawnWalk = stairWalkPathOf(drawn);
    let maxJump = 0;
    let mono = true;
    let prevYSample = -Infinity;
    for (let k = 1; k < drawnWalk.length; k += 1) {
      const segLen = Math.hypot(drawnWalk[k].x - drawnWalk[k - 1].x, drawnWalk[k].z - drawnWalk[k - 1].z);
      const n = Math.max(1, Math.ceil(segLen / 0.02));
      for (let j = 0; j <= n; j += 1) {
        const t = j / n;
        const y = topAt(
          drawn,
          drawnWalk[k - 1].x + (drawnWalk[k].x - drawnWalk[k - 1].x) * t,
          drawnWalk[k - 1].z + (drawnWalk[k].z - drawnWalk[k - 1].z) * t,
        );
        if (!Number.isFinite(y)) maxJump = Number.NaN;
        else if (prevYSample > -Infinity) maxJump = Math.max(maxJump, Math.abs(y - prevYSample));
        if (y < prevYSample - 1e-3) mono = false;
        prevYSample = y;
      }
    }
    check("§33 手绘：沿走线（含拐角弧）高度连续、无整级跳变", maxJump < 0.03, true);
    check("§33 手绘：沿走线高度单调不减（拐角处不下陷）", mono, true);
    check("§33 手绘：转折点仍在梯段上（把手有着落）", Number.isFinite(cornerY) && cornerY > 0.1 && cornerY < 1.7, true);

    // —— 模型的可读懂性不变量（这两条正是"作者对不上自己画的线"的根源）——
    // ① 末端（= 路径最后一点）正好到达总高；
    check("§33 手绘：路径最后一点处正好是总高", round6(topAt(drawn, 1.5, 1.35)), 1.8);
    // ② **沿路径不外扩**：转角平台从路径里**扣除**（不额外接一段），只有顶端多铺一块
    //    边长 = 梯宽的到达平台。（旧模型把平台接在转折点**之后**：末段升不到总高、
    //    整条几何后移一个梯宽 —— 作者在路径末端量不到总高，就会觉得线对不上。）
    const pad = drawnRuns[drawnRuns.length - 1];
    check("§33 手绘：顶端到达平台是水平的、顶面 = 总高", [round6(pad.y0), round6(pad.y1)], [1.8, 1.8]);
    check("§33 手绘：顶端到达平台边长 = 梯宽", round6(pad.length), 2);
    const db = stairBounds(drawn);
    check(
      "§33 手绘：几何 = 路径 ± 半宽 + 顶端一个梯宽",
      [db.maxX <= 1.5 + 2 + 0.01, db.maxZ <= 1.35 + 1 + 0.01],
      [true, true],
    );
    const drawnEnd = drawnRuns[drawnRuns.length - 1];
    check(
      "§33 手绘：末端达到总高",
      round6(
        topAt(
          drawn,
          drawnEnd.x + Math.sin(drawnEnd.heading) * drawnEnd.length,
          drawnEnd.z + Math.cos(drawnEnd.heading) * drawnEnd.length,
        ),
      ),
      1.8,
    );
  }

  // ⑩ 缓转不插平台（螺旋）。踩过的坑：原先"每个转折点都插一段进深 = 楼梯宽度的平台"，
  //    而螺旋每段只转 15°，于是每小段都再走一个 1.4m 水平段 —— 几何逐段外扩
  //    （半径 1.6 的螺旋被拉到 22m），24 段梯跑变成 47 段、螺旋变成一串平台。
  {
    const sp = { ...box("SH", 8, -2, 1.4, 1.4, 2.4), topShape: "stair" } as DirectorObject;
    const helixPath = helixStairPath(sp, 1.6, 1);
    const helix = { ...sp, stair: { path: helixPath } } as DirectorObject;
    check(
      "§33 螺旋：每段都是梯跑（边数 + 1 个顶端平台，缓转不插平台）",
      stairRuns(helix).length,
      helixPath.length,
    );

    // 路径是以 (9.6, −2) 为圆心、半径 1.6 的整圆；几何反推的包围盒最多再外扩半个梯宽，
    // 外加顶端那一块到达平台（外扩一个梯宽 = 1.4）。旧 bug 会把半径 1.6 的螺旋拉到 22m。
    const hb = stairBounds(helix);
    const r = 1.6 + 0.7 + 1.4 + 0.01;
    check(
      "§33 螺旋：包围盒贴着圆（平台外扩会立刻越界）",
      [
        hb.minX >= 9.6 - r && hb.maxX <= 9.6 + r,
        hb.minZ >= -2 - r && hb.maxZ <= -2 + r,
      ],
      [true, true],
    );
  }

  // ⑪ 视觉踏步的**展开方向**。踩过的坑：渲染层自己算这个偏移，把踏步沿**垂直于**梯跑
  //    的方向排开（盒子长边在 Z、位置却沿 X 递增）—— 整座楼梯画成一堆错位的方块、
  //    人物站在真实表面上却看着悬空。现在展开只有 `stairTreads` 一个出处（渲染层只消费
  //    中心点），这里把它的不变量钉住。
  {
    const st = { ...box("ST", 0, 0, 2, 4, 1.6), topShape: "stair" } as DirectorObject;
    const run = stairRuns(st)[0];
    const steps = Math.max(1, Math.round((run.y1 - run.y0) / STAIR_VISUAL_STEP));
    const all = stairTreads(st);
    // 梯跑按级高细分；顶端到达平台是平的 ⇒ 只有 1 级。
    const treads = all.slice(0, steps);
    check("§33 踏步：梯跑数量 = 按级高细分", treads.length, steps);
    check("§33 踏步：顶端到达平台只有 1 级（它是平的）", all.length - steps, 1);
    check(
      "§33 踏步：中心横向恒在梯跑中线上（沿错方向排布会立刻越界）",
      treads.every((t) => Math.abs(t.x - run.x) < 1e-9),
      true,
    );
    // 沿程首尾各留半级 —— 说明它铺满整段、且是**沿**着梯跑铺的。
    check(
      "§33 踏步：中心沿程铺满整段（首尾各留半级）",
      [
        round6(Math.min(...treads.map((t) => t.z)) - run.z),
        round6(Math.max(...treads.map((t) => t.z)) - run.z - run.length),
      ],
      [round6(run.length / steps / 2), round6(-run.length / steps / 2)],
    );
  }

  // ⑫ 可达性：**走上楼梯不该被报"不可达"**。路线沿坡面上升时逐条边都迈得上，但合并后的
  //    总量（1.8m）会被拿去问"能不能攀爬" —— 判据应该是**坡度**（与 `avoidance.isPassable`
  //    同一套）。示例里那条"主角走上 L 形"的路线就因此挂着红叉「落差 1.80m」。
  {
    const slopeStair = {
      ...box("SR", 0, 0, 1.8, 2, 1.8),
      topShape: "stair",
      stair: {
        path: [
          { id: "R_a", x: 0, z: 0 },
          { id: "R_b", x: 0, z: 4 },
        ],
      },
    } as DirectorObject;
    const st: DirectorState = {
      ...scene([slopeStair, { ...actor("H", 0, -1), baseY: 1.8 } as DirectorObject], "terrain"),
      segments: [seg("sH", "H", [0, -1], [0, 3.8], { timeEnd: 8 })],
    };
    // 路线终点必须留在楼梯内：越过顶端半步就成了真的"落差"，那是另一回事（该报）。
    check(
      "§33 可达性：走上楼梯不报不可达（坡面按坡度判，不再当成落差）",
      scanReachability(st).length,
      0,
    );
  }

  // ⑬ 沿路径累进的落脚高度：**`baseY` 不再是"能不能走上楼梯"的开关**。
  //    老规则每点独立、以 `baseY + maxStep` 封顶 ⇒ `baseY` 缺省（0）的演员在楼梯上
  //    永远升不过 `maxStep = 0.35`：几何在升、人不动，看起来就是"穿过台阶"。
  //    现在从段首沿路径一步一步滚上去（见 `pathHeight.ts` 的 `progressiveGroundAt`）。
  {
    const slopeStair = {
      ...box("SW2", 0, 0, 1.8, 2, 1.8),
      topShape: "stair",
      stair: {
        path: [
          { id: "W_a", x: 0, z: 0 },
          { id: "W_b", x: 0, z: 4 },
        ],
      },
    } as DirectorObject;
    const st: DirectorState = {
      // 演员**不带** baseY（= 0）：这正是用户拖进场景的新演员的样子。
      ...scene([slopeStair, actor("HW", 0, -1)], "terrain"),
      segments: [seg("sW", "HW", [0, -1], [0, 3.8], { timeEnd: 8 })],
    };
    const walker = st.objects.find((o) => o.id === "HW") as DirectorObject;
    let hi = Number.NEGATIVE_INFINITY;
    let drop = 0;
    let prev = Number.NaN;
    for (let i = 0; i <= 120; i += 1) {
      const t = (i / 120) * 8;
      const p = objectPosition(st, "HW", t);
      const y = pathHeightAt(st, walker, p.x, p.z, t);
      if (!Number.isNaN(prev)) drop = Math.max(drop, prev - y);
      prev = y;
      if (y > hi) hi = y;
    }
    // 老规则下这里恒 ≤ 0.325（= maxStep），所以这条会立刻红。
    // 到顶时不写死 1.8：y 低通（0.15s 窗）有滞后，实测 1.79。
    check("§33 累进落脚：baseY 缺省也能走到楼梯顶（≥ 1.7）", hi >= 1.7, true);
    check("§33 累进落脚：全程不回落（不会中途跳到顶层再掉回来）", round6(drop), 0);

    // **终点设在楼梯中间**：走完之后没有"活跃段"了，此时若退回"以 baseY 封顶"的老规则，
    // 演员会当场掉回地面。终点的高度必须"停在哪就是哪"（段外沿用最近那段的剖面）。
    const mid: DirectorState = {
      ...scene([slopeStair, actor("HW3", 0, -1)], "terrain"),
      segments: [seg("sW3", "HW3", [0, -1], [0, 2], { timeEnd: 4 })],
    };
    const w3 = mid.objects.find((o) => o.id === "HW3") as DirectorObject;
    const p3 = objectPosition(mid, "HW3", 8); // 段早已结束
    const yMid = pathHeightAt(mid, w3, p3.x, p3.z, 8);
    check(
      "§33 累进落脚：终点设在楼梯中间，走完停住不掉回地面（≈ 0.9）",
      yMid > 0.7 && yMid < 1.0,
      true,
    );

    /** 沿路线采样，返回脚底最高值。 */
    const topAlong = (st: DirectorState, id: string): number => {
      const o = st.objects.find((x) => x.id === id) as DirectorObject;
      let top = 0;
      for (let i = 0; i <= 80; i += 1) {
        const t = (i / 80) * 8;
        const p = objectPosition(st, id, t);
        top = Math.max(top, pathHeightAt(st, o, p.x, p.z, t));
      }
      return top;
    };

    // **凌乱箱体**：新规则只沿「每级 ≤ maxStep 的连续可踏升面」上升 —— 既不会乱爬高箱，
    // 也能把随手堆的矮箱当台阶走上去（这是本次改动新增的能力）。
    const chained: DirectorState = {
      ...scene(
        [
          { ...box("K1", 0, 2, 2, 1, 0.3), blocking: false } as DirectorObject,
          { ...box("K2", 0, 3, 2, 1, 0.6), blocking: false } as DirectorObject,
          { ...box("K3", 0, 4, 2, 1, 0.9), blocking: false } as DirectorObject,
          actor("KW", 0, 0),
        ],
        "terrain",
      ),
      segments: [seg("sK", "KW", [0, 0], [0, 6], { timeEnd: 8 })],
    };
    check("§33 累进落脚：三块 0.3 矮箱连成台阶 → 能一级一级爬到 0.9", round6(topAlong(chained, "KW")), 0.9);

    const lump: DirectorState = {
      ...scene(
        [{ ...box("K4", 0, 3, 2, 2, 0.6), blocking: false } as DirectorObject, actor("KW2", 0, 0)],
        "terrain",
      ),
      segments: [seg("sK2", "KW2", [0, 0], [0, 6], { timeEnd: 8 })],
    };
    check("§33 累进落脚：单块 0.6 箱（> maxStep）不会被踩上去", round6(topAlong(lump, "KW2")), 0);
  }

  // ⑬ **脚底脚印的整体支撑**（"人物悬空"那条的真守卫）。
  //
  // 落脚判据是**点查询**（`supportUnder(x, z)`），它看不见"半个身子在外面"：站在路线
  // **终点**上时（走完的人、摆在终点上的配角）一半脚印探在楼梯外，画面上就是"人悬在
  // 半空"，而所有点查询都报正常。实测：0.6 见方的脚印在终点只有 56% 有支撑。
  // 所以这里按**脚印网格**（渲染真正占据的面积）采样，而不是只看中心点。
  {
    const foot = 0.6;
    let on = 0;
    let total = 0;
    for (let i = 0; i <= 8; i += 1) {
      for (let j = 0; j <= 8; j += 1) {
        const x = -foot / 2 + (foot * i) / 8;
        const z = 3 + dep - foot / 2 + (foot * j) / 8;
        total += 1;
        if (coversXZ(straight, x, z)) on += 1;
      }
    }
    check("§33 脚印：站在路线终点上整个脚印都有支撑（不再半个身子悬空）", on, total);
  }

  // ⑭ 环形菜单的**内容**：菜单是内容驱动的（`engine/objectActions`），清单为空就不出现 ——
  //    所以"该不该弹菜单"与"有哪些动作"是同一个答案。按数据钉住它，而不是靠肉眼确认。
  {
    const ids = (list: ObjectAction[]) => list.map((a) => a.id);
    const host = {
      ...box("BD", 0, 0, 10, 10, 24),
      category: "building",
      role: "set",
    } as DirectorObject;

    check(
      "§33 环形菜单：高台（building）有「台阶」",
      ids(objectActions(scene([host], "terrain"), host, 0)).includes("STAIR_LINK"),
      true,
    );
    // 已经是楼梯 → 不再提供「台阶」（楼梯连楼梯没有意义，还会互相压住）。
    const stairHost = { ...host, topShape: "stair" } as DirectorObject;
    check(
      "§33 环形菜单：目标已是楼梯 → 不提供「台阶」",
      ids(objectActions(scene([stairHost], "terrain"), stairHost, 0)).includes("STAIR_LINK"),
      false,
    );
    // planar 没有高度 → 台阶无从谈起（与 `topShape` / `baseY` 的生效前提一致）。
    check(
      "§33 环形菜单：planar 下不提供「台阶」",
      ids(objectActions(scene([host]), host, 0)).includes("STAIR_LINK"),
      false,
    );
    // 静态环境不参与运动 → 不提供 MOVE / ACTION（与工具栏手绘路径对 set 的门禁同一条理由）。
    const plain = box("PR", 0, 0, 1, 1, 1) as DirectorObject;
    const plainIds = ids(objectActions(scene([plain], "terrain"), plain, 0));
    check("§33 环形菜单：set 不提供 MOVE", plainIds.includes("MOVE"), false);
    check("§33 环形菜单：set 不提供 ACTION", plainIds.includes("ACTION"), false);
    // 演员那两套**原样保留**：这是已经调过的编排入口，行为不能变。
    const man = actor("A1", 0, 0);
    check(
      "§33 环形菜单：演员（空闲）仍是 4 项编排动作",
      ids(objectActions(scene([man], "terrain"), man, 0)),
      ["MOVE", "LOOK AT", "FOLLOW", "ACTION"],
    );
  }

  // ⑮ 高台连台阶的**规划**（环形菜单「台阶」的数学）。三处最容易悄悄错、且只在画面上
  //    看得出来的地方：**哪头是坡顶**（由两端面高决定，不由"谁被选中"决定）、总高必须是
  //    两端**实测**高差、两端锚点必须贴住各自的墙面（而不是捅进楼里 / 接到半空）。
  {
    const tower = {
      ...box("TW", 0, 0, 4, 4, 3),
      category: "building",
      role: "set",
    } as DirectorObject;
    const st = scene([tower], "terrain");

    // 作者最常见的点法：在高台上点「台阶」→ 点 6m 外的地面。
    // 若按"源 = 坡脚"实现，这里算出来就是"地面连到地面"（高差 0）—— 那是错的。
    const up = planStairLink(st, tower, undefined, 6, 0);
    check("§33 连台阶：高台 → 地面（朝向由高差决定，不是由谁被选中）", up.ok, true);
    if (up.ok) {
      check(
        "§33 连台阶：坡脚在地面、坡顶在楼顶",
        [round6(up.plan.startY), round6(up.plan.endY)],
        [0, 3],
      );
      check("§33 连台阶：总高 = 两端实测高差（不是作者填的）", round6(up.plan.rise), 3);
      check("§33 连台阶：坡脚 = 点的那一处", [round6(up.plan.start.x), round6(up.plan.start.z)], [6, 0]);
      check(
        "§33 连台阶：坡顶落在楼顶之内（没捅进墙里）",
        [up.plan.end.x > 0, up.plan.end.x < 2],
        [true, true],
      );
      check(
        "§33 连台阶：坡度是派生量 = atan(高差 / 水平距离)",
        round6(up.plan.slopeDeg),
        round6((Math.atan2(up.plan.rise, up.plan.run) * 180) / Math.PI),
      );
    }

    // 高台连更高的高台：从低台顶面爬到高台顶面。
    const peer = {
      ...box("T4", 12, 0, 6, 6, 5),
      category: "building",
      role: "set",
    } as DirectorObject;
    const pair = planStairLink(scene([tower, peer], "terrain"), tower, peer, 12, 0);
    check("§33 连台阶：高台连更高的高台，通过", pair.ok, true);
    if (pair.ok) {
      check(
        "§33 连台阶：坡脚在低台顶面、坡顶在高台顶面",
        [round6(pair.plan.startY), round6(pair.plan.endY)],
        [3, 5],
      );
    }

    // 太陡：24m 高台连 20m 外 ⇒ ≈58° > 45° ⇒ 拒绝，且话里带"至少多远"（照着改就能成）。
    const tall = {
      ...box("T2", 0, 0, 10, 10, 24),
      category: "building",
      role: "set",
    } as DirectorObject;
    const steep = planStairLink(scene([tall], "terrain"), tall, undefined, 20, 0);
    check("§33 连台阶：24m 高台连 20m 外 → 拒绝（太陡）", steep.ok, false);
    check(
      "§33 连台阶：拒绝话里给出「至少多远」",
      !steep.ok && steep.problem.text.includes("至少 24 m"),
      true,
    );

    // 两座等高的高台：高差 0 ⇒ 拒绝（台阶要有高差）。
    const flat = {
      ...box("T5", 12, 0, 6, 6, 3),
      category: "building",
      role: "set",
    } as DirectorObject;
    check(
      "§33 连台阶：两座等高高台 → 拒绝",
      planStairLink(scene([tower, flat], "terrain"), tower, flat, 12, 0).ok,
      false,
    );
  }

  // ⑯ 预览折线：`plan.points` 既是预览画的虚线、也是最终写进 `stair.path` 的那一份 ——
  //    所以"加点拉长折线 → 坡度变缓"必须真的成立在**同一份几何**上（否则作者看着变绿、
  //    生成出来还是红的），而"被拒时也要给出折线"是预览层能提供修法的前提。
  {
    const tower24 = {
      ...box("T9", 0, 0, 10, 10, 24),
      category: "building",
      role: "set",
    } as DirectorObject;
    const st9 = scene([tower24], "terrain");

    const straight = planStairLink(st9, tower24, undefined, 20, 0);
    check("§33 连台阶：先给一条太陡的直线（24m 高台连 20m 外）", straight.ok, false);
    // 这条是预览层的**契约**：几何问题也要把折线给出来，否则作者根本没有"改"的入口。
    check("§33 连台阶：被拒时仍给出折线（预览才画得出来）", (straight.plan?.points.length ?? 0) >= 2, true);

    const base = straight.plan!;
    const bends = insertBend(base, { x: 40, z: 0 });
    const stretched = planStairLink(st9, tower24, undefined, 20, 0, bends);
    check("§33 连台阶：加转折点后折线变长", stretched.plan!.run > base.run, true);
    check("§33 连台阶：加转折点后坡度变缓并通过", stretched.ok, true);
    check(
      "§33 连台阶：折线 = 坡脚 + 转折点 + 坡顶（顺序即路径顺序）",
      stretched.plan!.points.length,
      3,
    );
    check(
      "§33 连台阶：run 是折线长，不是两端直线距离",
      round6(stretched.plan!.run) !==
        round6(
          Math.hypot(
            stretched.plan!.end.x - stretched.plan!.start.x,
            stretched.plan!.end.z - stretched.plan!.start.z,
          ),
        ),
      true,
    );
    // 再加一个点：应当落在**离它最近的那一段**之后，已有的转折不被挪动。
    const two = insertBend(stretched.plan!, { x: 10, z: 0 });
    check(
      "§33 连台阶：加点落在最近的那一段之后（已有转折不打乱）",
      [round6(two[0].x), round6(two[1].x)],
      [40, 10],
    );
    check("§33 连台阶：两个转折点都在折线里", planStairLink(st9, tower24, undefined, 20, 0, two).plan!.points.length, 4);
  }

  // ⑰ 宽度：**人能通过的基本条件**（作者原话），所以它是创建时的输入项，不再是硬编码 1.8；
  //    并且要看得见 —— 预览里画出走廊的两条边界。
  {
    const tower3 = {
      ...box("TW3", 0, 0, 4, 4, 3),
      category: "building",
      role: "set",
    } as DirectorObject;
    const st3 = scene([tower3], "terrain");

    const def = planStairLink(st3, tower3, undefined, 6, 0);
    check("§33 连台阶：宽度默认值", round6(def.plan!.width), round6(DEFAULT_STAIR_WIDTH));

    // 比人的脚宽（0.6）还窄 ⇒ 拒绝。这不是"窄一点"，是人过不去 —— 与坡度同级。
    const narrow = planStairLink(st3, tower3, undefined, 6, 0, [], 0.5);
    check("§33 连台阶：宽度 0.5 m（< 人的脚宽 0.6）→ 拒绝", narrow.ok, false);
    check(
      "§33 连台阶：宽度拒绝的话里带两个数（当前 / 下限）",
      !narrow.ok && narrow.problem.text.includes("0.5") && narrow.problem.text.includes("0.6"),
      true,
    );
    // 不算太窄就不该拒绝 —— 否则"宽度可调"是假的。
    check("§33 连台阶：宽度 1.2 m 正常通过", planStairLink(st3, tower3, undefined, 6, 0, [], 1.2).ok, true);

    // 走廊边界：与折线等长、严格平行、横向相距 宽度/2（直线段上是精确值）。
    const wide = planStairLink(st3, tower3, undefined, 6, 0, [], 2).plan!;
    check(
      "§33 连台阶：两条走廊边界与折线点数一致",
      [wide.edges[0].length, wide.edges[1].length],
      [wide.points.length, wide.points.length],
    );
    check(
      "§33 连台阶：边界横向偏移 = 宽度/2",
      wide.edges.map((edge) =>
        edge.every((p, i) => Math.abs(Math.abs(p.z - wide.points[i].z) - wide.width / 2) < 1e-6),
      ),
      [true, true],
    );

    // `offsetPolyline` 本身：沿 +X 的直线，法线在 Z 上。
    const straightLine = [
      { x: 0, z: 0, y: 0 },
      { x: 2, z: 0, y: 1 },
      { x: 4, z: 0, y: 2 },
    ];
    const off = offsetPolyline(straightLine, 0.9);
    check("§33 折线偏移：横向恰为 ±lateral", off.map((p) => round6(p.z)), [-0.9, -0.9, -0.9]);
    check("§33 折线偏移：不改沿程与高度", off.map((p) => round6(p.x)), [0, 2, 4]);
  }

  // ⑱ 「走楼梯」：把楼梯自己的路径变成演员的路线。**不做第二次拟合** —— 楼梯的路径与
  //    演员走的路本来是同一件事，所以这里只加一段接近段；拒绝的两种都是"他上不去"。
  {
    const ids = (list: ObjectAction[]) => list.map((a) => a.id);
    // 直跑：d = 4 ⇒ 路径 4 m、总高 2 ⇒ 26.6°，人能走。
    const runStair = { ...box("SW", 0, 0, 2, 4, 2), topShape: "stair" } as DirectorObject;
    const man = actor("A1", 0, -6);
    const st = scene([runStair, man], "terrain");

    const walk = planStairWalk(st, runStair, man);
    check("§33 走楼梯：能走（26.6° < 45°）", walk.ok, true);
    if (walk.ok) {
      check("§33 走楼梯：路线 = 接近段 + 楼梯路径", walk.plan.points.length, 3);
      check("§33 走楼梯：接近段退到坡脚之外（不凭空出现在楼梯上）", round6(walk.plan.points[0].z), -2);
      check("§33 走楼梯：终点就是坡顶", round6(walk.plan.points[2].z), 4);
      check(
        "§33 走楼梯：中间点就是楼梯路径的第一个点（同一份几何）",
        [round6(walk.plan.points[1].x), round6(walk.plan.points[1].z)],
        [0, 0],
      );
    }

    // 太陡：6 m 高 / 4 m 路径 ⇒ 56° > 45° ⇒ 拒绝，话里带两个数。
    const steepStair = { ...box("SW2", 0, 0, 2, 4, 6), topShape: "stair" } as DirectorObject;
    const steepWalk = planStairWalk(scene([steepStair, man], "terrain"), steepStair, man);
    check("§33 走楼梯：太陡（56° > 45°）→ 拒绝", steepWalk.ok, false);
    check(
      "§33 走楼梯：拒绝话里带坡度与上限",
      !steepWalk.ok && steepWalk.text.includes("56") && steepWalk.text.includes("45"),
      true,
    );

    // 太窄：0.5 m 宽的楼梯装不下 0.6 m 宽的人 ⇒ 拒绝。
    const narrowStair = { ...box("SW3", 0, 0, 0.5, 4, 2), topShape: "stair" } as DirectorObject;
    check(
      "§33 走楼梯：太窄（0.5 < 0.6）→ 拒绝",
      planStairWalk(scene([narrowStair, man], "terrain"), narrowStair, man).ok,
      false,
    );

    // 同一条楼梯对不同主体结论不同：缓坡 + 1.5 m 宽 ⇒ 人走得（宽 0.6）、车走不得（宽 2.0）。
    const gentle = { ...box("SW4", 0, 0, 1.5, 4, 1), topShape: "stair" } as DirectorObject;
    const car = {
      ...box("CAR", 0, -8, 2, 4.2, 1.5),
      category: "vehicle",
      type: "actor",
      role: "agent",
    } as DirectorObject;
    const shared = scene([gentle, man, car], "terrain");
    check(
      "§33 走楼梯：同一条楼梯 —— 人走得、车走不得（按各自能力表）",
      [planStairWalk(shared, gentle, man).ok, planStairWalk(shared, gentle, car).ok],
      [true, false],
    );

    // 菜单内容：这一项只在**真有它走得上去的楼梯**时出现（与"点了能不能成"同一个答案）。
    check(
      "§33 环形菜单：有可走的楼梯 → 演员有「走楼梯」",
      ids(objectActions(st, man, 0)).includes("WALK_STAIR"),
      true,
    );
    check(
      "§33 环形菜单：场景里没有楼梯 → 不出现「走楼梯」",
      ids(objectActions(scene([man], "terrain"), man, 0)).includes("WALK_STAIR"),
      false,
    );
    check(
      "§33 环形菜单：只有太陡的楼梯 → 也不出现",
      ids(objectActions(scene([steepStair, man], "terrain"), man, 0)).includes("WALK_STAIR"),
      false,
    );

    // —— 真的走上去吗 ——
    // 光有"路线形状对"不算数：把这条路线喂给求解器 + 累进落脚，逐帧看**脚底高度**。
    // （这一条才拦得住"几何在升、人不动"那一类：数字自洽、画面不对。）
    const walkMan = actor("A2", 0, -6);
    const stWalkScene = scene([runStair, walkMan], "terrain");
    const planned = planStairWalk(stWalkScene, runStair, walkMan);
    if (planned.ok) {
      const route = planned.plan.points;
      const segWalk: MoveSegment = {
        ...seg("sWalk", "A2", [0, 0], [0, 0], { timeEnd: 8 }),
        startX: route[0].x,
        startZ: route[0].z,
        endX: route[route.length - 1].x,
        endZ: route[route.length - 1].z,
        points: route.map((p, i) => ({
          id: `wp${i}`,
          type: "path" as const,
          shape: "LINE" as const,
          x: p.x,
          z: p.z,
        })),
      };
      const stWalk: DirectorState = { ...stWalkScene, segments: [segWalk] };
      const man2 = stWalk.objects.find((o) => o.id === "A2") as DirectorObject;
      const ys: number[] = [];
      for (let i = 0; i <= 20; i += 1) {
        const t = (i / 20) * 8;
        const p = objectPosition(stWalk, "A2", t);
        ys.push(pathHeightAt(stWalk, man2, p.x, p.z, t));
      }
      check("§33 走楼梯：脚底高度单调不减（不会中途下陷）", ys.every((y, i) => i === 0 || y >= ys[i - 1] - 1e-6), true);
      check("§33 走楼梯：从地面起步（≈ 0）", round6(ys[0]) <= 0.05, true);
      check("§33 走楼梯：走到坡顶（≈ 总高 2）", ys[ys.length - 1] >= 1.9, true);
    }

    // —— 向下走 ——
    // 起点层高这一步是关键：向上走时路线起点**恰好**在地面（层高 0），所以不写也对；
    // 向下走时起点在楼顶，层高必须跟着路线起点，否则落脚链条从地面起步、人穿过楼梯。
    const upPlan = planStairWalk(st, runStair, man, "up");
    check("§33 走楼梯（上）：起点层高 = 地面（以前不写也对，是巧合）", upPlan.ok ? round6(upPlan.plan.startY) : -1, 0);

    const downPlan = planStairWalk(st, runStair, man, "down");
    check("§33 走楼梯：向下也能走", downPlan.ok, true);
    if (downPlan.ok) {
      check("§33 走楼梯（下）：路线 = 平台接近段 + 倒序路径", downPlan.plan.points.length, 3);
      check("§33 走楼梯（下）：起点落在到达平台上（不悬空）", round6(downPlan.plan.points[0].z), 5);
      check("§33 走楼梯（下）：终点就是坡脚", round6(downPlan.plan.points[2].z), 0);
      check("§33 走楼梯（下）：起点层高 = 楼顶 2（这是必须写回去的那个数）", round6(downPlan.plan.startY), 2);
    }

    // 抬高的楼梯（坡脚在 3 m）：**只能下来不能上去** —— 从地面一步迈不上 3 m。
    const elevated = { ...runStair, baseY: 3 } as DirectorObject;
    const stElevated = scene([elevated, man], "terrain");
    check(
      "§33 走楼梯：坡脚悬在 3 m → 向上拒绝（一步迈不上去）",
      planStairWalk(stElevated, elevated, man, "up").ok,
      false,
    );
    check(
      "§33 走楼梯：同一条楼梯向下走得成",
      planStairWalk(stElevated, elevated, man, "down").ok,
      true,
    );
    check(
      "§33 环形菜单：抬高的楼梯 → 只有「走下来」（菜单跟着可行性变）",
      ids(objectActions(stElevated, man, 0)).filter((id) => id.startsWith("WALK_")),
      ["WALK_STAIR_DOWN"],
    );
    check(
      "§33 环形菜单：两向都走得成 → 两项都在",
      (["WALK_STAIR", "WALK_STAIR_DOWN"] as const).map((want) =>
        ids(objectActions(st, man, 0)).includes(want),
      ),
      [true, true],
    );

    // —— 向下走的端到端：逐帧看脚底 ——
    const downMan = actor("A3", 0, 5);
    const stDownScene = scene([runStair, downMan], "terrain");
    if (downPlan.ok) {
      const routeDown = downPlan.plan.points;
      const segDown: MoveSegment = {
        ...seg("sDown", "A3", [0, 0], [0, 0], { timeEnd: 8 }),
        startX: routeDown[0].x,
        startZ: routeDown[0].z,
        endX: routeDown[routeDown.length - 1].x,
        endZ: routeDown[routeDown.length - 1].z,
        points: routeDown.map((p, i) => ({
          id: `dp${i}`,
          type: "path" as const,
          shape: "LINE" as const,
          x: p.x,
          z: p.z,
        })),
      };
      // 同一条路线、只换演员层高 —— 于是"层高该写什么"这件事被量出来，而不是靠推理。
      // `salt` 顶掉 `pathHeight.ts` 按 (对象, 段) 缓存的高度剖面：两次采样若共用同一
      // `revision`，第二次会拿到第一次的剖面（实测踩到过：反例量出来与正例一模一样）。
      const feetWith = (baseY: number, salt: number): number[] => {
        const world = {
          ...stDownScene,
          revision: stDownScene.revision + salt,
          objects: stDownScene.objects.map((o) => (o.id === "A3" ? { ...o, baseY } : o)),
          segments: [segDown],
        } as DirectorState;
        const who = world.objects.find((o) => o.id === "A3") as DirectorObject;
        const out: number[] = [];
        for (let i = 0; i <= 20; i += 1) {
          const t = (i / 20) * 8;
          const p = objectPosition(world, "A3", t);
          out.push(pathHeightAt(world, who, p.x, p.z, t));
        }
        return out;
      };
      const good = feetWith(downPlan.plan.startY, 1);
      check(
        "§33 走楼梯（下）：脚底从楼顶降到地面（首 ≈ 2、末 ≈ 0）",
        [good[0] > 1.9, good[good.length - 1] < 0.05],
        [true, true],
      );
      check("§33 走楼梯（下）：全程不回升", good.every((y, i) => i === 0 || y <= good[i - 1] + 1e-6), true);
      // 反例（这就是"层高必须跟着路线起点"的证明）：层高留在地面 0 ⇒ 链条从 0 起步，
      // 人贴地穿过整座楼梯。数字自洽、画面全错，所以把原因钉在这里而不是只写在注释里。
      const ignored = feetWith(0, 2);
      check("§33 走楼梯（下）：层高不写 → 链条从地面起步（人穿过楼梯）", round6(ignored[0]) <= 0.05, true);
    }
  }

  // ⑲ 走完楼梯之后：终点能不能落在**平台 / 楼顶**上。
  //
  // 作者的问法："楼梯连着一个 building，我能不能把这段 path 的终点设在那个平台上。"
  // 拆成两件事量，因为它们是两件事：
  //   ① 走上去的路线本来就收在楼梯顶端 —— 而连到 building 的台阶，顶端就落在楼顶边上；
  //   ② 把终点再往里挪到楼顶中间，**站位与落脚高度都要跟着对** —— 不能被避障推回去
  //      （building 对地面来说是障碍），也不能掉回地面。
  {
    const bld = {
      ...box("BLD", 0, 6, 8, 8, 3),
      category: "building",
      role: "set",
    } as DirectorObject;
    const actor9 = actor("A9", 0, -10);
    const baseWorld = scene([bld, actor9], "terrain");
    // 用「连台阶」的规划造出那段台阶（与 store 落库同一份几何，不用手写）。
    const link = planStairLink(baseWorld, bld, undefined, 0, -8, [], 1.8);
    check("§33 楼顶：台阶连到 building（16.6° < 45°）", link.ok, true);
    if (link.ok) {
      const stair = {
        id: "LNK",
        name: "台阶",
        type: "prop",
        category: "structure",
        role: "set",
        x: link.plan.start.x,
        z: link.plan.start.z,
        rotation: 0,
        topShape: "stair",
        stair: { path: link.plan.points.map((p, i) => ({ id: `sp${i}`, x: p.x, z: p.z })) },
        footprint: { w: link.plan.width, d: link.plan.run, h: link.plan.rise },
        baseY: link.plan.startY,
        color: "#8b9bb0",
      } as DirectorObject;
      const world0 = scene([bld, actor9, stair], "terrain");
      const walkUp = planStairWalk(world0, stair, actor9, "up");
      // 连台阶时"坡顶落在楼顶之内"：顶端在楼边（z = 2.0）往里 0.05 —— 也就是**站在楼顶上**。
      check(
        "§33 楼顶：台阶的顶端就在楼顶边上（往里 0.05，= 连台阶时接到的那个顶面）",
        [link.plan.end.z > 2, link.plan.end.z < 2.1],
        [true, true],
      );
      check(
        "§33 楼顶：走上去的终点 = 楼梯顶端（楼顶边上），不用手动改",
        walkUp.ok ? round6(walkUp.plan.points[walkUp.plan.points.length - 1].z) : -1,
        round6(link.plan.end.z),
      );

      const route = walkUp.ok ? walkUp.plan.points : [];
      if (route.length >= 2) {
        // 终点再往里 3 m（= 楼顶中间）：polyline 变成 [起点, ...路线点, 新终点]。
        const endZ = link.plan.end.z + 3;
        const segRoof: MoveSegment = {
          ...seg("sRoof", "A9", [0, 0], [0, 0], { timeEnd: 10 }),
          startX: route[0].x,
          startZ: route[0].z,
          endX: 0,
          endZ,
          points: route.slice(1).map((p, i) => ({
            id: `rp${i}`,
            type: "path" as const,
            shape: "LINE" as const,
            x: p.x,
            z: p.z,
          })),
        };
        const world: DirectorState = { ...world0, segments: [segRoof] };
        const who = world.objects.find((o) => o.id === "A9") as DirectorObject;
        const pEnd = objectPosition(world, "A9", 10);
        // 这两条原先记的是"已知取舍"（被截在楼前 + 高度与站位不同源）。`blockingRectsForSegment`
        // 的**端点层高判据**落地后它们应当翻成期望行为 —— 现在就是。
        check(
          "§33 楼顶：终点设在楼顶中间 → 他确实走到了那里（不再被截在楼前）",
          [round6(pEnd.x), round6(pEnd.z)],
          [0, round6(endZ)],
        );
        check(
          "§33 楼顶：脚底 = 楼顶高度（与站位同源，不是按作者进度硬取）",
          round6(pathHeightAt(world, who, pEnd.x, pEnd.z, 10)) >= 2.9,
          true,
        );

        // **反面（豁免的安全性）**：同一个世界里**没有**那段台阶、终点却照样画在楼里 ——
        // 他从地面迈不上 3 m 的楼顶，于是那个建筑**照旧是障碍**、照旧把他挡在楼外。
        // 这正是 `endpointOnTopExempts` 第 3 条判据（"他到底是不是走上来的"）在起作用：
        // 端点在障碍顶上只算必要条件，够不到那一层就不豁免 —— 所以豁免**不会让人穿墙**。
        const segWall: MoveSegment = {
          ...seg("sWall", "A9", [0, 0], [0, 0], { timeEnd: 10 }),
          startX: 0,
          startZ: -9.8,
          endX: 0,
          endZ,
          points: [],
        };
        const worldWall: DirectorState = { ...baseWorld, segments: [segWall] };
        check(
          "§33 楼顶：没有台阶却把终点画在楼里 → 照旧被挡在楼外（豁免不会让人穿墙）",
          round6(objectPosition(worldWall, "A9", 10).z) < 2,
          true,
        );
        // 全程看一眼：脚底从地面升到楼顶，且**走到楼顶之后平走**（不再上升）。
        const ys: number[] = [];
        for (let i = 0; i <= 20; i += 1) {
          const t = (i / 20) * 10;
          const p = objectPosition(world, "A9", t);
          ys.push(pathHeightAt(world, who, p.x, p.z, t));
        }
        check("§33 楼顶：脚底单调不减（不会中途下陷）", ys.every((y, i) => i === 0 || y >= ys[i - 1] - 1e-6), true);
        check(
          "§33 楼顶：到顶之后是**平走**（最后两段高度相同）",
          round6(ys[ys.length - 1]) === round6(ys[ys.length - 2]),
          true,
        );
      }
    }
  }
}

console.log("\n[34] 内容末尾：报数必须同时报名（「内容到 Xs」是谁顶的）");

// 时间轴顶栏那句「⚠ 内容到 12.0s」数的是四类里的最大 `timeEnd`：路段 / 约束 / 相机镜头 /
// 动作片段。它们**不一定都在视野里**（相机有自己的轨道、动作片段在折叠行、对象多了还要横向滚），
// 所以只报一个数字会把人卡住 —— 作者会对着"内容到 12s"在画面上找不到那 12s 是什么。
// 守卫钉两件事：末尾取对了，**出处也取对了**。
{
  const hero = actor("H1", 0, 0);
  const base = scene([hero], "terrain");
  const withSegs: DirectorState = {
    ...base,
    segments: [
      seg("SEG_A", "H1", [0, 0], [1, 0], { timeEnd: 5 }),
      seg("SEG_B", "H1", [1, 0], [2, 0], { timeEnd: 8 }),
    ],
  };

  const bySegment = contentEndCause(withSegs);
  check("[34] 内容末尾 = 最长的那一段", round6(bySegment.end), 8);
  check("[34] 并且指出是哪一个（SEG_B，挂在 H1 上）", [bySegment.kind, bySegment.id, bySegment.owner], [
    "segment",
    "SEG_B",
    "H1",
  ]);
  check(
    "[34] rawContentEnd 与出处同源（不会长出第二份算法）",
    round6(rawContentEnd(withSegs)),
    round6(bySegment.end),
  );

  // 动作片段顶到 12s：画面上那几条 MOVE 只到 8s —— 提示必须说出**是动作片段**。
  const withAction: DirectorState = {
    ...withSegs,
    actions: [
      { id: "ACT_1", object: "H1", kind: "hold", timeStart: 0, timeEnd: 12 } as unknown as ActionClip,
    ],
  };
  const byAction = contentEndCause(withAction);
  check("[34] 动作片段更长时，末尾与出处一起翻成它", [
    round6(byAction.end),
    byAction.kind,
    byAction.owner,
  ], [12, "action", "H1"]);

  // 相机镜头同理：相机有独立轨道，最容易被当成"画面上什么都没有"。
  const withCam: DirectorState = {
    ...withAction,
    cameraMoves: [
      { id: "MV_1", camera: "CAM_01", timeStart: 0, timeEnd: 15 } as unknown as CameraMove,
    ],
  };
  const byCam = contentEndCause(withCam);
  check("[34] 镜头更长时，出处翻成镜头（并报出是哪台相机）", [
    round6(byCam.end),
    byCam.kind,
    byCam.owner,
  ], [15, "camera", "CAM_01"]);

  check(
    "[34] 空场景：末尾 0、没有出处（调用点回退到片长）",
    [round6(contentEndCause(scene([], "terrain")).end), contentEndCause(scene([], "terrain")).id],
    [0, ""],
  );
}

console.log("\n[35] 姿势：作者可选 vs 阶段（自动）");

// `POSE_PRESETS` 是一张**按数据形状**分组的表（都是关节角），里面住着三类东西：
// 作者可选（静态/手势）、步态、以及**阶段姿势**（由弧线进度自动挑，不可选）。
// 下拉框曾经用"排除 walk/run"来过滤 —— 于是 6 个阶段姿势全漏成了"选了也不触发"的死选项。
// 这三条守卫把"三类不重不漏 + 可选项里绝不含阶段"钉死。
{
  const stance = new Set<string>(STANCE_POSE_NAMES);
  check(
    "[35] 作者可选的姿势里不含任何阶段姿势",
    AUTHOR_POSE_NAMES.filter((name) => stance.has(name)),
    [],
  );
  check(
    "[35] 阶段姿势确实都在预设表里（自动叠加要用）",
    STANCE_POSE_NAMES.every((name) => name in POSE_PRESETS),
    true,
  );
  check(
    "[35] 三类不重不漏（新增预设必须归类）",
    [...AUTHOR_POSE_NAMES, ...STANCE_POSE_NAMES, "walk", "run"].sort(),
    [...POSE_PRESET_NAMES].sort(),
  );
}

// 关节空间的「这个片段是什么姿势」只该有**一个**出处：方块简模与 GLB 骨骼共用
// `clipJointAngles`。曾经 GLB 只认动画片段名 —— `sit` / `point` / **自定义动作** 选了
// 完全没反应（`POSE_PRESETS` 与 `customActions` 它根本没读），而方块简模照做。
{
  const clip = (kind: ActionKind, extra?: Partial<ActionClip>): ActionClip => ({
    id: `A_${kind}`,
    object: "H1",
    timeStart: 0,
    timeEnd: 2,
    kind,
    ...extra,
  });
  const bare: DirectorState = { ...createBlankState(), actions: [], customActions: [] };

  // ① 每个**作者可选**的姿势都要能算出角度（`stand` = 标准站姿，本来就是全 0，故排除）。
  check(
    "[35] 每个可选姿势都能算出关节角（GLB 缺动画时的兜底）",
    AUTHOR_POSE_NAMES.filter(
      (kind) => kind !== "stand" && Object.keys(clipJointAngles(bare, clip(kind), 1)).length === 0,
    ),
    [],
  );

  // ② 自定义动作取的是「动作库」里那条记录 —— 漏了它，GLB 上的自定义动作永远是空姿势。
  const withLib: DirectorState = {
    ...bare,
    customActions: [{ id: "POSE_01", name: "敬礼", joints: { shoulderR: [-1, 0, 0] } }],
  };
  check(
    "[35] 自定义动作的角度取自动作库（不是空姿势）",
    Object.keys(clipJointAngles(withLib, clip("custom", { customId: "POSE_01" }), 1)),
    ["shoulderR"],
  );

  // ③ 合成 = 逐片段相加：`actionPoseAt` 只是把 `clipJointAngles` 累加，两边不会各自长歪。
  const stacked: DirectorState = { ...bare, actions: [clip("wave"), clip("crouch")] };
  const sum: Record<string, [number, number, number]> = {};
  for (const c of stacked.actions) {
    for (const [key, v] of Object.entries(clipJointAngles(stacked, c, 1))) {
      const cur = sum[key] ?? [0, 0, 0];
      sum[key] = [cur[0] + (v?.[0] ?? 0), cur[1] + (v?.[1] ?? 0), cur[2] + (v?.[2] ?? 0)];
    }
  }
  check(
    "[35] actionPoseAt = 逐片段 clipJointAngles 相加（唯一出处）",
    actionPoseAt(stacked, "H1", 1).pose.joints,
    sum,
  );

  // ④ 手势 kind 不得拿**代理片段**顶替：wave / talk 都映射到 agree 时，两者演成同一段点头。
  check(
    "[35] 手势不拿代理片段顶替（否则不同动作演成同一段）",
    (["wave", "point", "talk"] as const).filter(
      (kind) => (MODEL_CONFIG.human?.clips.poses as Record<string, unknown>)[kind],
    ),
    [],
  );
}

console.log("\n[36] 名字显示：场景三态 vs 个体（**场景更高一级**）");

// 导演定的规则：场景有更大的控制 —— 开会压过个体、关也压过个体，只有「默认」才把
// 控制权交给个体。这张真值表就是 engine/nameVisibility.ts 的全部语义，逐行钉死。
{
  check(
    "[36] 场景=开 → 压过个体（哪怕个体写 false）",
    [nameVisible("on", undefined), nameVisible("on", { showName: false })],
    [true, true],
  );
  check(
    "[36] 场景=关 → 压过个体（哪怕个体写 true）",
    [nameVisible("off", undefined), nameVisible("off", { showName: true })],
    [false, false],
  );
  check(
    "[36] 场景=默认 → 个体说话；个体不写 = 显示",
    [
      nameVisible("default", { showName: false }),
      nameVisible("default", { showName: true }),
      nameVisible("default", undefined),
      nameVisible(undefined, {}),
    ],
    [false, true, true, true],
  );
  check(
    "[36] 旧数据：布尔 true/false 按 开/关 解释",
    [nameVisible(true, { showName: true }), nameVisible(false, { showName: true })],
    [true, false],
  );
  check(
    "[36] 「场景是否接管」判据（个体开关据此置灰）",
    [
      sceneTakesOverNames("on"),
      sceneTakesOverNames("off"),
      sceneTakesOverNames("default"),
      sceneTakesOverNames(undefined),
    ],
    [true, true, false, false],
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);