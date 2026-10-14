/** A local diagnostic input for the normal Live pipeline. This owns playback
 * and its object URL only: it cannot identify cards, create evidence or save. */
export class LiveVideoSource {
  private readonly controller = new AbortController();
  private url?: string;
  private playbackEpoch = 0;
  private terminal = false;
  private wantsPlayback = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onEnded: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  private current() {
    return (
      !this.controller.signal.aborted &&
      !!this.url &&
      this.video.src === this.url &&
      this.video.srcObject === null
    );
  }

  private readonly ended = () => {
    if (!this.current() || this.terminal) return;
    this.terminal = true;
    try {
      this.onEnded();
    } finally {
      this.dispose();
    }
  };

  private readonly failed = () => {
    if (!this.current() || this.terminal) return;
    this.terminal = true;
    try {
      this.onError(
        new Error(
          "This video could not be decoded. Choose a supported MP4 or WebM.",
        ),
      );
    } finally {
      this.dispose();
    }
  };

  async open(file: File, longestEdge: number) {
    if (this.controller.signal.aborted || this.url)
      throw new Error("Video preparation is no longer available.");
    if (
      !file.size ||
      file.size > 250 * 1024 * 1024 ||
      (!/^(video\/(mp4|webm)|application\/octet-stream)$/.test(file.type) &&
        !/\.(mp4|webm)$/i.test(file.name))
    )
      throw new Error("Choose a nonempty MP4 or WebM video under 250 MB.");
    try {
      this.url = URL.createObjectURL(file);
      this.video.autoplay = false;
      this.video.loop = false;
      this.video.muted = true;
      this.video.srcObject = null;
      this.video.src = this.url;
      this.video.load();
      await this.metadata();
      if (!this.current())
        throw new DOMException("Preparation cancelled.", "AbortError");
      if (
        !Number.isFinite(this.video.duration) ||
        this.video.duration <= 0 ||
        this.video.duration > 300
      )
        throw new Error("Choose a video of at most five minutes.");
      if (
        !this.video.videoWidth ||
        !this.video.videoHeight ||
        Math.max(this.video.videoWidth, this.video.videoHeight) > longestEdge
      )
        throw new Error(
          `Choose a video with a longest edge of ${longestEdge} pixels or less.`,
        );
      this.video.addEventListener("ended", this.ended);
      this.video.addEventListener("error", this.failed);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private metadata(): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener("loadedmetadata", ready);
        this.video.removeEventListener("error", failed);
        signal.removeEventListener("abort", cancelled);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(
          new Error(
            "This video could not be decoded. Choose a supported MP4 or WebM.",
          ),
        );
      };
      const cancelled = () => {
        cleanup();
        reject(new DOMException("Preparation cancelled.", "AbortError"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Video metadata took too long to load."));
      }, 15_000);
      this.video.addEventListener("loadedmetadata", ready);
      this.video.addEventListener("error", failed);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else if (this.video.error) failed();
      else if (this.video.readyState >= 1) ready();
    });
  }

  pause() {
    this.wantsPlayback = false;
    this.playbackEpoch++;
    if (this.current()) this.video.pause();
  }

  /** False means Pause, End or a replacement source won a pending play(). */
  async play(): Promise<boolean> {
    if (!this.current() || this.terminal) return false;
    if (this.video.ended) {
      this.ended();
      return false;
    }
    const epoch = ++this.playbackEpoch;
    this.wantsPlayback = true;
    this.video.playbackRate = 1;
    await this.video.play();
    if (!this.current() || this.terminal || epoch !== this.playbackEpoch) {
      if (this.current() && !this.wantsPlayback) this.video.pause();
      return false;
    }
    if (this.video.ended) {
      this.ended();
      return false;
    }
    return true;
  }

  dispose() {
    if (this.controller.signal.aborted) return;
    const ownsElement = this.current();
    this.controller.abort();
    this.wantsPlayback = false;
    this.playbackEpoch++;
    this.video.removeEventListener("ended", this.ended);
    this.video.removeEventListener("error", this.failed);
    if (ownsElement) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
}
