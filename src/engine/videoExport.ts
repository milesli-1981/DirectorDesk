import { useDirectorStore } from "../state/directorStore";
import { contentEndTime } from "./timeline";

/**
 * Previs 视频导出（多机位批量，MediaRecorder 实时录制）。
 *
 * 设计对齐 Baseline §1352：低模 Preview 很便宜，可全部输出——每台相机一条视频。
 * 本实现复用现有渲染：逐台相机切到其 POV（Camera View），用 canvas.captureStream
 * 实时录制，输出 `<场景名>_<相机名>.webm`。确定性离线渲染（WebCodecs/MP4 +
 * 精确画幅遮幅）作为后续升级方向。
 */

let captureCanvas: HTMLCanvasElement | null = null;

/** 由 WorldView 内的 CaptureBridge 在 Canvas 挂载时写入渲染画布。 */
export function setCaptureCanvas(canvas: HTMLCanvasElement | null): void {
  captureCanvas = canvas;
}

export function getCaptureCanvas(): HTMLCanvasElement | null {
  return captureCanvas;
}

function pickMime(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "video/webm";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentSceneName(): string {
  const { manifest } = useDirectorStore.getState();
  return manifest.order.find((tab) => tab.id === manifest.activeSceneId)?.name ?? "scene";
}

export interface ExportVideoOptions {
  fps?: number;
  onProgress?: (message: string) => void;
}

/**
 * 录制单台相机的 POV 视频，返回 Blob（不触发下载）。
 * 这是无头渲染 / MCP 导出与多机位下载共同复用的核心。
 */
export async function recordCameraPov(
  cameraId: string,
  fps = 24,
  onProgress?: (message: string) => void,
): Promise<Blob> {
  // 画布可能尚未完成首帧初始化，短暂轮询等待（最多约 1.5s）再判定为未就绪。
  let canvas = getCaptureCanvas();
  for (let attempt = 0; !canvas && attempt < 30; attempt += 1) {
    await delay(50);
    canvas = getCaptureCanvas();
  }
  if (!canvas) throw new Error("渲染画布尚未就绪，请稍候重试");

  const capture = (canvas as HTMLCanvasElement & {
    captureStream?: (fps?: number) => MediaStream;
  }).captureStream;
  if (typeof capture !== "function") {
    throw new Error("当前浏览器不支持 canvas.captureStream，无法录制视频");
  }

  const { cameras } = useDirectorStore.getState().state;
  if (!cameras.some((c) => c.id === cameraId)) {
    throw new Error(`场景中没有相机 ${cameraId}`);
  }

  // 切到该机位的 POV 视角，停在第一帧先渲染一帧。
  useDirectorStore.setState({
    viewMode: "camera",
    activeCameraId: cameraId,
    currentTime: 0,
    playing: false,
  });
  // 等待 r3f 切换到该机位并完成一帧渲染（captureStream 需画布已有内容）。
  await delay(250);

  const stream = capture.call(canvas, fps);
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  // 与录制同步开始播放，确保从 t=0 采起。
  useDirectorStore.setState({ playing: true });

  // 等到播放结束（App 播放循环到达内容末尾会停止并把播放头归零）。
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!useDirectorStore.getState().playing) return resolve();
      setTimeout(check, 80);
    };
    check();
  });

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  onProgress?.(`已录制：${cameraId}`);
  return new Blob(chunks, { type: mime });
}

/**
 * 逐台相机导出 POV 视频（浏览器内下载）。
 * 录制为实时：每台相机按内容时长以正常速度播放并采集画布，因此总耗时 ≈ Σ(各相机内容时长)。
 */
export async function exportMultiCamVideos(options: ExportVideoOptions = {}): Promise<void> {
  const fps = options.fps ?? 24;
  const { cameras } = useDirectorStore.getState().state;
  if (cameras.length === 0) throw new Error("当前场景没有相机，无法导出视频");

  const sceneName = currentSceneName();
  const before = useDirectorStore.getState();

  for (const cam of cameras) {
    options.onProgress?.(`录制中：${cam.name} …`);
    const blob = await recordCameraPov(cam.id, fps, options.onProgress);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sceneName}_${cam.name}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    options.onProgress?.(`已下载：${sceneName}_${cam.name}.webm`);
  }

  // 恢复进入导出前的视图状态。
  useDirectorStore.setState({
    viewMode: before.viewMode,
    activeCameraId: before.activeCameraId,
    playing: false,
    currentTime: 0,
  });
}
