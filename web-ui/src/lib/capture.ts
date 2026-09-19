export const MAX_FRAME_WIDTH = 1280;
export const MAX_FRAME_HEIGHT = 720;
export const DEFAULT_FRAMES_PER_SECOND = 1;
export const MIN_FRAMES_PER_SECOND = 1;
export const MAX_FRAMES_PER_SECOND = 8;
export const FRAME_INTERVAL_MS = 1000 / DEFAULT_FRAMES_PER_SECOND;

export function clampFramesPerSecond(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FRAMES_PER_SECOND;
  }
  return Math.min(MAX_FRAMES_PER_SECOND, Math.max(MIN_FRAMES_PER_SECOND, Math.round(value)));
}

export function frameIntervalMs(fps: number): number {
  return 1000 / clampFramesPerSecond(fps);
}

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): {
  width: number;
  height: number;
} {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function waitForVideoFrame(
  video: HTMLVideoElement,
  timeoutMs = 2000
): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) {
      return true;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  return video.videoWidth > 0 && video.videoHeight > 0;
}

export function captureJpegBase64(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  quality = 0.8
): string | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    return null;
  }

  const { width, height } = fitWithin(sourceWidth, sourceHeight, MAX_FRAME_WIDTH, MAX_FRAME_HEIGHT);
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(video, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
    return null;
  }
  return dataUrl.slice(JPEG_DATA_URL_PREFIX.length);
}
