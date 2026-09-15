import { DirectorObject, StairPathPoint } from "../domain/schema";

/**
 * 抽象楼梯（`topShape: "stair"`）的几何。
 *
 * ## 为什么把楼梯建模成一个整体
 *
 * 用一摞盒子拼楼梯有三个必然的毛病，且都不是"调参能解决"的：
 *
 * 1. **每级都是一次 y 突变**。人走上去时身体一级一跳，相机跟着弹，只能靠事后低通去抹
 *    （见 `pathHeightAt` 的台阶 y 低通）—— 那是治标。
 * 2. **必须逐块标 `blocking: false`**。`isPassable` 拿最矮那块比 `maxStep`，而高处的那些块
 *    从地面看就是墙，于是演员会**绕过整座楼梯**而不是走上去。
 * 3. **不能拐弯**。转向要自己摆两块盒子去凑，接缝、标高全靠手工对齐。
 *
 * 抽象成一个整体后，作者只画一条**路径**（与资产 / 相机路径同一套逻辑）：楼梯沿它上升，
 * 转角即拐弯，**急转**处自动铺方形休息平台（缓转按连续曲面接上，见 `LANDING_MIN_TURN`）。
 * **物理上是连续坡面**（不是一级级台阶），
 * 所以第 1 条从根上消失；第 2 条由"坡脚在 maxStep 内即可走上去"解决
 * （见 `avoidance.isPassable`）；第 3 条由折线直接表达。
 *
 * 坡度、每段的高都是**派生量**：`tan(坡度) = 总高 / 路径水平长度`，每段按弧长均摊总高。
 * 踏步只用于**渲染**（`stairRuns` + `STAIR_VISUAL_STEP`），与物理无关 ——
 * 与 `ramp` 一样是"视觉近似、物理精确"，只是这次的近似更贴近实物。
 *
 * ## 约定
 *
 * - 路径点是**世界坐标**；缺省（不足 2 点）时退回一段直跑：沿对象局部 +Z、
 *   长度取 `footprint.d`（于是 `D` 滑杆对"没画路径"的楼梯仍然管用）。
 * - 起始高度 = `objectBottom`，终点高度 = `objectTop`（即 `footprint.h` 就是总高）。
 * - 走廊宽度 = `footprint.w`，整条路径共用一个宽度。
 * - **水平延伸 = 路径长**：急转处的休息平台是**从路径里扣除**的（吃掉两侧边各半个宽度），
 *   所以**末端（最后一个路径点）正好到达总高** —— 作者画的线就是人走的那条线。
 * - **顶端另有到达平台**：从最后一个路径点再往外铺一块边长 = 宽度的平台（接在路径
 *   **之外**，不占路径长度）。没有它，站在路线终点上的人有半个脚印探在楼梯外
 *   （点查询看不见，画面上就是"悬空"）。
 * - `planar` 下不参与（`topShape` 与 `baseY` 只在 terrain 生效），由各调用点短路。
 *
 * ## 纯函数 / 零分配
 *
 * `walkStair` 是唯一的遍历实现：热路径（`topAt` / `coversXZ`，每帧几十~上百次）
 * 传 `out = null`，**不分配任何对象**（两趟循环：先求总长，再走一遍）；
 * 渲染 / 包围盒走 `stairRuns` 才收集数组。单一实现保证"能站哪"与"画在哪"不会分叉。
 */

/** 一段可站立面：梯跑（`y0 → y1` 线性上升）或转角平台（`y0 === y1`）。 */
export interface StairRun {
  /** 该段起点（世界坐标）。 */
  x: number;
  z: number;
  /** 行进方向（弧度，yaw 约定：0 = +Z）。 */
  heading: number;
  /** 沿行进方向的长度（米）。 */
  length: number;
  y0: number;
  y1: number;
  halfWidth: number;
}

/** 只用于渲染的踏步级高（米）。细分出来的"视觉台阶"不参与任何判定。 */
export const STAIR_VISUAL_STEP = 0.16;

/** 一段梯跑细分出来的一块**视觉踏步**（仅渲染，不参与任何判定）。 */
export interface StairTread {
  /** 踏步**中心**（世界坐标）。 */
  x: number;
  z: number;
  /** 行进方向（与所属梯跑一致）。盒子的长边必须沿它排 —— 见 `stairTreads`。 */
  heading: number;
  /** 沿行进方向的长度（= 该段长度 / 级数）。 */
  length: number;
  /** 横向半宽（= 所属梯跑的半宽）。 */
  halfWidth: number;
  /** 该踏步的顶面高度（世界米）。 */
  top: number;
}

/**
 * 把每段梯跑按 `STAIR_VISUAL_STEP` 细分成踏步（渲染）。
 *
 * **展开方向只有一个出处**：踏步中心 = 所属梯跑的起点 + 行进方向 × 到该级中心。
 * 渲染层只负责把中心换算到局部坐标 —— 曾经渲染层自己算这个偏移、把步子沿**垂直于**
 * 梯跑的方向排开（盒子长边在 Z、位置却沿 X 递增），于是整座楼梯看着不像楼梯、
 * 人物悬在半空：数字全对，图全错。§33 用「直线梯的踏步中心横向恒 0、沿程铺满」钉住。
 */
export function stairTreads(object: DirectorObject): StairTread[] {
  const out: StairTread[] = [];
  for (const run of stairRuns(object)) {
    const rise = run.y1 - run.y0;
    const steps = Math.max(1, Math.round(rise / STAIR_VISUAL_STEP) || 1);
    const stepLen = run.length / steps;
    const s = Math.sin(run.heading);
    const c = Math.cos(run.heading);
    for (let k = 0; k < steps; k += 1) {
      const along = (k + 0.5) * stepLen;
      out.push({
        x: run.x + s * along,
        z: run.z + c * along,
        heading: run.heading,
        length: stepLen,
        halfWidth: run.halfWidth,
        top: run.y0 + rise * ((k + 1) / steps),
      });
    }
  }
  return out;
}

const DEG = Math.PI / 180;
const EPS = 1e-6;

/**
 * 铺休息平台的**最小转角**（度）。
 *
 * 不足 40° 的转折按"连续曲面"直接接上：螺旋路径每段只转 15°（一圈 24 段），
 * 若逐点插平台，每段都要再走一个「平台长度 = 楼梯宽度」的水平段 ——
 * 几何会逐段外扩（实测半径 1.6m 的螺旋被拉到 22m，梯段从 24 段变成 47 段），
 * 楼梯也变成一串平台而不是螺旋。
 */
const LANDING_MIN_TURN = 40;

/** 两条朝向之间的最小夹角（度，0..180）。 */
function turnDeg(a: number, b: number): number {
  const d = ((a - b) / DEG) % 360;
  return Math.abs(((d + 540) % 360) - 180);
}

/** 生效的水平路线：作者画的路径（≥2 点），否则退回沿局部 +Z 的一段直跑。 */
export function stairPathOf(object: DirectorObject): Array<{ x: number; z: number }> {
  const path = object.stair?.path;
  if (path && path.length >= 2) return path;
  const theta = object.rotation * DEG;
  const d = Math.max(0, object.footprint.d);
  return [
    { x: object.x, z: object.z },
    { x: object.x + Math.sin(theta) * d, z: object.z + Math.cos(theta) * d },
  ];
}

/** 路径水平总长（米）。 */
export function stairRunLength(object: DirectorObject): number {
  const pts = stairPathOf(object);
  let sum = 0;
  for (let i = 1; i < pts.length; i += 1) {
    sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return sum;
}

/** 坡度（度）：**派生量** = atan(总高 / 路径水平长度)。路径退化时钳到 89°。 */
export function stairSlopeDeg(object: DirectorObject): number {
  const run = stairRunLength(object);
  if (run <= EPS) return 89;
  return (Math.atan2(Math.max(0, object.footprint.h), run) * 180) / Math.PI;
}

/**
 * 单段命中测试：点在段内则返回该处高度，否则 `null`。
 * 局部坐标换算与 `ground.topAt` 同源（`along` 是沿行进方向、`lat` 是横向）。
 */
function hitRun(run: StairRun, x: number, z: number): number | null {
  const dx = x - run.x;
  const dz = z - run.z;
  const s = Math.sin(run.heading);
  const c = Math.cos(run.heading);
  const along = dx * s + dz * c;
  if (along < -EPS || along > run.length + EPS) return null;
  const lat = dx * c - dz * s;
  if (Math.abs(lat) > run.halfWidth + EPS) return null;
  const t = run.length <= EPS ? 0 : Math.min(1, Math.max(0, along / run.length));
  return run.y0 + (run.y1 - run.y0) * t;
}

/**
 * 唯一的梯段遍历：沿路径逐边铺梯跑，**急转**处铺一段水平休息平台，顶端铺到达平台。
 *
 * **转角平台是从路径里扣除的**（吃掉两侧边各 `landing/2`）—— 于是水平延伸 = 路径长，
 * 末端正好在**最后一个路径点**到达总高，作者画的那条线就是人走的那条线。
 * 梯跑与平台在拐角处铺满、不留空洞；短边把裁切量夹住时两者会重叠，重叠处取**最高面**
 * （与离散盒子堆叠同一条语义：谁在上面谁说了算）。
 *
 * **顶端到达平台接在路径之外**（外扩一个宽度）：它是"到达面"，用来让站在路线终点上的人
 * 整个脚印都有支撑 —— 所以它不参与 `flightsRun`，也不改变"末端到顶"。
 *
 * `out === null` → 只测 `(x, z)` 是否落在某段上，返回该处高度（`NaN` = 不在任何段上），
 * **零分配**；`out !== null` → 收集每一段（渲染 / 包围盒 / Inspector），返回值无意义。
 */
function walkStair(object: DirectorObject, x: number, z: number, out: StairRun[] | null): number {
  const halfWidth = object.footprint.w / 2;
  const total = object.footprint.h;
  if (halfWidth <= EPS || total <= EPS) return Number.NaN;

  const pts = stairPathOf(object);
  if (pts.length < 2) return Number.NaN;

  const landing = object.footprint.w;

  // 第一趟：**梯跑**总长。
  // 平台从路径里**扣除**（占掉两侧边各 landing/2），所以先算"扣完平台后还剩多少梯跑"，
  // 每段的高按它均摊。于是：**水平延伸 = 路径长**，末端正好在**最后一个路径点**到达总高。
  // （早先是"平台额外接在转折点之后"：几何比作者画的路径长出一段、末端永远到不了顶 ——
  //   作者在路径末端量不到总高，读不懂自己对出来的线。）
  let flightsRun = 0;
  let prevHeading = Number.NaN;
  for (let i = 1; i < pts.length; i += 1) {
    const ex = pts[i].x - pts[i - 1].x;
    const ez = pts[i].z - pts[i - 1].z;
    const len = Math.hypot(ex, ez);
    if (len <= EPS) continue;
    const heading = Math.atan2(ex, ez);
    const tailLen =
      i + 1 < pts.length ? Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) : 0;
    const tailHeading =
      i + 1 < pts.length ? Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) : 0;
    const trimStart =
      !Number.isNaN(prevHeading) && turnDeg(heading, prevHeading) >= LANDING_MIN_TURN
        ? Math.min(landing / 2, len / 2)
        : 0;
    const trimEnd =
      tailLen > EPS && turnDeg(tailHeading, heading) >= LANDING_MIN_TURN
        ? Math.min(landing / 2, len / 2)
        : 0;
    flightsRun += Math.max(0, len - trimStart - trimEnd);
    prevHeading = heading;
  }
  if (flightsRun <= EPS) return Number.NaN;

  let px = pts[0].x;
  let pz = pts[0].z;
  let py = object.bottom ?? object.baseY ?? 0;
  let hitY = Number.NaN;
  // 上一条边在"当前顶点"被平台吃掉的份额（= 平台的入射侧）。一个转折点只铺一次：
  // 在**出射**那条边上处理（否则同一拐角会被处理两遍、平台叠两层）。
  let prevTrimEnd = 0;
  prevHeading = Number.NaN;

  for (let i = 1; i < pts.length; i += 1) {
    const ex = pts[i].x - pts[i - 1].x;
    const ez = pts[i].z - pts[i - 1].z;
    const len = Math.hypot(ex, ez);
    if (len <= EPS) continue;
    const heading = Math.atan2(ex, ez);
    const tailLen =
      i + 1 < pts.length ? Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) : 0;
    const tailHeading =
      i + 1 < pts.length ? Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z) : 0;

    // 该边两端是不是紧邻**急转**：是则各被平台吃掉 landing/2。
    // 只对急转铺平台：缓转（螺旋每段十几度）本是连续曲面，逐点插平台会把几何逐段外扩
    // （见 LANDING_MIN_TURN）。缓转处两段矩形在顶点共享，只在最外缘留一个
    // ≤ 半宽·tan(Δ/2) 的小楔口，而人走的中线始终被覆盖。
    const trimStart =
      !Number.isNaN(prevHeading) && turnDeg(heading, prevHeading) >= LANDING_MIN_TURN
        ? Math.min(landing / 2, len / 2)
        : 0;
    const trimEnd =
      tailLen > EPS && turnDeg(tailHeading, heading) >= LANDING_MIN_TURN
        ? Math.min(landing / 2, len / 2)
        : 0;

    // 休息平台：边长 = 楼梯宽度、**以转折点为中心**（沿入射方向表达）。
    // 沿路径的长度取两侧被吃掉的实际份额 `prevTrimEnd + trimStart`（短边会被夹住，
    // 平台不该沿路径外伸），横向半宽 = 宽度的一半 —— 正常情况就是个正方平台。
    if (trimStart > 0) {
      const run: StairRun = {
        x: px - Math.sin(prevHeading) * prevTrimEnd,
        z: pz - Math.cos(prevHeading) * prevTrimEnd,
        heading: prevHeading,
        length: prevTrimEnd + trimStart,
        y0: py,
        y1: py,
        halfWidth: landing / 2,
      };
      if (out) out.push(run);
      else {
        const h = hitRun(run, x, z);
        if (h !== null && (Number.isNaN(hitY) || h > hitY)) hitY = h;
      }
    }

    const flen = Math.max(0, len - trimStart - trimEnd);
    const rise = (total * flen) / flightsRun;
    if (flen > EPS) {
      const run: StairRun = {
        x: px + Math.sin(heading) * trimStart,
        z: pz + Math.cos(heading) * trimStart,
        heading,
        length: flen,
        y0: py,
        y1: py + rise,
        halfWidth,
      };
      if (out) out.push(run);
      else {
        const h = hitRun(run, x, z);
        if (h !== null && (Number.isNaN(hitY) || h > hitY)) hitY = h;
      }
    }
    px += ex;
    pz += ez;
    py += rise;
    prevHeading = heading;
    prevTrimEnd = trimEnd;
  }

  // **顶端到达平台**：从最后一个路径点再往外铺一块边长 = 楼梯宽度的水平平台。
  //
  // 为什么必须有（这是"人悬空"的正解，不是装饰）：走廊在**路径最后一点**就结束了，
  // 而人是个 footprint 盒子（0.6×0.6）—— 站在路线终点上时（走完的人、摆在上面的配角）
  // 一半脚印探在楼梯外，画面上就是"人悬在半空"。实测：0.6 见方的脚印只有 56% 有支撑。
  // 位置判据是**点查询**（`supportUnder(x, z)`），所以它看不见"半个身子在外面"这件事 ——
  // 只能由几何兜住：让终点之外也有一块能站的面。
  //
  // 它接在路径**之外**（不占路径长度），所以两条不变量都不破：
  // 水平延伸仍 = 路径长 + 一个宽度、末端（路径最后一点）仍然正好是总高。
  if (!Number.isNaN(prevHeading) && landing > EPS) {
    const run: StairRun = {
      x: px,
      z: pz,
      heading: prevHeading,
      length: landing,
      y0: py,
      y1: py,
      halfWidth,
    };
    if (out) out.push(run);
    else {
      const h = hitRun(run, x, z);
      if (h !== null && (Number.isNaN(hitY) || h > hitY)) hitY = h;
    }
  }
  return out ? Number.NaN : hitY;
}

/** `(x, z)` 处楼梯的顶面高度；不在楼梯上返回 `NaN`。热路径，零分配。 */
export function stairHitAt(object: DirectorObject, x: number, z: number): number {
  return walkStair(object, x, z, null);
}

/** `(x, z)` 是否落在楼梯的水平投影内。热路径，零分配。 */
export function stairCoversXZ(object: DirectorObject, x: number, z: number): boolean {
  return !Number.isNaN(walkStair(object, x, z, null));
}

/** 分段列出每一段（渲染 / 包围盒 / Inspector）。冷路径。 */
export function stairRuns(object: DirectorObject): StairRun[] {
  const out: StairRun[] = [];
  walkStair(object, Number.NaN, Number.NaN, out);
  return out;
}

/** 楼梯的**世界 AABB**（含转折）。不依赖 `footprint.d` —— 它是几何反推的结果。 */
export function stairBounds(object: DirectorObject): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const runs = stairRuns(object);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const c = Math.cos(run.heading);
    const s = Math.sin(run.heading);
    // 段的四个角：沿 ±length、横向 ±halfWidth。
    for (const [a, l] of [
      [0, -run.halfWidth],
      [0, run.halfWidth],
      [run.length, -run.halfWidth],
      [run.length, run.halfWidth],
    ] as Array<[number, number]>) {
      const wx = run.x + s * a + c * l;
      const wz = run.z + c * a - s * l;
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }
  }
  if (!Number.isFinite(minX)) return { minX: object.x, maxX: object.x, minZ: object.z, maxZ: object.z };
  return { minX, maxX, minZ, maxZ };
}

/**
 * 以对象原点为中心的外接半尺寸（**保守超集**）。
 *
 * 与 `ground.objectHalfExtents` 同一契约：调用方按 `object.x ± hx` 取盒，
 * 所以这里必须让盒子**覆盖**全部梯跑 —— 拐弯楼梯的 AABB 未必以原点为中心，
 * 取两侧的较大值即可（多覆盖一点无害，漏覆盖会让桶索引查不到它）。
 */
export function stairHalfExtents(object: DirectorObject): { hx: number; hz: number } {
  const b = stairBounds(object);
  return {
    hx: Math.max(Math.abs(b.minX - object.x), Math.abs(b.maxX - object.x)),
    hz: Math.max(Math.abs(b.minZ - object.z), Math.abs(b.maxZ - object.z)),
  };
}

/** 楼梯的 AABB 矩形（遮挡 / 碰撞用；中心是 AABB 的真实中心，不是对象原点）。 */
export function stairRect(object: DirectorObject): { x: number; z: number; w: number; d: number } {
  const b = stairBounds(object);
  return {
    x: (b.minX + b.maxX) / 2,
    z: (b.minZ + b.maxZ) / 2,
    w: Math.max(EPS, b.maxX - b.minX),
    d: Math.max(EPS, b.maxZ - b.minZ),
  };
}

/**
 * 单段顶面的**有符号平面** `(nx, ny, nz, c)`（法线指向 +Y 侧）。
 *
 * 面内两方向：沿行进（抬起 `incline`）与横向；法线取二者叉积。
 * 平台（`rise = 0`）自然退化成水平面。渲染 / 拾取 / 坡面姿态共用这一份，
 * 各写各的就会出现"画在坡上、站姿却是平的"（红线 5）。
 */
export function runPlane(run: StairRun): { nx: number; ny: number; nz: number; c: number } {
  const rise = run.y1 - run.y0;
  const incline = Math.atan2(rise, Math.max(run.length, EPS));
  const s = Math.sin(run.heading);
  const c = Math.cos(run.heading);
  const nx = -s * Math.sin(incline);
  const ny = Math.cos(incline);
  const nz = -c * Math.sin(incline);
  return { nx, ny, nz, c: -(nx * run.x + ny * run.y0 + nz * run.z) };
}

/** `(x, z)` 落在哪一段上；不落则 `null`。**冷路径**（会分配），供拾取 / 姿态使用。 */
export function stairRunAt(object: DirectorObject, x: number, z: number): StairRun | null {
  for (const run of stairRuns(object)) {
    if (hitRun(run, x, z) !== null) return run;
  }
  return null;
}

/* --------------------------------------------------------- 画布上的路径点把手 */

/** 把手球心离楼梯表面的抬升（米）。渲染与命中必须用同一个数，否则"看得见却点不中"。 */
export const STAIR_HANDLE_LIFT = 0.12;

/**
 * 路径点把手的落点高度（世界米）：**贴在楼梯表面上**（作者拖的就是"面在哪拐"）。
 * 退化情形（点不在任何梯段上）回落到顶面高度。
 */
export function stairHandleY(object: DirectorObject, x: number, z: number): number {
  const y = stairHitAt(object, x, z);
  // 顶面高度内联（不引 ground.ts：那会与 `ground → stair` 形成环）。
  return Number.isNaN(y) ? (object.baseY ?? 0) + object.footprint.h : y;
}

/* ------------------------------------------------------------ 路径的三种来源 */

let helixSeq = 0;

/**
 * **螺旋楼梯**的路径：绕一个中心转 `turns` 圈的一段圆。
 *
 * 返回的就是一条**普通路径**（世界坐标）—— 存进 `stair.path` 之后，坡度派生、转角平台、
 * 踏步网格、画布拖拽全部照旧，没有第二套机制。踏步宽 = `footprint.w`，环绕在路径两侧，
 * 于是这一条圆路径画出来就是常见的螺旋梯。
 *
 * 起点 = 对象原点、起始切向 = `rotation` 朝向；圆心在起点的**右手侧** `radius` 处，
 * 因此第一段是切向进入圆弧，起点不会出现折角。圈数与半径决定路径总长，
 * 总高仍由 `footprint.h` 给 —— 坡度 = `atan(高 / 弧长)`，弧长变了坡度自然跟着变。
 */
export function helixStairPath(
  object: DirectorObject,
  radius: number,
  turns: number,
): StairPathPoint[] {
  const r = Math.max(0.3, radius);
  const t = Math.max(0.25, Math.min(6, turns));
  const theta = object.rotation * DEG;
  // yaw 约定：朝向 = (sinθ, cosθ)；右手侧 = 朝向 +90° = (cosθ, −sinθ)。
  const cx = object.x + Math.cos(theta) * r;
  const cz = object.z - Math.sin(theta) * r;
  // 圆心→起点的单位向量 u；与之构成前进方向的 v（在起点处切向 = 朝向）。
  const ux = -Math.cos(theta);
  const uz = Math.sin(theta);
  const vx = Math.sin(theta);
  const vz = Math.cos(theta);

  // 每圈 24 段：折线弦长与理论弧长的差约 0.1%（实心螺旋梯的视觉也够圆）。
  const n = Math.max(12, Math.ceil(t * 24));
  const seq = (helixSeq += 1);
  const out: StairPathPoint[] = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (i / n) * t * Math.PI * 2;
    out.push({
      id: `HSL_${seq}_${i}`,
      x: cx + r * (Math.cos(a) * ux + Math.sin(a) * vx),
      z: cz + r * (Math.cos(a) * uz + Math.sin(a) * vz),
    });
  }
  return out;
}
