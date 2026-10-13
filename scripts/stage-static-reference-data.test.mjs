import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "stage-static-reference-data.mjs",
);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const required = [
  "index.html",
  "favicon.svg",
  "packs/manifest.json",
  "packs/README.txt",
  ...[
    "THIRD_PARTY_NOTICES.md",
    "tcg-scan.txt",
    "react.txt",
    "react-dom.txt",
    "scheduler.txt",
    "lucide-react.txt",
    "opencv-js.txt",
  ].map((x) => `licenses/${x}`),
  ...[
    "worker.min.js",
    "worker.min.js.LICENSE.txt",
    "TESSERACT-JS-LICENSE.txt",
    "TESSERACT-CORE-LICENSE.txt",
    "TESSDATA-LICENSE.txt",
    "eng.traineddata.gz",
    "model-provenance.json",
  ].map((x) => `ocr/${x}`),
  "ocr/runtime-provenance.json",
  "ocr/tesseract-core-lstm.wasm.js",
  "ocr/tesseract-core-simd-lstm.wasm.js",
  ...[
    "fastweb-MODEL-CARD.md",
    "fastweb-single-1.39.onnx",
    "learned-models-NOTICE.md",
    "onnxruntime-LICENSE.txt",
    "ort-wasm-simd-threaded.wasm",
    "provenance.json",
    "xfeat-LICENSE.txt",
    "xfeat-MODEL-CARD.md",
    "xfeat_backbone.onnx",
    "xfeat_backbone.onnx.data",
  ].map((x) => `vision-models/${x}`),
  "assets/index-original.js",
  "assets/index-original.css",
  "assets/vision.worker-original.js",
  "assets/static-database-install-original.js",
];
async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
async function exists(path) {
  return lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tcg-static-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); // Only this test's own mkdtemp tree.
  const repo = join(root, "repo"),
    source = join(root, "references"),
    build = join(root, "build"),
    output = join(root, "bundle");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await copyFile(script, join(repo, "scripts/stage-static-reference-data.mjs"));
  for (const path of required)
    await put(join(build, path), `Original synthetic fixture: ${path}\n`);
  await put(
    join(build, "index.html"),
    '<!doctype html><html><head><link rel="icon" href="/favicon.svg"><script type="module" src="/assets/index-original.js"></script><link rel="stylesheet" href="/assets/index-original.css"></head></html>',
  );
  await put(
    join(build, "assets/index-original.js"),
    'export const install = () => import("./static-database-install-original.js");',
  );
  await put(
    join(build, "packs/manifest.json"),
    JSON.stringify({ version: 1, packs: [] }),
  );
  await put(
    join(repo, "LICENSE"),
    await readFile(join(build, "licenses/tcg-scan.txt")),
  );
  await put(
    join(repo, "THIRD_PARTY_NOTICES.md"),
    await readFile(join(build, "licenses/THIRD_PARTY_NOTICES.md")),
  );
  await put(
    join(repo, "docs/providers.md"),
    "Original synthetic provider notice. No third-party data.\n",
  );
  const shards = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7])];
  const manifest = {
    format: "tcg-learned-reference-pack",
    version: 1,
    algorithm: "xfeat256-int8-v1",
    records: [
      { identityKey: "pokemon:original-a" },
      { identityKey: "pokemon:original-b" },
    ],
    shards: shards.map((data, index) => ({
      file: `features-${String(index + 1).padStart(5, "0")}.bin`,
      bytes: data.length,
      count: 1,
      sha256: sha(data),
    })),
  };
  for (const [index, data] of shards.entries())
    await put(join(source, manifest.shards[index].file), data);
  const f = { root, repo, source, build, output, manifest };
  f.repin = async (override = {}) => {
    const text = JSON.stringify(manifest);
    await put(join(source, "manifest.learned.json"), text);
    f.release = {
      id: "pokemon-en-learned-2026-10-12",
      manifestSha256: sha(text),
      sha256: "a".repeat(64),
      manifestBytes: Buffer.byteLength(text),
      referenceBytes:
        Buffer.byteLength(text) +
        shards.reduce((sum, data) => sum + data.length, 0),
      shardCount: 2,
      referenceCount: 2,
      nameCount: 2,
      ...override,
    };
    await put(
      join(repo, "src/lib/pokemon-reference-release.ts"),
      `export const POKEMON_REFERENCE_RELEASE = {\n${Object.entries(f.release)
        .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
        .join("\n")}\n} as const;\n`,
    );
  };
  await f.repin();
  f.run = async (args = []) => {
    try {
      const result = await run(process.execPath, [
        join(repo, "scripts/stage-static-reference-data.mjs"),
        "--source",
        f.source,
        "--build",
        f.build,
        "--output",
        f.output,
        ...args,
      ]);
      return { ...result, code: 0 };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return f;
}
async function refused(f, pattern) {
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, pattern);
  assert.equal(await exists(join(f.output, "site")), false);
  return result;
}

test("verify-only checks every source without creating a bundle", async (t) => {
  const f = await fixture(t),
    result = await f.run(["--verify-only"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "verified-only-no-files-written");
  assert.equal(report.referenceBytes, f.release.referenceBytes);
  assert.equal(report.build.basePath, "/");
  assert.equal(
    report.build.staticInstallerChunk,
    "assets/static-database-install-original.js",
  );
  assert.equal(report.referenceFileCount, 3);
  assert.equal(report.limits.maxFileBytes, 25 * 1024 * 1024);
  assert.equal(report.limits.maxFiles, 1000);
  assert.equal(await exists(f.output), false);
});
test("stage original synthetic files with exact checksums, notices, and no private paths", async (t) => {
  const f = await fixture(t),
    verified = await f.run(["--verify-only"]),
    result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout),
    site = join(f.output, "site");
  assert.equal(report.status, "staged-locally-not-deployed");
  assert.equal(
    report.checksumsSha256,
    JSON.parse(verified.stdout).checksumsSha256,
  );
  assert.deepEqual(await readdir(f.output), ["site"]);
  const checksums = await readFile(join(site, "SHA256SUMS"), "utf8");
  for (const line of checksums.trim().split("\n")) {
    const [digest, path] = line.split("  ");
    assert.equal(sha(await readFile(join(site, path))), digest, path);
  }
  const inventoryText = await readFile(
    join(site, "deployment-report.json"),
    "utf8",
  );
  assert.equal(inventoryText.includes(f.root), false);
  const inventory = JSON.parse(inventoryText);
  assert.equal(inventory.files.length + 2, report.fileCount);
  assert.equal(
    inventory.files.reduce((sum, file) => sum + file.bytes, 0),
    inventory.payload.totalBytes,
  );
  assert.equal(sha(checksums), report.checksumsSha256);
  assert.equal(sha(inventoryText), report.reportSha256);
  assert.equal(await exists(join(site, "providers.md")), true);
  assert.equal(await exists(join(site, "REFERENCE_DATA_NOTICE.md")), true);
  const again = await f.run();
  assert.equal(again.code, 1);
  assert.match(again.stderr, /Output already exists/);
  assert.equal(await readFile(join(site, "SHA256SUMS"), "utf8"), checksums);
});
test("an existing arbitrary output is never touched", async (t) => {
  const f = await fixture(t);
  await put(join(f.output, "keep.txt"), "Do not change me.");
  await refused(f, /Output already exists/);
  assert.equal(
    await readFile(join(f.output, "keep.txt"), "utf8"),
    "Do not change me.",
  );
});
for (const [name, change, expected] of [
  [
    "unreviewed input headers",
    async (f) =>
      put(join(f.build, "_headers"), "/*\n  Access-Control-Allow-Origin: *\n"),
    /Input _headers is not accepted/,
  ],
  [
    "input headers symlink",
    async (f) => symlink(join(f.root, "unread"), join(f.build, "_headers")),
    /Input _headers is not accepted/,
  ],
  [
    "unreviewed redirects",
    async (f) => put(join(f.build, "_redirects"), "/* /index.html 200\n"),
    /Unsafe build entry/,
  ],
  [
    "missing static chunk",
    async (f) =>
      rm(join(f.build, "assets/static-database-install-original.js")),
    /static installer chunk/,
  ],
  [
    "unreferenced static chunk",
    async (f) =>
      put(
        join(f.build, "assets/index-original.js"),
        "export const local = true;",
      ),
    /does not reference/,
  ],
  [
    "HTML external origin",
    async (f) => {
      const p = join(f.build, "index.html");
      await writeFile(
        p,
        (await readFile(p, "utf8")).replace(
          "/assets/index-original.js",
          "https://other.invalid/assets/index-original.js",
        ),
      );
    },
    /safely infer/,
  ],
  [
    "HTML traversal base",
    async (f) => {
      const p = join(f.build, "index.html");
      await writeFile(
        p,
        (await readFile(p, "utf8"))
          .replaceAll('href="/', 'href="/../')
          .replace('src="/', 'src="/../'),
      );
    },
    /safely infer/,
  ],
  [
    "HTML mismatched asset base",
    async (f) => {
      const p = join(f.build, "index.html");
      await writeFile(
        p,
        (await readFile(p, "utf8")).replace(
          "/assets/index-original.css",
          "/other/assets/index-original.css",
        ),
      );
    },
    /asset URLs/,
  ],
  [
    "HTML base element",
    async (f) => {
      const p = join(f.build, "index.html");
      await writeFile(p, `<base href="/">${await readFile(p, "utf8")}`);
    },
    /base elements/,
  ],
  [
    "corrupt manifest",
    async (f) => {
      const p = join(f.source, "manifest.learned.json");
      const bytes = await readFile(p);
      bytes[0] = 91;
      await writeFile(p, bytes);
    },
    /SHA-256 mismatch/,
  ],
  [
    "corrupt shard",
    async (f) =>
      writeFile(
        join(f.source, "features-00001.bin"),
        Buffer.from([9, 2, 3, 4]),
      ),
    /SHA-256 mismatch/,
  ],
  [
    "truncated shard",
    async (f) => truncate(join(f.source, "features-00001.bin"), 2),
    /Size mismatch/,
  ],
  [
    "extra raw art",
    async (f) => put(join(f.source, "private-card.webp"), "private"),
    /extras\/symlinks/,
  ],
  [
    "extra private directory",
    async (f) => mkdir(join(f.source, "private")),
    /extras\/symlinks/,
  ],
  [
    "missing shard",
    async (f) => rm(join(f.source, "features-00001.bin")),
    /extras\/symlinks/,
  ],
  [
    "source symlink",
    async (f) => {
      const target = f.source;
      f.source = join(f.root, "linked-source");
      await symlink(target, f.source);
    },
    /Symlink/,
  ],
  [
    "manifest symlink",
    async (f) => {
      const p = join(f.source, "manifest.learned.json");
      await copyFile(p, join(f.root, "manifest.json"));
      await rm(p);
      await symlink(join(f.root, "manifest.json"), p);
    },
    /Symlink/,
  ],
  [
    "shard symlink",
    async (f) => {
      const p = join(f.source, "features-00001.bin");
      await rm(p);
      await symlink(join(f.source, "features-00002.bin"), p);
    },
    /extras\/symlinks/,
  ],
  [
    "build symlink",
    async (f) => {
      const target = f.build;
      f.build = join(f.root, "linked-build");
      await symlink(target, f.build);
    },
    /Symlink/,
  ],
  [
    "nested build symlink",
    async (f) =>
      symlink(join(f.root, "missing"), join(f.build, "assets/extra.js")),
    /Unapproved build entry/,
  ],
  [
    "build private file",
    async (f) => put(join(f.build, ".env"), "TOKEN=not-a-real-secret"),
    /Unsafe build entry/,
  ],
  [
    "build image",
    async (f) =>
      put(
        join(f.build, "assets/card.png"),
        "original synthetic image placeholder",
      ),
    /Unapproved build entry/,
  ],
  [
    "build source map",
    async (f) => put(join(f.build, "assets/index-original.js.map"), "{}"),
    /Unapproved build entry/,
  ],
  ...[
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "runtime-provenance.json",
  ].map((name) => [
    `missing required OCR asset ${name}`,
    async (f) => rm(join(f.build, "ocr", name)),
    /Missing runtime asset\/notice/,
  ]),
  [
    "retired standalone OCR WASM",
    async (f) => put(join(f.build, "ocr/tesseract-core-lstm.wasm"), "retired"),
    /Unapproved build entry/,
  ],
  [
    "missing notice",
    async (f) => rm(join(f.build, "vision-models/learned-models-NOTICE.md")),
    /Missing runtime asset\/notice/,
  ],
  [
    "stale built notice",
    async (f) => put(join(f.repo, "THIRD_PARTY_NOTICES.md"), "stale"),
    /Size mismatch/,
  ],
  [
    "nonempty legacy packs",
    async (f) =>
      put(
        join(f.build, "packs/manifest.json"),
        JSON.stringify({ version: 1, packs: ["private"] }),
      ),
    /empty public packs manifest/,
  ],
  [
    "oversized asset",
    async (f) =>
      truncate(join(f.build, "assets/index-original.js"), 25 * 1024 * 1024 + 1),
    /File size exceeds safe limits/,
  ],
  [
    "unsafe shard name even when pinned",
    async (f) => {
      f.manifest.shards[0].file = "../private.bin";
      await f.repin();
    },
    /unsafe, duplicate/,
  ],
  [
    "duplicate shard even when pinned",
    async (f) => {
      f.manifest.shards[1].file = f.manifest.shards[0].file;
      await f.repin();
    },
    /unsafe, duplicate/,
  ],
  [
    "wrong pinned total",
    async (f) => f.repin({ referenceBytes: 9999 }),
    /total bytes/,
  ],
  [
    "wrong pinned count",
    async (f) => f.repin({ referenceCount: 3 }),
    /release shape\/counts/,
  ],
  [
    "wrong pinned names",
    async (f) => f.repin({ nameCount: 3 }),
    /release shape\/counts/,
  ],
  [
    "wrong shard total records",
    async (f) => {
      f.manifest.shards[0].count = 2;
      await f.repin();
    },
    /shard record counts/,
  ],
  [
    "oversized manifest pin",
    async (f) => f.repin({ manifestBytes: 25 * 1024 * 1024 + 1 }),
    /pins violate/,
  ],
  [
    "overlapping output/source",
    async (f) => {
      f.output = join(f.source, "bundle");
    },
    /disjoint/,
  ],
  [
    "output inside checkout",
    async (f) => {
      f.output = join(f.repo, "bundle");
    },
    /outside the checkout/,
  ],
  [
    "symlink output ancestor",
    async (f) => {
      await symlink(f.root, join(f.root, "link"));
      f.output = join(f.root, "link/bundle");
    },
    /Symlink/,
  ],
  [
    "missing output parent",
    async (f) => {
      f.output = join(f.root, "missing/bundle");
    },
    /ENOENT/,
  ],
])
  test(`rejects ${name} without creating a site`, async (t) => {
    const f = await fixture(t);
    await change(f);
    await refused(f, expected);
  });
test("conservative complete bundle file count includes audit files", async (t) => {
  const f = await fixture(t);
  // Existing payload has required.length + three reference files + two notices + generated headers.
  const extras = 1000 - (required.length + 3 + 2 + 1 + 2) + 1;
  for (let index = 0; index < extras; index++)
    await put(join(f.build, `assets/test-${index}.js`), "x");
  await refused(f, /Bundle exceeds 1000 files/);
});
test("unknown and repeated arguments cannot override release pins", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--release", "anything"],
    ["--source", f.source],
    ["--verify-only", "--verify-only"],
  ]) {
    const result = await f.run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown or repeated/);
  }
});

test("reports a safe subpath without relocating files or changing bytes", async (t) => {
  const f = await fixture(t),
    path = join(f.build, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8"))
      .replaceAll('href="/', 'href="/tcg-scan/')
      .replace('src="/', 'src="/tcg-scan/'),
  );
  const result = await f.run(["--verify-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).build.basePath, "/tcg-scan/");
});

function parseHeaders(contents) {
  return contents
    .split(/\n\s*\n/)
    .map((block) =>
      block.split("\n").filter((line) => line && !line.startsWith("#")),
    )
    .filter((lines) => lines.length)
    .map(([path, ...headers]) => [
      path,
      Object.fromEntries(
        headers.map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        }),
      ),
    ]);
}
test("generates only reviewed MIME/cache headers, covered by the checksums", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const site = join(f.output, "site"),
    text = await readFile(join(site, "_headers"), "utf8");
  const immutable = "public, max-age=31536000, immutable";
  const expected = [
    ["/*", { "X-Content-Type-Options": "nosniff" }],
    ["/", { "Cache-Control": "no-cache" }],
    ["/index.html", { "Cache-Control": "no-cache" }],
    [
      "/assets/index-original.css",
      { "Content-Type": "text/css; charset=utf-8", "Cache-Control": immutable },
    ],
    [
      "/assets/index-original.js",
      {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": immutable,
      },
    ],
    [
      "/assets/static-database-install-original.js",
      {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": immutable,
      },
    ],
    [
      "/assets/vision.worker-original.js",
      {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": immutable,
      },
    ],
    [
      "/vision-models/ort-wasm-simd-threaded.wasm",
      { "Content-Type": "application/wasm", "Cache-Control": "no-cache" },
    ],
    [
      "/reference-data/pokemon-en-learned-2026-10-12/manifest.learned.json",
      {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": immutable,
      },
    ],
    [
      "/reference-data/pokemon-en-learned-2026-10-12/features-*.bin",
      {
        "Content-Type": "application/octet-stream",
        "Cache-Control": immutable,
      },
    ],
  ];
  assert.deepEqual(parseHeaders(text), expected);
  assert.equal(
    parseHeaders(text).filter(([path]) => path.includes("*")).length,
    2,
  );
  assert.doesNotMatch(
    text,
    /Access-Control|Content-Encoding|Set-Cookie|Content-Security-Policy|https?:\/\//,
  );
  const report = JSON.parse(
    await readFile(join(site, "deployment-report.json"), "utf8"),
  );
  assert.deepEqual(report.hosting, {
    headersFile: "_headers",
    requiredNotFoundHandling: "none",
    routingVerified: false,
  });
  assert.equal(
    report.files.find((file) => file.path === "_headers").sha256,
    sha(text),
  );
  assert.match(
    await readFile(join(site, "SHA256SUMS"), "utf8"),
    new RegExp(`${sha(text)}  _headers\\n`),
  );
});
test("hashed WASM is immutable but stable-name runtime WASM is revalidated", async (t) => {
  const f = await fixture(t);
  await put(
    join(f.build, "assets/runtime-original.wasm"),
    "Original synthetic WASM placeholder.",
  );
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const rules = new Map(
    parseHeaders(await readFile(join(f.output, "site/_headers"), "utf8")),
  );
  assert.deepEqual(rules.get("/assets/runtime-original.wasm"), {
    "Content-Type": "application/wasm",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  assert.deepEqual(rules.get("/vision-models/ort-wasm-simd-threaded.wasm"), {
    "Content-Type": "application/wasm",
    "Cache-Control": "no-cache",
  });
});
test("subpath QA headers stay within the inferred base", async (t) => {
  const f = await fixture(t),
    path = join(f.build, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8"))
      .replaceAll('href="/', 'href="/tcg-scan/')
      .replace('src="/', 'src="/tcg-scan/'),
  );
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const rules = parseHeaders(
    await readFile(join(f.output, "site/_headers"), "utf8"),
  );
  assert.ok(rules.every(([path]) => path.startsWith("/tcg-scan/")));
  assert.equal(rules[0][0], "/tcg-scan/*");
});
test("excessive generated header rules fail closed", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 100; index++)
    await put(join(f.build, `assets/additional-${index}.js`), "x");
  await refused(f, /exceed 100 header rules/);
});

test("generated header paths respect Cloudflare's line length ceiling", async (t) => {
  const f = await fixture(t),
    path = join(f.build, "index.html"),
    base = `/${"a".repeat(1980)}/`;
  await writeFile(
    path,
    (await readFile(path, "utf8"))
      .replaceAll('href="/', `href="${base}`)
      .replace('src="/', `src="${base}`),
  );
  await refused(f, /header line exceeds 2,000/);
});
