import type * as OpenCv from "@techstark/opencv-js";
import { differenceHash, perceptualHash } from "./hash";
import type { ReferenceFeatures } from "./types";

/** Canonical offline extractor. Matches the live engine's resize, grayscale and ORB settings. */
export function extractReferenceFeatures(
  cv: typeof OpenCv,
  rgba: { data: Uint8ClampedArray; width: number; height: number },
  key: string,
  maxFeatures = 96,
): ReferenceFeatures {
  const source = cv.matFromImageData(rgba as ImageData), resized = new cv.Mat(), gray = new cv.Mat(), tiny = new cv.Mat(), difference = new cv.Mat();
  const orb = new cv.ORB(500, 1.2, 8, 15, 0, 2, cv.ORB_HARRIS_SCORE, 31, 12);
  const mask = new cv.Mat(), descriptor = new cv.Mat(), keypoints = new cv.KeyPointVector();
  try {
    cv.resize(source, resized, new cv.Size(240, 336), 0, 0, cv.INTER_AREA);
    cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY);
    cv.resize(gray, tiny, new cv.Size(32, 32), 0, 0, cv.INTER_AREA);
    cv.resize(gray, difference, new cv.Size(9, 8), 0, 0, cv.INTER_AREA);
    orb.detectAndCompute(gray, mask, keypoints, descriptor);
    // Round-robin a 4×6 spatial grid. Strong text/border corners cannot displace
    // every artwork descriptor, a common failure of a simple top-response slice.
    const cells: { index: number; x: number; y: number; response: number }[][] = Array.from({ length: 24 }, () => []);
    for (let i = 0; i < keypoints.size(); i++) {
      const point = keypoints.get(i) as { pt: { x: number; y: number }; response: number };
      cells[Math.min(5, Math.floor(point.pt.y / 56)) * 4 + Math.min(3, Math.floor(point.pt.x / 60))].push({ index: i, x: point.pt.x, y: point.pt.y, response: point.response });
    }
    for (const cell of cells) cell.sort((a, b) => b.response - a.response);
    const selected: typeof cells[number] = [];
    const limit = Math.min(500, Math.max(20, maxFeatures), keypoints.size());
    for (let round = 0; selected.length < limit; round++) for (const cell of cells) {
      if (cell[round]) selected.push(cell[round]);
      if (selected.length >= limit) break;
    }
    const bytes = new Uint8Array(selected.length * 32);
    selected.forEach((point, i) => bytes.set(descriptor.data.subarray(point.index * 32, point.index * 32 + 32), i * 32));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { key, hash: perceptualHash(tiny.data), differenceHash: differenceHash(difference.data), points: selected.flatMap(p => [p.x, p.y]), descriptors: btoa(binary) };
  } finally { source.delete(); resized.delete(); gray.delete(); tiny.delete(); difference.delete(); orb.delete(); mask.delete(); descriptor.delete(); keypoints.delete(); }
}
