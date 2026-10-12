import { expect, it } from "vitest";
import { imageDimensions, preflightImage } from "./image-header";
function png(width = 4032, height = 3024) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const v = new DataView(bytes.buffer);
  v.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return bytes;
}
it("reads PNG dimensions before decode and rejects allocation bombs", () => {
  expect(imageDimensions(png())).toEqual({ width: 4032, height: 3024 });
  for (const [w, h] of [
    [0, 10],
    [50000, 50000],
    [10000, 10000],
    [16385, 10],
  ])
    expect(() => imageDimensions(png(w, h))).toThrow();
});
it("walks bounded JPEG marker lengths and reads progressive dimensions", () => {
  const bytes = Uint8Array.from([
    255, 216, 255, 224, 0, 4, 0, 0, 255, 194, 0, 8, 8, 4, 176, 3, 132, 0, 255,
    217,
  ]);
  expect(imageDimensions(bytes)).toEqual({ width: 900, height: 1200 });
  bytes[10] = 255;
  expect(() => imageDimensions(bytes)).toThrow();
});
it("reads extended, lossless and lossy WebP dimension headers", () => {
  const base = () => {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode("RIFF"), 0);
    b.set(new TextEncoder().encode("WEBP"), 8);
    new DataView(b.buffer).setUint32(16, 10, true);
    return b;
  };
  const ext = base();
  ext.set(new TextEncoder().encode("VP8X"), 12);
  ext[24] = 255;
  ext[25] = 3;
  ext[27] = 255;
  ext[28] = 1;
  expect(imageDimensions(ext)).toEqual({ width: 1024, height: 512 });
  const lossless = base();
  lossless.set(new TextEncoder().encode("VP8L"), 12);
  lossless[20] = 0x2f;
  new DataView(lossless.buffer).setUint32(21, 239 + (335 << 14), true);
  expect(imageDimensions(lossless)).toEqual({ width: 240, height: 336 });
  const lossy = base();
  lossy.set(new TextEncoder().encode("VP8 "), 12);
  lossy.set([157, 1, 42], 23);
  new DataView(lossy.buffer).setUint16(26, 600, true);
  new DataView(lossy.buffer).setUint16(28, 825, true);
  expect(imageDimensions(lossy)).toEqual({ width: 600, height: 825 });
});
it("fails closed on truncated, unsupported and invalid chunk lengths", () => {
  for (const b of [
    new Uint8Array(),
    new TextEncoder().encode("<svg></svg>"),
    png().slice(0, 23),
    Uint8Array.from([255, 216, 255, 224, 0, 1]),
  ])
    expect(() => imageDimensions(b)).toThrow();
});
it("only reads a bounded header from a blob", async () => {
  const header = png();
  const file = new Blob([header, new Uint8Array(700000)]);
  expect(await preflightImage(file)).toEqual({ width: 4032, height: 3024 });
});
