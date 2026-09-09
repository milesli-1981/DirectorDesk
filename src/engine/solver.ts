import {
  Constraint,
  DirectorGroup,
  DirectorObject,
  DirectorState,
  FORMATION_MORPH_SECONDS,
  FormationKind,
  Vec2,
} from "../domain/schema";
import { segmentPosition, segmentRoutePoints } from "./path";
import { setRects } from "./occlusion";

/** 无驱动（Segment / Constraint）时的基础位置。 */
function basePosition(state: DirectorState, o: DirectorObject, time: number): Vec2 {
  const ss = state.segments
    .filter((s) => s.object === o.id)
    .sort((a, b) => a.timeStart - b.timeStart);

  if (ss.length === 0) return { x: o.x, z: o.z };
  // 第一个 Segment 开始前，对象停在它自己的 ORIGIN。
  if (time < ss[0].timeStart) return { x: o.x, z: o.z };

  // 环境（set 资产）参与运动求解：路径被挡时 agent 实际走绕行折线。
  const obstacles = setRects(state);

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
function groupInfluenceOffset(state: DirectorState, objectId: string, time: number): Vec2 {
  const group = (state.groups ?? []).find((g) => g.dynamics && g.members.includes(objectId));
  if (!group || group.members.length < 2) return { x: 0, z: 0 };

  const anchorId = group.members[0];
  // 锚点即团队路线本身（其自身 Segment 已对静态 set 绕行），不做任何偏移。
  if (objectId === anchorId) return { x: 0, z: 0 };

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

  // —— 编队期望位：锚点位置 + 按队伍朝向旋转后的槽位 ——
  const anchor = base(anchorId, time);
  const heading = baseHeading(state, anchorId, time);
  const forward = { x: Math.sin(heading), z: Math.cos(heading) };
  const right = { x: Math.cos(heading), z: -Math.sin(heading) };

  // —— 局部避让（Local Avoidance）——
  // 静态 set 仅作障碍（agent 间不做避让）。只让「自己期望位」与障碍冲突的队员让位：
  // 例如环形队伍右侧遇障 → 仅右侧队员被推开内收，左侧完全保持原编队位置不动。
  // 不再把整队塌缩为单列——那会为了过地形而让本可不动的队员也跟着变阵。
  // 关键：避让位移只加在「最终期望位」上，绝不参与下方「队首滞后低通」——否则惯性会把避让
  // 抵消掉（过去未避让的位置被低通记住，生成反向甩动把人拽回障碍里），看着就像没避开。
  const CLEAR = 0.25; // 与障碍间的余量，避免贴边穿模
  const sets = setRects(state);
  const meObj = state.objects.find((o) => o.id === objectId);
  const mw = (meObj?.footprint.w ?? 0.5) / 2;
  const md = (meObj?.footprint.d ?? 0.5) / 2;
  const slot = blendedSlot(objectId); // 纯编队槽位（不含避让），供滞后低通使用
  const desiredPure = {
    x: anchor.x + forward.x * slot.fwd + right.x * slot.right,
    z: anchor.z + forward.z * slot.fwd + right.z * slot.right,
  };
  const dpos = desiredPure;
  let pushX = 0;
  let pushZ = 0;
  for (const r of sets) {
    const hw = r.w / 2 + mw + CLEAR; // 膨胀盒半宽（含自身尺寸 + 余量）
    const hh = r.d / 2 + md + CLEAR;
    const dxr = dpos.x - r.x;
    const dzr = dpos.z - r.z;
    const penX = hw - Math.abs(dxr); // >0 表示落入本轴膨胀盒
    const penZ = hh - Math.abs(dzr);
    if (penX > 0 && penZ > 0) {
      // 沿穿透更浅的轴推出，使本队员与障碍保持 CLEAR 余量；其余队员不受影响。
      if (penX < penZ) pushX += (dxr >= 0 ? 1 : -1) * penX;
      else pushZ += (dzr >= 0 ? 1 : -1) * penZ;
    }
  }
  // 最终期望位 = 编队期望位 + 避让位移（直接叠加，已随期望位平滑变化，不被低通抵消）。
  const desired = {
    x: desiredPure.x + pushX,
    z: desiredPure.z + pushZ,
  };

  // —— 队员惯性（队首编队点的时间低通）——
  // 把「队首 + 当前朝向」得到的编队期望点沿时间做指数低通（一阶滞后），队员跟随这个被平滑、
  // 滞后的点：变线时因反应慢而保持旧路线 + 沿原路线减速落后，变线后自然加速归位。
  // 低通作用于 C0 连续的位置/朝向，结果平滑无台阶；且天然有记忆——连续折弯时上一段滞后
  // 没追完会被新弯继续叠加（"上一组指令没完全消化"），不会像取台阶差值那样猛翻。
  const rankScale = 0.6 + index * 0.35; // 越靠后的队员缓冲/追赶越明显（鞭尾感）
  const TAU = 0.16 * rankScale; // 反应时间常数（秒）：越大缓冲越久
  const LAG = Math.min(0.9, 0.5 * rankScale); // 滞后占比：越大越靠后、落后越多

  const pNow = base(anchorId, time);
  const hNow = baseHeading(state, anchorId, time);
  const fN = { x: Math.sin(hNow), z: Math.cos(hNow) };
  const rN = { x: Math.cos(hNow), z: -Math.sin(hNow) };
  const dNow = {
    x: pNow.x + fN.x * slot.fwd + rN.x * slot.right,
    z: pNow.z + fN.z * slot.fwd + rN.z * slot.right,
  };

  // 对「编队期望点」做时间低通（指数权重），得到平滑滞后的目标。
  const dt = 0.1;
  const N = 10; // 记忆窗口 ≈1s
  let lx = 0;
  let lz = 0;
  let wsum = 0;
  for (let k = 0; k <= N; k += 1) {
    const tk = Math.max(0, time - k * dt);
    const wk = Math.exp(-(time - tk) / TAU);
    const pa = base(anchorId, tk);
    const ha = baseHeading(state, anchorId, tk);
    const fa = { x: Math.sin(ha), z: Math.cos(ha) };
    const ra = { x: Math.cos(ha), z: -Math.sin(ha) };
    lx += (pa.x + fa.x * slot.fwd + ra.x * slot.right) * wk;
    lz += (pa.z + fa.z * slot.fwd + ra.z * slot.right) * wk;
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
  let fx = sx + nx;
  let fz = sz + nz;
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

/** 基础（不含引力场）朝向：用 applyDynamics=false 的位置差求运动方向，避免反馈。 */
export function baseHeading(state: DirectorState, id: string, time: number): number {
  const s = 0.08;
  const a = objectPosition(state, id, Math.max(0, time - s), new Set(), undefined, false);
  const b = objectPosition(state, id, time + s, new Set(), undefined, false);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-4) return Math.atan2(dx, dz);
  const subject = state.objects.find((o) => o.id === id);
  return subject ? (subject.rotation * Math.PI) / 180 : 0;
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
  return baseHeading(state, anchorId, time);
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

export function resolvePositions(state: DirectorState, time: number): Record<string, Vec2> {
  const out: Record<string, Vec2> = {};
  for (const o of state.objects) {
    out[o.id] = objectPosition(state, o.id, time);
  }
  return out;
}
