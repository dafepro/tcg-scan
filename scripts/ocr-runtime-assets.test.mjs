import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  OCR_CORE_ASSETS,
  RETIRED_OCR_ASSETS,
  stageOcrCoreAssets,
} from "./ocr-runtime-assets.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "node_modules/tesseract.js-core");
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "tcg-ocr-staging-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const output = join(path, "ocr");
  await mkdir(output);
  return { path, output };
}
test("stages both byte-verified embedded-WASM fallbacks and cleans only known retired bytes on repeated runs", async (t) => {
  const { output } = await fixture(t);
  for (const { name } of RETIRED_OCR_ASSETS)
    await copyFile(join(core, name), join(output, name));
  await writeFile(join(output, "keep-notice.txt"), "Preserve this notice.");
  await stageOcrCoreAssets(core, output);
  await stageOcrCoreAssets(core, output);
  assert.deepEqual(
    (await readdir(output)).sort(),
    [
      "keep-notice.txt",
      "runtime-provenance.json",
      ...OCR_CORE_ASSETS.map((a) => a.name),
    ].sort(),
  );
  for (const { name } of OCR_CORE_ASSETS)
    assert.deepEqual(
      await readFile(join(output, name)),
      await readFile(join(core, name)),
    );
  const provenance = JSON.parse(
    await readFile(join(output, "runtime-provenance.json"), "utf8"),
  );
  assert.equal(provenance.lstmOnly, true);
  assert.equal(provenance.assets.length, 2);
});
test("refuses unknown bytes at a retired filename without deleting or replacing anything", async (t) => {
  const { output } = await fixture(t);
  await writeFile(join(output, RETIRED_OCR_ASSETS[0].name), "User-owned bytes");
  await assert.rejects(
    stageOcrCoreAssets(core, output),
    /Unreviewed OCR runtime bytes/,
  );
  assert.deepEqual(await readdir(output), [RETIRED_OCR_ASSETS[0].name]);
});
test("refuses symlink cleanup targets and output directories", async (t) => {
  const { path, output } = await fixture(t);
  const target = join(path, "important.txt");
  await writeFile(target, "Keep me");
  await symlink(target, join(output, RETIRED_OCR_ASSETS[0].name));
  await assert.rejects(stageOcrCoreAssets(core, output), /regular file/);
  assert.equal(await readFile(target, "utf8"), "Keep me");
  await symlink(output, join(path, "linked-output"));
  await assert.rejects(
    stageOcrCoreAssets(core, join(path, "linked-output")),
    /real directories/,
  );
});
test("official browser loader chooses the staged LSTM wrapper for both SIMD outcomes", async () => {
  const code = await readFile(
    join(
      root,
      "node_modules/tesseract.js/src/worker-script/browser/getCore.js",
    ),
    "utf8",
  );
  for (const supported of [false, true]) {
    const loaded = [],
      expected = supported
        ? "tesseract-core-simd-lstm.wasm.js"
        : "tesseract-core-lstm.wasm.js";
    const context = {
      module: { exports: null },
      require(name) {
        if (name === "wasm-feature-detect")
          return { simd: async () => supported };
        if (name === "../../../package.json")
          return { dependencies: { "tesseract.js-core": "^6.0.0" } };
        throw new Error(`Unexpected import ${name}`);
      },
    };
    context.global = {
      importScripts(url) {
        loaded.push(url);
        context.global.TesseractCore = {};
      },
    };
    runInNewContext(code, context);
    await context.module.exports(true, "https://test.invalid/tcg-scan/ocr/", {
      progress() {},
    });
    assert.deepEqual(loaded, [`https://test.invalid/tcg-scan/ocr/${expected}`]);
    assert.equal(
      OCR_CORE_ASSETS.some((a) => a.name === expected),
      true,
    );
  }
});
