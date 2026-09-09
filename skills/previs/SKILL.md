---
name: previs
description: 把自然语言/结构化创意简述转成导演场景 JSON，并通过 Director Desk 的 MCP 工具渲染为预演视频。当用户想要「生成/导出/渲染一段镜头、分镜、预演视频」，或给出角色、机位、运镜、相遇/对话等镜头描述时使用。
---

# Previs 技能（Director Desk）

本技能让 AI 在对话里把用户的镜头创意直接变成**视频文件**：先理解创意 → 落成精简场景描述（brief）→ 编译成 `DirectorState` JSON → 调 MCP 工具 `render_previs` 渲染出片。

## 何时使用
- 用户要「做个 X 场景的视频 / 预演 / 分镜」。
- 用户描述人物、地点、相遇、对话、运镜（跟拍 / 环绕 / 过肩 / 推拉 / 升降）等镜头意图。
- 用户给出或想修改一份导演场景 JSON。

## 工作流（SOP）
1. **拆解创意**：把用户的简述拆成 角色（actors）、地点、时间轴上的 beats、以及镜头段落（cameras + moves）。
2. **写 brief**：用下方「简版场景 spec」描述，不要手写完整 DirectorState。
3. **编译**：调用本技能附带的 `compileSpec.mjs`：
   `node skills/previs/compileSpec.mjs brief.json --out scene.json`（用 `--out` 落盘为干净的 UTF-8，避免 shell 重定向带来的编码问题）。也可管道传入 JSON 到 stdout。
4. **渲染**：调用 MCP 工具 `render_previs({ scene: <json字符串> })`。返回视频文件的本地绝对路径（`file://` 资源），交给用户打开。
5. **迭代**：根据用户反馈微调 brief（换镜头、调错位量、改焦距等）后重渲。

## 简版场景 spec（输入格式）
```jsonc
{
  "duration": 5,                 // 秒
  "aspectRatio": "16:9",        // 可选：16:9 / 2.39:1 / 1.85:1 / 4:3 / 9:16
  "actors": [
    {
      "id": "WALKER", "color": "#3aa6ff",
      "x": 0, "z": 0,           // 起点（世界单位，米）
      "path": [[0,0],[0,-3]]     // 路点 [[x,z],...]，>=2 点才生成移动段
    },
    { "id": "GREETER", "color": "#ff9a3a", "x": 1, "z": -1 }
  ],
  "cameras": [
    {
      "id": "CAM_A", "target": "WALKER",
      "framing": "medium",        // wide/ establishing/ medium/ close_up/ two_shot/ extreme_close_up
      "view": "eye_level",        // eye_level/ chest/ low/ high/ ground/ overhead
      "side": "back_3_4",        // front/ back/ left/ right/ back_3_4/ front_3_4 ...
      "lens": 35,                 // 18/24/35/50/85
      "moves": [
        { "type": "FOLLOW", "start": 0, "end": 2 },
        { "type": "ORBIT", "orbitDeg": -90, "start": 2, "end": 3 },
        { "type": "OTS", "target": "GREETER", "shoulderId": "WALKER",
          "otsSide": "R", "otsOffset": 0.35, "start": 3, "end": 5 }
      ]
    }
  ],
  "constraints": [               // 可选：FOLLOW / LOOK_AT 持续意图
    { "type": "LOOK_AT", "subject": "WALKER", "target": "GREETER", "start": 3, "end": 5 }
  ]
}
```

## 关键字段速查（DirectorState）
- **运镜类型** `CameraMotionType`：`STATIC` / `FOLLOW` / `ORBIT` / `DOLLY` / `DOLLY_ZOOM` / `CRANE` / `DRONE` / `OTS`。
- **景别** `framing`：`wide` `establishing` `medium` `close_up` `two_shot` `extreme_close_up`。
- **机位高度** `view`：`eye_level` `chest`(胸高，略低于眼平) `low` `high` `ground` `overhead`。
- **机位角度** `side`：`front` `back` `left` `right` `back_3_4` `front_3_4` `over_shoulder` 等。
- **焦距** `lensMm`：焦距越小越广角（透视夸张），越大越长焦（压缩背景、景深浅）。
- **过肩 OTS**：`shoulderId`=前景演员，`targetId`=主体，`otsSide`=L/R，`otsOffset`(0=正对，~0.35=标准错位，越大主体越靠边)。
- **荷兰角** `roll`：画面滚转角（度）。
- **环绕/推拉/升降**：`orbitDeg` / `dollyScale` / `craneHeight`。
- **交接（段间）**：`cameraJunctions` 的 `mode`：`smooth`(一镜到底) / `cut`(硬切) / `stop`(停帧)。

## 镜头设计要点（给模型参考）
- **后退跟拍**：相机 `side: front` + `FOLLOW`，胸高、35mm，机位随目标同速后退。
- **过肩收尾**：`type: OTS`，`shoulderId` 为前景、`targetId` 为主体；错位量 0.35 让主体靠边、前景只露肩膀。正反打=互换 shoulder/target 并翻转 otsSide。
- **180° 规则**：保持机位在动作轴线同侧；跨轴会让观众迷失方位。
- **景深**：长焦 + 近距离 → 景深极浅，前景/背景虚化；系统已按真实光学自动推导（焦点跟随 target）。

## 注意
- `render_previs` 为**实时 1x 录制**，渲染耗时 ≈ 场景时长；这是预演，不是离线加速渲染。
- 输出为 `.webm`（VP8/VP9）。需要 MP4 时由调用方用 ffmpeg 转码。
- 视频以本地文件返回；对话中展示取决于客户端是否支持视频附件。
