import type { FeaturePack, ReferenceAdded, ReferenceInput, VisionCoverage, VisionOptions, VisionReady, VisionResult, WorkerRequest, WorkerResponse } from "./types";
export type * from "./types";

export class VisionBusyError extends Error {
  constructor() { super("A frame is already being analyzed; drop this frame instead of queuing it."); this.name = "VisionBusyError"; }
}
/** Own one client per camera session. All image analysis runs off the UI thread. */
export class VisionClient {
  private worker: Worker | undefined;
  private initialization: Promise<VisionReady> | undefined;
  private nextId = 1;
  private analyzing = false;
  private disposed = false;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  get busy(): boolean { return this.analyzing; }
  initialize(): Promise<VisionReady> {
    if (this.disposed) return Promise.reject(new Error("Vision client is disposed."));
    if (this.initialization) return this.initialization;
    if (typeof Worker === "undefined") return Promise.reject(new Error("This browser does not support the local recognition worker."));
    this.worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module", name: "local-card-recognition" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id); clearTimeout(pending.timeout);
      if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
    };
    this.worker.onerror = event => this.fail(new Error(event.message || "The local vision worker stopped unexpectedly."));
    this.worker.onmessageerror = () => this.fail(new Error("The browser could not transfer a frame to the local vision worker."));
    this.initialization = this.request<VisionReady>({ type: "initialize" });
    return this.initialization;
  }
  private request<T>(message: Omit<Extract<WorkerRequest, { type: "initialize" }>, "id"> | Omit<Extract<WorkerRequest, { type: "load-pack" }>, "id"> | Omit<Extract<WorkerRequest, { type: "add-reference" }>, "id"> | Omit<Extract<WorkerRequest, { type: "analyze" }>, "id"> | { type: "clear" }, transfers: Transferable[] = []): Promise<T> {
    if (!this.worker || this.disposed) return Promise.reject(new Error("Vision client is not initialized."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error("Local recognition timed out. Restart the scanner to reset the worker.")), message.type === "initialize" ? 90_000 : 30_000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      try { this.worker!.postMessage({ ...message, id }, transfers); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
  async loadPack(pack: FeaturePack): Promise<VisionCoverage> { await this.initialize(); return this.request({ type: "load-pack", pack }); }
  async addReference(input: ReferenceInput): Promise<ReferenceAdded> {
    await this.initialize();
    const { image, ...reference } = input;
    const bitmap = await createImageBitmap(image);
    try { return await this.request({ type: "add-reference", reference, image: bitmap }, [bitmap]); }
    catch (error) { bitmap.close(); throw error; }
  }
  /** Consumes/transfers the bitmap or ImageData buffer. Call only when !busy. */
  async analyze(image: ImageBitmap | ImageData, options: VisionOptions = {}): Promise<VisionResult> {
    if (this.analyzing) { if ("close" in image) image.close(); throw new VisionBusyError(); }
    this.analyzing = true;
    try {
      await this.initialize();
      const transfer = "data" in image ? image.data.buffer : image;
      return await this.request({ type: "analyze", image, options }, [transfer]);
    } catch (error) { if ("close" in image) image.close(); throw error; }
    finally { this.analyzing = false; }
  }
  async clearReferences(): Promise<VisionCoverage> { await this.initialize(); return this.request({ type: "clear" }); }
  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    this.pending.clear(); this.worker?.terminate(); this.worker = undefined; this.initialization = undefined; this.analyzing = false;
  }
  dispose(): void { this.disposed = true; this.fail(new Error("Vision client disposed.")); }
}
