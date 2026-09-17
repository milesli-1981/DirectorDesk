import { NameVisibility } from "../domain/schema";

/**
 * 对象名字**该不该显示** —— 全项目唯一的判定处。
 *
 * 两级、且**场景更高一级**（导演定的：场景有更大的控制）：
 *
 * | 场景 `showNames` | 个体 `showName` | 结果 | 谁说了算 |
 * |---|---|---|---|
 * | `"on"`  | 任意 | 显示 | **场景**（个体被压过） |
 * | `"off"` | 任意 | 隐藏 | **场景**（个体被压过） |
 * | `"default"`（缺省） | `true` | 显示 | 个体 |
 * | `"default"` | `false` | 隐藏 | 个体 |
 * | `"default"` | 不写 | 显示 | 个体缺省 |
 *
 * 参数刻意收成"两个值"而不是整个 `DirectorState`：调用点在渲染里（组件只拿到这两样），
 * 而守卫里可以直接喂字面量把这个真值表逐行钉死（scripts/check-3d.ts §36）。
 * 兼容旧数据：布尔 `true`/`false` 分别按 `"on"`/`"off"` 解释。
 */
export function nameVisible(
  scene: NameVisibility | boolean | undefined,
  object: { showName?: boolean } | undefined,
): boolean {
  const mode: NameVisibility =
    scene === true || scene === "on"
      ? "on"
      : scene === false || scene === "off"
        ? "off"
        : "default";
  if (mode === "on") return true;
  if (mode === "off") return false;
  return object?.showName ?? true;
}

/** 场景处于"接管"状态吗（`on` / `off`）—— 个体开关此时应当置灰。 */
export function sceneTakesOverNames(scene: NameVisibility | boolean | undefined): boolean {
  return scene === true || scene === false || scene === "on" || scene === "off";
}
