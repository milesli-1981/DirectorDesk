# Director Desk — Camera / 运镜模板设计文档

> 版本：Draft 2026-09-07
> 关联文档：`Director_Desk_V1_Architecture_Baseline_2026-09-05.md`（V1.20 Follow Single Source）
> 状态：**设计阶段，尚未落地到代码**

---

## 0. 背景与目标

本项目（3D 导演台）的终极目标不是做一个"自由创作运镜的编辑器"，而是：

> **解决 MiniMax 这类视频生成模型不理解运镜描述的问题。**

视频模型（MiniMax / Kling / Runway / Sora 等）通常以「文本 prompt + 参考图」为输入，短板在于：

- **空间一致性**：长镜头里相机几何会漂移、主体忽大忽小、方向错乱。
- **时间一致性**：复杂运动序列中前后帧的运镜逻辑断裂。
- **语义歧义**：人类写的"绕着飞一圈""推进去"对模型来说信息量不足、不可复现。

因此本工具的价值主张是：

> **把"视频参考里高频、且模型最容易翻车"的运镜情况，沉淀成"模型能懂的结构化机位模板"。**
> 导演的工作流 = 从模板库选最接近视频参考的一种 → 微调参数/路径 → 导出「结构化 spec + 自然语言 prompt」喂给模型。

本文档定义：
1. 专业运镜的分类维度（给"机位有哪些类型"一个完整坐标系）；
2. 视频参考里的**集中情况（Concentrated Cases）**——即模型最需要被精确描述的场景；
3. 落地为 **Shot Archetype Library（机位模板库）** 的字段设计与预设清单；
4. 当前数据模型已支持 / 待补充的维度与后续实现清单。

---

## 1. 专业运镜的分类维度（正交坐标系）

影视里的"机位类型"不是互斥的枚举，而是几组**正交维度**的叠加。任何真实镜头都可映射到这些维度上。

### 1.1 运动几何 — 6 个自由度（所有"运镜"的本质）
| 类别 | 轴 | 含义 |
|---|---|---|
| 位移 | Dolly | 沿光轴前后（改变透视压缩） |
| 位移 | Truck | 左右横移 |
| 位移 | Pedestal / Boom | 上下升降 |
| 旋转 | Pan | 水平摇（ yaw ） |
| 旋转 | Tilt | 俯仰（ pitch ） |
| 旋转 | Roll / Dutch | 翻滚 / 荷兰角 |
| 光学 | Zoom | 变焦（不改变机位） |
| 光学 | Focus rack | 移焦（焦平面切换） |

> 一个专业镜头 = 上述若干轴的**组合**，业内给常见组合起了名字（见 1.2）。

### 1.2 命名组合镜头（Motion 层想覆盖的）
- **Tracking / Following（跟随）**：相机平行移动，保持主体在框内。
- **Dolly in / out（推 / 拉）**：沿光轴前后，改变透视。
- **Crane / Jib（升降）**：大幅垂直 + 弧线。
- **Orbit / Arc（环绕）**：绕主体转，改变视点角度。
- **Static / Locked-off（固定机位）**：机器不动，让世界在框里发生。
- 常见但当前模型**未覆盖**：Pan/Tilt（原地旋转重新构图不平移）、Truck（纯横向）、Steadicam（三维平滑跟随）、Handheld（手持微晃）、Dolly Zoom / Vertigo（推拉 + 反向变焦）、Whip pan（甩镜）、Reveal（遮挡后揭示）、Fly-through / Aerial（穿越 / 航拍）。

### 1.3 与被拍对象的关系（Relationship 层）
- Locked-off：主体自己走进框（而非机器去追）。
- Lead / Trail：机器领在前面 / 跟在后面。
- **Two-shot / Group**：目标是**一组**对象（双人对话、群像）。
- **OTS（过肩）**：目标是相对于两个主体的夹角（A 看 B 的过肩）。
- **POV**：机器 = 某角色的视线（目标 = 角色自身）。
- **Insert / Detail**：目标是道具 / 局部特写。
- **Establishing**：框住场景 / 环境而非人。

### 1.4 景别 / 方位 / 镜头（Framing / Side / View / Lens）
- 景别 `Framing`：EWS / WS / MS / CU / ECU。
- 方位 `Side`：Front / 3-4 Front / Side / 3-4 Back / Back。
- 视角 `View`：Eye / Low / High / Ground / Overhead。
- 镜头 `Lens`：24 / 35 / 50 / 85mm（决定透视与压缩）。

### 1.5 支撑系统（决定运动质感）
三脚架 / 独脚架 / Dolly 车 / 滑轨 / 摇臂 / Steadicam / 云台 / 手持 / 无人机 / 运动控制（MoCo） / 车船载具。

### 1.6 多机位语法
Master（主镜）+ Coverage（反打、过肩、双人），180° 轴线法则、30° 法则 —— 靠"多台 Camera 各自 Intent + 各自 Track"表达。

---

## 2. 视频参考里的集中情况（Concentrated Cases）

> 下列情况来自对真实视频参考的归纳。它们共同点是：**人类导演靠经验和参考画面就能拍，但文本描述喂给视频模型时极易翻车**。这正是模板库要攻克的场景。

### 2.1 一镜到底 / 复杂运动线
典型机位：
- **推入揭示**：从门 / 走廊 Dolly-in，穿过遮挡露出主体。
- **升降 + 环绕**：Crane 起 → 接 Orbit，经典"英雄登场"。
- **跟移穿场**：Tracking 穿过人群 / 街道，主体始终在框。
- **甩镜转场**：Whip pan 从一个场景甩到另一个。

**模型痛点**：长序列里相机几何会漂移、主体忽大忽小、方向错乱。
**模板应编码**：多段路径（多控制点 `points` + 分段 `ease`）+ 起点 / 终点 `Framing` + 全程 `Target` 锁定 + 明确 `duration`。
**现有支撑**：`MOVE segment + FOLLOW 约束 + points + ease` 已可表达。

### 2.2 航拍绕飞
典型机位：
- **环绕建筑 / 人物**：Orbit（高空），高度基本恒定。
- **从下到上的揭幕**：Crane 由低仰拍拉到 Overhead。
- **航拍推进 / 拉远**：高空 Dolly，配合地形。

**模型痛点**：尺度感错乱、高度 / 俯角不一致、绕飞时主体位置跳变。
**模板应编码**：`View = Overhead/High` + `Motion = ORBIT`（半径 + 高度参）。
**待补维度**：`altitude`（飞行高度）字段。

### 2.3 多人复杂关系（最关键，也最考验模型）
典型机位：
- **过肩对话（OTS）**：A 看 B 的过肩，反打时保持 180° 轴线。
- **双人同框（Two-shot）**：框住两人，谁左谁右不能反。
- **群像调度**：多人走位，前后景关系。
- **主观视线（POV）**：以某角色为眼走。

**模型痛点**：谁在左谁在右会反、前后景错乱、对话反打跳轴。
**模板应编码**：`Target` 从"单个对象"扩成 `GROUP / OTS / POV` 三类。尤其 OTS 需要"以两人为参照的夹角"而非单点目标。
**待补维度**：`Target` 类型扩展。

### 2.4 补充的集中情况
| 情况 | 典型机位 | 模型痛点 |
|---|---|---|
| 对话覆盖包 | Master + 双 OTS 反打 + 单人 | 多镜一致性、跳轴 |
| 动作 / 追逐 | Handheld 跟、车载、Run-and-gun | 抖动质感、速度感 |
| 产品 / 特写 | 静态或慢 Dolly + Turntable 环绕 | 旋转中心、光照 |
| 情绪 / 张力 | POV 行走、Vertigo 推拉变焦 | 透视错乱的"度" |
| 环境建立 | 慢 Crane / 航拍拉开 | 尺度、纵深 |

---

## 3. Shot Archetype Library（机位模板库）设计

### 3.1 模板字段定义
每个模板是一个结构化对象，同时携带「可被模型读懂的自然语言描述」：

```ts
interface ShotTemplate {
  id: string;            // 模板唯一标识
  label: string;         // 中文显示名
  category: CaseId;      // 归属集中情况（见 §2）
  motion: Motion;        // STATIC | FOLLOW | ORBIT | DOLLY | CRANE | ...
  framing: Framing;      // EWS | WS | MS | CU | ECU
  view: View;            // EYE | LOW | HIGH | GROUND | OVERHEAD
  side: Side;            // FRONT | THREE_Q_FRONT | SIDE | THREE_Q_BACK | BACK | ARC
  lens: Lens;            // 24 | 35 | 50 | 85
  target: TargetSpec;    // { type: OBJECT|GROUP|OTS|POV|LOCATION, ref: string[] }
  altitude?: number;     // 航拍高度（米），待补
  duration: number;      // 秒
  path?: PathDescriptor; // 可选：多段路径描述（复用现有 points + ease）
  prompt: string;        // 为视频模型写好的自然语言描述（喂料）
}
```

### 3.2 预设清单（初版 15 个，覆盖 §2 全部情况）
| id | label | motion | framing/view/side | target | 说明 |
|---|---|---|---|---|---|
| `static_locked` | 固定机位 | STATIC | 任意 | OBJECT | 机器不动，让世界发生 |
| `tracking_follow` | 跟移 | FOLLOW | 侧 / 平行 | OBJECT | 平行跟随主体 |
| `dolly_in_reveal` | 推入揭示 | DOLLY | WS→CU | OBJECT | 穿过遮挡露出主体 |
| `crane_hero` | 升降英雄 | CRANE | LOW→EYE | OBJECT | 由下而上英雄登场 |
| `orbit_hero` | 环绕英雄 | ORBIT | EYE / ARC | OBJECT | 绕主体转改变视点 |
| `aerial_orbit` | 航拍绕飞 | ORBIT | OVERHEAD / ARC | OBJECT | 高空恒定高度环绕 |
| `aerial_reveal` | 航拍揭幕 | CRANE | LOW→OVERHEAD | OBJECT | 由仰拍拉到俯视 |
| `ots_dialogue` | 过肩对话 | STATIC/FOLLOW | 3-4 FRONT | OTS(两人) | 保持 180° 轴线 |
| `two_shot` | 双人同框 | STATIC | WS / SIDE | GROUP(两人) | 框住双人，左右不反 |
| `group_blocking` | 群像调度 | FOLLOW/ORBIT | WS | GROUP | 多人前后景走位 |
| `pov_walk` | 主观行走 | FOLLOW | EYE | POV(角色) | 以角色为眼 |
| `whip_pan` | 甩镜转场 | PAN | 任意 | LOCATION | 快速水平摇转场 |
| `vertigo` | 眩晕推拉 | DOLLY_ZOOM | MS | OBJECT | 推拉 + 反向变焦 |
| `product_turntable` | 产品转盘 | ORBIT | EYE / CU | OBJECT | 环绕静物特写 |
| `establishing` | 环境建立 | CRANE / ORBIT | EWS / OVERHEAD | LOCATION | 拉开看全貌 |
| `aerial_drone` | 无人机自由飞行 | DRONE | WIDE / HIGH / ARC | OBJECT | 边绕边升边拉的一镜自由飞行（代码已实现 `DRONE` motion） |

### 3.3 模板示例（完整字段）
```json
{
  "id": "aerial_orbit_reveal",
  "label": "航拍绕飞揭示",
  "category": "aerial",
  "motion": "ORBIT",
  "framing": "WIDE",
  "view": "OVERHEAD",
  "side": "ARC",
  "lens": 35,
  "target": { "type": "OBJECT", "ref": ["M17"] },
  "altitude": 12,
  "duration": 6,
  "prompt": "Aerial drone shot orbiting clockwise around [M17] at 12m height,
             wide framing, slow reveal from behind to front, smooth continuous motion."
}
```

### 3.4 与现有 schema 的映射
| 字段 | 现状 | 是否需改 |
|---|---|---|
| `motion` | 已有 `STATIC/FOLLOW/ORBIT/DOLLY/CRANE` | 需补 `PAN/TILT/TRUCK/STEADICAM/HANDHELD/DOLLY_ZOOM` |
| `framing/view/side/lens` | 已有 | 无需改 |
| `target` | 仅单 OBJECT | 需扩 `GROUP/OTS/POV/LOCATION` |
| `altitude` | 无 | 新增（航拍高度） |
| `path (points+ease)` | 已有 | 可复用，模板可带默认路径 |
| `duration` | 已有（segment.time） | 可复用 |

---

## 4. 待补充的数据模型维度（汇总）

### 4.1 Motion 待补
`PAN / TILT`（原地旋转重新构图，不平移）、`TRUCK`（纯横向）、`STEADICAM`（三维平滑跟随）、`HANDHELD`（手持微晃）、`DOLLY_ZOOM`（眩晕推拉）。

### 4.2 Target 类型扩展
- `OBJECT`：现有单个对象。
- `GROUP`：一组对象（双人同框、群像）。
- `OTS`：以两个对象为参照的夹角（过肩对话）。
- `POV`：以某角色为视线来源（主观）。
- `LOCATION`：固定机位，不跟任何人（环境 / 转场）。

### 4.3 新增字段
- `altitude`（航拍 / 升降高度，米）。

---

## 5. 工作流与导出

导演工作流：
1. **选模板**：从 Shot Archetype Library 选最接近视频参考的一种（可按 §2 的集中情况分类浏览）。
2. **微调**：在 Director View 拖路径 / 端点 / 控制点，在 Inspector 改 Framing / View / Side / Lens / Target / 曲线。
3. **导出**：生成两份产物喂给视频模型——
   - **结构化 spec**：当前 `DirectorState` 的 JSON（精确、可复现）。
   - **自然语言 prompt**：模板自带的 `prompt` 文案，可编辑后复制。

> 模板库就是把「真实视频参考」与「模型能懂的运镜语言」之间的桥。

---

## 6. 后续实现清单（暂不写代码）

按优先级：

1. **高**：`Target` 类型扩展 `GROUP / OTS / POV / LOCATION`，并让 `cameraSolver` 支持多参照取景。
2. **高**：新增 `src/domain/templates.ts`，落地 §3.2 的 15 个 `ShotTemplate` 预设（含 `prompt` 文案）。
3. **中**：补 `Motion`：`PAN / TILT / TRUCK / STEADICAM / HANDHELD / DOLLY_ZOOM`；补 `altitude` 字段。
4. **中**：UI 加「**从模板新建机位**」入口；Inspector 显示并允许编辑该机位的 `prompt` 文案，一键复制。
5. **低**：导出面板，同时输出结构化 spec + 自然语言 prompt。

---

## 7. Segment / Leg 与 Handoff 交互设计（新增）

> 本节定义"如何在 timebar 上加 leg"以及"多段 leg 之间如何连接"。目标：交互简单、空间连续、与现有模型一致（timebar 管时间，Director View 管空间）。

### 7.1 加 leg：只保留一种入口（append）
- **timebar 每条对象轨道末尾一个「+ 加腿」按钮**，点一下 = append 一条新 leg。
- **取消**此前设想的"在播放头拆分 / 中间插入"进阶操作（过于复杂、易破坏连续）；中间插入后续如需，单独做简单的"split 当前腿"功能，不混在"加腿"里。
- 新 leg 默认状态：
  - **起点自动锚定前腿终点**（共享 handoff，空间连续，无瞬移缝隙）；
  - handoff 模式默认 `stop`（作为一条可读、可独立编辑的离散腿）；
  - 给一个默认时长占位（如 2s）；
  - 路径在 View 中表现为一段短直线 stub（见 7.2）。

### 7.2 新 leg 在 Director View 中的表现：默认一段短直线 stub
- 新 leg 在 View 中**默认就是一段很短的直线路径**（2 个点：起点 = 共享 handoff 点，终点 = 前腿终点沿原方向偏移一小段，如 2 单位）。
- 点完 timebar 的「+」后，该 stub **立即出现并自动选中高亮**；用户在 View 中拖它的终点或沿线加折点，把它塑形成目标路径（与编辑任何已有 leg 完全一致）。
- 为何用 stub 而非"空腿 / 零长度"：立即可见可拖；与现有"每条 leg 都是 `points` 路径"的模型一致，不引入新概念。
- **stub 拖回起点 = 停留腿**：终点拖回与起点重合 → 该 leg 退化为零长度 = 停留 / 停顿（object 在那儿待 `time` 秒），View 用一个小**环标记**表示 hold，不画线。这样"加一段停顿"自然覆盖，无需单独 stop 类型。

### 7.3 timebar leg ↔ View path 的选中联动
- timebar 上每条 leg ↔ View 中一条 path（一一对应）。
- 点 timebar 的 leg → View 高亮对应 path；点 View 的 path → timebar 选中对应 leg。
- 新加的 leg 默认处于"双向选中"态，加完直接去 View 拖即可。

### 7.4 Handoff（交接点）三模式与交互
相邻两条 leg 共享一个 `Handoff.sharedPoint`，并带 `mode`：

```
Handoff {
  sharedPoint: PathPoint          // 前腿终点 === 后腿起点（同一份数据）
  mode: 'smooth' | 'stop' | 'cut'
}
```

| mode | 语义 | timebar 边界图标 | Director View 徽标 |
|---|---|---|---|
| `stop`（默认） | 前腿速度降到 0，后腿从 0 起步（停顿再走） | 实心方点 ■ | ■ |
| `smooth` | 出入切线联动、速度连续（一镜到底） | 两段弧线相连圆 ◉ | ◉ |
| `cut` | 允许位置不连续（瞬移 / 跳切） | 断裂 / 锯齿 | ⤳ |

**切换方式**
- 点 timebar 边界节点 → 弹极简三选（smooth / stop / cut）；或右键出上下文菜单。
- Director View 中交接点徽标亦可点击切换，双向同步。

**smooth 模式下的切线拖拽（关键交互）**
- `smooth` 模式下，交接点显示**一条共享切线手柄**；拖动它 = 同时旋转前后两条 leg 的出入切线（联动，保持连续）。
- 切到 `stop` 后手柄**解锁为两条独立切线**，每条 leg 可各自设缓动（从"连续"退回"停顿再走"）。

**mode 本质是 Speed Curve 边界的便捷配置（不另写物理）**
- `stop` → 前腿 `ease-out`、后腿 `ease-in`（速度归零）。
- `smooth` → 边界两端都 `linear` / 互补，并锁定切线联动（速度不归零）。
- `cut` → 允许后腿起点自由拖动（瞬移），用虚线连线提示不连续。

**默认值**：新交接点默认 `stop`（离散、可读）；Inspector 提供逐腿切换 + 整轨一键 smooth/stop。

### 7.5 多段连续 leg 的端点同步规则（重要）
当多条 leg 连续、在 View 中修改某段交接点的位置时：

1. **交接点位置：A 尾 = B 头 = 同一份 `sharedPoint` → 永远自动同步**（除非 `cut`）。
   - 因为 A 的最后一个点与 B 的第一个点引用同一份数据，拖 A 的尾点，B 的头点自动跟随，**无需手动传播**。这是共享点方案相对"每段各存起点"的核心好处。
2. **`cut` 模式不联动**：handoff 设为 `cut` 时下一段起点解耦，拖 A 尾点不会动 B 头点（有意为之）。
3. **只动"那一个点"，不自动搬动整条腿**：拖 `sharedPoint` 时，A 的其它点、B 的其它点**保持原位**（各自仅相邻端点改变，两段可能在交接处被拉伸）。这是最可预测的逐点行为。
   - 进阶可选：按住修饰键拖动 = 将**下游整条腿刚性平移**（保持 B 自身形状只换位置）。默认不启用。
4. **切线遵循同一逻辑**：`smooth` 下交接点切线联动（转它则 A 出射 + B 入射一起转）；`stop` 下两条切线独立。
5. **中段折点不影响其它 leg**：修改某 leg **内部**的折点只影响该 leg 自身，无需跨段同步。

**同步算法（伪代码）**

```
function moveHandoff(state, handoffId, newPos):
  hp      = state.handoffs[handoffId]
  prevLeg = legBefore(hp)      // 前腿
  nextLeg = legAfter(hp)       // 后腿
  delta   = newPos - hp.sharedPoint.pos

  hp.sharedPoint.pos = newPos  // A 尾 === B 头 === 同一份，自动同步

  if hp.mode == 'cut':
    return                     // 下游解耦：不动 nextLeg 起点

  // 默认：仅移动共享点；两段各自其它点保持原位（可在交接处被拉伸）
  if modifier.rigidTranslateDownstream:
    for p in nextLeg.points[1:]:   // 修饰键：刚性平移下游整腿，保持形状
      p.pos += delta

  // smooth：共享切线手柄已联动，无需额外操作
  // stop：两段切线独立，由各自 Speed Curve 决定
```

> 关键点：**同步不是"复制坐标后双向广播"，而是"只改一份 sharedPoint"**——因为 A 尾与 B 头引用同一份数据，任一方的编辑天然反映到另一方。

---

## 8. Camera Segment 与「一镜到底」（新增）

> 本节回应一个问题：同一台相机在一镜到底里能否中途改拍摄目标 / 角度 / 距离 / 位置 / 景别？结论：camera **已经有 segment 概念（`CameraMove`）**，一镜到底可表达，但它是「半分段」的，且缺 actor 那边已解决的**段间连续性**。

### 8.1 现状：camera 本来就有 segment
每台相机在 Timeline 上有自己的 track，由一串 `CameraMove` 组成：

```typescript
interface CameraMove {
  id: string;
  camera: string;
  type: CameraMotionType;          // STATIC / FOLLOW / ORBIT / DOLLY / CRANE
  timeStart: number; timeEnd: number;
  targetId?: string;               // 可覆盖「拍谁」
  orbitDeg: number;                // ORBIT：本段内绕目标转过的角度
  dollyScale: number;              // DOLLY：结束时距离系数（1=保持基准取景距离）
  craneHeight: number;             // CRANE：结束时附加高度（米）
  ease: EaseCurve;
}
```

同一台相机、一镜到底、中途换目标 / 换角度 / 推进 / 升降，**已经能用多条相邻 `CameraMove` 表达**。理念上与 actor 的 `MoveSegment` 一致。

### 8.2 「半分段」事实表
| 维度 | 现在归属 | 一镜内能否按段改 |
|---|---|---|
| 拍摄目标 target | `CameraMove.targetId` | ✅ 能 |
| 运动类型 motion | `CameraMove.type` | ✅ 能 |
| 角度（绕飞） | `CameraMove.orbitDeg` | ✅ 能（仅 ORBIT 连续转） |
| 距离（推拉） | `CameraMove.dollyScale` | ✅ 能 |
| 高度（升降） | `CameraMove.craneHeight` | ✅ 能 |
| **景别 framing** | `CameraObject`（相机全局） | ❌ 不能 |
| **视角 view** | `CameraObject`（相机全局） | ❌ 不能 |
| **方位 side** | `CameraObject`（相机全局） | ❌ 不能 |
| **镜头 lens** | `CameraObject`（相机全局） | ❌ 不能 |

**关键缺口**：`framing / view / side / lens` 现在挂在 `CameraObject` 上，是整台相机的全局设置，不按段分。所以一镜到底里「先 wide 再推成 CU」「从 eye 升到 overhead」目前做不到分段切换。

### 8.3 与 actor 的结构性不对称
- **actor 的 segment**（`MoveSegment`）：带**显式空间路径**（start/end/points 折线）+ 速度曲线，路径可直接编辑。
- **camera 的 segment**（`CameraMove`）：只带**运动类型 + 参数**（orbit/dolly/crane），机位本身是 `placeCamera` **反推**出来的（`位置 = 目标 + framing + side + view + orbit/dolly/crane`），不是可编辑折线。

因此相机要跑复杂自定义轨迹（如同时 dolly-in + crane-up + 自定义弧线），现在没有「路径编辑」手段，只能套命名运动。

### 8.4 一镜到底真正的缺口：段间硬切
`solveCamera` 在某一时刻只 `find` 当前**唯一**生效的 `CameraMove`；两条相邻 `CameraMove` 的交界处**无任何插值/混合**，直接跳变。`sampleCameraPath` 在边界会出现**位置不连续**。

- 单条 `CameraMove` 内部：orbit/dolly/crane 缓动平滑 ✅
- 两条 `CameraMove` 边界：硬切 ❌

这正是 actor 那边已解决的 `Handoff`（smooth/stop/cut）。**camera 的一镜到底缺的就是这个：CameraMove 之间的接管（连续 / 停顿 / 跳切）。**

### 8.5 设计建议（与 actor 对称）
把「同一相机的一镜到底」完全类比「同一 actor 的多 leg」：

1. **`CameraJunction`（边界交接）**：相邻 `CameraMove` 边界 = 一个交接点，带 `smooth / stop / cut`，**镜像 actor 的 `Handoff`**。这是一镜到底连续性的核心。
   - `smooth`：交界前后机位（位置 + 朝向）连续插值，无跳变。
   - `stop`：在边界处速度归零再起（允许重新构图停顿）。
   - `cut`：允许跳变（硬切转场）。
2. **`framing / view / side / lens` 下放到 `CameraMove`（可覆盖）**：`CameraObject` 仅保留默认值，每段可 override。这样一镜内景别 / 视角 / 方位 / 镜头都能分段演进（如 wide→CU、eye→overhead）。
3. **（可选）相机显式空间路径**：新增 `motion: "PATH"` 类型，让相机像 actor 一样沿可编辑折线运动，覆盖 ORBIT/DOLLY/CRANE 表达不了的复杂运镜。

> 与 §7 的关系：actor 用 `Handoff` 解决 leg 间连续；camera 用 `CameraJunction` 解决 `CameraMove` 间连续。两者语义同构，应共用同一套「smooth/stop/cut」交互与可视化（菱形交接节点 + 图标）。

### 8.6 验收
- 同一相机两条相邻 `CameraMove` 在 `smooth` 下机位连续、无跳变；`stop` 下可停顿；`cut` 下可跳变。
- 一段 `CameraMove` 可独立设置 framing/view/side/lens，且覆盖 `CameraObject` 默认值。
- Timeline 上相机 track 的 `CameraMove` 之间有可见的交接节点，可切换模式。

### 8.7 实现状态（2026-09-07 落地）

> 代码已在 `src/state/directorStore.ts`、`src/components/Timeline.tsx`、`src/components/Inspector.tsx`、`src/engine/demoShot.ts` 中落地；架构说明见 `Director_Desk_V1_Architecture_Baseline_2026-09-05.md` §69.2；测试见 `Director_Desk_Automation_Test_Cases_V1.md` §15。

| §8.5 建议 | 状态 | 说明 |
|---|---|---|
| 8.5-1 `CameraJunction`（边界交接） | ✅ 已实现 | `CameraJunction { prevMove, nextMove, mode }` 已存在；`reconcileCameraJunctions` 在相邻且时间相接的 `CameraMove` 间自动生成，确定性 id `J_<prev>_<next>`，默认 `stop`；Timeline 上渲染为菱形节点（◉ smooth / ■ stop / ✕ cut），点击循环 `stop → smooth → cut`；`setCameraJunctionMode` 保留 mode。|
| 8.5-2 `framing/view/side/lens` 下放到 `CameraMove` | ✅ 已实现 | `CameraMove` 已有可选字段 `framing? / view? / side? / lensMm?`；`CameraObject` 仅保留默认值；Inspector 提供对应下拉覆盖，求解时 `CameraMove` 段级值优先于相机全局值。|
| 8.5-3 相机显式空间路径 `motion: "PATH"` | ⬜ 未实现（可选） | 当前相机机位仍由 `placeCamera` 反推（目标 + framing + side + view + orbit/dolly/crane），无折线编辑。复杂自定义轨迹待后续。|

**Demo 预置（让相机轨道默认可见 / 可编辑）**：`demoShot.ts` 的 `CAM_A` 预填两条 `CameraMove`——`MOVE_CAM_A_01`（FOLLOW，0–6s，medium / back_3_4 / 50mm）与 `MOVE_CAM_A_02`（ORBIT，6–12s，orbit 120° / close_up / side / 35mm），二者时间相接处预置 `smooth` 的 `CameraJunction`，演示「一镜到底」连续性。

**Timeline 追加入口**：每台相机轨道末尾新增「+」按钮，调用 `addCameraMove(camera.id, camera.motion)`，在播放头处追加该相机当前运镜类型的 `CameraMove` 并自动选中。

### 8.7.1 段级 / 相机级取值语义（2026-09-07 定稿）

`CameraMove` 的 `framing / view / side / lensMm` 均为**可选**字段，求解时按 `options.X ?? camera.X` 取值：

| 段级字段 | 行为 |
|---|---|
| 留空（`undefined`） | **继承**相机级 `CameraObject` 的同名属性；相机级改动立即在该段生效 |
| 填了值 | 该段**独立生效**，不再受相机级同名属性影响 |

- **UI 可发现性**：段级下拉首项是 `(camera default)`（选它即回退为继承）；相机级 `Camera Intent` 区在该相机存在段级覆盖时显示 `⚠ ... 已被某些 CameraMove 段级覆盖`（`Inspector.tsx` 的 `overriddenByMoves`）。
- **新建段默认继承**：`addCameraMove` 不会把相机级值复制进 `CameraMove`，新段一律留空。
- ⚠ **历史坑（已修）**：demo 早期版本把 `framing / view / side / lensMm` **写死**在两条 `CameraMove` 上，导致相机级四项在整条时间轴上**静默失效**，表现为「改 camera 属性没反应」。现改为：`MOVE_CAM_A_01` 四项全部留空（完整继承），`MOVE_CAM_A_02` 仅保留 `framing: "close_up"` 演示段级覆盖。
- ⚠ **localStorage 会屏蔽修复**：`loadScene()` 优先载入已保存场景，旧存档里写死的段级值仍然生效。因此 `STORAGE_KEY` 由 `director-desk-scene-v1` 升为 `-v2`，放弃旧存档以确保修正后的 demo 生效。

---

*文档基于与用户的多次讨论整理：专业运镜分类（§1）、视频参考集中情况与模板库设计（§2–§5）、待补维度与实现清单（§4–§6）、Segment/Leg 与 Handoff 交互设计（§7）、Camera Segment 与一镜到底（§8）。所有内容均为设计草案，待确认后落地到 `src/domain`、`src/engine/path`、`src/engine/cameraSolver`、`src/state` 与 UI 层。*
