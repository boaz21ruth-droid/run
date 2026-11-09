/** 浏览器自带的二维码识别（Chrome / Android 支持；iOS Safari 目前没有，按钮就不显示） */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return ctor && typeof navigator.mediaDevices?.getUserMedia === "function" ? ctor : null;
}

export function canScanQr(): boolean {
  return detectorCtor() != null;
}

/**
 * 打开后置摄像头，识别到第一个二维码就停止并返回内容；signal 取消时关掉摄像头并返回 null。
 * 识别结果就是参赛凭证的 ticketCode，直接当搜索词用。
 */
export async function scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<string | null> {
  const Ctor = detectorCtor();
  if (!Ctor) return null;
  const detector = new Ctor({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  const stop = () => stream.getTracks().forEach((track) => track.stop());
  signal.addEventListener("abort", stop, { once: true });
  try {
    video.srcObject = stream;
    await video.play();
    while (!signal.aborted) {
      const codes = await detector.detect(video).catch(() => []);
      const hit = codes.find((c) => c.rawValue.trim() !== "");
      if (hit) return hit.rawValue.trim();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  } finally {
    stop();
    video.srcObject = null;
  }
}
