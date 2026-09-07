# Director Desk — 资产（Asset）模型设计

> 日期：2026-09-07
> 关联：`Director_Desk_V1_Architecture_Baseline_2026-09-05.md`（§10 / §39 遮挡 / §41 路径 / §43 World Mode）、`Director_Desk_Automation_Test_Cases_V1.md` §16。
> 实现状态：Phase 1（资产抽象 / 默认体块 / 摆放 / 持久化）、Phase 2（遮挡判定 + 绕障可视化）与摆放碰撞（set 自动分离）均已落地，见代码 `src/domain/schema.ts`、`src/engine/assetPresets.ts`、`src/engine/occlusion.ts`、`src/engine/collision.ts`、`src/engine/pathfinding.ts`、`src/state/directorStore.ts`、`src/components/WorldView.tsx`、`src/components/ObjectList.tsx`、`src/components/Inspector.tsx`、`src/app/App.tsx`。

## 1. 动机

拍摄目标不只有「人（actor）」——也可以是移动的载具、动物，或任意移动对象；同时场景中还需要桌椅、楼房、建筑等**环境物**。这些环境物会影响：

1. **遮挡关系**：某栋楼可能挡住相机对主体的拍摄。
2. **行动路线**：被拍对象的移动路径应绕开桌椅/建筑。

因此把它们统一抽象为**资产（Asset）**：人、建筑、动物、载具、家具、自然、道具都是资产的不同类别。

## 2. 数据模型

`DirectorObject` 升级为 Asset（保留 `type` 仅作兼容）：

```ts
type AssetCategory = "human" | "animal" | "vehicle" | "building" | "furniture" | "nature" | "prop";
type AssetRole = "agent" | "set";
type Footprint = { w: number; d: number; h: number }; // 宽(x) 深(z) 高(y)，世界单位（米）

interface DirectorObject {
  id: string;
  type: ObjectKind;        // 兼容保留：actor / landmark / prop
  category: AssetCategory;
  role: AssetRole;         // agent=可运动/可作目标；set=静态环境
  x: number; z: number;
  rotation: number;        // 摆放朝向 yaw，度
  footprint: Footprint;    // 默认体块尺寸
  color: string;
  locked?: boolean;        // 锁定后不可通过拖拽改变位置（防误触）
}
```

- **agent**：可运动，拥有 `MoveSegment`、可作 `CameraMove.targetId`、可作 `Constraint` 主体/目标。
- **set**：静态环境，无 segment；是**遮挡体**与**路径障碍**。

## 3. 默认体块（assetPresets.ts）

每个类别给一组默认 `footprint` / `color` / `role`：

| 类别 | role | 默认体块 (w×d×h) | 颜色 |
|---|---|---|---|
| human | agent | 0.6 × 0.6 × 1.8 | #67a7ff |
| animal | agent | 0.9 × 1.6 × 1.1 | #63d39b |
| vehicle | agent | 2.0 × 4.2 × 1.5 | #f0a35a |
| building | set | 10 × 10 × 24 | #9aa7b5 |
| furniture | set | 1.2 × 1.2 × 0.9 | #b9a07a |
| nature | set | 2.5 × 2.5 × 4 | #4f9d69 |
| prop | set | 0.8 × 0.8 × 0.8 | #c0c8d0 |

## 4. 渲染（WorldView）

- 所有资产按 `footprint` 渲染为**体块**（立方体），`set` 半透明以区分。
- **`category === "human"`** 用**人形组合体** `HumanoidFigure` 渲染（头 + 躯干 + 双臂 + 双腿），与建筑 / 家具等纯方盒资产区分；比例全部由 `footprint` 推导（腿 0.44h、躯干 0.34h、头 r = 0.096h，双臂挂在躯干两侧）。
- 选中时显示地面轮廓（footprint 矩形线框）+ 选中环。
- `agent` 保留朝向动画（跟随速度方向）与轻微 bob；`set` 固定在摆放位置/朝向上。
- demo 预置了 `BLD_A`（楼）、`TBL_01`（桌）、`BLD_B`（刻意挡在 `CAM_A → M17` 视线中点 ≈ (-8.9, 3.1)）三个静态环境资产，用于演示遮挡与绕障；刷新即可见 `BLOCKED`。

## 5. 摆放（Scene Tree + Inspector）

- **Scene Tree**：`ADD ASSET` 面板，按类别一键 `addAsset(category)`，自动生成 id（`AST_<CATEGORY>_NN`）并摆放到空位。
- **Inspector**：选中资产后可编辑 `role`（agent/set 切换）、`rotation`（朝向滑杆）、`footprint` 的 W/D/H（体块尺寸）、以及 `Delete Asset`（删除资产并清理其 segment / constraint / 相机目标）。
- **Director View 拖拽**：所有资产（含 `set`）都能在视图中直接按下拖动移动。`hitObjectRay` 按资产自身 `footprint` 命中——高度取 `footprint.h`，抓取容差按 footprint 半宽外扩，因此高大的建筑、宽大的家具都能点中拖动（而非只能点其底部中心）。已选中对象的**路径点 / 端点优先于抓取资产**，避免大体块的抓取范围吞掉落在其中的路径端点。
- **资产锁定（防误触）**：每个资产有 `locked?: boolean`。Scene Tree 每行末尾的 `Lock` / `Locked` 按钮、Inspector 资产区的 `Lock position` / `Unlock` 按钮均可一键切换（`toggleLock` / `updateAsset(id, { locked })`）。锁定后 `moveObject` 直接返回、任何拖拽都不改坐标；`handleDown` 命中锁定对象时只选中、不接管拖拽、也不禁用相机轨道。Director View 中锁定对象头顶显示 `LOCKED` 徽标（仅 Director 视图，相机视图不显示辅助物）。

## 6. 摆放碰撞（set 资产自动分离）

静态环境资产（楼 / 桌椅 / 建筑）摆放时不应互相穿模。与遮挡共用同一套 `footprint`（AABB，x/z 平面）作为碰撞体积：

- `footprintsOverlap(a, b)`：两个资产的 footprint 是否重叠。
- `separateSetAsset(objects, id, startX?, startZ?)`：从起算坐标出发，对每个重叠的 `set` 资产取 **最小穿透轴**（`overlapX < overlapZ` 则推 x，否则推 z），把该资产推到刚好不碰，并保留 `0.05` 的间隙；最多迭代 8 轮，以解开链式重叠（A 推开 B，B 又压到 C …）。

**作用范围**：仅 **set ↔ set**。`agent`（人 / 车 / 动物）不参与碰撞，可自由重叠。

| 接入点 | 行为 |
|---|---|
| `addAsset` | 新生成的 set 资产先算分离落点，再写入状态 |
| `moveObject` | 拖拽落点若为 set 资产，先分离再写坐标 |
| `updateAsset` | 编辑 set 资产的 `x / z / footprint` 时重新分离 |

> **为什么不选警告或硬禁止**：导演预演中环境物应能自由靠近摆放，但不应互相穿插。自动推开既保留自由摆放的手感，又不会出现穿模。

## 7. 场景持久化

`README` 早前因「与数据模型不兼容」移除了本地持久化；现 `DirectorState` 已是纯 JSON，重接：

- **自动保存**：`store.persist()` 在 `revision` 变化时写入 `localStorage`（key `director-desk-scene-v1`），不随播放头/缩放抖动。
- **导出 / 导入**：App 顶栏 `Export`（下载 `director-desk-scene.json`）/ `Import`（读取 JSON 并 `importScene`）。
- 初始状态优先从 `localStorage` 载入已保存场景，否则用 demo。

## 8. 遮挡关系（engine/occlusion.ts）

- `segIntersectsRect`：相机机位 → 目标连线是否与某 `set` 资产包围矩形相交。
- `blockingAssets(state, camPos, targetPos)`：返回挡住当前镜头的 `set` 资产。
- **可视化**：Director View 中遮挡资产显示红色线框 + `BLOCKED` 标签（`OcclusionHighlights`）；Camera HUD 显示 `⚠ OCCLUDED · <assetId>`。
- **视线**：同时绘制相机 → 目标的连线——被挡为**红色虚线**，通畅为**淡青实线**，直观呈现「是哪条视线被挡」。
- ⚠ **当前为 x/z 平面判定**：未考虑高度，因此高于遮挡体的 crane / overhead 机位仍会被标记为遮挡。

## 9. 行动路线 / 绕障（engine/pathfinding.ts）

绕障结果**已接入运动求解**：agent 实际行走的就是绕行折线，而不只是可视化。

- `routeAround(start, end, rects, margin)`：以各障碍（外扩 `margin`）的四个拐角为中转节点建**可见图**，用 Dijkstra 求 `start → end` 的最短无碰撞折线。相比旧的「把顶点推出盒子」，它能对**穿越障碍中部**的路径沿拐角真正绕行——旧实现会把左半边推到左边缘、右半边推到右边缘，中间仍留一条穿过楼体的直线。
- `pushOut` / `pushOutAll`：起终点若落在障碍内（例如把端点放在楼里），先沿最小穿透轴推到最近的外边缘。因此 agent 不会走进楼内，停留时也会停在楼外边缘。
- `avoidObstacles(points, rects, margin)`：折线畅通则原样返回；被挡则按端点重路由（代价是丢失中间的 ARC 曲线造型——但该路径本身已被阻挡）。
- **单一数据源**：`path.ts` 的 `segmentRoutePoints(segment, rects)` 同时供运动求解（`segmentPosition`）与 Director View 的**橙色虚线「导航层」**使用，所以「看到的线」就是「agent 真正走的线」。结果带签名缓存（segment 几何 + 障碍几何）。
- ⚠ **已知限制**：① `FOLLOW` 约束按「约束开始时刻捕获的相对偏移」跟随，不会独立绕障，跟随者可能被带进障碍；② 绕行会改变路径总里程而时长不变，因此绕行时 agent 表观速度略快。

## 10. 后续工作

1. `FOLLOW` 跟随者独立绕障（当前按相对偏移跟随，可能被带进障碍）。
1b. 绕行后按新里程重新分配时长，保持表观速度与原路径一致。
2. 遮挡驱动取景建议（自动换 side / 调整机位避免穿模）。
3. 资产库（Asset Library）持久化默认体块模板，支持从库拖拽实例化。
4. `PATH` 运动类型（见 Camera 文档 §8.5-3）与资产路径编辑的统一。
5. 遮挡判定引入高度（y 轴），避免 crane / overhead 等高于遮挡体的机位被误判为遮挡（见 §8）。
6. 摆放碰撞的「最小穿透轴」在完全同心重叠（中心点重合）时方向任意，可改为沿用相对速度 / 视线方向作为兜底。
