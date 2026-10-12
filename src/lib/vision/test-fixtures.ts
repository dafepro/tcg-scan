// Original geometric artwork only. No third-party image or live service is used.
export function syntheticCard(seed: number): ImageData {
  const width = 240, height = 336, data = new Uint8ClampedArray(width * height * 4);
  let state = seed;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const rect = (left: number, top: number, w: number, h: number, value: number) => {
    for (let y = top; y < Math.min(height, top + h); y++) for (let x = left; x < Math.min(width, left + w); x++) {
      const i = (y * width + x) * 4; data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
  };
  rect(0, 0, width, height, 230); rect(5, 5, width - 10, height - 10, 25); rect(10, 10, width - 20, height - 20, 235);
  rect(20, 55, 200, 140, 110);
  for (let i = 0; i < 90; i++) rect(22 + Math.floor(random() * 174), 57 + Math.floor(random() * 114), 4 + Math.floor(random() * 20), 4 + Math.floor(random() * 20), Math.floor(random() * 230));
  for (let i = 0; i < 130; i++) rect(24 + Math.floor(random() * 170), 210 + Math.floor(random() * 95), 2 + Math.floor(random() * 8), 3 + Math.floor(random() * 5), 25 + Math.floor(random() * 45));
  for (let i = 0; i < 24; i++) rect(24 + Math.floor(random() * 170), 20 + Math.floor(random() * 24), 3 + Math.floor(random() * 12), 3 + Math.floor(random() * 7), 25);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
export function syntheticScene(image: ImageData, reversed = false): ImageData {
  const width = 640, height = 520, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 40; data[i + 1] = 50; data[i + 2] = 55; data[i + 3] = 255; }
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const source = ((reversed ? image.height - 1 - y : y) * image.width + (reversed ? image.width - 1 - x : x)) * 4;
    data.set(image.data.subarray(source, source + 4), ((y + 90) * width + x + 200) * 4);
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
