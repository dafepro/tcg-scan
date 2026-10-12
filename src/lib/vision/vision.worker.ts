/// <reference lib="webworker" />
import cvModule from "@techstark/opencv-js";
import { VisionEngine } from "./engine";
import type { Cv } from "./engine";
import type { WorkerRequest, WorkerResponse } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let enginePromise: Promise<VisionEngine> | undefined;
function engine(): Promise<VisionEngine> {
  enginePromise ??= (async () => {
    const cv = await (cvModule as unknown as Promise<Cv>);
    if (!cv.Mat || !cv.ORB || !cv.findHomography) throw new Error("The local OpenCV feature-verification runtime could not initialize.");
    return new VisionEngine(cv);
  })();
  return enginePromise;
}
function readPixels(input: ImageBitmap | ImageData): ImageData {
  if ("data" in input) return input;
  if (input.width > 4096 || input.height > 4096 || input.width * input.height > 16_000_000) throw new Error("Downscale the camera frame before local recognition.");
  const canvas = new OffscreenCanvas(input.width, input.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("OffscreenCanvas is unavailable in this browser.");
  context.drawImage(input, 0, 0);
  return context.getImageData(0, 0, input.width, input.height);
}
scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  const transfers: Transferable[] = [];
  try {
    const local = await engine();
    let result: unknown;
    switch (message.type) {
      case "initialize": result = { engine: "OpenCV ORB + RANSAC", coverage: local.coverage() }; break;
      case "load-pack": result = local.loadPack(message.pack); break;
      case "clear": result = local.clear(); break;
      case "add-reference": result = local.addReference(message.reference, readPixels(message.image)); break;
      case "analyze": {
        const analyzed = local.analyze(readPixels(message.image), message.options);
        for (const detection of analyzed.detections) if (detection.crop) transfers.push(detection.crop.data.buffer);
        result = analyzed; break;
      }
    }
    scope.postMessage({ id: message.id, result } satisfies WorkerResponse, transfers);
  } catch (error) {
    const detail = error instanceof Error ? error.message : typeof error === "number" ? `OpenCV processing error (${error}).` : String(error);
    scope.postMessage({ id: message.id, error: detail } satisfies WorkerResponse);
  } finally {
    if ("image" in message && "close" in message.image) message.image.close();
  }
};
