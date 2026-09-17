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
 * 转角即拐弯，而且**急转是圆的**（作者的原话："不要做硬转，做弧度"）：每个急转顶点被内切掉
 * 一段等半径圆弧（见 `filletPath`），弧上每段的折角都很小 ⇒ 直接落进"缓转 = 连续曲面"
 * 那条既有通道：不铺平台、不补角、转角也不会"宽出来"，踏步沿弧自然铺开。
 * 弧是折线近似的，段与段之间那一丝外侧楔口由相邻两段**互相重叠**填掉（各自沿自身方向
 * 延伸 `半宽·tan(Δ/2)`）—— 实测转角上整个脚印 100% 站得住。
 * 只有圆角放不下（相邻段太短）时才退回"硬角 + 平台 / 补角"兜底（见 `LANDING_MIN_TURN`）。
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

/**
 * 「悬空板」楼梯的踏板厚度（米）：`stair.solid === false` 时，每级只留这么厚的一块板。
 *
 * 与 `STAIR_VISUAL_STEP`（级高）同量级但略薄 —— 视觉上读得出"这是板、不是台阶"，
 * 又不会薄到像纸片。**只影响渲染**（物理是连续坡面，见 `StairSpec.solid` 的说明）。
 */
export const STAIR_TREAD_THICKNESS = 0.12;

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

/**
 * 超过这个转角就不再"沿两段走廊探出去补角"（miter），改铺一块方形平台。
 * （只对**圆角放不下**的那种硬角生效：正常路径的急转已经被 `filletPath` 圆掉了。）
 *
 * miter 的探出量是 `(w/2)·tan(Δ/2)`，在折返角上随 tan 发散 —— Δ→180° 时长出一条尖舌。
 * 135° 处探出量 ≈ 2.4 × 半宽，还在"看起来像两段梯跑咬在一起"的范围里；
 * 再钝就该摆了（真实回折梯也是在折返处放一块平台，而不是让两条梯跑咬成尖角）。
 */
const MITER_MAX_TURN = 135;

/**
 * 多大以上的转角才**圆角**（度）。
 *
 * 门槛放在"急转"之下、螺旋每段之上：螺旋路径每段只转 15°（它本来就是一条连续曲面），
 * 再给每个采样点切圆角只会把盒子数量翻倍、还把"路径长 = 弦长和"精确成立的那条钉子拔掉。
 * 而 ≥ 20° 的折角是**看得出来**的硬角 —— 那才是要圆掉的东西。
 */
const ROUND_MIN_TURN = 20;

/**
 * 圆弧的离散粒度（度）：切出的每段折角都很小 ⇒ 每段都落在"缓转 = 连续曲面"区间里。
 *
 * 别调太小：弧上每段都会变成**一段梯跑 + 若干踏步网格**，粒度直接乘到渲染与查询的成本上
 * （5° 时一个 90° 拐角 = 19 段，8° = 11 段）。而外侧轮廓由相邻段的重叠 miter 填成真弧，
 * 所以调粗并不"变方"—— 台阶扇面细一点粗一点，肉眼都在"圆弧"这一档里。
 */
const ROUND_STEP_DEG = 8;

/** 两条朝向之间的最小夹角（度，0..180）。 */
function turnDeg(a: number, b: number): number {
  const d = ((a - b) / DEG) % 360;
  return Math.abs(((d + 540) % 360) - 180);
}

/**
 * **把折线里的硬角换成圆弧**（内切圆角，与 CAD 的 fillet 同一套）。
 *
 * 为什么圆：硬角处两段走廊的端面必然对不上 —— 要么裂一个楔口、要么得拿一块平台去补，
 * 而那块平台一定**比梯跑宽**（作者看到的就是"转角宽出来一块"）。换成**等半径圆弧**之后，
 * 弧上每一段的折角都很小，直接落进"缓转 = 连续曲面"那条既有通道（螺旋梯就是这么走的）：
 * 不铺平台、不补角、不宽出来，踏步还会沿弧自然铺开 —— 看上去就是一段弯梯。
 *
 * 半径全是**派生量**（作者不用填）：
 *   · ≤ `w/2`（半个梯宽）—— 再大就成了绕圈的旋转楼梯；
 *   · ≤ `0.85·(w/2)/(sec(Δ/2) − 1)`：**保证作者画的那个转折点仍落在梯段内**（它到圆弧的
 *     横向偏移 = `R·(sec(Δ/2) − 1)` ≤ 0.85 个半宽）。这条不能省 —— 路径点把手就钉在
 *     那个点上，它一旦掉出梯段，把手就"看得见却点不中"（见 `stairHandleY` 与 §33 拾取）；
 *   · ≤ 由相邻两段的**长度**夹住（切点不越过段中点，否则相邻两个圆角会互相吃掉）。
 * 半径小到没意义就直接**不圆**：留给急转的平台 / 补角去兜底 —— 那种拐角看着硬，
 * 但至少接缝有面、没有洞（见 `walkStair` 里的接缝处理）。
 */
function filletPath(
  pts: Array<{ x: number; z: number }>,
  halfWidth: number,
): Array<{ x: number; z: number; arc?: boolean }> {
  if (pts.length < 3 || halfWidth <= EPS) return pts;
  const out: Array<{ x: number; z: number; arc?: boolean }> = [pts[0]];
  // 上一段的**实际起点**：上一个圆角的切点（没圆就是原顶点）。相邻段的可用长度从它算起。
  let cx = pts[0].x;
  let cz = pts[0].z;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const vx = pts[i].x;
    const vz = pts[i].z;
    const nx = pts[i + 1].x;
    const nz = pts[i + 1].z;
    const inLen = Math.hypot(vx - cx, vz - cz);
    const outLen = Math.hypot(nx - vx, nz - vz);
    // 退化点（重合）直接丢掉：留着只会喂给下面一次 0/0。
    if (inLen <= EPS || outLen <= EPS) continue;
    const uix = (vx - cx) / inLen;
    const uiz = (vz - cz) / inLen;
    const uox = (nx - vx) / outLen;
    const uoz = (nz - vz) / outLen;
    const cosT = Math.min(1, Math.max(-1, uix * uox + uiz * uoz));
    const turn = Math.acos(cosT);
    const sinT = Math.sin(turn);
    const half = turn / 2;
    const tanHalf = Math.tan(half);
    if ((turn * 180) / Math.PI >= ROUND_MIN_TURN && sinT > EPS) {
      const radius = Math.min(
        halfWidth,
        (0.85 * halfWidth * Math.cos(half)) / Math.max(EPS, 1 - Math.cos(half)),
        (0.5 * Math.min(inLen, outLen)) / Math.max(EPS, tanHalf),
      );
      const t = radius * tanHalf;
      if (radius > 0.01 && t <= 0.5 * Math.min(inLen, outLen) + EPS) {
        // 圆心：从**入射切点**沿"入射方向指向出射方向"的法向偏 R。
        // 解 `(C−Tin)⊥u_in` 与 `(C−Tout)⊥u_out` 得 `C = Tin + R·n̂`，
        // 其中 `n̂ = (u_out − cosΔ·u_in)/sinΔ`（垂直于 u_in、指向拐弯那一侧）。
        const nrx = (uox - cosT * uix) / sinT;
        const nrz = (uoz - cosT * uiz) / sinT;
        const tinX = vx - uix * t;
        const tinZ = vz - uiz * t;
        const toutX = vx + uox * t;
        const toutZ = vz + uoz * t;
        const ox = tinX + nrx * radius;
        const oz = tinZ + nrz * radius;
        const a0 = Math.atan2(tinX - ox, tinZ - oz);
        let dA = Math.atan2(toutX - ox, toutZ - oz) - a0;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        // **取奇数段**：让弧的中点落在某一段的**正中**，而不是两段的缝上。
        // 作者画的那个转折点正好在弧的中点上（它是弧上离转折点最近的点）—— 落在缝上就会掉进
        // 外侧楔口里：点查询报"不在梯段上"，把手立刻变成"看得见却点不中"（见 §33 拾取）。
        let steps = Math.max(2, Math.round((turn * 180) / Math.PI / ROUND_STEP_DEG));
        if (steps % 2 === 0) steps += 1;
        out.push({ x: tinX, z: tinZ });
        for (let k = 1; k < steps; k += 1) {
          const a = a0 + (dA * k) / steps;
          out.push({ x: ox + radius * Math.sin(a), z: oz + radius * Math.cos(a) });
        }
        // 收尾用**切点本身**（不用累加出来的角度），免得浮点误差让接缝错开一丝。
        out.push({ x: toutX, z: toutZ });
        // `arc: true` 标出"这些点是圆角切出来的"——`walkStair` 据此把外侧的楔口补掉
        // （折线近似圆弧，每段之间必然留一个 ≤ 半宽·tan(粒度/2) 的三角缺口）。
        for (let k = out.length - (steps + 1); k < out.length; k += 1) out[k].arc = true;
        cx = toutX;
        cz = toutZ;
        continue;
      }
    }
    out.push({ x: vx, z: vz });
    cx = vx;
    cz = vz;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * **人真正走的那条线**：作者画的路径，但急转处的硬角已被 `filletPath` 换成圆弧。
 *
 * 渲染、拾取、坡度、走线规划全都走它 —— 于是"坡度是派生量""水平延伸 = 路径长"
 * 这些不变量都对着**真实几何**成立。作者画的折线（`stairPathOf`）只用来记路径点 /
 * 画把手：每个转折点都还在梯段内（见 `filletPath` 的半径上限）。
 */
export function stairWalkPathOf(object: DirectorObject): Array<{ x: number; z: number }> {
  return stairGeomOf(object).walk;
}

/**
 * 每座楼梯的几何缓存（圆角走线 + 水平包围盒 + 段表）。
 *
 * 为什么必须缓存：`stairHitAt` / `stairCoversXZ` 是**热路径** —— 演员落地、绕障、路径
 * 检查、画布拾取每帧都会问它。而圆角要跑一行三角函数、还要分配一整条新折线
 * （一个急转 = 十几个点）。把圆角直接接进热路径之后，页面立刻卡了（实测）。
 *
 * 失效判据 = **路径数组的引用**：本项目所有写入点都是不可变的
 * `{ ...object, stair: { path: next } }`（store 的 `updateAsset`、画布拖点、Inspector），
 * 所以引用一变就是新形状；几何查询于是退化成"一次 WeakMap 查表 + 一次引用比较 +
 * 一次包围盒判定"，不再重建任何几何。
 */
interface StairGeom {
  pathRef: unknown;
  walk: Array<{ x: number; z: number; arc?: boolean }>;
  runs: StairRun[];
  hasRuns: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const stairGeomCache = new WeakMap<DirectorObject, StairGeom>();

/** 取（必要时重建）该对象的圆角走线与包围盒；段表惰性重建（只有渲染 / 包围盒要）。 */
function stairGeomOf(object: DirectorObject): StairGeom {
  const path = stairPathOf(object);
  let geom = stairGeomCache.get(object);
  if (!geom) {
    geom = {
      pathRef: null,
      walk: [],
      runs: [],
      hasRuns: false,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
    };
    stairGeomCache.set(object, geom);
  }
  if (geom.pathRef !== path) {
    geom.pathRef = path;
    geom.walk = filletPath(path, object.footprint.w / 2);
    geom.hasRuns = false;
    // 包围盒 = 走线 ± 半宽，末端再放一个到达平台。查询绝大多数落在盒外 ——
    // 早退一次就省掉整条折线的遍历（这是热路径上最便宜的那道闸）。
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const p of geom.walk) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const pad = object.footprint.w + object.footprint.w / 2;
    geom.minX = minX - pad;
    geom.maxX = maxX + pad;
    geom.minZ = minZ - pad;
    geom.maxZ = maxZ + pad;
  }
  return geom;
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

/** **走线**的水平总长（米）——圆角之后那条线，与几何 / 坡度同源。 */
export function stairRunLength(object: DirectorObject): number {
  const pts = stairWalkPathOf(object);
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
 * 唯一的梯段遍历：沿**圆角之后**的走线逐边铺梯跑，顶端铺到达平台。
 *
 * 急转已经被 `filletPath` 圆成一段弧 ⇒ 弧上每段折角都很小，落进"缓转 = 连续曲面"那条通道：
 * 不铺平台、不补角、转角也不会宽出来。相邻两段在拐角处**故意重叠**一点点（各自沿自身方向
 * 延伸 `半宽·tan(Δ/2)`），把"折线近似圆弧"留下的外侧楔口填掉 —— 于是角上整个脚印都站得住。
 * 重叠处取**最高面**（与离散盒子堆叠同一条语义：谁在上面谁说了算）。
 * 只有圆角放不下（相邻段太短）时才退回平台 / 补角，且**平台从路径里扣除**（吃掉两侧
 * 各 `landing/2`）⇒ 水平延伸 = 路径长、末端正好在**最后一个路径点**到达总高。
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

  // 人走的是**圆角之后**那条线（见 `filletPath`）：急转不再是硬角，而是一段圆弧。
  // 走线与包围盒都取自缓存 —— 这是热路径，不能每次查询都重跑一遍圆角。
  const geom = stairGeomOf(object);
  const pts = geom.walk;
  if (pts.length < 2) return Number.NaN;
  // 早退：不在包围盒里就不必逐段测（绝大多数查询离得很远）。`NaN` 入参不会命中任何比较，
  // 所以"只想取段表"的调用（`stairRuns` 传 `NaN`）照常走完全程。
  if (out === null && (x < geom.minX || x > geom.maxX || z < geom.minZ || z > geom.maxZ)) {
    return Number.NaN;
  }

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
  // 圆角把折线切成一小段一小段之后，每两段之间会留一个"折线近似圆弧"的三角楔口
  // （≤ 半宽·tan(粒度/2)）。**那是真的缺口**：点查询看不见它、脚印会漏下去
  // （实测：站在转角上 0.6 见方的脚印只有 27% 有支撑）。所以把每段沿**自身方向**
  // 延伸 miter 长度 `半宽·tan(Δ/2)` —— 两块一叠，楔口正好填满，而横向仍然只占走廊
  // 自己的宽度（不会"宽出来"）。高度按**本段坡度外推**，于是
  // "水平延伸 = 路径长、末端到顶"那本账（`flightsRun`）一分不动。
  let prevSeamLen = 0;
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

    // 接缝：**不是拿一块"方块"去盖**（无论那块方块是"边长 = 宽度"还是"边长够包住接缝"——
    // 后者为了包住接缝会做得比梯跑还宽，转角就"宽出来一块"，那不对），
    // 而是让两段走廊各自沿**自身方向**探出去补角（经典 miter）：
    //
    //   · 入射侧：从入射梯跑被切掉的地方（转折点 − w/2·u）补到 转折点 + miter·u；
    //   · 出射侧：从 转折点 − miter·v 补到出射梯跑的起点（转折点 + w/2·v）。
    //
    // 探出量 = 两段走廊外缘交点离转折点的距离 = `(w/2)·tan(Δ/2)`。
    // 两块都**只占走廊自己的宽度**（半宽 = w/2）—— 这就是"转角不该宽出来"的保证。
    // 90° 时两块**重合**（正好是原来的 w×w 方形平台，逐值不变），只铺一块免得共面打架；
    // 其余角度两块并起来恰好填满两段端面之间的缺口。
    //
    // 折返角（> `MITER_MAX_TURN`）改成方形平台，见该常量。
    //
    // 梯跑被吃掉的份额（`trimStart` / `prevTrimEnd`）仍按 `landing/2` 算 —— 那是
    // "水平延伸 = 路径长、末端到顶"这条不变量的账；补角只是把缺口填上，
    // 与相邻梯跑重叠处取**最高面**（与离散盒子堆叠同一条语义）。
    if (trimStart > 0) {
      const half = landing / 2;
      const turn = (turnDeg(heading, prevHeading) * Math.PI) / 180;
      const at = (head: number, ax: number, az: number, length: number, hw: number): StairRun => ({
        x: ax,
        z: az,
        heading: head,
        length,
        y0: py,
        y1: py,
        halfWidth: hw,
      });
      const seam: StairRun[] = [];
      if (turn <= (MITER_MAX_TURN * Math.PI) / 180) {
        const miter = half * Math.tan(turn / 2);
        seam.push(
          at(
            prevHeading,
            px - Math.sin(prevHeading) * half,
            pz - Math.cos(prevHeading) * half,
            half + miter,
            half,
          ),
        );
        // 90° 时"出射侧那块"与上面那块是**同一块**（同位置同尺寸），别铺两遍。
        if (Math.abs(turn - Math.PI / 2) > 1e-9) {
          seam.push(
            at(
              heading,
              px - Math.sin(heading) * miter,
              pz - Math.cos(heading) * miter,
              half + miter,
              half,
            ),
          );
        }
      } else {
        // 方形平台：边长 = 能包住两段端面的大小 `(w/2)·(|cosΔ| + |sinΔ|)`（90° 时 = 宽度）。
        const cover = half * (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn)));
        seam.push(
          at(
            prevHeading,
            px - Math.sin(prevHeading) * cover,
            pz - Math.cos(prevHeading) * cover,
            cover * 2,
            cover,
          ),
        );
      }
      for (const run of seam) {
        if (out) out.push(run);
        else {
          const h = hitRun(run, x, z);
          if (h !== null && (Number.isNaN(hitY) || h > hitY)) hitY = h;
        }
      }
    }

    const flen = Math.max(0, len - trimStart - trimEnd);
    const rise = (total * flen) / flightsRun;
    // 本段两端的"填缝延伸"：只对**圆角切出来的**顶点做（`pts[·].arc`）。缓转 / 螺旋维持原样
    // （它们的楔口是既定口径：中线始终有面，见 LANDING_MIN_TURN）。
    const seamStart = prevSeamLen;
    const seamEnd =
      pts[i].arc === true && tailLen > EPS
        ? halfWidth * Math.tan((turnDeg(tailHeading, heading) * DEG) / 2)
        : 0;
    if (flen > EPS) {
      const slope = rise / flen;
      const run: StairRun = {
        x: px + Math.sin(heading) * (trimStart - seamStart),
        z: pz + Math.cos(heading) * (trimStart - seamStart),
        heading,
        length: flen + seamStart + seamEnd,
        y0: py - seamStart * slope,
        y1: py + rise + seamEnd * slope,
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
    prevSeamLen = seamEnd;
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

/**
 * `(x, z)` 处楼梯的顶面高度；不在楼梯上返回 `NaN`。**热路径**。
 *
 * 快在哪：几何（圆角走线 + 包围盒）走缓存，查询先过包围盒 —— 不在盒里直接 `NaN`，
 * 连折线都不碰。**不要**在这里面重建几何（见 `stairGeomOf` 的注释）。
 */
export function stairHitAt(object: DirectorObject, x: number, z: number): number {
  return walkStair(object, x, z, null);
}

/** `(x, z)` 是否落在楼梯的水平投影内。热路径（同上）。 */
export function stairCoversXZ(object: DirectorObject, x: number, z: number): boolean {
  return !Number.isNaN(walkStair(object, x, z, null));
}

/**
 * 分段列出每一段（渲染 / 包围盒 / Inspector / 射线）。
 *
 * 结果**每座楼梯只建一次**并缓存，返回的是**同一个数组** —— 调用方只读，别改。
 * （渲染每帧都要它、射线每次拾取都要它、而圆角之后的段数不少，重建一遍很贵。）
 */
export function stairRuns(object: DirectorObject): StairRun[] {
  const geom = stairGeomOf(object);
  if (!geom.hasRuns) {
    const out: StairRun[] = [];
    walkStair(object, Number.NaN, Number.NaN, out);
    geom.runs = out;
    geom.hasRuns = true;
  }
  return geom.runs;
}

/**
 * **单段**版的命中测试：段内返回该处高度，出段返回 `null`。
 *
 * 给射线求交用：平面是无限的、段是有限的，命中的落点必须真在这一段里。
 * 那里**不能**调 `stairHitAt` —— 那是 O(段数) 的全局查询，套在逐段循环里就是 O(段数²)，
 * 圆角之后的段数足够多，一次拾取就能卡住。
 */
export function stairRunHeightAt(run: StairRun, x: number, z: number): number | null {
  return hitRun(run, x, z);
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
