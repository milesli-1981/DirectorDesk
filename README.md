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
- Timeline
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
  - 顶栏 `Render Video`：对当前场景逐台相机渲染其 POV（Camera View），用 `canvas.captureStream` + MediaRecorder 实时录制，每台相机输出一条 WebM（`<场景名>_<相机名>.webm`，对齐 Baseline §1352 多机位批量）。
  - 实时录制：总耗时 ≈ 各相机内容时长之和；确定性离线渲染（WebCodecs / MP4 + 精确画幅遮幅）为后续升级方向。
- 运动求解
  - 位置 = Segment（路径里程 × 速度曲线）
  - 路径被静态环境（set 资产）阻挡时自动绕行：拐角可见图 + Dijkstra；端点落在障碍内会推到外边缘
  - FOLLOW 在约束开始时刻捕获相对偏移，之后保持该偏移
  - 无驱动时保持最近一次驱动结束姿态，不弹回 ORIGIN
  - Body Motion（步态循环）与整体位移（Motion Curve）分离

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
src/
├── app/           # 应用壳：布局、播放循环、快捷键
├── components/    # ObjectList / WorldView / Inspector / EaseEditor / Timeline / RadialRing
├── domain/        # Director Schema
├── engine/        # ease / path / solver / pick / timeline / demoShot
└── state/         # Zustand Store
```

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

本版聚焦还原原型交互闭环（Director 意图 → 求解 → 实时预览）。
原代码中的 Camera Solver / Previs Export / Undo-Redo / 本地持久化 与当前数据模型不兼容，已移除；
相关能力（多机位、Camera Interest、AI Direction Package）建议在新的 Segment / Constraint 模型稳定后再接回。
