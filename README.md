# Director Desk V1

基于 `Director_Desk_V1_Architecture_Baseline_2026-09-05.md`，并按 `prototype/preview.html`
（Director Desk V1.20 — Follow Single Source）还原的可运行版本。

核心原则：**Timeline 只是 Director State 的一个视图，Playback 读取同一份状态。**

## 当前实现

- 布局：Scene Tree（左） / Director World（中） / Inspector（右） / Timeline（底部整行）；右侧 Inspector 控件自适应收窄，不出现横向滚动条
- Director State（唯一数据源）
  - `objects`：Actor / Landmark / Prop 的 ORIGIN
  - `segments`：MOVE Segment（When + 速度曲线）
  - `constraints`：FOLLOW / LOOK_AT 持续意图
  - `revision`：每次意图变更自增
- 3D Director View（Three.js，俯视导演平面）
  - 对象 / 资产拖拽移动 ORIGIN（命中按 `footprint`：高大的建筑也能直接拖动，不只是底部）
  - 点击对象打开径向意图环（MOVE / LOOK AT / FOLLOW / ACTION …）
  - 路径可视化、START / END 端点拖拽
  - 沿路径拖拽生成中间控制点（插入最近局部区间，而非追加到末尾）
  - 控制点 LINE ⇄ ARC 切换；ARC 为控制点，相邻 ARC 会被规范化为 LINE
  - 选中非法 LINE 点时按钮不渲染（而不是 disabled）
  - FOLLOW / LOOK AT 连线
  - 缩放（按钮 / 滚轮），只改变视图不改变世界坐标
  - `category === "human"` 的资产用**人形组合体**（头 + 躯干 + 双臂 + 双腿）渲染，与建筑 / 家具等方盒资产区分
  - 演员头顶名牌渲染进场景（高分辨率贴图 + 各向异性 + 半透明圆角背板），视频导出也能录到、亮 / 杂背景上均清晰可读
  - Camera 视图下**任何机位代理都不入画**（含其它相机），只保留演员 / 环境资产本体与取景叠加
- Inspector
  - 当前意图 / 选中时间轴项 / 路径点数量与形态
  - Speed Curve：cubic-bezier 预设 + 双控制柄拖拽 + 速度条 + 播放头
  - State Revision 与 Director State JSON
- Camera（多机位）
  - 可任意增加机位：`＋ CAMERA`
  - Camera Intent：Target / Framing / View / Side / Lens / 默认 Motion
  - 每台相机拥有自己的 Camera Track：`STATIC / FOLLOW / ORBIT / DOLLY / CRANE / DRONE`（DRONE = 同时绕圈 + 升降 + 推拉的自由空中飞行）
  - 无人机机位：Scene Tree 的 `＋ DRONE` 一键生成航拍机（默认 high 机位 / 24mm / DRONE 运镜）；也可在 Inspector 把任意相机切到 Drone 平台（自带基础飞行高度、不受地面约束），Director View 以四旋翼代理显示
    片段在 Timeline 上拖动改时间、边缘修剪时长、可单独编辑速度曲线
  - 运镜参数：ORBIT 角度、DOLLY 距离系数、CRANE 高度
  - Director View 显示相机代理、视锥与整段运镜轨迹
  - Camera View：通过当前机位取景，带三分法 / 中心 / 安全框与画幅比遮幅
  - 项目级 Master Ratio：16:9 / 2.39:1 / 1.85:1 / 4:3 / 9:16
  - 段级 / 相机级属性：CameraMove 的 `framing / view / side / lens` **留空 = 继承相机级**，填值 = 该段独立生效；段级下拉首项 `(camera default)` 即回退为继承，存在段级覆盖时相机级区域会给出 `⚠` 提示
  - 相机改名：Scene Tree 与 Timeline 的相机标签均可**双击改名**（id 不变，仅改显示名），导出文件名随之变化
- Timeline
  - 顶栏右上角放置 `Scene Duration (s)`（场景最大时长，成片导出与时间轴刻度基准），左侧轨道标签列（对象 id）宽度默认 190px
  - 每个对象一条轨道，Segment / Constraint 自动生成 Clip，轨道末尾「＋」可加腿（append 新 MOVE，默认 2s / 2 单位 stub）
  - 每台相机一条轨道，demo 预置 CAM_A 两条 CameraMove（FOLLOW / ORBIT）+ smooth 交接；轨道末尾「＋」可追加 CameraMove
  - 拖动 Clip 改变时间（不改变空间几何），拖边缘修剪时长
  - Segment Clip 显示缓动缩略图
  - 轨道标签过长时截断为省略号（悬停显示全名）；标签可作把手上下拖动调整行顺序
  - 播放头拖拽定位，Play / Home / Reset
  - 播放到「最后一个有内容的时刻」（segment / constraint / camera move 的最大 `timeEnd`）自动结束，并把播放头重置回第一帧；从末尾按播放会先回到第一帧
- Assets（资产）
  - 一切被拍对象与环境物统一抽象为资产：human / animal / vehicle（agent，可运动、可作目标）/ building / furniture / nature / prop（set，静态环境）。
  - 每个资产有默认体块（footprint w×d×h）+ 朝向；Scene Tree 的 `ADD ASSET` 面板按类别一键摆放，Inspector 可改 role / rotation / 体块尺寸 / 删除。
  - 静态环境资产参与遮挡（红色 BLOCKED 高亮 + 相机→目标视线，被挡红虚线 / 通畅淡青）与行动路线绕障（橙色虚线导航层 = agent 实际行走路线，已接入运动求解）。
  - 摆放碰撞：set ↔ set 重叠时沿最小穿透轴自动分离到刚好不碰（agent 不参与）。
  - demo 预置 `BLD_A`（楼）、`TBL_01`（桌）演示环境，以及 `BLD_B`（刻意挡在 CAM_A → M17 视线上）演示遮挡。
  - 资产可锁定：Scene Tree 行内或 Inspector 一键 `Lock`，锁定后不可拖拽移动（防误触），仍可点选解锁；Director View 中显示 `LOCKED` 标记。
- 片场 / 场景页（多场景）
  - 顶部 tab 栏管理「场景页」：新建（空白）/ 切换 / 双击重命名 / × 删除（保留至少一个）/ ⧉ 复制 / 拖动排序。
  - 片场名可在 tab 栏左侧编辑（仅作工程统称，不另成层）。
- 场景持久化
  - 每张场景页独立 localStorage key（由片场 manifest 索引），切换不丢页；旧的 v2 单场景存档首次启动自动迁移为「一个场景页的片场」。
  - 顶栏 Export / Import 改为整片场（manifest + 全部场景页 JSON）；旧的单个场景文件仍可导入（当作当前场景页替换）。自动保存由「场景页内容 revision + 片场结构」任一变化触发。
- 视频导出（Previs）
  - 顶栏 `Render Video`：对当前场景逐台相机渲染其 POV（Camera View），确定性离线逐帧渲染，每台相机输出一条视频（`<场景名>_<相机名>.mp4`，对齐 Baseline §1352 多机位批量）。
  - 直出 MP4：使用 WebCodecs（`VideoEncoder` + H.264/avc）逐帧编码 + `mp4-muxer` 封装，画幅精确遮幅、确定可复现；浏览器不支持 WebCodecs 时自动回退 WebM（MediaRecorder），保证总能出片。
  - 导出期间切换为 Camera View 逐帧推进，结束后恢复导演视图与播放头。
  - 也封装为 **Previs MCP Server**（`mcp-server/`）：对外暴露 `render_previs(sceneJson)` 工具，LLM 可在对话里把场景 JSON 直接渲染成预演视频（详见下文「MCP / Previs MCP Server」）。
- 运动求解
  - 位置 = Segment（路径里程 × 速度曲线）
  - 路径被静态环境（set 资产）阻挡时自动绕行：拐角可见图 + Dijkstra；端点落在障碍内会推到外边缘
  - FOLLOW 在约束开始时刻捕获相对偏移，之后保持该偏移
  - 无驱动时保持最近一次驱动结束姿态，不弹回 ORIGIN
  - Body Motion（步态循环）与整体位移（Motion Curve）分离

- 组 / Group Dynamics（引力场，Baseline §58，最小原型）
  - 组不是文件夹，而是可被导演直接控制的**主体**：组内成员之间存在「引力场」关系——开启 `dynamics` 后，成员被拉向群体质心，并受「领队」（速度最大者）在引力半径内吸引，形成关系驱动、而非同步动画的群体运动。
  - 数据模型：`DirectorState.groups: DirectorGroup[]`（`id / name / color / members / dynamics / cohesion / influenceRadius`）；`CameraObject.groupId` 可直接引用组，相机以 GROUP 取景并实时跟随成员变化。
  - 求解（`solver.ts`）：在 Segment / FOLLOW / Hold 基础运动之上，额外叠加一层引力场偏移；通过 `applyDynamics` 开关避免递归与反馈，FOLLOW 偏移按「作者态」几何捕获、不受扰动。
  - 朝向传播（Emergent Alignment）：组内成员的**面向**按「距离越近权重越高、远处采样时间延迟更久」加权对齐到邻近成员——领队（速度最大者）一旦转向，转向会像波一样沿群体传开（近处立刻跟、远处延迟跟），这是关系驱动、而非同步脚本动画的涌现特征（`groupHeadingInfluence`，波速 `WAVE`、延迟上限 `MAX_DELAY` 可调）。
  - 用法（左侧 GROUPS 面板）：`＋ 新建组` → 在 OBJECTS 选中对象后点 `＋加入选中` 拉进组 → `相机取景` 让当前相机框住整组；`引力场` 开关 + 聚拢 / 半径滑块调节涌现强度；导演视图内用同色连线画出组关系网络（开引力场高亮、否则灰显）。
  - demo 预置 `TEAM_ALPHA`（M17/M18/M19，引力场开），`CAM_DRONE` 已改为 GROUP 取景该组，刷新即可见效果。
  - 涌现演示场景 `群体涌现转向`：4 人小队先并行前进，领队在 t=3s 突然 90° 北转；**无任何 FOLLOW 约束**，组员纯靠引力场（聚拢 + 领队吸引 + 朝向传播）被「卷」着延迟转向，切到 `CAM_SWARM` 俯视即可清晰看到这道转向波。
  - 行进避障（过地形）：编队在行进 / 变阵途中遇到静态障碍时，**只让被挡一侧的队员局部让位**（沿穿透更浅的轴推到刚好留 0.25m 余量），未挡一侧完全保持原编队位置；不再把整队塌缩成单列。局部避让直接叠加在最终期望位上、不经惯性低通，避免被甩动抵消而「看着让了却仍穿过去」。
  - 变阵「绝不倒退」：编队切换过渡会整体前移新阵型，使每个队员的目标前向位置都不小于其起始位置——即**绝不为了排队形而向后倒退**，没到位的队员一律向前归位（可越过前方已就位队友）。团队（Group）行也支持锁定：锁后编辑态下拖不动队首（即整队不可被拖拽移动），播放时仍按轨迹行进。

## 启动

```bash
npm install
npm run dev
```

默认地址：

```text
http://localhost:4173
```

## 目录

```text
mcp-server/         # Previs MCP Server：把场景 JSON 渲染成视频，供 LLM 在对话里出片
skills/             # previs skill：简版 brief → compileSpec.mjs → DirectorState JSON
src/
├── app/           # 应用壳：布局、播放循环、快捷键
├── components/    # ObjectList / WorldView / Inspector / EaseEditor / Timeline / RadialRing
├── domain/        # Director Schema
├── engine/        # ease / path / solver / pick / timeline / demoShot
└── state/         # Zustand Store
```

## MCP / Previs MCP Server

把「导演场景 JSON → 预演视频」的能力包装成 MCP 工具，供 LLM 在对话里直接出片（`mcp-server/`，细节见其独立 README）。

### 工具 `render_previs`

| 参数 | 类型 | 说明 |
|---|---|---|
| `scene` | string (JSON) | `DirectorState` 单场景，或 `{ manifest, scenes }` 整片场 |
| `camera` | string? | 相机 id；省略则录第一台相机 |
| `fps` | number? | 帧率，默认 24（1–60） |
| `appUrl` | string? | Web App 地址，默认取 `PREVIS_APP_URL` / `http://localhost:5173` |

返回视频文件的本地绝对路径，并附带 `file://` 资源；渲染为**实时 1x**，耗时 ≈ 场景时长。

### 原理（复用现有渲染，零重写）

```text
LLM ──(MCP/stdio)──> render_previs(sceneJson)
                        │
                        ▼
                  MCP server（mcp-server/index.mjs）
                    ├─ 起本地 HTTP 接收器（视频落盘到临时文件）
                    ├─ Playwright 启动无头 Chromium，加载 Web App (?headless=1)
                    ├─ 调 window.previsRender({ scene, camera, fps, receiver })
                    │     App：导入场景 → 录制指定相机 POV（MediaRecorder）→ 上传接收器
                    └─ 返回视频文件绝对路径（file:// 资源）
```

Web App 侧只需 `?headless=1` 时挂上 `window.previsRender`（见 `src/engine/headlessApi.ts`）。

### 运行与接入

1. 跑起 Web App（MCP server 需要能访问它）：仓库根 `npm run dev`，默认 `http://localhost:5173`。
2. 安装 MCP server 依赖：`cd mcp-server && npm install --ignore-scripts && npx playwright install chromium`。
3. 启动：`cd mcp-server && npm start`（stdio 传输）。

客户端（`Claude Desktop` / `CodeBuddy` 等）配置示例：

```json
{
  "mcpServers": {
    "directdesk-previs": {
      "command": "node",
      "args": ["/绝对路径/mcp-server/index.mjs"],
      "env": { "PREVIS_APP_URL": "http://localhost:5173" }
    }
  }
}
```

### 配合 Skill 出片

`skills/previs/` 提供 `SKILL.md`（SOP + 简版场景 spec 速查 + 镜头工艺要点）与 `compileSpec.mjs`（把简版 brief 编译成 `DirectorState` JSON），降低 LLM 手写完整 schema 的负担。

流程：**用户创意 → brief → `compileSpec.mjs` → `DirectorState` JSON → `render_previs` → 视频**。

## 数据关系

```text
OBJECT(ORIGIN)
   ↓
SEGMENT(MOVE) ── points ── ease ── timeStart / timeEnd
   ↓
CONSTRAINT(FOLLOW / LOOK_AT)
   ↓
TIMELINE (view)
   ↓
SOLVER → PREVIEW
```

## 说明

本版聚焦还原原型交互闭环（Director 意图 → 求解 → 实时预览），并已接回部分原被移除的能力：

- 本地持久化：已重新实现为片场/场景页 per-page localStorage（v3），见上文「场景持久化」与 Baseline §73。
- Previs Export：已重新实现为 Previs 视频导出（多机位批量、WebCodecs 直出 MP4 + WebM 兜底），见上文「视频导出」与 Baseline §74。
- MCP 对外能力：场景 JSON → 视频已封装为 `render_previs` MCP 工具（`mcp-server/`），并配 `skills/previs/` 的 brief 编译器，见上文「MCP / Previs MCP Server」。
- 多机位：已在 Camera 章节实现（多相机 + 各自 Camera Track + 交接）。
- 待接回：Camera Solver（独立镜头求解）、Undo-Redo、Camera Interest、AI Direction Package——建议在 Segment / Constraint 模型稳定后继续。
