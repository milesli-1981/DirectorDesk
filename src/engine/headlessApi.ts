import { useDirectorStore } from "../state/directorStore";
import { recordCameraPov } from "./videoExport";

/**
 * 无头渲染 API：让外部（如 MCP server 通过 Playwright）把一份场景 JSON 推进来、
 * 录制指定相机的 POV 视频，并把结果回传。
 *
 * 仅在 App 以 `?headless=1` 启动时由 App 挂载到 window.previsRender。
 * 设计对齐「MCP 包装」目标：输入场景 JSON，输出视频文件（经 receiver 落盘）。
 */

export interface PrevisRequest {
  /** 整片场（含 manifest+scenes）或单个场景的 DirectorState JSON 对象。 */
  scene: unknown;
  /** 指定相机 id；省略则录第一台相机。 */
  camera?: string;
  /** 帧率，默认 24。 */
  fps?: number;
  /** 视频上传地址（MCP server 的本地接收器）。省略则只返回成功、不落盘。 */
  receiver?: string;
}

export interface PrevisResult {
  /** 接收器回写的视频文件绝对路径。 */
  path?: string;
  /** 出错信息。 */
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把外部传入的场景对象导入当前 store。
 * 优先按「整片场」解析（manifest+scenes），失败再按单个场景解析。
 */
function importScenePayload(scene: unknown): void {
  const store = useDirectorStore.getState();
  const json = JSON.stringify(scene ?? {});
  const looksLikeProject =
    scene !== null && typeof scene === "object" && "manifest" in (scene as object) && "scenes" in (scene as object);
  try {
    if (looksLikeProject) store.importProject(json);
    else store.importScene(json);
  } catch (err) {
    // 单个场景解析失败则再试片场解析，最大化兼容性。
    if (looksLikeProject) store.importScene(json);
    else store.importProject(json);
  }
}

/**
 * window.previsRender 的实现：导入场景 → 录制指定相机 → 上传到 receiver。
 */
export async function previsRender(req: PrevisRequest): Promise<PrevisResult> {
  try {
    importScenePayload(req.scene);
    await delay(150);

    const cameras = useDirectorStore.getState().state.cameras;
    if (cameras.length === 0) throw new Error("场景没有相机，无法录制视频");
    const cameraId =
      req.camera && cameras.some((c) => c.id === req.camera) ? req.camera : cameras[0].id;

    const blob = await recordCameraPov(cameraId, req.fps ?? 24);

    let path: string | undefined;
    if (req.receiver) {
      const resp = await fetch(req.receiver, { method: "POST", body: blob });
      const data = (await resp.json().catch(() => ({}))) as { path?: string };
      path = data.path;
    }
    return { path };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 在 ?headless=1 时调用，把 API 挂到 window，供外部脚本调用。 */
export function installHeadlessApi(): void {
  const w = window as unknown as Record<string, unknown>;
  w.previsRender = previsRender;
}
