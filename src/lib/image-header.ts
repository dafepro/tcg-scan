/** Bound decoded-image allocation before asking a browser codec to open untrusted uploads. */
const HEADER_LIMIT = 512 * 1024;
export const MAX_SOURCE_PIXELS = 40_000_000;
const invalid = () =>
  new Error(
    "Could not read this image header. Choose a valid JPG, PNG or WebP photo.",
  );
export function imageDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, count: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0,
    height = 0;
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    text(1, 7) === "PNG\r\n\x1a\n" &&
    text(12, 4) === "IHDR" &&
    v.getUint32(8) === 13
  ) {
    width = v.getUint32(16);
    height = v.getUint32(20);
  } else if (
    bytes.length >= 12 &&
    text(0, 4) === "RIFF" &&
    text(8, 4) === "WEBP"
  ) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = text(offset, 4),
        size = v.getUint32(offset + 4, true),
        body = offset + 8;
      if (body + Math.min(size, 10) > bytes.length) throw invalid();
      if (kind === "VP8X" && size >= 10) {
        width =
          1 +
          bytes[body + 4] +
          (bytes[body + 5] << 8) +
          (bytes[body + 6] << 16);
        height =
          1 +
          bytes[body + 7] +
          (bytes[body + 8] << 8) +
          (bytes[body + 9] << 16);
        break;
      }
      if (kind === "VP8L" && size >= 5 && bytes[body] === 0x2f) {
        const packed = v.getUint32(body + 1, true);
        width = (packed & 0x3fff) + 1;
        height = ((packed >>> 14) & 0x3fff) + 1;
        break;
      }
      if (
        kind === "VP8 " &&
        size >= 10 &&
        bytes[body + 3] === 0x9d &&
        bytes[body + 4] === 1 &&
        bytes[body + 5] === 0x2a
      ) {
        width = v.getUint16(body + 6, true) & 0x3fff;
        height = v.getUint16(body + 8, true) & 0x3fff;
        break;
      }
      if (size > bytes.length - body) throw invalid();
      offset = body + size + (size & 1);
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const frameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    for (let offset = 2; offset + 1 < bytes.length;) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalid();
      const size = v.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) throw invalid();
      if (frameMarkers.has(marker)) {
        if (size < 8) throw invalid();
        height = v.getUint16(offset + 3);
        width = v.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
  }
  if (!width || !height) throw invalid();
  if (width > 16384 || height > 16384 || width * height > MAX_SOURCE_PIXELS)
    throw new Error(
      "This image has too many decoded pixels. Resize it below 40 megapixels and 16384 pixels per side before importing.",
    );
  return { width, height };
}
export async function preflightImage(
  file: Blob,
): Promise<{ width: number; height: number }> {
  if (!file.size) throw invalid();
  return imageDimensions(
    new Uint8Array(await file.slice(0, HEADER_LIMIT).arrayBuffer()),
  );
}
