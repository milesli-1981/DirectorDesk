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
import { DirectorObject, DirectorState, MoveSegment, Locomotion } from "../src/domain/schema";

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exit(1);