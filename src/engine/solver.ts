import {
  Constraint,
  DirectorGroup,
  DirectorObject,
  DirectorState,
  FORMATION_MORPH_SECONDS,
  FormationKind,
  MoveSegment,
  Vec2,
} from "../domain/schema";
import {
  ArcLut,
  pointAtArcLength,
  segmentPosition,
  segmentRoutePoints,
  tangentAtArcLength,
} from "./path";
import { Rect, setRects } from "./occlusion";
import { easeVal, normalizeEase } from "./ease";

/**
 * 编队能否「骑过」某障碍：队伍横向跨度足够，障碍两侧都留得下人。
 *
 * 用途：让**锚点**的全局路线规划忽略这类小障碍。否则哪怕一个小箱子，只要压在队伍
 * 行进线上，`pathfinding.avoidObstacles` 就会先用可见图 + Dijkstra 把整条线路掰弯绕开，
 * 「石头中间、队伍两边分流」这个局部行为就永远触发不到。
 * 去掉这几个障碍后线路保持笔直，由队员在 local avoidance 里从两侧分流绕过（见下方
 * groupInfluenceOffset 的侧向分流）。锚点自己则靠同款侧向避让小幅让开，不会走进石头。
 *
 * 保守起见用障碍**对角线**估计横向占位（任意来向都成立）；纵队 span≈0，必然判否，
 * 因此纵队仍走旧的全局绕障（否则队首会直接穿墙）。
 */
function canStraddle(state: DirectorState, o: DirectorObject, r: Rect): boolean {
  const group = (state.groups ?? []).find((g) => g.dynamics && g.members[0] === o.id);
  if (!group || group.members.length < 2) return false;
  const count = group.members.length;
  const spacing = group.spacing ?? 1.2;
  const kind = group.formation ?? "column";
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const s = formationSlot(kind, spacing, i, count).right;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  // 两侧各要留出人体半宽 + 贴边余量（合计约 1.1m）。
  return max - min > Math.hypot(r.w, r.d) + 1.1;
}

/**
 * 某对象做路径规划时应考虑的静态障碍。
 * 群队锚点要排除「编队骑得过去」的小障碍（见 canStraddle）；其余对象 / 障碍一律照旧。
 * **可视化与运动求解都必须走这里**，否则橙色导航层会显示绕行、agent 却直穿过去。
 */
export function routeObstacles(state: DirectorState, objectId: string): Rect[] {
  const all = setRects(state);
  const o = state.objects.find((item) => item.id === objectId);
  if (!o) return all;
  return all.filter((r) => !canStraddle(state, o, r));
}

/** 无驱动（Segment / Constraint）时的基础位置。 */
function basePosition(state: DirectorState, o: DirectorObject, time: number): Vec2 {
  const ss = state.segments
    .filter((s) => s.object === o.id)
    .sort((a, b) => a.timeStart - b.timeStart);

  if (ss.length === 0) return { x: o.x, z: o.z };
  // 第一个 Segment 开始前，对象停在它自己的 ORIGIN。
  if (time < ss[0].timeStart) return { x: o.x, z: o.z };

  // 环境（set 资产）参与运动求解：路径被挡时 agent 实际走绕行折线。
  // 例外：群队锚点要把「编队骑得过去」的小障碍排除掉——它们不该掰弯整条线路，
  // 而由队员在 local avoidance 里从石头两侧分流绕过（见 canStraddle 注释）。
  const obstacles = routeObstacles(state, o.id);

  const active = ss.find((s) => time >= s.timeStart && time <= s.timeEnd);
  if (active) return segmentPosition(active, time, obstacles);

  // 停留位置同样取绕行折线的端点，避免停在障碍内部。
  const prev = [...ss].reverse().find((s) => time > s.timeEnd);
  if (prev) {
    const route = segmentRoutePoints(prev, obstacles);
    const last = route[route.length - 1];
    return { x: last.x, z: last.z };
  }

  const next = ss.find((s) => time < s.timeStart);
  if (next) {
    const route = segmentRoutePoints(next, obstacles);
    return { x: route[0].x, z: route[0].z };
  }

  return { x: o.x, z: o.z };
}

function activeConstraint(
  state: DirectorState,
  objectId: string,
  time: number,
  skip?: Constraint,
): Constraint | undefined {
  return state.constraints.find(
    (q) =>
      q.subject === objectId &&
      q !== skip &&
      time >= q.timeStart &&
      time <= q.timeEnd,
  );
}

/**
 * Follow 的偏移量在约束开始时刻捕获：
 * 之后跟随者保持这个相对位移，而不是吸附到目标身上。
 */
function followOffset(
  state: DirectorState,
  q: Constraint,
  stack: Set<string>,
): Vec2 | null {
  const subject = state.objects.find((o) => o.id === q.subject);
  const target = state.objects.find((o) => o.id === q.target);
  if (!subject || !target) return null;
  // FOLLOW 偏移按「作者态」几何捕获（applyDynamics=false），不受引力场扰动。
  const a = objectPosition(state, q.subject, q.timeStart, stack, q, false);
  const b = objectPosition(state, q.target, q.timeStart, new Set([...stack, subject.id]), undefined, false);
  return { x: a.x - b.x, z: a.z - b.z };
}

/** 确定性哈希：由 id 生成稳定相位，供微扰噪声使用（无状态、可复算）。 */
function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return (h / 9973) * Math.PI * 2;
}

/**
 * 编队槽位（锚点局部坐标）：fwd = 沿队伍朝向的前后，right = 侧向。
 * 锚点自身（index 0）恒为原点——它的路径就是整队的唯一路线。
 * 导出供「新建团队」时的初始摆放复用，保证与求解器一致。
 */
export function formationSlotOf(
  kind: FormationKind,
  spacing: number,
  index: number,
  count: number,
): { fwd: number; right: number } {
  return formationSlot(kind, spacing, index, count);
}
/**
 * 编队切换的前向偏移：返回新阵型需要整体前移的米数，保证切换后没有任何队员的目标
 * 前向位置落后于其起始前向位置——即整队变阵时绝不「为了排队形而向后倒退」。
 * 未到位的队员一律向前归位，可越过前方已就位队友的位置。
 */
export function formationForwardShift(
  prev: FormationKind,
  cur: FormationKind,
  spacing: number,
  count: number,
): number {
  if (prev === cur || count <= 1) return 0;
  let maxBack = 0;
  for (let i = 0; i < count; i += 1) {
    const d = formationSlot(prev, spacing, i, count).fwd - formationSlot(cur, spacing, i, count).fwd;
    if (d > maxBack) maxBack = d;
  }
  return maxBack > 0 ? maxBack : 0;
}

function formationSlot(
  kind: FormationKind,
  spacing: number,
  index: number,
  count: number,
): { fwd: number; right: number } {
  if (index <= 0) return { fwd: 0, right: 0 };
  const d = Math.max(0.2, spacing || 1.2);
  switch (kind ?? "column") {
    case "row": // 横队：垂直于行进方向一字排开
      return { fwd: 0, right: (index - (count - 1) / 2) * d };
    case "wedge": // 楔队：锚点后方左右交替、逐层外扩
      return {
        fwd: -Math.ceil(index / 2) * d,
        right: (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * d,
      };
    case "ring": // 环阵：围绕锚点均分一周
      return {
        fwd: Math.cos((index / count) * Math.PI * 2) * d * 1.4,
        right: Math.sin((index / count) * Math.PI * 2) * d * 1.4,
      };
    case "column": // 纵队：锚点后方依次跟随
    default:
      return { fwd: -index * d, right: 0 };
  }
}

/** 某对象跨所有 segment 的连续路径（含绕障），供「沿路径弧长参数化」的编队使用。 */
interface ObjectRoute {
  lut: ArcLut;
  segs: MoveSegment[];
  /** 每段终点在整条路径上的弧长，与 segs 一一对应。 */
  segEnds: number[];
}

const objectRouteCache = new Map<string, ObjectRoute>();

/**
 * 取对象跨所有 segment 的连续路径 LUT（按 state.revision 缓存，避免每帧重算绕障）。
 *
 * 陷阱：obstacles 必须按【锚点】算。routeObstacles 会剔除「编队骑得过去」的小障碍，
 * 而对非锚点队员 canStraddle 恒为 false（保留全部障碍）——若按队员取会得到与锚点不同的
 * 折线，队形会散。故整队统一用锚点 id 取一份折线。
 */
export function objectRoute(state: DirectorState, objectId: string): ObjectRoute {
  const key = `${state.revision}|${objectId}`;
  const hit = objectRouteCache.get(key);
  if (hit) return hit;

  const segs = state.segments
    .filter((s) => s.object === objectId)
    .sort((a, b) => a.timeStart - b.timeStart);
  const rects = routeObstacles(state, objectId);

  const pts: Vec2[] = [];
  const cum: number[] = [];
  const segEnds: number[] = [];
  for (const seg of segs) {
    for (const p of segmentRoutePoints(seg, rects)) {
      const last = pts[pts.length - 1];
      if (!last) {
        pts.push(p);
        cum.push(0);
        continue;
      }
      const d = Math.hypot(p.x - last.x, p.z - last.z);
      if (d < 1e-6) continue; // 跨段接缝（相邻段首尾重合）去重，避免 0 长度段
      pts.push(p);
      cum.push(cum[cum.length - 1] + d);
    }
    segEnds.push(cum.length ? cum[cum.length - 1] : 0);
  }

  const route: ObjectRoute = {
    lut: { pts, cum, total: cum.length ? cum[cum.length - 1] : 0 },
    segs,
    segEnds,
  };
  if (objectRouteCache.size > 128) objectRouteCache.clear();
  objectRouteCache.set(key, route);
  return route;
}

/** 锚点在某时刻已走过的弧长：前面整段累加 + 本段按缓动的里程。 */
export function anchorArcLength(route: ObjectRoute, time: number): number {
  const { segs, segEnds } = route;
  if (!segs.length) return 0;
  if (time <= segs[0].timeStart) return 0;
  const last = segs.length - 1;
  if (time >= segs[last].timeEnd) return segEnds[last];

  for (let k = 0; k < segs.length; k += 1) {
    const s = segs[k];
    if (time >= s.timeStart && time <= s.timeEnd) {
      const prevEnd = k > 0 ? segEnds[k - 1] : 0;
      const segLen = segEnds[k] - prevEnd;
      const span = s.timeEnd - s.timeStart || 1;
      const u = (time - s.timeStart) / span;
      return prevEnd + easeVal(normalizeEase(s.ease), u) * segLen;
    }
  }
  // 段间空隙：沿用上一段终点
  for (let k = segs.length - 1; k >= 0; k -= 1) {
    if (time > segs[k].timeEnd) return segEnds[k];
  }
  return 0;
}

/**
 * 团队编队 + 惯性弹簧（Group Dynamics）。
 *
 * 一个 team 视作一个 unit，只 author 一条路线（锚点 = members[0]）。
 * - **匀速直线**：锚点加速度≈0 → 弹簧位移≈0 → 队员保持编队（+ 微量自然扰动）。
 * - **加速 / 减速 / 变线**：队员被惯性甩出 → 弹簧拉扯 + 阻尼振荡 → 随后归零 → 回到原编队。
 *
 * 位移 = 滞后项(∝ 当前加速度，持续变速时的拉伸) + 振荡项(∝ 过去 ~1s 加速度的
 * 衰减振荡响应，突变时的甩动与回弹)。二者都由锚点加速度驱动，因此**匀速时恒为零**，
 * 且全程无状态、可确定性复算（相机 / 遮挡 / 导出共用同一求解）。
 */

// 队员间最小间距（personal space）：不模拟物理碰撞，但保证同组两人不叠在一起。
// 二人身宽的一半之和 + 此余量即「最小间距」；设得很小，仅消除视觉重叠、不改动作者编排的间距。
const PERSONAL_SPACE = 0.05;
// 单次分离位移上限：避免极端拥挤时被一次性推飞（分离项会逐帧累积到间距达标为止）。
const MAX_SEP = 1.2;

function groupInfluenceOffset(state: DirectorState, objectId: string, time: number): Vec2 {
  const group = (state.groups ?? []).find((g) => g.dynamics && g.members.includes(objectId));
  if (!group || group.members.length < 2) return { x: 0, z: 0 };

  const anchorId = group.members[0];
  // 锚点即团队路线本身：不做编队位移 / 惯性甩动 / 自然微扰（下方按 isAnchor 全部跳过）。
  // 但它**要做侧向避让**：路线规划已把「骑得过去」的小障碍排除掉、线路笔直穿石而过，
  // 若锚点完全不让位，队首就会直接走进石头里。
  const isAnchor = objectId === anchorId;

  const index = group.members.indexOf(objectId);
  const base = (id: string, t: number): Vec2 =>
    objectPosition(state, id, t, new Set(), undefined, false);

  const spacing = group.spacing ?? 1.2;
  const formation0 = group.formation ?? "column";
  const prevFormation = group.prevFormation ?? formation0;
  // 编队切换过渡：记录上一次切换时刻与旧阵型，按时间插值槽位，
  // 使整队变阵用 FORMATION_MORPH_SECONDS 平滑滑过去，而非瞬间跳变（现实中不可能瞬间完成）。
  const morphAt = group.formationChangeAt;
  const morphT =
    morphAt == null
      ? 1
      : Math.max(0, Math.min(1, (time - morphAt) / FORMATION_MORPH_SECONDS));
  // 整体前移新阵型，确保任何队员的目标前向位置都不落后于其起始前向位置——
  // 整队变阵时绝不为了“排队形”而向后倒退，未到位的队员一律向前归位（可越过前排队友的位置）。
  const fwdShift =
    morphAt == null ? 0 : formationForwardShift(prevFormation, formation0, spacing, group.members.length);
  const blendedSlot = (id: string): { fwd: number; right: number } => {
    const idx = group.members.indexOf(id);
    const a = formationSlot(prevFormation, spacing, idx, group.members.length);
    const b = formationSlot(formation0, spacing, idx, group.members.length);
    const bFwd = b.fwd + fwdShift; // 新阵型整体前移，杜绝倒退
    return {
      fwd: a.fwd + (bFwd - a.fwd) * morphT,
      right: a.right + (b.right - a.right) * morphT,
    };
  };

  // —— 编队期望位：路径相对（弧长参数化）——
  // 队员 i 不在锚点旁做世界空间刚性偏移，而是沿同一条路径落后锚点 |slot.fwd| 弧长，
  // 再按该处切线做 slot.right 的侧移。过弯时整队沿路径蛇形跟随、永远贴线，不会像刚性
  // 编队那样绕锚点旋转被甩离路径、或在缓动端点（零速）处坍缩到节点。
  const anchor = base(anchorId, time);
  const route = objectRoute(state, anchorId);
  const useArc = route.segs.length > 0;
  const sAnchor = useArc ? anchorArcLength(route, time) : 0;

  // —— 局部避让（Local Avoidance）· 侧向分流绕行 ——
  // 静态 set 仅作障碍（agent 间不做避让）。只让「自己期望位」与障碍冲突的队员让位，
  // 不再把整队塌缩为单列——那会为了过地形而让本可不动的队员也跟着变阵。
  //
  // 旧实现按「世界 X / Z 中穿透更浅的轴」推出，与队伍朝向无关：斜向行进时常把队员沿
  // 行进方向往后推（丢掉前进量，观感上就是"放弃原路线"），且不同队员可能沿不同轴被推、
  // 甚至整队被挤向同一侧。现改为在【队伍局部坐标系】里决策：
  //   1) 一律优先沿「侧向」让位，前向坐标保持不变 → 保住前进进度，不倒退、不抢到队首前；
  //   2) 障碍窄到编队能「骑」过去（左右两端都伸到障碍轮廓之外）→ 分流：槽位在障碍中心
  //      左侧的贴左沿、右侧的贴右沿，像水流绕石，过完自然合拢回编队；
  //   3) 障碍过宽无法分流（长墙等）→ 整队绕同一侧；侧移距离过大则回退到原世界轴推出。
  // 侧别由【编队槽位的侧向偏移】判定（时间的纯函数），因此无状态、可确定性复算、不会抖。
  // 关键：避让位移只加在「最终期望位」上，绝不参与下方「队首滞后低通」——否则惯性会把避让
  // 抵消掉（过去未避让的位置被低通记住，生成反向甩动把人拽回障碍里），看着就像没避开。
  const CLEAR = 0.25; // 与障碍间的余量，避免贴边穿模
  const LEAD = 1.0; // 提前量：为「让位」留出渐入渐出的距离，避免一碰障碍就瞬移出去
  const sets = setRects(state);
  const meObj = state.objects.find((o) => o.id === objectId);
  const mw = (meObj?.footprint.w ?? 0.5) / 2;
  const md = (meObj?.footprint.d ?? 0.5) / 2;
  const slot = blendedSlot(objectId); // 纯编队槽位（不含避让），供滞后低通使用

  // 编队横向跨度（槽位侧向范围）：判断障碍能否被"骑"过去。
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const id of group.members) {
    const s = blendedSlot(id).right;
    if (s < latMin) latMin = s;
    if (s > latMax) latMax = s;
  }
  const latCenter = (latMin + latMax) / 2;
  const MAX_LAT_PUSH = 6; // 侧移超过此距离说明不是「小障碍」，回退到世界轴推出
  const SIDE_EPS = 1e-3;

  // 计算「某队员的编队期望位」：沿路径弧长采样 + 侧向槽位 + 静态障碍侧让（不含惯性 / 分离）。
  // 既用于自身，也供「队员间最小间距」取其它队员的期望位——后者必须取「不含惯性」的纯期望位，
  // 否则惯性滞后（lag）会被当成真实间距，导致分离被惯性位移抵消、间距判读错误。
  const desiredAt = (memberId: string): { pure: Vec2; desired: Vec2 } => {
    const mslot = blendedSlot(memberId);
    const msMe = sAnchor + mslot.fwd;
    const map = useArc ? pointAtArcLength(route.lut, msMe) : null;
    const mh = useArc ? tangentAtArcLength(route.lut, msMe) : baseHeading(state, anchorId, time);
    const mr = { x: Math.cos(mh), z: -Math.sin(mh) };
    const mdp = map
      ? { x: map.x + mr.x * mslot.right, z: map.z + mr.z * mslot.right }
      : {
          x: anchor.x + Math.sin(mh) * mslot.fwd + mr.x * mslot.right,
          z: anchor.z + Math.cos(mh) * mslot.fwd + mr.z * mslot.right,
        };
    const mObj = state.objects.find((o) => o.id === memberId);
    const mmw = (mObj?.footprint.w ?? 0.5) / 2;
    const mmd = (mObj?.footprint.d ?? 0.5) / 2;
    let pX = 0;
    let pZ = 0;
    for (const r of sets) {
      const hw = r.w / 2 + mmw + CLEAR + LEAD;
      const hh = r.d / 2 + mmd + CLEAR + LEAD;
      const dxr = mdp.x - r.x;
      const dzr = mdp.z - r.z;
      const penX = hw - Math.abs(dxr);
      const penZ = hh - Math.abs(dzr);
      if (!(penX > 0 && penZ > 0)) continue;
      // 障碍在队员局部侧轴的投影：成员期望位相对自身编队原点的侧向坐标 = slot.right。
      const oc_l = (r.x - mdp.x) * mr.x + (r.z - mdp.z) * mr.z + mslot.right;
      const halfLat = Math.abs(mr.x) * (r.w / 2) + Math.abs(mr.z) * (r.d / 2) + mmw + CLEAR;
      const straddle = latMin < oc_l - halfLat && latMax > oc_l + halfLat;
      const dSide = straddle ? mslot.right - oc_l : latCenter - oc_l;
      const side = dSide < -SIDE_EPS ? -1 : dSide > SIDE_EPS ? 1 : -1;
      let latPush = 0;
      for (const id of group.members) {
        const s = blendedSlot(id).right;
        if (straddle && (side < 0 ? s > oc_l : s <= oc_l)) continue;
        const pen = halfLat - Math.abs(s - oc_l);
        if (pen > latPush) latPush = pen;
      }
      if (latPush <= 0) continue;
      latPush *= side;
      const rampDist0 = LEAD + mmw + CLEAR;
      let depth = Math.min(penX, penZ);
      for (const id of group.members) {
        const s = blendedSlot(id);
        const dS = straddle ? s.right - oc_l : latCenter - oc_l;
        const sideJ = dS < -SIDE_EPS ? -1 : dS > SIDE_EPS ? 1 : -1;
        if (sideJ !== side) continue;
        const sMeJ = sAnchor + s.fwd;
        const hJ = useArc ? tangentAtArcLength(route.lut, sMeJ) : mh;
        const rJ = { x: Math.cos(hJ), z: -Math.sin(hJ) };
        const apJ = useArc ? pointAtArcLength(route.lut, sMeJ) : null;
        const dpJ = apJ
          ? { x: apJ.x + rJ.x * s.right, z: apJ.z + rJ.z * s.right }
          : {
              x: anchor.x + Math.sin(hJ) * s.fwd + rJ.x * s.right,
              z: anchor.z + Math.cos(hJ) * s.fwd + rJ.z * s.right,
            };
        const pxJ = hw - Math.abs(dpJ.x - r.x);
        const pzJ = hh - Math.abs(dpJ.z - r.z);
        if (pxJ > 0 && pzJ > 0) depth = Math.max(depth, Math.min(pxJ, pzJ));
      }
      const rt = rampDist0 > 0 ? Math.min(1, Math.max(0, depth / rampDist0)) : 1;
      const ramp = rt * rt * (3 - 2 * rt);
      if (Math.abs(latPush) <= MAX_LAT_PUSH) {
        pX += mr.x * latPush * ramp;
        pZ += mr.z * latPush * ramp;
      } else {
        if (penX < penZ) pX += (dxr >= 0 ? 1 : -1) * Math.max(0, penX - LEAD);
        else pZ += (dzr >= 0 ? 1 : -1) * Math.max(0, penZ - LEAD);
      }
    }
    return { pure: mdp, desired: { x: mdp.x + pX, z: mdp.z + pZ } };
  };

  const selfDes = desiredAt(objectId);
  const desiredPure = selfDes.pure;

  // —— 队员间最小间距（personal space）——
  // 不模拟物理碰撞，但保证同组两人不叠在一起：避障侧让会把同侧队员整体推向一侧，可能挤到
  // 站在那里、自己没被侧让的队员（尤其落在检测盒外、拿不到位移的人）→ 对方必须让开点距离。
  // 基于「编队期望位」（含障碍侧让，不含惯性/微扰）做一遍松弛：所有队员先取纯期望位，再对过近
  // 的配对沿连线互推开，迭代若干轮直到达标。逐对相加会被「夹在中间的人被两侧反向拉」抵消，松弛
  // 则整体收敛；结果与遍历顺序无关、无状态、可确定性复算（相机 / 遮挡 / 导出共用同一求解）。
  // 闭包内用局部缓存，单次 groupInfluenceOffset 调用内只算一次。
  let sepCache: Map<string, Vec2> | null = null;
  const separatedDesired = (): Map<string, Vec2> => {
    if (sepCache) return sepCache;
    const pos = new Map<string, Vec2>();
    for (const id of group.members) pos.set(id, desiredAt(id).desired);
    const ITER = 8;
    for (let it = 0; it < ITER; it += 1) {
      let moved = false;
      for (let a = 0; a < group.members.length; a += 1) {
        for (let b = a + 1; b < group.members.length; b += 1) {
          const A = group.members[a];
          const B = group.members[b];
          const pa = pos.get(A)!;
          const pb = pos.get(B)!;
          const dx = pb.x - pa.x;
          const dz = pb.z - pa.z;
          const d = Math.hypot(dx, dz);
          const oa = state.objects.find((o) => o.id === A);
          const ob = state.objects.find((o) => o.id === B);
          const minGap = (oa?.footprint.w ?? 0.5) / 2 + (ob?.footprint.w ?? 0.5) / 2 + PERSONAL_SPACE;
          if (d >= minGap || d < 1e-6) continue;
          const push = Math.min((minGap - d) * 0.5, MAX_SEP);
          const ux = dx / d;
          const uz = dz / d;
          pos.set(A, { x: pa.x - ux * push, z: pa.z - uz * push });
          pos.set(B, { x: pb.x + ux * push, z: pb.z + uz * push });
          moved = true;
        }
      }
      if (!moved) break;
    }
    sepCache = pos;
    return pos;
  };

  // 最终期望位 = 编队期望位 + 避让位移 + 队员间最小间距（直接叠加，已随期望位平滑变化，不被低通抵消）。
  const desired = separatedDesired().get(objectId)!;

  // —— 队员惯性（队首编队点的时间低通）——
  // 把「队首 + 当前朝向」得到的编队期望点沿时间做指数低通（一阶滞后），队员跟随这个被平滑、
  // 滞后的点：变线时因反应慢而保持旧路线 + 沿原路线减速落后，变线后自然加速归位。
  // 低通作用于 C0 连续的位置/朝向，结果平滑无台阶；且天然有记忆——连续折弯时上一段滞后
  // 没追完会被新弯继续叠加（"上一组指令没完全消化"），不会像取台阶差值那样猛翻。
  const rankScale = 0.6 + index * 0.35; // 越靠后的队员缓冲/追赶越明显（鞭尾感）
  const TAU = 0.16 * rankScale; // 反应时间常数（秒）：越大缓冲越久
  const LAG = Math.min(0.9, 0.5 * rankScale); // 滞后占比：越大越靠后、落后越多

  // 当前期望位 = 上面算出的 desiredPure（弧长采样点 或 刚性偏移，二者其一）。
  const dNow = desiredPure;

  // 对「编队期望点」做时间低通（指数权重），得到平滑滞后的目标。
  // 弧长版：对过去的锚点弧长重采样——天然贴合路径，且比原来 11 次 objectPosition 便宜得多。
  const dt = 0.1;
  const N = 10; // 记忆窗口 ≈1s
  let lx = 0;
  let lz = 0;
  let wsum = 0;
  for (let k = 0; k <= N; k += 1) {
    const tk = Math.max(0, time - k * dt);
    const wk = Math.exp(-(time - tk) / TAU);
    let pxk: number;
    let pzk: number;
    let rax: number;
    let raz: number;
    if (useArc) {
      const sK = anchorArcLength(route, tk) + slot.fwd;
      const pk = pointAtArcLength(route.lut, sK);
      const hk = tangentAtArcLength(route.lut, sK);
      pxk = pk.x;
      pzk = pk.z;
      rax = Math.cos(hk);
      raz = -Math.sin(hk);
    } else {
      const pa = base(anchorId, tk);
      const ha = baseHeading(state, anchorId, tk);
      pxk = pa.x + Math.sin(ha) * slot.fwd;
      pzk = pa.z + Math.cos(ha) * slot.fwd;
      rax = Math.cos(ha);
      raz = -Math.sin(ha);
    }
    lx += (pxk + rax * slot.right) * wk;
    lz += (pzk + raz * slot.right) * wk;
    wsum += wk;
  }
  const lagged = { x: lx / wsum, z: lz / wsum };
  let sx = LAG * (lagged.x - dNow.x);
  let sz = LAG * (lagged.z - dNow.z);

  // —— 匀速时的自然微扰（确定性噪声，让编队不死板）；幅度很小，只是极轻微的呼吸感 ——
  const amp = 0.05 * Math.max(0, Math.min(1, group.noise ?? 0.35));
  const seed = hashSeed(objectId);
  const nx = amp * (Math.sin(time * 1.27 + seed) * 0.6 + Math.sin(time * 2.63 + seed * 1.7) * 0.4);
  const nz = amp * (Math.cos(time * 1.11 + seed * 1.3) * 0.6 + Math.sin(time * 2.17 + seed * 0.7) * 0.4);

  // 求解器把偏移叠加在成员自身的作者路径之上，因此换算成相对自身的位移。
  const me = base(objectId, time);
  // 静态编队位移：必须精确贴合——队员要跟着队首走，不能被软上限卡住
  // （否则整队平移时队员会被钉在各自作者初始位附近，只剩队首能动）。
  const dx = desired.x - me.x;
  const dz = desired.z - me.z;
  // 弹簧 + 微扰是叠加在编队之上的「动态甩动」，这部分才用软上限约束，避免甩飞。
  // 锚点不参与：它的路线就是团队路线本身，只允许下面的小障碍侧移。
  let fx = isAnchor ? 0 : sx + nx;
  let fz = isAnchor ? 0 : sz + nz;
  const fmag = Math.hypot(fx, fz);
  const maxOff = 2.0; // 与作者路径冲突的软上限（仅作用于甩动，不作用于编队贴合）
  if (fmag > maxOff) {
    fx = (fx / fmag) * maxOff;
    fz = (fz / fmag) * maxOff;
  }
  // 二次避让（兜底）：对「编队期望 + 惯性甩动」的最终落点再测一次障碍。
  // 一次避让只改期望位，但变线 / 转弯时甩动可达 2m 且方向不可控，可能把人甩进障碍——
  // 这里按最终落点把它推出去，保证无论惯性怎么甩都不穿模。
  const finalX = desired.x + fx;
  const finalZ = desired.z + fz;
  let cx = 0;
  let cz = 0;
  for (const r of sets) {
    const hw = r.w / 2 + mw + CLEAR;
    const hh = r.d / 2 + md + CLEAR;
    const dxr = finalX - r.x;
    const dzr = finalZ - r.z;
    const penX = hw - Math.abs(dxr);
    const penZ = hh - Math.abs(dzr);
    if (penX > 0 && penZ > 0) {
      if (penX < penZ) cx += (dxr >= 0 ? 1 : -1) * penX;
      else cz += (dzr >= 0 ? 1 : -1) * penZ;
    }
  }
  return { x: dx + fx + cx, z: dz + fz + cz };
}

/** 基础（不含引力场）朝向：先用 applyDynamics=false 的位置差求运动方向，避免反馈；
 * 差分近零（默认缓动在 u=0/u=1 斜率为 0，waypoint 附近 anchor 必有一段近零速区间）时，
 * 不再回落到 subject.rotation（demo.rotation=0 会让 column 队员沿 +x 轴坍缩到节点），
 * 改为从路径几何取切线：active 段的方向，两段交接瞬间用前后段方向的角平分线。
 */
export function baseHeading(state: DirectorState, id: string, time: number): number {
  const s = 0.08;
  const a = objectPosition(state, id, Math.max(0, time - s), new Set(), undefined, false);
  const b = objectPosition(state, id, time + s, new Set(), undefined, false);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-4) return Math.atan2(dx, dz);

  const obj = state.objects.find((o) => o.id === id);
  // 段挂在 DirectorState.segments 上（DirectorObject 并没有 segments 字段），按 object 过滤。
  const segments = obj
    ? state.segments.filter((s) => s.object === id).sort((a, b) => a.timeStart - b.timeStart)
    : [];
  const obstacles = routeObstacles(state, id);
  const segDir = (seg: MoveSegment): { x: number; z: number } => {
    const route = segmentRoutePoints(seg, obstacles);
    const a0 = route[0];
    const b0 = route[route.length - 1];
    return { x: b0.x - a0.x, z: b0.z - a0.z };
  };

  const active = segments.find((seg) => time >= seg.timeStart && time <= seg.timeEnd);
  if (active) {
    const nextSeg = segments[segments.indexOf(active) + 1];
    // 两段交接瞬间：用前后段方向的角平分线，让 column 平滑过弯而不塌到节点。
    if (
      nextSeg &&
      Math.abs(time - active.timeEnd) < 1e-6 &&
      Math.abs(time - nextSeg.timeStart) < 1e-6
    ) {
      const d = segDir(active);
      const dn = segDir(nextSeg);
      const bx = d.x + dn.x;
      const bz = d.z + dn.z;
      if (Math.hypot(bx, bz) > 1e-4) return Math.atan2(bx, bz);
      return Math.atan2(dn.x, dn.z);
    }
    const d = segDir(active);
    if (Math.hypot(d.x, d.z) > 1e-4) return Math.atan2(d.x, d.z);
  }

  // 无 active 段（段间隙 / 全段前后）：优先用下一段方向（出向），再上一段，最后回落到 rotation。
  const next = segments.find((seg) => time < seg.timeStart);
  if (next) {
    const dn = segDir(next);
    if (Math.hypot(dn.x, dn.z) > 1e-4) return Math.atan2(dn.x, dn.z);
  }
  const prev = [...segments].reverse().find((seg) => time > seg.timeEnd);
  if (prev) {
    const dp = segDir(prev);
    if (Math.hypot(dp.x, dp.z) > 1e-4) return Math.atan2(dp.x, dp.z);
  }
  return obj ? (obj.rotation * Math.PI) / 180 : 0;
}

/**
 * 团队的【朝向】：整队作为一个 unit 一起转向——所有队员对齐到锚点（队首）的朝向。
 * 与位置侧的惯性弹簧配合：变线时位置会甩动回弹，但朝向始终跟着队伍大方向，
 * 这正是兽群 / 军队"整体转向"的观感（而非各自为政）。
 * 锚点自身返回 null，沿用它自己的运动 / 摆放朝向。
 */
function groupHeadingInfluence(state: DirectorState, objectId: string, time: number): number | null {
  const group = (state.groups ?? []).find((g) => g.dynamics && g.members.includes(objectId));
  if (!group || group.members.length < 2) return null;
  const anchorId = group.members[0];
  if (objectId === anchorId) return null;

  // 路径相对：每个队员朝向**自己所在弧长处**的路径切线，而不是统一对齐锚点朝向。
  // 纵队过弯时后排因此沿路径自然转向，不会整队朝同一方向（看着像横着走）。
  const route = objectRoute(state, anchorId);
  if (!route.segs.length) return baseHeading(state, anchorId, time);
  const slot = formationSlot(
    group.formation ?? "column",
    group.spacing ?? 1.2,
    group.members.indexOf(objectId),
    group.members.length,
  );
  const sMe = anchorArcLength(route, time) + slot.fwd;
  return tangentAtArcLength(route.lut, sMe);
}

/** 解析任意对象在任意时刻的世界位置。stack 用于打断循环引用；applyDynamics=false 时跳过组引力场（供 FOLLOW / 引力场自身计算基础位置，避免反馈）。 */
export function objectPosition(
  state: DirectorState,
  objectId: string,
  time: number,
  stack: Set<string> = new Set(),
  skip?: Constraint,
  applyDynamics = true,
): Vec2 {
  const o = state.objects.find((item) => item.id === objectId);
  if (!o) return { x: 0, z: 0 };
  if (stack.has(objectId)) return basePosition(state, o, time);

  const others = state.constraints.filter((q) => q.subject === objectId && q !== skip);
  const active = others.find((q) => time >= q.timeStart && time <= q.timeEnd);

  let result: Vec2;
  if (active && active.type === "FOLLOW") {
    const target = state.objects.find((item) => item.id === active.target);
    const off = target ? followOffset(state, active, stack) : null;
    if (target && off) {
      // 跟随目标取基础位置（applyDynamics=false），引力场只在最外层叠加一次。
      const b = objectPosition(state, active.target, time, new Set([...stack, objectId]), undefined, false);
      result = { x: b.x + off.x, z: b.z + off.z };
    } else {
      result = basePosition(state, o, time);
    }
  } else if (
    state.segments.some((s) => s.object === objectId && time >= s.timeStart && time <= s.timeEnd)
  ) {
    result = basePosition(state, o, time);
  } else {
    // 没有驱动时保持最近一次驱动结束的姿态，而不是弹回 ORIGIN。
    let hold: { end: number; pose: Vec2 } | null = null;
    for (const s of state.segments) {
      if (s.object === objectId && time >= s.timeEnd && (!hold || s.timeEnd > hold.end)) {
        hold = { end: s.timeEnd, pose: { x: s.endX, z: s.endZ } };
      }
    }
    for (const q of others) {
      if (q.type !== "FOLLOW") continue;
      if (time <= q.timeEnd) continue;
      if (hold && q.timeEnd <= hold.end) continue;
      const target = state.objects.find((item) => item.id === q.target);
      if (!target) continue;
      const off = followOffset(state, q, stack);
      if (!off) continue;
      const b = objectPosition(state, q.target, q.timeEnd, new Set([...stack, objectId]), undefined, false);
      hold = { end: q.timeEnd, pose: { x: b.x + off.x, z: b.z + off.z } };
    }
    result = hold ? hold.pose : basePosition(state, o, time);
  }

  // 组引力场：在所有基础运动（Segment / FOLLOW / Hold）之上叠加一次。
  if (applyDynamics) {
    const off = groupInfluenceOffset(state, objectId, time);
    result = { x: result.x + off.x, z: result.z + off.z };
  }

  return result;
}

/** 朝向：优先运动方向，其次 LOOK_AT 约束。 */
export function objectFacing(state: DirectorState, objectId: string, time: number): number {
  const step = 0.06;
  const a = objectPosition(state, objectId, Math.max(0, time - step));
  const b = objectPosition(state, objectId, time + step);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-4) return Math.atan2(dx, dz);

  const look = state.constraints.find(
    (q) =>
      q.type === "LOOK_AT" &&
      q.subject === objectId &&
      time >= q.timeStart &&
      time <= q.timeEnd,
  );
  if (look) {
    const p = objectPosition(state, objectId, time);
    const t = objectPosition(state, look.target, time);
    if (Math.hypot(t.x - p.x, t.z - p.z) > 1e-4) return Math.atan2(t.x - p.x, t.z - p.z);
  }

  // 静止时沿用即将执行 / 刚执行完的 Segment 方向，避免朝向突变为默认值
  // （否则「3/4 背跟」这类相对朝向的机位会在 Segment 起点瞬移）。
  const own = state.segments
    .filter((segment) => segment.object === objectId)
    .sort((a, b) => a.timeStart - b.timeStart);
  const upcoming = own.find((segment) => time < segment.timeStart);
  if (upcoming) {
    const dxs = upcoming.endX - upcoming.startX;
    const dzs = upcoming.endZ - upcoming.startZ;
    if (Math.hypot(dxs, dzs) > 1e-4) return Math.atan2(dxs, dzs);
  }
  const finished = [...own].reverse().find((segment) => time > segment.timeEnd);
  if (finished) {
    const dxs = finished.endX - finished.startX;
    const dzs = finished.endZ - finished.startZ;
    if (Math.hypot(dxs, dzs) > 1e-4) return Math.atan2(dxs, dzs);
  }

  // 组引力场的朝向传播：组员的面向对齐到邻近成员（按距离延迟），
  // 使领队转向像波一样沿群体传开（关系驱动、非同步动画）。
  const gh = groupHeadingInfluence(state, objectId, time);
  if (gh !== null) return gh;

  // 无运动 / 无 LOOK_AT / 无片段方向时，沿用资产自己的摆放朝向（Inspector 的 Rotation）。
  // 此前这里恒返回 atan2(0,0)=0，导致 Rotation 对 agent 类资产完全无效。
  const subject = state.objects.find((o) => o.id === objectId);
  if (subject) return (subject.rotation * Math.PI) / 180;

  return Math.atan2(dx, dz);
}

/**
 * 机位取景用的「行进朝向」：与 objectFacing 的区别是**不含组动力学**
 * （编队弹簧 / 惯性甩动 / 局部分流绕障的横向让位）。
 *
 * 整队的行进方向没变时，个别队员（含队首）为绕障做的横向让位不该带着镜头一起转——
 * 否则一发生避障，俯瞰这类机位就跟着甩头（实测偏航能甩 130°+），看着像整队转向了。
 * 队首的绕障位移发生在 groupInfluenceOffset 里，用 applyDynamics=false 即可剥掉。
 *
 * 取不到运动方向（静止）时：先看导演意图 LOOK_AT，再回落到 baseHeading
 * （路径切线 → 片段方向 → 资产摆放朝向），两者同样不含动力学。
 */
export function travelHeading(state: DirectorState, id: string, time: number): number {
  const s = 0.06;
  const a = objectPosition(state, id, Math.max(0, time - s), new Set(), undefined, false);
  const b = objectPosition(state, id, time + s, new Set(), undefined, false);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-4) return Math.atan2(dx, dz);

  const look = state.constraints.find(
    (q) =>
      q.type === "LOOK_AT" &&
      q.subject === id &&
      time >= q.timeStart &&
      time <= q.timeEnd,
  );
  if (look) {
    const p = objectPosition(state, id, time, new Set(), undefined, false);
    const t = objectPosition(state, look.target, time, new Set(), undefined, false);
    if (Math.hypot(t.x - p.x, t.z - p.z) > 1e-4) return Math.atan2(t.x - p.x, t.z - p.z);
  }
  return baseHeading(state, id, time);
}

export function resolvePositions(state: DirectorState, time: number): Record<string, Vec2> {
  const out: Record<string, Vec2> = {};
  for (const o of state.objects) {
    out[o.id] = objectPosition(state, o.id, time);
  }
  return out;
}
