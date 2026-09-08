# Director Desk · Previs MCP Server

把 Director Desk 的「导演场景 JSON → 预演视频」能力包装成 MCP 工具，供 LLM 在对话里直接出片。

## 架构

```
LLM ──(MCP)──> render_previs(sceneJson)
                  │
                  ▼
            MCP server (本目录)
              ├─ 起本地接收器（视频落盘到临时文件）
              ├─ Playwright 启动无头 Chromium，加载 Web App (?headless=1)
              ├─ 调 window.previsRender({ scene, camera, fps, receiver })
              │     App: 导入场景 → 录制指定相机 POV (MediaRecorder) → 上传接收器
              └─ 返回视频文件绝对路径 (file:// 资源)
```

复用现有渲染与 `MediaRecorder` 导出逻辑（无重写）；Web App 侧只需 `?headless=1` 挂载 `window.previsRender`。

## 前置

1. 安装依赖：
   ```bash
   cd mcp-server
   npm install --ignore-scripts     # 先不下载浏览器
   npx playwright install chromium  # 单独下载无头 Chromium
   ```
2. 运行 Web App（MCP server 需要能访问它）：
   ```bash
   cd <repo root>
   npm run dev                      # 默认 http://localhost:5173
   ```
   可用环境变量 `PREVIS_APP_URL` 覆盖地址。

## 运行 MCP server

```bash
cd mcp-server
npm start
# 或：node index.mjs
```

客户端（如 Claude Desktop / CodeBuddy）通过 stdio 连接。示例 `claude_desktop_config.json`：

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

## 工具

### `render_previs`

| 参数 | 类型 | 说明 |
|---|---|---|
| `scene` | string (JSON) | `DirectorState` 单场景，或 `{ manifest, scenes }` 整片场 |
| `camera` | string? | 相机 id；省略则录第一台相机 |
| `fps` | number? | 帧率，默认 24 |
| `appUrl` | string? | Web App 地址，默认 `PREVIS_APP_URL` / `http://localhost:5173` |

返回视频文件的本地绝对路径（及 `file://` 资源）。渲染为**实时 1x**，耗时 ≈ 场景时长。

## 配合 Skill 使用

`sources/previs`(仓库根 `skills/previs/`) 提供：
- `SKILL.md`：SOP + 简版场景 spec 速查 + 镜头工艺要点；
- `compileSpec.mjs`：把「简版 brief」编译成 `DirectorState` JSON，降低 LLM 手写完整 schema 的负担。

流程：用户创意 → brief → `compileSpec.mjs` → `DirectorState` JSON → `render_previs` → 视频。
