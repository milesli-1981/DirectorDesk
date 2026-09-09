import { useDirectorStore } from "../state/directorStore";
import { contentEndTime } from "./timeline";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/**
 * Previs 视频导出（多机位批量）。
 *
 * - 直出 MP4：优先用 WebCodecs + mp4-muxer 逐帧编码 H.264，确定性、画质好、
 *   直接产出 `.mp4`，不再依赖 MediaRecorder（它跨浏览器拿不到 MP4 封装）。
 * - WebM 兜底：当浏览器不支持 WebCodecs（或 VideoEncoder 不支持目标分辨率）时，
 *   回退到 canvas.captureStream + MediaRecorder 实时录制 `.webm`。
 *   无头 / MCP 导出（headlessApi）固定走 WebM 路径（recordCameraPov）。
 *
 * 设计对齐 Baseline §1352：低模 Preview 很便宜，可全部输出——每台相机一条视频。
 */

let captureCanvas: HTMLCanvasElement | null = null;

/** 由 WorldView 内的 CaptureBridge 在 Canvas 挂载时写入渲染画布。 */
export function setCaptureCanvas(canvas: HTMLCanvasElement | null): void {
  captureCanvas = canvas;
}

export function getCaptureCanvas(): HTMLCanvasElement | null {
  return captureCanvas;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待渲染画布就绪（最多约 1.5s）。 */
async function waitCaptureCanvas(): Promise<HTMLCanvasElement> {
  let canvas = getCaptureCanvas();
  for (let attempt = 0; !canvas && attempt < 30; attempt += 1) {
    await delay(50);
    canvas = getCaptureCanvas();
  }
  if (!canvas) throw new Error("渲染画布尚未就绪，请稍候重试");
  return canvas;
}

function currentSceneName(): string {
  const { manifest } = useDirectorStore.getState();
  return manifest.order.find((tab) => tab.id === manifest.activeSceneId)?.name ?? "scene";
}

function sceneEnd(state: ReturnType<typeof useDirectorStore.getState>["state"]): number {
  // 成片长度 = 时间轴配置的总时长（state.duration），而不是只到最后一个有内容的帧：
  // 否则会出现「配了 5s、内容只排到 3s、成片就只有 3s」——内容之后的空档同样属于成片。
  // contentEndTime 仅在 duration 异常为 0 时兜底。
  return state.duration > 0 ? state.duration : contentEndTime(state);
}

function switchToPov(cameraId: string): Promise<void> {
  useDirectorStore.setState({
    viewMode: "camera",
    activeCameraId: cameraId,
    currentTime: 0,
    playing: false,
  });
  // 等待 r3f 切换到该机位并完成一帧渲染（编码需画布已有内容）。
  return delay(250);
}

export interface ExportVideoOptions {
  fps?: number;
  onProgress?: (message: string) => void;
}

/* ----------------------------------------------------------------- WebM 兜底 */

function pickMime(): string {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "video/webm";
}

/**
 * 录制单台相机的 POV 视频（WebM），返回 Blob（不触发下载）。
 * 无头渲染 / MCP 导出复用此函数。
 */
export async function recordCameraPov(
  cameraId: string,
  fps = 24,
  onProgress?: (message: string) => void,
): Promise<Blob> {
  const canvas = await waitCaptureCanvas();

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

  await switchToPov(cameraId);

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

  // 录制必须按「真实经过时间」推进播放头，不能交给 App 的播放循环：
  // 那个循环把每帧 delta 钳在 50ms 内（防切后台跳帧），一旦重场景掉到 20fps 以下，
  // 时间就会走得比真实时间慢——录出来变长、而且像慢动作。
  const end = sceneEnd(useDirectorStore.getState().state);
  recorder.start();
  const startedAt = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      if (elapsed >= end) {
        useDirectorStore.setState({ currentTime: end });
        return resolve();
      }
      useDirectorStore.setState({ currentTime: elapsed });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  onProgress?.(`已录制：${cameraId}`);
  return new Blob(chunks, { type: mime });
}

/* ------------------------------------------------------------------ MP4 直出 */

/** 浏览器是否具备 WebCodecs 编码能力（且目标分辨率被支持）。 */
async function supportsMp4(width: number, height: number, fps: number): Promise<boolean> {
  const Encoder = (globalThis as unknown as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (typeof Encoder === "undefined") return false;
  try {
    const support = await Encoder.isConfigSupported({
      codec: "avc1.640028",
      width,
      height,
      bitrate: 12_000_000,
      framerate: fps,
    });
    return !!support.supported;
  } catch {
    return false;
  }
}

/**
 * 把画布按宽高比塞进 maxW×maxH 框，返回偶数尺寸（H.264 要求偶宽高）。
 */
function fitEven(w: number, h: number, maxW: number, maxH: number): [number, number] {
  let nw = w;
  let nh = h;
  if (nw > maxW || nh > maxH) {
    const scale = Math.min(maxW / nw, maxH / nh);
    nw = Math.round(nw * scale);
    nh = Math.round(nh * scale);
  }
  nw -= nw % 2;
  nh -= nh % 2;
  return [Math.max(2, nw), Math.max(2, nh)];
}

/**
 * 录制单台相机的 POV 视频（MP4），逐帧用 WebCodecs 编码 + mp4-muxer 封装。
 * 不触发下载；返回 `video/mp4` Blob。不支持时抛出（调用方回退 WebM）。
 */
export async function recordCameraMp4(
  cameraId: string,
  fps = 24,
  onProgress?: (message: string) => void,
): Promise<Blob> {
  const canvas = await waitCaptureCanvas();

  const { cameras } = useDirectorStore.getState().state;
  if (!cameras.some((c) => c.id === cameraId)) {
    throw new Error(`场景中没有相机 ${cameraId}`);
  }

  const end = sceneEnd(useDirectorStore.getState().state);

  // 编码尺寸：WebGL 画布可能已按 dpr 放大；统一塞进 1920×1080 以兼容 level 4.0。
  const [encW, encH] = fitEven(canvas.width, canvas.height, 1920, 1080);
  if (!(await supportsMp4(encW, encH, fps))) throw new Error("UNSUPPORTED");

  // 若需缩放，用一张离屏 2D 画布承接；否则直接编码原画布。
  const needsScale = encW !== canvas.width || encH !== canvas.height;
  const off = needsScale ? document.createElement("canvas") : null;
  let offCtx: CanvasRenderingContext2D | null = null;
  if (off) {
    off.width = encW;
    off.height = encH;
    offCtx = off.getContext("2d");
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: encW, height: encH, frameRate: fps },
    fastStart: "in-memory",
  });

  const Encoder = (globalThis as unknown as { VideoEncoder: typeof VideoEncoder }).VideoEncoder;
  const Frame = (globalThis as unknown as {
    VideoFrame: new (source: CanvasImageSource, init: { timestamp: number }) => VideoFrame;
  }).VideoFrame;

  let encoder: VideoEncoder;
  let resolveP!: () => void;
  let rejectP!: (err: unknown) => void;
  const finished = new Promise<void>((res, rej) => {
    resolveP = res;
    rejectP = rej;
  });
  try {
    encoder = new Encoder({
      output: (chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined) =>
        muxer.addVideoChunk(chunk, meta),
      error: (err: DOMException) => rejectP(err),
    });
    encoder.configure({
      codec: "avc1.640028",
      width: encW,
      height: encH,
      bitrate: 12_000_000,
      framerate: fps,
    });
  } catch {
    throw new Error("UNSUPPORTED");
  }

  await switchToPov(cameraId);

  const totalFrames = Math.max(1, Math.ceil(end * fps));
  let frameIndex = 0;
  const tick = () => {
    try {
      if (off && offCtx) offCtx.drawImage(canvas, 0, 0, encW, encH);
      const src: CanvasImageSource = off ?? canvas;
      const tsUs = Math.round((frameIndex / fps) * 1_000_000);
      const frame = new Frame(src, { timestamp: tsUs });
      encoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
      frame.close();
    } catch (err) {
      rejectP(err);
      return;
    }
    frameIndex += 1;
    if (frameIndex >= totalFrames) {
      useDirectorStore.setState({ currentTime: end });
      resolveP();
      return;
    }
    // 先设定下一帧时间，让 r3f 在本帧批次内渲染好，下一次 tick 再采集。
    useDirectorStore.setState({ currentTime: Math.min(frameIndex / fps, end) });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await finished;

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const buffer = (muxer.target as ArrayBufferTarget).buffer;
  onProgress?.(`已录制：${cameraId}`);
  return new Blob([buffer], { type: "video/mp4" });
}

/* ----------------------------------------------------------- 多机位批量导出 */

/**
 * 逐台相机导出 POV 视频（浏览器内下载）。
 * 优先直出 MP4；若某台相机不支持 WebCodecs，则自动回退为 WebM。
 */
export async function exportMultiCamVideos(options: ExportVideoOptions = {}): Promise<void> {
  const fps = options.fps ?? 24;
  const { cameras } = useDirectorStore.getState().state;
  if (cameras.length === 0) throw new Error("当前场景没有相机，无法导出视频");

  const sceneName = currentSceneName();
  const before = {
    viewMode: useDirectorStore.getState().viewMode,
    activeCameraId: useDirectorStore.getState().activeCameraId,
    currentTime: useDirectorStore.getState().currentTime,
  };

  for (const cam of cameras) {
    options.onProgress?.(`录制中：${cam.name} …`);
    let blob: Blob;
    let ext: string;
    try {
      blob = await recordCameraMp4(cam.id, fps, options.onProgress);
      ext = "mp4";
    } catch (err) {
      // MP4 不支持或中途失败：回退 WebM，保证总能出片。
      if (String((err as Error)?.message).includes("UNSUPPORTED") || err instanceof DOMException) {
        options.onProgress?.(`${cam.name} 不支持 MP4，回退 WebM …`);
        blob = await recordCameraPov(cam.id, fps, options.onProgress);
        ext = "webm";
      } else {
        throw err;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sceneName}_${cam.name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    options.onProgress?.(`已下载：${sceneName}_${cam.name}.${ext}`);
  }

  // 恢复进入导出前的视图状态。
  useDirectorStore.setState({
    viewMode: before.viewMode,
    activeCameraId: before.activeCameraId,
    playing: false,
    currentTime: before.currentTime,
  });
}
