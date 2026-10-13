import { afterEach, describe, expect, it } from "vitest";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyOrtPackagingAssets } from "./runtime-packaging";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tcg-ort-packaging-"));
  temporary.push(root);
  await symlink(resolve("node_modules"), join(root, "node_modules"));
  const publicDir = join(root, "public");
  await mkdir(join(publicDir, "vision-models"), { recursive: true });
  return {
    root,
    publicDir,
    wasm: join(publicDir, "vision-models/ort-wasm-simd-threaded.wasm"),
  };
}
describe("ORT public runtime alias preconditions", () => {
  it("accepts only an identical staged copy of the pinned official runtime", async () => {
    const { root, publicDir, wasm } = await fixture();
    await copyFile(
      resolve("node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
      wasm,
    );
    await expect(
      verifyOrtPackagingAssets(root, publicDir),
    ).resolves.toBeUndefined();
    await writeFile(wasm, "Unexpected runtime");
    await expect(verifyOrtPackagingAssets(root, publicDir)).rejects.toThrow(
      "ORT packaging integrity check failed",
    );
  });
  it("rejects a missing public fallback instead of silently emitting a duplicate", async () => {
    const { root, publicDir } = await fixture();
    await expect(verifyOrtPackagingAssets(root, publicDir)).rejects.toThrow(
      "ENOENT",
    );
  });
  it("rejects an unreviewed runtime version", async () => {
    const root = await mkdtemp(join(tmpdir(), "tcg-ort-version-"));
    temporary.push(root);
    const runtime = join(root, "node_modules/onnxruntime-web");
    await mkdir(runtime, { recursive: true });
    await writeFile(
      join(runtime, "package.json"),
      JSON.stringify({ version: "1.30.1" }),
    );
    await expect(
      verifyOrtPackagingAssets(root, join(root, "public")),
    ).rejects.toThrow("exactly onnxruntime-web@1.30.0");
  });
});
