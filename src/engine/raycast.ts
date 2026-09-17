import * as THREE from "three";
import { DirectorObject, DirectorState } from "../domain/schema";
import { coversXZ, objectBottom, objectTop, topAt } from "./ground";
import {
  runPlane,
  stairHitAt,
  stairRunAt,
  stairRunHeightAt,
  stairRuns,
  stairSlopeDeg,
} from "./stair";
import { effectiveState, worldModeOf } from "./worldMode";

/**
 * 3D 拾取：射线打在哪个**可站立面**上。
 *
 * 与 `groundPoint()`（把射线投到无限平面 y=0）的分工 —— 这里有个容易踩的坑：
 *
 * > 射线按面拾取会拿到正确的高度，但**水平坐标在面的边界处会跳**。
 * > 从地面移到 3m 平台的顶面时，交点会沿视线方向突然前移 `h / tan(俯角)`；
 * > 30° 俯角下就是 5.2m。拿它当拖拽目标，物体在越过棱边的瞬间会瞬移。
 *
 * 所以职责拆开：
 * - **水平坐标** 仍由 `groundPoint()` 的 y=0 平面投影给（连续、跟手、与扩展前逐像素一致）
 * - **高度 / 所在层** 由本模块给（射线真正打到哪个面上）
 *
 * 这也正是总纲决策 4 的原话：「路径决定 x/z 与朝向，几何决定 y」。
 *
 * planar 模式下本模块**只测 y=0 基准面**，于是 layer 恒为 0，与扩展前完全一致。
 */

const EPS = 1e-6;

export interface SurfaceHit {
  x: number;
  y: number;
  z: number;
  /** 命中面所属对象的 id；null = 基准面 y = 0。 */
  objectId: string | null;
  /** 命中面在其对象内的坡度（度）。基准面为 0。 */
  slopeDeg: number;
  /** 沿射线的参数（= 距离，方向为单位向量时）。 */
  distance: number;
}

/* ------------------------------------------------------------- 射线 ↔ 盒 */

/**
 * 射线与轴对齐盒求交（slab 法），返回**进入**参数 t；未命中返回 null。
 *
 * @param padding 盒外扩量。拾取时按抓取容差外扩，让"擦边点中"也能选上。
 */
export function rayBoxEnter(
  ray: THREE.Ray,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  padding = 0,
): number | null {
  const o = ray.origin;
  const d = ray.direction;
  let tMin = -Infinity;
  let tMax = Infinity;

  // 逐轴收窄 [tMin, tMax]。轴分量趋零时退化成"此时是否已在板内"的一步判断。
  // 三轴展开写而不是循环数组：本函数对每个对象调用一次，别在热路径上分配。

  // X
  if (Math.abs(d.x) < EPS) {
    if (o.x < minX - padding || o.x > maxX + padding) return null;
  } else {
    const inv = 1 / d.x;
    let t1 = (minX - padding - o.x) * inv;
    let t2 = (maxX + padding - o.x) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  // Y
  if (Math.abs(d.y) < EPS) {
    if (o.y < minY - padding || o.y > maxY + padding) return null;
  } else {
    const inv = 1 / d.y;
    let t1 = (minY - padding - o.y) * inv;
    let t2 = (maxY + padding - o.y) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  // Z
  if (Math.abs(d.z) < EPS) {
    if (o.z < minZ - padding || o.z > maxZ + padding) return null;
  } else {
    const inv = 1 / d.z;
    let t1 = (minZ - padding - o.z) * inv;
    let t2 = (maxZ + padding - o.z) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMax < 0) return null;
  return tMin > 0 ? tMin : 0;
}

/* --------------------------------------------------- 射线 ↔ 对象实体盒 */

const _boxRay = new THREE.Ray();
const _boxOffset = new THREE.Vector3();
const _boxRot = new THREE.Matrix4();

/**
 * 射线与对象的实体盒求交（**rotation 生效**），返回进入参数 t。
 *
 * 做法：把射线变换到对象的局部坐标系（先平移到对象中心、再绕 Y 反旋），
 * 之后就是标准的轴对齐 slab 测试。因为只有旋转没有缩放，局部 t 就是世界 t。
 *
 * 与 `coversXZ` 的改动同源：渲染是转的，判定就必须是转的。用裸 AABB 的话，
 * 把 10×1 的墙转 90°，点击 5m 外的地方也会选中它。
 *
 * @param bottomY / topY 实体盒的上下沿（世界 y）。运动对象的 y 由落脚高度决定，不是 0。
 */
export function rayObjectBox(
  ray: THREE.Ray,
  object: DirectorObject,
  bottomY: number,
  topY: number,
  padding = 0,
): number | null {
  const hw = object.footprint.w / 2;
  const hd = object.footprint.d / 2;
  if (!object.rotation) {
    return rayBoxEnter(
      ray,
      object.x - hw,
      bottomY,
      object.z - hd,
      object.x + hw,
      topY,
      object.z + hd,
      padding,
    );
  }
  _boxOffset.set(object.x, 0, object.z);
  _boxRay.copy(ray);
  _boxRay.origin.sub(_boxOffset);
  _boxRot.makeRotationY((-object.rotation * Math.PI) / 180);
  _boxRay.applyMatrix4(_boxRot);
  return rayBoxEnter(_boxRay, -hw, bottomY, -hd, hw, topY, hd, padding);
}

/* ----------------------------------------------------- 射线 ↔ 顶面（含坡道） */

/**
 * 顶面所在的无符号平面：`nx·x + ny·y + nz·z + c = 0`。
 *
 * flat  → `y = top`
 * ramp  → 由 `topAt` 的线性式反推。`topAt` 给的是
 *         `y = bottom + h/2 + (h/d)·[(x−cx)·sinθ + (z−cz)·cosθ]`，
 *         整理即得下面的系数。两者必须同源，否则"画在哪"与"能站哪"会分叉。
 *
 * 返回 null 表示该对象没有可站立的顶面（高度为 0 等退化情形）。
 *
 * **导出给 `engine/stance.ts`**：坡面姿态（pitch/roll）需要的法线就是这个平面的法线。
 * 渲染层另写一份坡面法线会重演红线 5 的坑（屏幕上看在那里、姿态却对不上）。
 */
export function topPlaneOf(
  object: DirectorObject,
  x?: number,
  z?: number,
): { nx: number; ny: number; nz: number; c: number } | null {
  const bottom = objectBottom(object);
  const top = objectTop(object);
  const h = top - bottom;
  if (h <= EPS) return null;
  if (object.topShape === "stair") {
    // 折线顶面**没有单一平面**：给了 (x, z) 就取该点所在那一段的平面（姿态因此正确）；
    // 没给就退化成水平面 —— 只在"问不到位置"时发生，不会用于求交（求交走 `rayStairTop`）。
    const run = x === undefined || z === undefined ? null : stairRunAt(object, x, z);
    const seg = run ?? stairRuns(object)[0];
    if (!seg) return { nx: 0, ny: 1, nz: 0, c: -top };
    return runPlane(seg);
  }
  if (object.topShape !== "ramp" || object.footprint.d <= EPS) {
    return { nx: 0, ny: 1, nz: 0, c: -top };
  }
  const theta = (object.rotation * Math.PI) / 180;
  const s = Math.sin(theta);
  const co = Math.cos(theta);
  const k = h / object.footprint.d;
  return {
    nx: -k * s,
    ny: 1,
    nz: -k * co,
    c: -(bottom + h / 2 - k * (object.x * s + object.z * co)),
  };
}

/** 对象顶面的坡度（度）：flat = 0，ramp = atan(h / d)，stair = 作者给的坡度。 */
export function topSlopeDeg(object: DirectorObject): number {
  if (object.topShape === "stair") return stairSlopeDeg(object);
  if (object.topShape !== "ramp" || object.footprint.d <= EPS) return 0;
  const h = objectTop(object) - objectBottom(object);
  return (Math.atan2(h, object.footprint.d) * 180) / Math.PI;
}

/** 射线与一个平面求交；返回沿射线的 t（仅正值）。 */
function rayPlaneIntersect(
  ray: THREE.Ray,
  plane: { nx: number; ny: number; nz: number; c: number },
): number | null {
  const o = ray.origin;
  const d = ray.direction;
  const denom = plane.nx * d.x + plane.ny * d.y + plane.nz * d.z;
  if (Math.abs(denom) < EPS) return null;
  const t = -(plane.nx * o.x + plane.ny * o.y + plane.nz * o.z + plane.c) / denom;
  return t > EPS ? t : null;
}

/**
 * 楼梯顶面与射线的交：**逐段求交取最近的那个**。
 *
 * 平面是无限的、段是有限的，所以命中点还要用**单段**判据复核 —— 落在别的段上就被否掉，
 * 由那一段自己的那次迭代接住（别在这里用全局的 `stairHitAt`，那会把循环变成 O(段数²)）。
 */
function rayStairTop(ray: THREE.Ray, object: DirectorObject): number | null {
  const o = ray.origin;
  const d = ray.direction;
  let best: number | null = null;
  // 兜底候选：落点不落在**这一段**里、但仍可能落在整条楼梯的占用面上。
  // 楼梯是折线 + 圆角拼出来的，弯道上各段又短又斜，射线完全可能从两段的缝里穿过 ——
  // 作者看到的就是"整条楼梯怎么点都点不中"（多点几次、换个位置又能中）。
  let fallback: number | null = null;
  for (const run of stairRuns(object)) {
    const plane = runPlane(run);
    const t = rayPlaneIntersect(ray, plane);
    if (t === null) continue;
    if (best !== null && t >= best) continue;
    const px = o.x + d.x * t;
    const pz = o.z + d.z * t;
    // 平面是无限的、段是有限的 ⇒ 落点必须真的在**这一段**里（单段版的权威判据）。
    // 别在这里调 `stairHitAt`：那是 O(段数) 的全局查询，套在逐段循环里就成了 O(段数²)——
    // 圆角之后的段数足够多，一次拾取就能卡住。
    if (stairRunHeightAt(run, px, pz) === null) {
      if (fallback === null || t < fallback) fallback = t;
      continue;
    }
    best = t;
  }
  if (best !== null || fallback === null) return best;
  // 兜底：把"最近的那个穿缝落点"拿到全局占用面上验一次（**只验一次**，不是每段一次）。
  const fx = o.x + d.x * fallback;
  const fz = o.z + d.z * fallback;
  return stairHitAt(object, fx, fz) !== null ? fallback : null;
}

/** 射线与该对象顶面的交（不校验 footprint 归属）；返回沿射线的 t。 */
function rayTopPlane(ray: THREE.Ray, object: DirectorObject): number | null {
  // 楼梯是折线顶面，没有单一平面 —— 逐段求交。
  if (object.topShape === "stair") return rayStairTop(ray, object);
  const plane = topPlaneOf(object);
  if (!plane) return null;
  return rayPlaneIntersect(ray, plane);
}

/** 射线与水平面 `y = y0` 的交；返回沿射线的 t。 */
export function rayPlaneT(ray: THREE.Ray, y0: number): number | null {
  const d = ray.direction.y;
  if (Math.abs(d) < EPS) return null;
  const t = (y0 - ray.origin.y) / d;
  return t > EPS ? t : null;
}

/* ------------------------------------------------------------- 地面拾取 */

/** 取对象在 (x, z) 处的顶面高度。斜坡 / 楼梯按局部坐标插值，与 topAt 同源。 */
function surfaceY(object: DirectorObject, x: number, z: number): number {
  return topAt(object, x, z);
}

/**
 * 拾取射线命中的可站立面。
 *
 * 候选 = 基准面 y=0 + 所有 set 对象的顶面。取最近的那个；
 * 但**优先取未被遮挡的**：若某个盒体的侧面挡在候选与相机之间（射线先进入该盒），
 * 那么"看得见"的候选才是导演真正指着的东西。
 *
 * 关键取舍：**遮挡只做偏好，不做硬过滤。** 若所有候选都被遮挡，仍返回最近的那个
 * （可能被挡在后面），而不是返回 null。理由：拖拽中途突然"这一帧没有落点"会让物体卡住，
 * 比"落点略微偏差"糟糕得多 —— 宁可指偏，不可卡死。
 *
 * planar 模式只保留基准面候选 → layer 恒 0，与扩展前一致。
 *
 * @param forceTerrain 本次交互强制按 3D 语义拾取（按住 Shift）。
 *   只放开"指着哪一层"这一件事，不动世界模式本身 —— 见 `engine/worldMode` 的说明。
 * @param excludeIds 本次手势正在移动的对象集合，**必须排除**。见下面这段 —— 不排除会自激振荡。
 *   用集合而非单个 id：团队拖拽时整队都在动，每一个成员都可能是指针身下的那一块。
 */
export function raycastGround(
  state: DirectorState,
  ray: THREE.Ray,
  forceTerrain?: boolean,
  excludeIds?: ReadonlySet<string>,
): SurfaceHit | null {
  const s = effectiveState(state, forceTerrain);
  const planar = worldModeOf(s) === "planar";

  let nearest: SurfaceHit | null = null;
  let nearestVisible: SurfaceHit | null = null;
  // 射线进入各个盒体的最小 t（= 第一个挡在路上的实体面）。只用于判定候选是否被遮挡。
  let firstSolid = Infinity;

  if (!planar) {
    for (const object of s.objects) {
      // 被拖动的对象同样不参与"遮挡"判定：它正跟着指针走，
      // 若不排除就会把自己身后的一切都判成"看不见的"。
      if (excludeIds?.has(object.id)) continue;
      if (object.role !== "set" || object.hidden) continue;
      const enter = rayObjectBox(ray, object, objectBottom(object), objectTop(object));
      if (enter !== null && enter < firstSolid) firstSolid = enter;
    }
  }

  const consider = (hit: SurfaceHit) => {
    if (!nearest || hit.distance < nearest.distance) nearest = hit;
    if (hit.distance <= firstSolid + EPS) {
      if (!nearestVisible || hit.distance < nearestVisible.distance) nearestVisible = hit;
    }
  };

  // 基准面：一切都不能填满，总要有个兜底。
  const tPlane = rayPlaneT(ray, 0);
  if (tPlane !== null) {
    consider({
      x: ray.origin.x + ray.direction.x * tPlane,
      y: 0,
      z: ray.origin.z + ray.direction.z * tPlane,
      objectId: null,
      slopeDeg: 0,
      distance: tPlane,
    });
  }

  if (!planar) {
    for (const object of s.objects) {
      // **排除正在被移动的对象**，否则会自激振荡。
      //
      // 这是个"自指"问题：拖动时物体跟着指针走 ⇒ 指针总压在它身上 ⇒
      // 拾取到的是**它自己的顶面** ⇒ `baseY = 自己的顶面 = baseY + h`。
      // 每帧涨一个身高：斜视相机下它抬高 `h/tan(俯角)` 后会漂出指针射线，
      // 于是又落回地面，下一帧再被拾取 —— 表现为 1→0→1→0 每帧翻转的疯狂抖动，
      // 永远落不下来。俯视相机（射线垂直于顶面）则表现为一路向上飞出画布。
      //
      // 注意这**不是 Shift 的锅**：只要"被拖动的对象参与拾取"，terrain 模式
      // （3D 开关打开）下的普通拖拽、拖入新资产，都会犯同一个错。
      // Shift 只是让 planar 世界第一次有了"抬高自己"的可能，于是把它暴露了出来。
      //
      // 排除之后，"指针下面的面"才是真正该落脚的那一层：盒子被拖到平台上方时，
      // 射线穿过它自己继续往下，命中的是平台顶面 ⇒ 稳稳叠上去。
      if (excludeIds?.has(object.id)) continue;
      // 与地面查询保持同一套候选规则：只有静态环境能作为落脚面，且要显式可站。
      if (object.role !== "set" || object.hidden || object.walkable === false) continue;
      const t = rayTopPlane(ray, object);
      if (t === null) continue;
      const x = ray.origin.x + ray.direction.x * t;
      const z = ray.origin.z + ray.direction.z * t;
      // 顶面是"面"，必须落在对象自己的水平轮廓里 —— coversXZ 按局部坐标判，rotation 生效。
      if (!coversXZ(object, x, z)) continue;
      consider({
        x,
        y: surfaceY(object, x, z),
        z,
        objectId: object.id,
        slopeDeg: topSlopeDeg(object),
        distance: t,
      });
    }
  }

  return nearestVisible ?? nearest;
}

/**
 * 只要"指针指着哪一层"的便捷形式。planar 恒 0。
 * 供拖拽 / 拖放落点决定 `baseY` 用。
 *
 * @param excludeIds 本次手势正在移动的对象（拖拽必须传，否则会自激振荡，见 `raycastGround`）。
 */
export function layerAtPointer(
  state: DirectorState,
  ray: THREE.Ray,
  forceTerrain?: boolean,
  excludeIds?: ReadonlySet<string>,
): SurfaceHit | null {
  return raycastGround(state, ray, forceTerrain, excludeIds);
}
