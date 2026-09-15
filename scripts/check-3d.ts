/* 3D 空间扩展的几何自检。用 `npm run check:3d` 运行。 */
import * as THREE from "three";
import { createBlankState } from "../src/engine/demoShot";
import {
  groundHeightAt,
  objectBottom,
  objectTop,
  pathGroundAt,
  restingHeightAt,
  snapElevation,
  standingHeightFor,
  supportUnder,
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
import { cameraAnchorHeight, solveCamera } from "../src/engine/cameraSolver";
import {
  AIRBORNE_EPS,
  airborneOf,
  arcPitchOf,
  pelvisLiftOf,
  slopeDegOf,
  stanceOf,
  surfaceAt,
  tiltFor,
} from "../src/engine/stance";
import { DirectorObject, DirectorState, MoveSegment, Locomotion, CameraObject } from "../src/domain/schema";

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
  check("§26 不可达文案：说人话带数字", scan[0].message, "下落 3.00 米太高，最多 1.90 米");
  check("§26 落差文案：", reachMessage(6, -1.5, 0.6, 0, loco), "下落 1.50m");
  check(
    "§26 往上不可达文案：点名攀爬能力",
    reachMessage(3, 2.5, 0.3, 0, loco),
    "这里落差 2.50 米，超过攀爬能力 1.60 米",
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
  check("§27 拖下 3m 台：文案说人话带数字", tallHint?.message, "下落 3.00 米太高，最多 1.90 米");

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
  // ① 平地（planar）必须逐值等于扩展前的绝对米数。这是本 Phase 的**硬回归**：
  //    任何相对化写错都会立刻在这里红。
  {
    const s = camScene([actor("H", 0, 0)], [cam("C", "H")]);
    const r = solveCamera(s, "C", 0)!;
    // eye_level = 1.7，chest = 1.35（原绝对值）
    check("§28 planar eye_level：机位 y = 1.7", round6(r.position[1]), 1.7);
    check("§28 planar：注视点 y = 1.55（演员眼高）", round6(r.target[1]), 1.55);
    const s2 = camScene([actor("H", 0, 0)], [cam("C", "H", { view: "chest" })]);
    check("§28 planar chest：机位 y = 1.35", round6(solveCamera(s2, "C", 0)!.position[1]), 1.35);
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
    check("§28 站在 3m 平台：视高相对化 → 机位 y = 3 + 1.7", round6(r.position[1]), 4.7);
    check("§28 站在 3m 平台：注视点 y = 3 + 1.55", round6(r.target[1]), 4.55);
  }

  // ④ 关键陷阱自查：**不能**写成 target[1] + VIEW_HEIGHT —— 
  //    那会让每个视角凭空多抬一个眼高（1.55）。这里断言"机位 - 地面 == VIEW_HEIGHT"。
  {
    const s = camScene(
      [box("P", 0, 0, 4, 4, 3, 0), actor("H", 0, 0, 3)],
      [cam("C", "H", { view: "low" })],
      [],
      "terrain",
    );
    const r = solveCamera(s, "C", 0)!;
    check("§28 陷阱自查：机位 − 地面 == VIEW_HEIGHT[low] == 0.9", round6(r.position[1] - 3), 0.9);
    check("§28 陷阱自查：机位 ≠ 注视点 + VIEW_HEIGHT", round6(r.position[1]) === round6(r.target[1] + 0.9), false);
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
    // 且全程"不离地"—— 否则这条用例会退化成在测跳跃，失去它存在的意义。
    let maxAir = 0;
    for (let i = 0; i <= 10; i += 1) {
      const t = (i / 10) * 2;
      const z = -4 + 8 * (i / 10);
      const air =
        pathHeightAt(walk, walk.objects[1], 0, z, t) -
        standingHeightFor(walk, walk.objects[1], 0, z);
      maxAir = Math.max(maxAir, air);
    }
    check("§29 缓坡步行：全程不离地（离地量 ≈ 0）", round6(maxAir), 0);
  }
}

console.log("\n[30] 相机避障");
{
  // 一堵墙正好压住默认机位（eye_level 1.7 的高处盒子）。
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
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);