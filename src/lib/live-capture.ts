import { CaptureHistory } from "./capture-history";
import { CaptureRateLimitError, FrameCapture } from "./frame-capture";
import type { CapturedPixels } from "./frame-capture";
import type { VisionClient } from "./vision";
import type { RoiContinuityFrame } from "./vision/roi-continuity";

export const captureClock = () => performance.timeOrigin + performance.now();

/** Bounded typed-array downsample. It does not draw video through a canvas or
 * create ImageData, and retains no full-resolution history. */
export function grayscaleSample(
  image: CapturedPixels["image"],
  frameId: number,
  timestampMs: number,
): RoiContinuityFrame {
  const scale = Math.min(1, 640 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  // Integrate each destination pixel's source footprint rather than selecting
  // one source pixel. Nearest-neighbor aliasing made tiny real-card translations
  // look like appearance changes, despite unchanged geometric/identity gates.
  const area = new Uint8Array(width * height);
  const sx = image.width / width,
    sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const top = y * sy,
      bottom = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const left = x * sx,
        right = (x + 1) * sx;
      let sum = 0;
      for (let j = Math.floor(top); j < Math.ceil(bottom); j++) {
        const sourceY = Math.max(0, Math.min(image.height - 1, j));
        for (let i = Math.floor(left); i < Math.ceil(right); i++) {
          const sourceX = Math.max(0, Math.min(image.width - 1, i));
          const weight =
            (Math.min(bottom, j + 1) - Math.max(top, j)) *
            (Math.min(right, i + 1) - Math.max(left, i));
          const offset = (sourceY * image.width + sourceX) * 4;
          const luminance =
            (77 * image.data[offset] +
              150 * image.data[offset + 1] +
              29 * image.data[offset + 2]) /
            256;
          sum += luminance * weight;
        }
      }
      area[y * width + x] = Math.round(sum / (sx * sy));
    }
  }
  // Fixed separable 3x3 [1,2,1]/4 antialiasing with clamped borders. Three
  // integer horizontal rows give exactly the same rounding as full Float32
  // intermediates, without retaining a frame-sized float scratch surface.
  const gray = new Uint8Array(area.length);
  let previous = new Uint16Array(width),
    current = new Uint16Array(width),
    next = new Uint16Array(width);
  const row = (y: number, target: Uint16Array) => {
    const offset = Math.max(0, Math.min(height - 1, y)) * width;
    for (let x = 0; x < width; x++)
      target[x] =
        area[offset + Math.max(0, x - 1)] +
        2 * area[offset + x] +
        area[offset + Math.min(width - 1, x + 1)];
  };
  row(0, previous);
  row(0, current);
  row(1, next);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      gray[y * width + x] = Math.round(
        (previous[x] + 2 * current[x] + next[x]) / 16,
      );
    const spare = previous;
    previous = current;
    current = next;
    next = spare;
    row(y + 2, next);
  }
  return { width, height, gray, frameId, timestampMs };
}

export interface LiveCaptureContext {
  capture: CapturedPixels;
  frameId: number;
  history: CaptureHistory;
  historyToken: number;
  graySize: { width: number; height: number };
  isCurrent(): boolean;
  latest(): { frameId: number; timestampMs: number } | undefined;
}
type CaptureSource = Pick<
  FrameCapture,
  "capture" | "dispose" | "minimumIntervalMs"
> &
  Partial<Pick<FrameCapture, "isSourceCurrent">>;
interface Dependencies {
  video: HTMLVideoElement;
  client: Pick<VisionClient, "busy" | "takeFrameBuffer">;
  frameLimit: number;
  onFrame(context: LiveCaptureContext): Promise<void>;
  onError(error: unknown): void;
  onTransport(transport: CapturedPixels["transport"]): void;
  capture?: CaptureSource;
}

/** One capture timer, one identity/continuity operation, one RGBA spare and a
 * bounded gray history. Camera sampling continues while inference runs; it
 * never queues full-resolution frames or starts a second model operation. */
export class LiveCaptureLoop {
  private readonly capture: CaptureSource;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private running = false;
  private paused = false;
  private disposed = false;
  private sampling = false;
  private processing = false;
  private sequence = 0;
  private spare?: ArrayBuffer;
  private history?: CaptureHistory;
  private token?: number;
  private latestCapture?: { frameId: number; timestampMs: number };

  constructor(private readonly dependencies: Dependencies) {
    this.capture =
      dependencies.capture ?? new FrameCapture({ now: captureClock });
  }

  start() {
    if (this.disposed || this.running) return;
    this.running = true;
    this.paused = false;
    void this.tick();
  }
  pause() {
    this.generation++;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.history?.cancel();
    this.latestCapture = undefined;
  }
  resume() {
    if (this.disposed || !this.running || !this.paused) return;
    this.paused = false;
    void this.tick();
  }
  interrupt() {
    const wasPaused = this.paused;
    this.pause();
    if (!wasPaused) this.resume();
  }
  dispose() {
    this.pause();
    this.disposed = true;
    this.running = false;
    this.capture.dispose();
    this.spare = undefined;
    this.history = undefined;
  }

  private schedule() {
    if (!this.disposed && this.running && !this.paused) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => void this.tick(),
        Math.max(100, this.capture.minimumIntervalMs),
      );
    }
  }
  private async tick() {
    if (this.disposed || !this.running || this.paused) return;
    if (this.sampling || (this.processing && !this.history?.status.open)) {
      this.schedule();
      return;
    }
    const generation = this.generation;
    this.sampling = true;
    try {
      const captured = await this.capture.capture(
        this.dependencies.video,
        this.dependencies.frameLimit,
        (bytes) => {
          const spare = this.spare;
          this.spare = undefined;
          return spare?.byteLength === bytes
            ? spare
            : this.dependencies.client.takeFrameBuffer(bytes);
        },
      );
      if (this.disposed || this.paused || generation !== this.generation)
        return;
      const frameId = ++this.sequence;
      this.latestCapture = { frameId, timestampMs: captured.capturedAt };
      this.dependencies.onTransport(captured.transport);
      const sample = grayscaleSample(
        captured.image,
        frameId,
        captured.capturedAt,
      );
      if (this.processing || this.dependencies.client.busy) {
        if (this.history && this.token !== undefined)
          this.history.append(sample, this.token);
        this.spare = captured.image.data.buffer;
      } else {
        const history = new CaptureHistory();
        const token = history.begin(sample);
        this.history = history;
        this.token = token;
        this.processing = true;
        const isCurrent = () =>
          !this.disposed &&
          this.running &&
          !this.paused &&
          generation === this.generation &&
          this.history === history &&
          (this.capture.isSourceCurrent?.() ?? true);
        const context: LiveCaptureContext = {
          capture: captured,
          frameId,
          history,
          historyToken: token,
          graySize: { width: sample.width, height: sample.height },
          isCurrent,
          // A newer source frame may already have been acquired while copyTo
          // is pending. Do not commit a proof for the previous completed frame
          // until that readback joins the ordered history and is checked too.
          latest: () =>
            isCurrent() && !this.sampling ? this.latestCapture : undefined,
        };
        // Deliberately not awaited: only compact real captures continue while
        // this single inference/continuity callback owns the worker pipeline.
        void Promise.resolve()
          .then(() => this.dependencies.onFrame(context))
          .catch((error) => {
            if (isCurrent()) {
              this.pause();
              this.dependencies.onError(error);
            }
          })
          .finally(() => {
            history.cancel();
            if (this.history === history) {
              this.history = undefined;
              this.token = undefined;
            }
            this.processing = false;
          });
      }
    } catch (error) {
      if (
        generation === this.generation &&
        !this.disposed &&
        !(error instanceof CaptureRateLimitError)
      ) {
        this.pause();
        this.dependencies.onError(error);
      }
    } finally {
      this.sampling = false;
      this.schedule();
    }
  }
}
