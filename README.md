# Director Desk V1

基于 `Director_Desk_V1_Architecture_Baseline_2026-09-05.md`，并按 `prototype/preview.html`
（Director Desk V1.20 — Follow Single Source）还原的可运行版本。

核心原则：**Timeline 只是 Director State 的一个视图，Playback 读取同一份状态。**

## 当前实现

- 布局：Scene Tree（左） / Director World（中） / Inspector（右） / Timeline（底部整行）
- Director State（唯一数据源）
  - `objects`：Actor / Landmark / Prop 的 ORIGIN
  - `segments`：MOVE Segment（When + 速度曲线）
  - `constraints`：FOLLOW / LOOK_AT 持续意图
  - `revision`：每次意图变更自增
- 3D Director View（Three.js，俯视导演平面）
  - 对象拖拽移动 ORIGIN
  - 点击对象打开径向意图环（MOVE / LOOK AT / FOLLOW / ACTION …）
  - 路径可视化、START / END 端点拖拽
  - 沿路径拖拽生成中间控制点（插入最近局部区间，而非追加到末尾）
  - 控制点 LINE ⇄ ARC 切换；ARC 为控制点，相邻 ARC 会被规范化为 LINE
  - 选中非法 LINE 点时按钮不渲染（而不是 disabled）
  - FOLLOW / LOOK AT 连线
  - 缩放（按钮 / 滚轮），只改变视图不改变世界坐标
- Inspector
  - 当前意图 / 选中时间轴项 / 路径点数量与形态
  - Speed Curve：cubic-bezier 预设 + 双控制柄拖拽 + 速度条 + 播放头
  - State Revision 与 Director State JSON
- Timeline
  - 每个对象一条轨道，Segment / Constraint 自动生成 Clip
  - 拖动 Clip 改变时间（不改变空间几何），拖边缘修剪时长
  - Segment Clip 显示缓动缩略图
  - 播放头拖拽定位，Play / Home / Reset
- 运动求解
  - 位置 = Segment（路径里程 × 速度曲线）
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
