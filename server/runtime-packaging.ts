/** Preserve ORT fallback URLs while reusing the already-staged, identical public WASM. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const WASM = "ort-wasm-simd-threaded.wasm";
const wasmSha256 =
  "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2";
const glueSha256 =
  "11e64bd8ffe11bd1a2a2f0d6275fdfbbba7262f0b76b99b53d228a8a22ef3d90";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function verifyOrtPackagingAssets(
  root: string,
  publicDir: string,
): Promise<void> {
  const runtime = resolve(root, "node_modules/onnxruntime-web");
  const pkg = JSON.parse(
    await readFile(resolve(runtime, "package.json"), "utf8"),
  );
  if (pkg.version !== "1.30.0")
    throw new Error("ORT packaging requires exactly onnxruntime-web@1.30.0.");
  for (const [path, bytes, sha256] of [
    [resolve(runtime, "dist/ort.wasm.bundle.min.mjs"), 73054, glueSha256],
    [resolve(runtime, "dist", WASM), 14239897, wasmSha256],
    [resolve(publicDir, "vision-models", WASM), 14239897, wasmSha256],
  ] as const) {
    const data = await readFile(path);
    if (data.length !== bytes || digest(data) !== sha256)
      throw new Error(`ORT packaging integrity check failed: ${path}`);
  }
}
export function ortRuntimePackagingPlugin(): Plugin {
  let root: string, publicDir: string;
  return {
    name: "tcg-pinned-ort-public-runtime",
    apply: "build",
    enforce: "post",
    config(config) {
      const configuredRoot = resolve(config.root ?? process.cwd());
      const configuredPublic = resolve(
        configuredRoot,
        typeof config.publicDir === "string" ? config.publicDir : "public",
      );
      return {
        resolve: {
          alias: [
            {
              // Exact bare filename from the official bundle's two new URL expressions.
              // Vite's public-file resolver preserves configured root/subpath bases.
              find: /^ort-wasm-simd-threaded\.wasm$/,
              replacement: resolve(configuredPublic, "vision-models", WASM),
            },
          ],
        },
      };
    },
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    async buildStart() {
      if (!publicDir)
        throw new Error("ORT packaging requires the staged public directory.");
      await verifyOrtPackagingAssets(root, publicDir);
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (
          item.type === "asset" &&
          /^ort-wasm-simd-threaded(?:-[A-Za-z0-9_-]+)?\.wasm$/.test(
            item.fileName.split("/").at(-1) ?? "",
          )
        )
          throw new Error(
            `Unexpected duplicate ORT runtime emitted: ${item.fileName}`,
          );
      }
    },
  };
}
