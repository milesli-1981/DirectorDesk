# Director Desk / Director Engine — 当前设计总备份

> 版本：2026-09-05
>
> 本版本在 2026-09-04 总设计基础上，加入 **Group Dynamics / Emergent Behavior / Perception Event** 设计。
>
> 本文用于备份目前关于 **Director Desk / Director Engine** 的产品定位、架构、核心对象、Preview、AI、时间轴、相机、空间系统等讨论结论。
>
> 核心目标：建立一个独立于 ComfyUI、面向 AI 电影/视频预演（Previs）与导演调度的系统。

---

# 1. 产品定位

## Director Desk

**Director Desk = Independent AI Film Previsualization & Directing System**

它不是 Blender 的替代品，也不是传统 3D 软件。

核心目标：

> 用最少的操作，让导演描述复杂的 3D 场景、人物关系、运动、镜头和时间，并快速验证最终画面是否成立。

核心理念：

> Director Once, Generate Anywhere.

Director Desk 负责：
- 导演意图
- 场景空间
- 角色/群组
- 运动
- 镜头
- 时间轴
- 空间关系
- 遮挡
- Previs
- AI Direction Package

AI 负责：
- 看懂参考图
- 提供场景理解
- 提供建议

Three.js / Previs Renderer 负责：
- 实时显示
- 低模预演

Solver 负责：
- 将导演意图转换为实际位置、旋转、镜头参数等

---

# 2. ComfyUI 的定位

Director Engine 独立存在。

ComfyUI 只是一个可选的 AI / Workflow Adapter。

未来可以接：
- ComfyUI
- Local AI
- Cloud AI
- Blender
- Unreal
- AI Video Models

核心架构：

```text
DIRECTOR DESK
├── Director UI
├── Director World
├── Timeline
├── Camera
├── Proxy
├── Group
├── Spatial
└── Previs
        ↓
DIRECTOR ENGINE
├── Scene Runtime
├── Motion Solver
├── Camera Solver
├── Spatial Solver
├── Constraint System
└── Previs Renderer
        ↓
AI / WORKFLOW ADAPTER
├── ComfyUI
├── Local AI
└── Cloud AI
```

Director Engine 即使完全关闭 AI，也应该可以独立完成：

```text
World
→ Actor
→ Group
→ Camera
→ Timeline
→ Previs
```

---

# 3. Blender 的定位

Blender 是内容生产工具。

Director Desk 是导演 / Previs 工具。

Blender 擅长：
- 建模
- 雕刻
- UV
- 材质
- Rigging
- Weight Paint
- 复杂动画
- 物理
- 高质量渲染

Director Desk 不应该复制这些功能。

Director Desk 擅长：
- Semantic Proxy
- Actor
- Group / Crowd
- Landmark
- Spatial / Occlusion
- Action
- Constraint
- Path
- Motion Curve
- Director Camera
- Camera Solver
- Director Timeline
- Multi-Camera
- Reference Build
- Previs
- AI Direction

Blender 可以作为：
- 内容生产后端
- 高质量资产来源
- GLB / FBX 等资产交换工具
- 后期完整动画制作工具

核心区别：

Blender 用户：

> Create Cube → Create Armature → Keyframe → Camera

Director 用户：

> Create Base → Marine Runs Here → Zerg Charges → Camera Follows Marine

Director Desk 使用导演语言，而不是底层 3D 技术语言。

---

# 4. 8GB GPU 是开发基线

用户开发机器为 8GB VRAM，因此：

- 8GB：完整开发 / 测试基线
- 12GB：推荐
- 16GB：大型场景 / 更强 AI
- 24GB+：重型 AI / 批处理 / 高质量

关键原则：

> 8GB 必须跑完整闭环，而不仅仅是启动程序。

目标闭环：

```text
Reference Images
↓
AI Understanding
↓
Director World
↓
Three.js
↓
Actor / Group
↓
Camera
↓
Timeline
↓
PREVIS
```

AI 不应全部常驻：

```text
Vision → unload
Depth → unload
Segmentation → unload
```

AI 应该按需加载。

未来可以有：

```text
DIRECTOR AI
Compute Mode [Fast / Balanced / Quality]
VRAM Budget [8 GB]
Model Strategy [Automatic / Manual]
```

---

# 5. AI 的核心原则

> AI 负责看懂；Director 负责决定；Three.js 负责表现；Solver 负责计算；Previs 负责验证。

AI 不应该直接替导演决定世界。

AI 的场景理解是：

```text
AI SUGGESTED
```

用户确认后：

```text
USER CONFIRMED
```

用户手动修改：

```text
USER OVERRIDE
```

Solver 产生的结果：

```text
SOLVER GENERATED
```

避免 AI 不断覆盖用户的导演决定。

---

# 6. Reference Build

系统允许一次导入多张概念图。

不同图片承担不同角色：

```text
[World Map]
[Location]
[Architecture]
[Environment]
[Character]
[Creature]
[Prop]
[Style]
```

例如：

```text
Base Concept
Map
Valley
Forest
Marine
Zerg
Props
```

流程：

```text
References
↓
AI Scene Understanding
↓
World Proposal
↓
Director Confirmation
↓
Director World
```

AI 生成 Proposal：

```text
BASE
Proxy: Bunker
Size: 90 × 120m
Confidence: 0.82

VALLEY
Proxy: Terrain
Distance: ~800m
Confidence: 0.67

FOREST
Proxy: Forest
Area: ~300 × 500m
Confidence: 0.71
```

用户可以：
- Accept All
- 单项调整
- Replace Proxy
- 调整尺寸
- 调整位置

参考图应该绑定到具体 World Object / Anchor，而不是成为孤立图片。

---

# 7. Proxy System

核心原则：

> Image → Director Proxy

而不是：

> Image → Full 3D Model

AI 只需要识别：

> “这是什么？”

然后 Director Desk 自动绑定轻量 Proxy。

例如：

```text
Base → Bunker Proxy
Tower → Cylinder / Tower Proxy
Wall → Box Proxy
Ground → Plane
Marine → Humanoid Proxy
Zerg → Creature Proxy
Tank → Vehicle Proxy
Tree → Low-poly Tree
Valley → Terrain / Volume
```

Proxy 分三级：

## Primitive Proxy

- Cube
- Cylinder
- Plane
- Sphere
- Volume

## Semantic Proxy

- Humanoid
- Creature
- Vehicle
- Tree
- Building
- Tower
- Bunker
- Wall
- Mountain

## Group Proxy

- Army
- Swarm
- Crowd

Proxy 不只是外观，还携带：

- Type
- Size
- Position
- Orientation
- Collision
- Occlusion
- Visibility
- Landmark
- Targetability
- Solver Semantics

真实资产以后可以替换：

```text
Marine
→ Humanoid Proxy
→ Marine.glb
```

导演数据不需要改变。

---

# 8. Scale / Measurement

建议：

> 1 unit = 1 meter

Director Desk 关心的是比例，而不是网格拓扑。

重要物体允许手动调整：

```text
BASE
SIZE

Width  ←──●──→
Length ←──●──→
Height ←─●───→

80m × 120m × 25m
```

可以：
- 直接拖动尺寸
- 高级模式输入 X/Y/Z

可以设置 Scale Anchor，例如：

```text
Marine Height = 1.8m
```

然后系统根据它建议其他物体的比例。

原则：

> AI 估算只是建议；用户确认的尺度才是真实尺度。

---

# 9. Director World

World：

```text
WORLD
├── ENVIRONMENT
├── SUBJECT
│   ├── ACTOR
│   ├── GROUP
│   └── CROWD
├── PROP
├── LANDMARK
└── CAMERA
```

所有核心对象都应该支持：
- Select
- Move
- Scale
- Rotate
- Target
- Timeline

Project：

```text
PROJECT
├── SEQUENCE
│   ├── SHOT 01
│   ├── SHOT 02
│   └── ...
└── ASSETS
```

一个 Shot 拥有：
- World
- Timeline
- 多个 Camera

---

# 10. Actor / Group / Crowd

## Actor

单个可控制角色。

## Group

导演层级上的组织单位。

Group 不是普通文件夹，而是可直接被导演控制的主体。

例如：

```text
Zerg Swarm
Count = 500
Formation = Swarm
Density = High
Action = Charge
Target = Terran Base
Path = Valley Exit → Base
```

Group 支持：

### Distribution
- Count
- Area
- Density
- Randomness
- Variation
- Spacing
- Seed

### Formation
- Scattered
- Line
- Column
- Wedge
- Grid
- Circle
- Swarm

### Action
- Move
- Run
- Charge
- Hold
- Attack
- Retreat
- Scatter
- Regroup

可以：

```text
Macro Group Control
+
Individual Override
```

例如：

```text
Marine Army
├── Platoon A
│   ├── Marine 01
│   ├── Marine 02
│   └── ...
├── Platoon B
└── Hero Marine
```

---

# 11. Crowd 性能

不要真的模拟几百个完整角色。

采用：

```text
Near
→ Full / detailed

Mid
→ Simplified

Far
→ Low-poly

Very Far
→ GPU Instancing
```

远处群体使用：
- GPU Instancing
- LOD
- 简化碰撞
- Coarse Group Collider

例如 500 个 Zergling 不应该意味着 500 套完整骨骼、物理和碰撞。

---

# 12. Motion System

这是目前新增并已经确认的核心系统。

核心概念：

> Path = Where  
> Motion Curve = How  
> Timeline = When

同时加入：

> Locomotion = How the body moves

> Action = What it does

所以：

```text
WHERE
Path

WHEN
Timeline

HOW FAST
Motion Curve

HOW IT MOVES
Locomotion

WHAT IT DOES
Action
```

---

# 13. Motion Curve

人物、动物、怪兽、车辆、相机等运动都应该有 Curve。

因为真实运动通常不是匀速。

例如：

```text
RUN
Duration = 4s
Curve = Ease In / Out
```

默认：

- Linear
- Ease In
- Ease Out
- Ease In/Out
- Fast Start
- Fast Stop
- Smooth
- Step

高级用户可以：

```text
Advanced → Edit Curve
```

但 V1 不做 Blender / After Effects 那种复杂 F-Curve 编辑器。

---

# 14. Action / Constraint / Path / Curve / Timeline

严格区分：

## ACTION

角色“做什么”。

例如：
- WALK
- RUN
- SPRINT
- CHARGE
- ATTACK
- SHOOT
- JUMP
- IDLE

## CONSTRAINT

角色与其他对象的持续关系。

例如：
- LOOK_AT
- FOLLOW
- MAINTAIN_DISTANCE
- ORBIT
- STAY_BEHIND

例如：

```text
Marine A
ACTION = RUN

Marine B
CONSTRAINT = FOLLOW A
```

不要写成：

```text
RUN_FOLLOW
```

LOOK_AT 是持续导演意图，不是一次性 Action。

---

# 15. Path

Path 表示空间轨迹。

支持两种主要形式：

```text
Points / Waypoints
```

适合：
- 绕障碍
- 明确转折

以及：

```text
Vector / Spline
```

适合：
- 摄影机弧线
- 连续运动

V1 不需要暴露：
- Bezier Handles
- Tangent
- XYZ F-Curve

可以允许：

```text
Points ↔ Spline
```

互相转换。

---

# 16. Motion Skeleton

为了让 Preview 中的人、动物、怪兽真正“活起来”，需要基础骨骼。

但它不是 Blender Rig。

名称：

> Motion Skeleton

核心原则：

> Rig 是动画制作人员使用的；Motion Skeleton 是导演预览系统使用的。

---

# 17. Motion Skeleton 的层级

建议：

```text
MOTION SKELETON
├── STRUCTURE
├── MOTION
└── IK / TARGET
```

它只需要表达身体结构、基础运动和目标关系。

---

# 18. 人类 Motion Skeleton

例如 Marine：

```text
Root
└── Pelvis
    └── Spine
        └── Chest
            ├── Head
            ├── Arm L
            └── Arm R
        ├── Leg L
        └── Leg R
```

足以支持：

- Walk
- Run
- Sprint
- Turn
- Stop
- Look At
- Aim
- Simple Attack

不需要：
- 手指
- 面部
- 衣服骨骼
- 肌肉模拟

---

# 19. 动物 / 怪兽 Motion Skeleton

动物和怪兽同样需要基础骨骼。

例如六足 Zergling：

```text
Root
└── Body
    ├── Head
    ├── Leg FL
    ├── Leg FR
    ├── Leg ML
    ├── Leg MR
    ├── Leg RL
    ├── Leg RR
    └── Tail
```

然后：

```text
CHARGE
↓
腿部周期运动
↓
身体前倾
↓
脊柱摆动
↓
头部锁定目标
↓
尾巴跟随
```

---

# 20. Skeleton Profiles

统一的骨架类型：

```text
Biped
Quadruped
Six-Legged
Winged
Serpentine
Heavy Creature
Mechanical
Custom
```

例如：

```text
Marine
→ Biped

Dog
→ Quadruped

Zergling
→ Six-Legged

Bird
→ Winged

Snake
→ Serpentine
```

Custom Creature 可以定义自己的身体结构。

---

# 21. Locomotion System

Skeleton 只是身体结构。

真正让身体运动的是：

> Locomotion Profile

例如：

```text
Zergling
Skeleton = Six-Legged
Locomotion = Fast Creature Run
```

系统自动表现：
- 多足交替
- 身体上下起伏
- 身体前倾
- 头部稳定
- 尾部跟随

其他例子：

| 类型 | Preview |
|---|---|
| 人类 | 双足交替 + 手臂摆动 |
| 狗/狼 | 四足交替 + 身体起伏 |
| 猫科 | 四足 + 脊柱伸缩 |
| 鸟 | 翅膀周期运动 |
| 巨兽 | 大步行走 + 重心 |
| 昆虫 | 多足交替 |
| 蛇 | 身体波浪推进 |
| 飞行怪兽 | 翼拍 + 滑翔 |
| 机器人 | 机械步态 |

---

# 22. IK / Target Solver

因为系统已经有 LOOK_AT / TARGET，所以需要轻量 IK。

例如：

```text
Marine
LOOK_AT → Zerg
```

可以影响：

```text
Head
↓
Neck
↓
Chest
```

例如：

```text
Marine
AIM → Target
```

可以影响：

```text
Arm
↓
Chest
↓
Weapon
```

V1 不做复杂专业 Rig 系统，只需要导演级目标关系。

---

# 23. Action + Locomotion

例如：

```text
Zergling
ACTION = CHARGE
```

结合：

```text
Locomotion = Six-Legged Run
Speed = High
Lean = Strong
```

所以 Action 不负责具体骨骼动作。

Action 是：

> “我要做什么。”

Locomotion 是：

> “我的身体怎么完成这个运动。”

---

# 24. Body Motion 与整体位移必须分离

这是一个重要设计：

```text
BODY MOTION
腿部循环
身体起伏
手臂摆动

MOTION CURVE
整体速度
加速
减速
```

这样不会出现：

> 角色在原地播放跑步动画，然后匀速滑过去。

例如 Zergling：

```text
Body Motion
= 快速腿部交替

Motion Curve
= 0–2s 加速
  2–4s 高速
  4–5s 减速
```

---

# 25. Preview 的运动层级

最终 Preview 不需要完整动画级别。

建议三档：

## Level 1 — Position

只表现空间位置变化。

适合：
- 远景群体
- 大规模战场

## Level 2 — Standard Motion Preview

表现：
- 双腿 / 多腿交替
- 双臂摆动
- 身体起伏
- 前倾
- 转向
- 停止缓冲
- 简单目标朝向

这是 V1 的重点。

## Level 3 — Hero Preview

重要角色可以增加：
- 更完整动作
- 武器姿态
- Aim
- Attack
- Turn
- Look At

仍然不追求完整最终动画。

---

# 26. Preview 的真正目的

不是：

> 展示漂亮的 3D 模型。

而是：

> **让导演看懂谁、什么时候、在哪里、朝哪里、以什么速度、做什么。**

因此：

> Preview 要“看得出人在动”，但不需要“做得出完整动画”。

---

# 27. Camera

Camera 是真正独立的 3D Object。

结构：

```text
CAMERA
├── FRAMING
├── VIEW
├── LENS
├── MOTION
└── TARGET
```

---

# 28. Framing

导演语言：

- Wide Shot
- Medium Shot
- Close Up
- Extreme Wide

Framing 不应该简单映射成固定 Lens。

Camera Solver 根据：
- Subject
- Distance
- Height
- Position
- Target
- Lens

计算实际 Camera。

---

# 29. Camera View

VIEW：

```text
Eye Level
Low
High
Ground
Overhead
```

Side：

```text
Front
3/4 Front
Side
3/4 Back
Back
```

Special：

```text
Over Shoulder
POV
Dutch
```

---

# 30. Lens

V1 简化：

```text
24mm
35mm
50mm
85mm
```

高级用户以后可以手动输入。

---

# 31. Camera Motion

支持：

- FREE
- FOLLOW
- ORBIT
- DOLLY
- CRANE

Rig 是实现方法，不应该成为导演最终操作语言。

Camera Track 可以包括：

- Position
- Rotation
- Lens
- Target
- Focus

但 V1 优先语义控制。

---

# 32. Camera Path

相机水平运动：

```text
2D Ground Path
```

高度：

```text
Height = Curve
```

时间：

```text
Duration
```

不需要 V1 就暴露完整 XYZ 曲线。

---

# 33. Camera Effects

轻量 Additive Motion：

- Handheld
- Shake
- Impact
- Drift
- Bob

例如：

```text
Explosion
→ Impact

Gunshot
→ Recoil

Running
→ Handheld / Bob
```

概念：

```text
Final Camera Transform
=
Base Camera Motion
+
Shake Offset
```

---

# 34. Camera Overlay

Camera View 支持：

- Rule of Thirds
- Center
- Horizon
- Safe Area
- Aspect Ratio Mask

---

# 35. Aspect Ratio

项目级 Master Ratio：

```text
16:9
2.39:1
1.85:1
4:3
9:16
```

Shot 可以 Override。

Aspect Ratio 同时影响：
- Viewport Mask
- Camera Solver
- Previs
- AI Output
- 预计生成画面构图

---

# 36. Director View / Camera View

两个核心视图：

## Director View

可以看到：

- 整个 World
- Actors
- Groups
- Props
- Cameras
- Camera Frustum
- Camera Path
- Colliders
- Landmarks

## Camera View

只看到：

> 最终摄影机画面

---

# 37. Multi-Camera

一个 Shot 可以拥有多个 Camera。

结构：

```text
SHOT
├── WORLD
├── TIMELINE
├── CAMERA A
├── CAMERA B
└── CAMERA C
```

所有 Camera：
- 共享 World
- 共享 Timeline
- 各自拥有 Camera Track

V1 不强制制作 Camera Switch Track。

因为低模 Preview 很便宜，可以全部输出：

```text
SHOT_05_CAM_A.mp4
SHOT_05_CAM_B.mp4
SHOT_05_CAM_C.mp4
```

也可以做：
- Multi-cam Grid
- Camera Comparison

最后再选择其中一个交给 AI 视频生成。

---

# 38. Spatial System

借鉴游戏引擎，但不变成游戏引擎。

Director World：

```text
Geometry
Collision
Occlusion
Navigation
Landmarks
```

轻量 Spatial Simulation：

- Collision
- Ground Detection
- Character Blocking
- Pathfinding
- Camera Collision
- Line of Sight
- Trigger / Event

核心问题不是：

> 精确物理。

而是：

> 能不能过去？有没有被挡住？摄影机能不能看到？

---

# 39. Occlusion

这是复杂场景的重要能力。

例如：

```text
Valley
→ Low-poly Mountain / Cliff Proxy
→ Valley Volume
→ Occlusion Boundary
```

Forest：

```text
Instanced Low-poly Trees
+
Coarse Occlusion Volume
```

不需要模拟每片树叶。

核心原则：

> 普通 3D 编辑器关心对象是什么；Director Desk 关心摄影机什么时候能看到什么。

---

# 40. Landmark

Landmark 是导演空间中的重要位置标记。

例如：

```text
VALLEY_EXIT
BASE_GATE
HILL_TOP
FOREST_EDGE
LANDING_ZONE
```

可以被：
- Actor
- Group
- Camera
- Solver
- Constraint
- Path

直接引用。

例如：

```text
Zerg Swarm
Path = VALLEY_EXIT → BASE_GATE
```

---

# 41. Pathfinding

V1 不需要完整游戏 AI。

只需要轻量：
- Ground navigation
- Obstacle avoidance
- Basic pathfinding
- Camera collision
- Group path

复杂导航以后再扩展。

---

# 42. World Scale

建议：

> 真实世界单位，1 unit = 1 meter。

Three.js Perspective Camera 本身支持近大远小。

不需要把世界限制成一个很小的空间。

但是为了避免巨大绝对坐标导致浮点精度问题：

> 使用 Shot Local World / Local Origin。

---

# 43. World Mode

V1：

```text
WORLD MODE = PLANAR
```

未来：

```text
PLANAR
CURVED
PLANETARY
```

不要把：
- 镜头 Fisheye
- Planetary Curvature

混为一谈。

---

# 44. Continuity

Project：

```text
Project
↓
Sequence
↓
Shot
```

Sequence 是连续的导演段落。

Shot 之间需要保持世界状态。

例如：

```text
S01 END STATE
↓
S02 START STATE
```

可以选择性继承：

```text
INHERIT FROM S01

✓ Environment
✓ Actor Position
✓ Actor State
✓ Props
✓ Door State
✓ Lighting
☐ Camera
```

---

# 45. Continuity Checker

只提醒，不阻止。

例如：

```text
Spatial discontinuity:
Actor A moved 15.2m between shots.

[Accept]
[Fix]
```

V1 默认 Shot → Shot：

```text
CUT
```

不做 Premiere 式完整剪辑系统。

---

# 46. Timeline

Timeline 不是 Scene Schema 中普通的一个对象。

它是：

> 横跨 Actor / Group / Camera / Prop / Event / Lighting / Constraint 的时间层。

核心形式是 Clip：

```text
Marine A [ RUN ---------------- ]

Marine B      [ FOLLOW -------- ]

Zerg       [ CHARGE ------------ ]

Camera      [ DOLLY -------------]

Event                  [EXPLOSION]
```

Clip 包含：
- Start
- Duration
- Action
- Path
- Curve
- Parameters

交互：

- 拖动 Clip → 移动时间
- 拖边缘 → 改 Duration
- 展开 → 查看 Curve / Parameters

---

# 47. Timeline 的核心交互

核心原则：

> Select → Command → Timeline

例如：

1. 点击 Marine A
2. ACTION → RUN
3. 在 World 中画 Path
4. Timeline 自动创建：

```text
Marine A [ RUN ]
```

然后：

```text
Marine A
LOOK_AT → Zerg
```

再：

```text
Marine B
FOLLOW → Marine A
```

最后：

```text
Camera
Medium
Low Angle
Follow Marine A
```

Camera Solver 自动计算。

---

# 48. Director Command Layer

用户操作最终形成语义 Command。

例如：

```text
Marine A → RUN → Zerg
```

内部：

```text
SUBJECT = Marine A
ACTION = RUN
TARGET = Zerg
```

又例如：

```text
Marine B → FOLLOW → Marine A
```

内部：

```text
SUBJECT = Marine B
CONSTRAINT = FOLLOW
TARGET = Marine A
```

Camera：

```text
Camera
→ Medium
→ Low Angle
→ Follow Marine A
```

内部：

```text
FRAMING = MEDIUM
VIEW = LOW ANGLE
TARGET = Marine A
MOTION = FOLLOW
```

---

# 49. Director State / Resolved State

这是核心架构概念。

## Director State

表示导演意图：

```text
A runs to Zerg.
B follows A.
A looks at Zerg.
Camera follows A.
```

## Resolved State

Solver 计算出来的实际状态：

```text
Position
Rotation
Camera Position
Camera Rotation
Lens
etc.
```

流程：

```text
Director State
↓
Solve
↓
Resolved State
↓
Three.js
```

手动修改也应该尽可能保留语义：

```text
Camera Intent
↓
Camera Solver
↓
Resolved Camera
← Manual Override
```

---

# 50. Previs Coverage

不是所有 Shot 都必须完整 Previs。

根据复杂程度：

## Simple

```text
10–20%
```

甚至只需要：

```text
Director Schema
+
Reference
+
Prompt
```

## Normal

```text
50–70%
```

增加简单 Previs。

## Complex

```text
100%
```

例如：
- 多角色
- Crossing Paths
- Camera Movement
- Occlusion
- Collision
- Complex Lighting
- Large Crowd

AI 电影项目整体可以：

```text
约 30–60%
```

具体根据复杂程度调整。

---

# 51. Prompt vs Previs

明确区分：

## Prompt

负责软视觉信息：

- Style
- Material
- Clothing Detail
- Lighting Mood
- Atmosphere
- Acting Texture

## Previs

负责硬空间 / 导演信息：

- Who
- Where
- Movement
- Eyeline
- Camera
- Framing
- Duration
- Spatial Relation

原则：

> Prompt = What  
> Previs = Where / How / When

---

# 52. AI Direction Package

未来可以输出：

```text
AI DIRECTION
├── SUBJECT
├── ACTION
├── COMPOSITION
├── CAMERA
├── ENVIRONMENT
└── STYLE
```

Model-specific Adapter 再把 Director Schema 编译成：
- Natural Language Prompt
- Model-specific Control
- Previs Reference
- Camera / Motion Input

---

# 53. Previs 对 AI Video 的价值

AI 视频模型不一定直接读取 Director Schema。

但是视觉 Previs 可以表达：

- 人在哪里
- 群体规模
- 密度
- 谁跟随谁
- 谁朝向谁
- 摄影机位置
- 摄影机运动
- 构图
- 空间关系

未来可以输出：

```text
Previs
Depth
Mask
Camera Motion
Subject Motion
```

具体取决于下游模型支持能力。

---

# 54. 最重要的整体数据关系

目前可以把核心逻辑理解成：

```text
REFERENCE
↓
AI UNDERSTANDING
↓
WORLD PROPOSAL
↓
SEMANTIC PROXY
↓
MOTION SKELETON
↓
LOCOMOTION
↓
ACTION / CONSTRAINT
↓
PATH
↓
MOTION CURVE
↓
TIMELINE
↓
CAMERA / SOLVER
↓
SPATIAL / OCCLUSION
↓
PREVIS
↓
AI DIRECTION
↓
VIDEO GENERATION
```

---

# 55. Director Desk 的核心哲学

最终系统不是：

> 一个更简单的 Blender。

而是：

> 一个让导演可以用导演语言直接操作 3D 空间的系统。

核心对象：

```text
World
Actor
Group
Crowd
Proxy
Motion Skeleton
Locomotion
Action
Constraint
Path
Motion Curve
Timeline
Camera
Landmark
Spatial
Occlusion
Reference
Previs
AI Direction
```

核心交互：

```text
Select
→ Command
→ Spatial Edit
→ Timeline
→ Preview
```

核心技术原则：

```text
Director State
→ Solver
→ Resolved State
→ Renderer
```

核心产品原则：

> **Director Desk 负责“决定”。**
>
> **Solver 负责“计算”。**
>
> **Three.js 负责“表现”。**
>
> **AI 负责“理解和生成”。**
>
> **Blender 负责“专业内容生产”。**

---

# 56. 当前最值得继续研究的下一步

现在已经形成比较完整的核心概念。

下一步应该不是继续无限增加功能，而是开始把它落成：

## A. Director World UI

确定：
- 左侧 Scene Tree
- 中间 3D World
- 右侧 Director Panel
- 底部 Timeline

## B. Motion Skeleton V1

确定：
- Skeleton Profile
- Skeleton 最小骨骼
- IK
- Locomotion Template
- Proxy Deformation

## C. Director Schema

重新整理最终数据结构：

```text
PROJECT
├── SEQUENCE
│   ├── SHOT
│   │   ├── WORLD
│   │   ├── SUBJECTS
│   │   ├── CAMERAS
│   │   └── TIMELINE
│   └── ...
└── ASSETS
```

Timeline 作为横切时间层，而不是简单的 Scene 子节点。

## D. V1 最小闭环

建议最终先实现：

```text
Create Shot
↓
Add Reference
↓
Create Proxy
↓
Place Actor
↓
Set Scale
↓
Create Group
↓
Draw Path
↓
Set Action
↓
Set Locomotion
↓
Set Motion Curve
↓
Create Camera
↓
Set Framing
↓
Set Target
↓
Timeline
↓
Realtime Preview
↓
Export Previs
```

这个闭环跑通之后，再接 AI。

---

# 57. 一句话版本

如果以后重新开始这个项目，只需要记住：

> **Director Desk = 用导演语言控制一个可计算的 3D 世界，并把导演意图转换成可验证的 Previs 和可供 AI 视频模型使用的 Direction Package。**

以及最核心的一条：

> **Image → Semantic Proxy，不是 Image → Full 3D Model。**

角色运动核心：

> **Semantic Proxy + Motion Skeleton + Locomotion + Action + Path + Motion Curve + Timeline**

最终：

> **Director Once, Generate Anywhere.**


---

# 58. Group Dynamics / Emergent Behavior

这是在 Actor / Group / Crowd 之上的进一步核心能力。

传统 Group Control 假设：

```text
Director Command
↓
所有成员
↓
同时执行
```

但真实群体运动并不总是同步的。尤其在：

- 突然转向
- 未计划的威胁
- 地面震动
- 爆炸 / 冲击
- 发现目标
- 队形被障碍打断
- 某个成员突然改变行动

群体会出现 **Emergent Behavior**。

核心原则：

> **Group 是一个关系网络，而不是一组同时移动的 Actor。**

### 58.1 Group Graph

Group 内部可以存在轻量关系 Graph：

```text
GROUP
├── Actor A
├── Actor B
├── Actor C
├── Actor D
└── ...

RELATION GRAPH
A ↔ B
A ↔ C
B ↔ D
C ↔ D
```

关系可以表达：

- Follow
- Awareness
- Proximity
- Formation
- Leadership
- Target
- Influence
- Regroup

Graph 不需要模拟复杂社会行为。
它主要用于帮助 Solver 理解：

> 谁的动作会影响谁。

### 58.2 Emergent Leader

群体在正常状态下可以没有明确 Leader。

当出现突发事件时，一个 Actor 可能因为：

- 最先感知
- 最接近事件
- 最先改变方向
- 当前具有最高 Awareness
- 正在执行更相关的 Action

成为临时的 **Emergent Leader / Leading Node**。

例如：

```text
NORMAL

A — B — C — D — E

↓ sudden event

A →
  B →
    C →
      D
      E
```

这里不是 Director 直接命令：

```text
A = LEADER
```

而是 Solver 根据事件和关系动态产生：

```text
A = TEMPORARY LEADING NODE
```

### 58.3 Influence / Attraction

可以把 Group Graph 理解成一种轻量的导演级“引力”关系。

不是物理引力，而是：

> **一个节点的行为对其他节点运动方向产生影响。**

例如：

```text
A changes direction
↓
B notices A
↓
B changes direction
↓
C notices B / A
↓
C changes direction
```

最终形成：

```text
Local reaction
↓
Propagation
↓
Group reorganization
```

这可以产生比“所有人一起转向”更自然的群体运动。

### 58.4 Perception Event

为了触发 Emergent Behavior，需要一个轻量事件层。

例如：

```text
EVENT
├── Ground Tremor
├── Explosion
├── Enemy Spotted
├── Gunfire
├── Impact
└── Unknown Threat
```

事件可以拥有：

```text
Location
Radius
Intensity
Duration
Direction
Visibility
```

Actor 根据距离、朝向、遮挡和自身状态得到：

```text
AWARENESS
```

例如：

```text
Actor A → Awareness 0.92
Actor B → Awareness 0.67
Actor C → Awareness 0.31
```

因此不同 Actor 不必同时反应。

### 58.5 Reaction Delay

群体行为的重要参数是：

```text
Reaction Delay
```

例如：

```text
A reacts at 0.0s
B reacts at 0.2s
C reacts at 0.4s
D reacts at 0.7s
```

这可以直接影响 Timeline 中的 Motion Clip 起始时间。

Director 可以控制整体范围：

```text
Reaction Spread = Low / Medium / High
```

而不需要逐个设置每个人的延迟。

### 58.6 Formation Deformation

Formation 不再被视为永远固定的几何结构。

```text
Formation
↓
External Event
↓
Deformation
↓
Reorganization
```

例如：

```text
WEDGE
  ↓
Sudden Turn
  ↓
Stretched Wedge
  ↓
New Direction
  ↓
Loose Formation
```

因此：

> Formation = Initial / Preferred Structure

而不是：

> Formation = Hard Constraint

### 58.7 Director Control

导演不需要操作 Graph 的每条边。

V1 可以只暴露高级语义：

```text
GROUP RESPONSE

Reaction: Organic
Propagation: Medium
Cohesion: Medium
Leadership: Emergent
Reaction Delay: 0.1–0.6s
```

高级模式以后再开放：

```text
Graph
Influence
Awareness
Weights
Propagation Rules
```

### 58.8 Director Principle

最终形成一个非常重要的区别：

```text
DIRECTOR
决定事件和意图
        ↓
SOLVER
计算群体如何响应
        ↓
GROUP DYNAMICS
产生局部反应与结构变化
        ↓
TIMELINE
记录实际结果
        ↓
PREVIS
验证视觉效果
```

导演可以说：

> “他们感觉到地面震动，开始警觉并改变方向。”

而不是：

> “Marine 01 在 0.2 秒转 37 度，Marine 02 在 0.4 秒转 51 度。”

这符合 Director Desk 的核心理念：

> **Director 描述意图；Solver 计算行为。**

---

# 59. Perception → Group Response → Camera

Group Dynamics 不仅影响角色运动，也可以影响导演镜头。

这是 Director Desk 与普通 3D 编辑器进一步区别的重要方向。

例如：

```text
Ground Tremor
↓
Actor Awareness
↓
Group Deformation
↓
Emergent Leading Node
↓
Camera Interest Shift
↓
Close-up / Reframe
```

摄影机可以拥有轻量的：

```text
CAMERA INTEREST
```

例如：

```text
Interest = M17
Reason = First Awareness
Priority = High
```

于是 Director Camera Solver 可以建议：

```text
Wide Shot
↓
Formation Change
↓
M17 becomes salient
↓
Medium / Close-up
```

重要原则：

> **AI / Solver 可以建议镜头，但不能擅自改变导演已经确认的镜头意图。**

这与 AI SUGGESTED / USER CONFIRMED / USER OVERRIDE 状态保持一致。

---

# 60. S06 作为 Group Dynamics 验证场景

为了验证上述系统，当前最适合的测试场景是：

> **Terran Marine Squad detects an unexpected ground tremor.**

测试流程：

```text
S06A
Normal Formation
↓
Ground Tremor
↓
Small Environmental Response

S06B
First Actor Awareness
↓
Emergent Leading Node
↓
Reaction Propagation
↓
Formation Deformation

S06C
M17 Awareness
↓
Look / Turn
↓
Camera Interest Shift
↓
Close-up
```

这个 Shot 不要求展示真正的敌人。

重点是验证：

- Event
- Awareness
- Reaction Delay
- Influence
- Emergent Leadership
- Formation Deformation
- Camera Interest
- Timeline 自动生成

如果 S06 成功，Group Dynamics 就具备成为 V1.5 / V2 核心能力的基础。

---

# 61. 当前设计判断：核心设计阶段基本完成

截至 2026-09-05，Director Desk 的核心概念已经足够完整。

不建议继续无止境增加抽象概念。

当前重点应该从：

```text
Concept Design
```

切换到：

```text
Implementation / Prototype
```

优先级：

### P0 — V1 Director Loop

```text
Create Shot
→ Reference
→ Proxy
→ Actor / Group
→ Path
→ Action
→ Locomotion
→ Motion Curve
→ Camera
→ Timeline
→ Preview
→ Export
```

### P1 — Director Timeline UI

重点确认：

```text
Scene Tree
        │
        │
3D World ─── Director Panel
        │
        │
      Timeline
```

Timeline 是整个 Director Desk 的横向时间层。

### P2 — Group Dynamics Prototype

先实现最小版本：

```text
Event
↓
Awareness
↓
Reaction Delay
↓
Influence
↓
Formation Deformation
```

暂时不实现复杂群体 AI。

### P3 — Camera Interest

让摄影机可以感知：

```text
Subject Salience
Event Salience
Group Change
```

并生成 Director Suggestion，而不是自动夺取导演控制权。

---

# 62. 更新后的核心数据关系

现在完整的数据链可以扩展为：

```text
REFERENCE
↓
AI UNDERSTANDING
↓
WORLD PROPOSAL
↓
SEMANTIC PROXY
↓
ACTOR / GROUP
↓
MOTION SKELETON
↓
LOCOMOTION
↓
ACTION / CONSTRAINT
↓
PATH / FORMATION
↓
EVENT / PERCEPTION
↓
GROUP DYNAMICS
↓
MOTION CURVE
↓
TIMELINE
↓
CAMERA / CAMERA INTEREST
↓
SOLVER
↓
SPATIAL / OCCLUSION
↓
PREVIS
↓
AI DIRECTION
↓
VIDEO GENERATION
```

最终哲学仍然不变：

> **Director Desk 负责“决定”。**
>
> **Solver 负责“计算”。**
>
> **Three.js 负责“表现”。**
>
> **AI 负责“理解和生成”。**
>
> **Blender 负责“专业内容生产”。**

而 Group Dynamics 带来的新一层是：

> **群体不是同步动画，而是关系驱动的运动系统。**

最终：

> **Director Once, Generate Anywhere.**

---

# 58. V1 实施阶段更新（2026-09-05）

## 产品需求
Director Desk 的目标不是传统 3D 软件，而是让用户用导演语言描述一个可计算的空间事件，并实时验证结果。

V1 必须支持：
- Project / Sequence / Shot
- 轻量 Director World
- Actor / Group / Proxy / Landmark
- 3D 空间摆位
- Camera
- Action / Constraint / Target
- Path
- Timeline
- Solver
- Three.js Realtime Preview
- 基础 Previs Export
- 为未来 AI Direction Package 保留稳定 Schema

V1 暂不追求 Blender 级建模、高精度绑定、完整 Mocap 编辑、完整物理/游戏 AI、完整剪辑系统或自动最终视频生成。

原则：**先验证导演闭环，再增加生产能力。**

# 59. 导演工作流：Camera First（推荐，不是硬依赖）

推荐流程：

```text
CREATE SHOT
↓
REFERENCE / WORLD
↓
ACTOR / GROUP
↓
CAMERA INTENT
↓
ACTION / CONSTRAINT
↓
PATH
↓
LOCOMOTION
↓
MOTION CURVE
↓
TIMELINE
↓
SOLVE
↓
PREVIEW
↓
EXPORT PREVIS
```

Camera 提前，因为导演首先可能定义：“我要拍谁、怎么拍”。

例如：`拍 M17 跑向 VALLEY_EXIT 的 Medium Follow Shot`。

但 Camera 与 Action 不形成硬编码先后依赖；二者都是并列 Director Intent。任何 Intent 修改后：

```text
Edit Intent → Invalidate affected Resolved State → Re-Solve → Realtime Preview
```

# 60. 信息架构

```text
PROJECT
├── Project Settings
├── ASSETS
│   ├── References
│   ├── Proxy Definitions
│   └── Skeleton Profiles
└── SEQUENCES
    └── SEQUENCE
        └── SHOTS
            └── SHOT
                ├── WORLD
                ├── SUBJECTS
                ├── GROUPS
                ├── LANDMARKS
                ├── CAMERAS
                ├── EVENTS
                ├── DIRECTOR STATE
                ├── TIMELINE
                └── RESOLVED STATE
```

Timeline 是横跨对象的时间层。

# 61. 核心架构

```text
USER INPUT
↓
DIRECTOR COMMAND
↓
DIRECTOR STATE
↓
SOLVER PIPELINE
↓
RESOLVED STATE
↓
THREE.JS RENDERER
↓
PREVIEW
↓
EXPORT
```

Director State 保存导演意图：

```text
M17: ACTION=RUN, TARGET=VALLEY_EXIT
M18: CONSTRAINT=FOLLOW, TARGET=M17
CAM_A: TARGET=M17, FRAMING=MEDIUM, VIEW=3/4 FRONT, MOTION=FOLLOW
```

Resolved State 保存计算结果：
- Actor Position / Rotation
- Locomotion
- Group Spatial State
- Camera Position / Rotation
- Lens
- Visibility / Constraint Results

原则：**Intent 可编辑，Resolved 可计算。**

Solver 分层：
1. Timeline Solver
2. Command / State Resolver
3. Path Resolver
4. Constraint Resolver
5. Locomotion Resolver
6. Group Resolver
7. Camera Solver
8. Spatial / Visibility Checks

Three.js 只负责表现，不承担导演逻辑。

# 62. V1 UI 架构

```text
┌──────────────┬────────────────────────────────┬──────────────┐
│ Scene Tree   │ DIRECTOR WORLD                 │ Director     │
│              │ Director View / Camera View    │ Panel        │
│ Project      │ Actors / Groups / Paths        │ Contextual   │
│ Sequence     │ Landmarks / Cameras / Frustums │ Semantic     │
│ Shot         │ Constraints                    │ Controls     │
├──────────────┴────────────────────────────────┴──────────────┤
│                           TIMELINE                           │
└──────────────────────────────────────────────────────────────┘
```

Scene Tree：
- Project
- Sequence
- Shot
- World
- Actors
- Groups
- Cameras
- Landmarks
- Events

Director World：
- Select
- Move
- Rotate
- Place
- Draw Path
- Inspect Camera / Frustum
- Director View / Camera View

Director Panel：
- Actor：Action、Target、Path、Locomotion、Constraints、Timing
- Camera：Framing、View、Lens、Target、Motion、Focus

Timeline：
- 动作开始 / 持续
- Event
- Camera Motion
- Reaction Delay
- Motion Curve

Timeline 不替代 Command Layer。

# 63. V1 最小闭环与 Killer Test

```text
CREATE SHOT
↓
CREATE WORLD
↓
ADD M17
↓
ADD VALLEY_EXIT
↓
CREATE CAMERA
↓
CAMERA: TARGET=M17, FRAMING=MEDIUM, MOTION=FOLLOW
↓
M17: ACTION=RUN, TARGET=VALLEY_EXIT
↓
DRAW PATH + SET TIMING
↓
SOLVE
↓
PREVIEW
```

成功标准：**修改任何导演意图，Preview 正确变化。**

第一阶段 Killer Test：

```text
M17 → RUN → VALLEY_EXIT
M18 → FOLLOW → M17
M19 → FOLLOW → M17
CAM_A → TARGET M17 / MEDIUM / FOLLOW
```

验证：
- Actor
- Landmark
- Path
- Action
- Constraint
- Group Relationship
- Timeline
- Camera Intent
- Camera Solver
- Resolved State
- Preview

# 64. Group Graph / Event 架构（V1.1+）

```text
GROUP
├── Members
├── Relations
├── Cohesion
├── Formation Preference
└── Influence Graph
```

关系边：
- Influence
- Attraction
- Follow Weight
- Awareness Link
- Reaction Priority

群体运动：

> Individual Intent + Graph Influence + Spatial Constraints

而不是所有成员同步转向。

事件链：

```text
EVENT
↓
PERCEPTION
↓
AWARENESS
↓
REACTION DELAY
↓
INDIVIDUAL RESPONSE
↓
GROUP GRAPH PROPAGATION
↓
FORMATION DEFORMATION
↓
CAMERA INTEREST
```

Temporary Leading Node 可以由事件临时产生，不等于固定 Leader。

S06（Tremor → Group Structure Breaks → M17 Senses）作为 V1.1/V1.2 Regression Test。

# 65. 推荐技术架构

```text
UI
├── React
├── Scene Tree
├── Director Panel
└── Timeline

Director Engine
├── Command Layer
├── State Store
├── Solver Pipeline
└── Continuity Checker

Rendering
└── Three.js

Export
├── Previs Frames
├── Previs Video
└── Direction Package

Future
└── AI Model Adapters
```

# 66. 开发优先级

## P0
Shot、Actor、Landmark、Path、Camera、Action、Constraint、Timeline、Director State、Resolved State、Basic Solver、Realtime Preview。

## P1
Scene Tree、Contextual Panel、Director/Camera View、Save/Load、Basic Previs Export、Continuity Warning。

## P2
Motion Skeleton、Locomotion、Turn、Stop、Follow、Motion Curves。

## P3
Group Graph、Perception、Event Propagation、Reaction Delay、Formation Deformation、Camera Interest。

## P4
Reference Understanding、World Proposal、Semantic Proxy Proposal、Prompt Adapter、Model-specific Direction Package、AI Video Pipeline。

# 67. 当前 V1 Architecture Baseline

Director Desk V1 的第一目标：

> **证明导演可以先表达拍摄意图，再表达角色行为，并让系统把这些并列的导演意图计算成可实时验证的 3D Previs。**

核心：

```text
WHO + WHERE + WHAT HAPPENS + WHEN + HOW IT IS SHOT
↓
DIRECTOR STATE
↓
SOLVE
↓
PREVIS
```

最终职责：

> Director Desk 负责“决定”。
>
> Solver 负责“计算”。
>
> Three.js 负责“表现”。
>
> AI 负责“理解和生成”。
>
> Blender 负责“专业内容生产”。

当前下一步：

```text
1. 确定技术栈与项目结构
2. TypeScript Director Schema
3. State Store
4. Three.js World
5. Actor / Landmark / Path
6. Camera Intent + Camera Solver
7. Timeline
8. 跑通 M17 Killer Test
```

---

# 68. Segment / Leg 与 Handoff（2026-09-07 更新）

> 本节将 V1.20 还原后的"加腿 / 多段连接"交互规则上升为需求。对应设计文档 `Director_Desk_Camera_Archetypes_Design_2026-09-07.md` §7，测试用例见 `Director_Desk_Automation_Test_Cases_V1.md` §20。

## 68.1 加 Leg：仅 append 一种入口

- timebar 每条对象轨道末尾提供「+ 加腿」入口，点击 = append 一条新 leg。
- **取消**"在播放头拆分 / 中间插入"的复杂操作（易破坏空间连续）；中间插入如需，后续单独实现为简单的 split 当前腿。
- 新 leg 默认：
  - 起点锚定前腿终点（共享 handoff 点）；
  - handoff 模式默认 `stop`；
  - 默认时长占位（如 2s）；
  - 路径在 Director View 中为一段短直线 stub。

## 68.2 新 Leg 在 Director View 的表现

- 默认一段短直线 stub：起点 = 共享 handoff 点，终点 = 前腿终点沿原方向偏移一小段。
- 点「+」后 stub 立即出现并自动选中；用户拖终点 / 加折点塑形（与编辑任何已有 leg 一致）。
- 终点拖回起点 = 停留腿（hold）：object 在原地待 `time` 秒，View 用环标记表示，不画线。

## 68.3 timebar ↔ View 选中联动

- timebar 每条 leg ↔ Director View 一条 path，一一对应。
- 点 timebar 的 leg → View 高亮对应 path；点 View 的 path → timebar 选中对应 leg。
- 新加的 leg 默认处于双向选中态。

## 68.4 Handoff 三模式

- `stop`（默认）：前腿速度降到 0，后腿从 0 起步（停顿再走）。
- `smooth`：出入切线联动、速度连续（一镜到底）。
- `cut`：允许位置不连续（瞬移 / 跳切）。
- **mode 本质是 Speed Curve 边界的便捷配置，不另写物理**：`stop` → 前腿 ease-out + 后腿 ease-in；`smooth` → 边界两端 linear / 互补并锁定切线联动；`cut` → 后腿起点自由。

## 68.5 多段 Leg 端点同步规则（核心需求）

- 交接点 = 前腿终点 === 后腿起点 === **同一份 `sharedPoint`** → 拖任一侧，另一侧自动同步（除非 `cut`）。
- `cut` 模式下一段起点解耦，拖前腿尾点**不**动后腿头点（允许瞬移）。
- 仅移动该共享点；两段各自其它点保持原位（可在交接处被拉伸）。修饰键可刚性平移下游整腿（保持形状只换位置）。
- `smooth` 下交接切线联动（转它则前腿出射 + 后腿入射一起转）；`stop` 下两条切线独立。
- 中段折点只影响本 leg，无需跨段同步。

## 68.6 验收

- 加腿后 View 立即出现 stub 且双向选中。
- 拖交接点，前后两段端点始终一致（非 cut）。
- `cut` 时前后端点可分离，并有不连续提示。
- `smooth` 切线联动、`stop` 切线独立。
