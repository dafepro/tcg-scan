#!/usr/bin/env node
/** Local-only, fail-closed packaging. No network, credentials, deletion, or deploy. */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 1000; // Conservative Pages browser-upload ceiling, route undecided.
const CHUNK_BYTES = 64 * 1024;
const MANIFEST = "manifest.learned.json";
const SHA = /^[a-f0-9]{64}$/;
const REQUIRED_BUILD_FILES = [
  "index.html",
  "favicon.svg",
  "packs/manifest.json",
  "packs/README.txt",
  "licenses/THIRD_PARTY_NOTICES.md",
  "licenses/tcg-scan.txt",
  "licenses/react.txt",
  "licenses/react-dom.txt",
  "licenses/scheduler.txt",
  "licenses/lucide-react.txt",
  "licenses/opencv-js.txt",
  "ocr/worker.min.js",
  "ocr/worker.min.js.LICENSE.txt",
  "ocr/TESSERACT-JS-LICENSE.txt",
  "ocr/TESSERACT-CORE-LICENSE.txt",
  "ocr/TESSDATA-LICENSE.txt",
  "ocr/eng.traineddata.gz",
  "ocr/model-provenance.json",
  ...["", "-lstm", "-simd", "-simd-lstm"].flatMap((variant) => [
    `ocr/tesseract-core${variant}.wasm`,
    `ocr/tesseract-core${variant}.wasm.js`,
  ]),
  "vision-models/fastweb-MODEL-CARD.md",
  "vision-models/fastweb-single-1.39.onnx",
  "vision-models/learned-models-NOTICE.md",
  "vision-models/onnxruntime-LICENSE.txt",
  "vision-models/ort-wasm-simd-threaded.wasm",
  "vision-models/provenance.json",
  "vision-models/xfeat-LICENSE.txt",
  "vision-models/xfeat-MODEL-CARD.md",
  "vision-models/xfeat_backbone.onnx",
  "vision-models/xfeat_backbone.onnx.data",
];
const REQUIRED_SET = new Set(REQUIRED_BUILD_FILES);
const BUILD_DIRS = new Set([
  "assets",
  "licenses",
  "ocr",
  "packs",
  "vision-models",
]);
function fail(message) {
  throw new Error(message);
}
function safeName(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".")
  );
}
function signature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
async function inspectPath(path, kind) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) fail(`Symlink is not allowed: ${current}`);
    if (current !== absolute && !stat.isDirectory())
      fail(`Non-directory ancestor: ${current}`);
  }
  const stat = await lstat(absolute, { bigint: true });
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile())
    fail(`Expected a regular ${kind}: ${absolute}`);
  return stat;
}
async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  fail(`Output already exists; choose a fresh directory: ${path}`);
}
function overlaps(a, b) {
  const rel = relative(a, b);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))
  );
}
/** One bounded read buffer; only the <=25 MiB manifest or small notices are retained. */
async function readChecked(
  path,
  { bytes, sha256, collect = false, destination } = {},
) {
  const before = await inspectPath(path, "file");
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES)
    fail(`File size exceeds safe limits (1..${MAX_FILE_BYTES} bytes): ${path}`);
  if (bytes !== undefined && size !== bytes) fail(`Size mismatch: ${path}`);
  if (constants.O_NOFOLLOW === undefined)
    fail("This platform lacks O_NOFOLLOW; use the cloud Linux workspace.");
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    if (signature(await input.stat({ bigint: true })) !== signature(before))
      fail(`Source changed before opening: ${path}`);
    if (destination) {
      await inspectPath(dirname(destination), "directory");
      output = await open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES),
      hash = createHash("sha256");
    const captured = collect ? Buffer.alloc(size) : undefined;
    let total = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (total + bytesRead > size) fail(`Source grew during read: ${path}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      captured?.set(chunk, total);
      if (output) {
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(
            chunk,
            written,
            bytesRead - written,
            null,
          );
          if (!result.bytesWritten) fail(`Short write: ${destination}`);
          written += result.bytesWritten;
        }
      }
      total += bytesRead;
    }
    const digest = hash.digest("hex");
    if (
      total !== size ||
      signature(await input.stat({ bigint: true })) !== signature(before) ||
      signature(await inspectPath(path, "file")) !== signature(before)
    )
      fail(`Source changed during read: ${path}`);
    if (sha256 !== undefined && digest !== sha256)
      fail(`SHA-256 mismatch: ${path}`);
    if (output) await output.sync();
    return { bytes: size, sha256: digest, contents: captured };
  } finally {
    await input.close();
    await output?.close();
  }
}
async function pinnedRelease() {
  const file = await readChecked(
    join(ROOT, "src/lib/pokemon-reference-release.ts"),
    { collect: true },
  );
  if (file.bytes > 32 * 1024) fail("Release pin source is unexpectedly large.");
  const body = file.contents
    .toString("utf8")
    .match(
      /export const POKEMON_REFERENCE_RELEASE\s*=\s*\{([\s\S]*?)\}\s*as const;/,
    )?.[1];
  if (!body) fail("Cannot read the fixed release pin source.");
  const values = {};
  for (const name of ["id", "manifestSha256", "sha256"]) {
    const matches = [
      ...body.matchAll(new RegExp(`\\b${name}:\\s*"([^"]+)"`, "g")),
    ];
    if (matches.length !== 1) fail(`Missing or ambiguous pin: ${name}`);
    values[name] = matches[0][1];
  }
  for (const name of [
    "manifestBytes",
    "referenceBytes",
    "shardCount",
    "referenceCount",
    "nameCount",
  ]) {
    const matches = [
      ...body.matchAll(
        new RegExp(`\\b${name}:\\s*([0-9][0-9_]*)(?=\\s*[,}])`, "g"),
      ),
    ];
    const value = Number(matches[0]?.[1].replaceAll("_", ""));
    if (matches.length !== 1 || !Number.isSafeInteger(value) || value <= 0)
      fail(`Invalid pin: ${name}`);
    values[name] = value;
  }
  if (
    !/^pokemon-en-learned-\d{4}-\d{2}-\d{2}$/.test(values.id) ||
    !SHA.test(values.manifestSha256) ||
    !SHA.test(values.sha256) ||
    values.manifestBytes > MAX_FILE_BYTES ||
    values.shardCount + 1 > MAX_FILES
  )
    fail("Release pins violate the supported static bundle contract.");
  return values;
}
async function referencePlan(source, release) {
  await inspectPath(source, "directory");
  const manifestFile = await readChecked(join(source, MANIFEST), {
    bytes: release.manifestBytes,
    sha256: release.manifestSha256,
    collect: true,
  });
  const manifest = JSON.parse(manifestFile.contents.toString("utf8"));
  if (
    manifest.format !== "tcg-learned-reference-pack" ||
    manifest.version !== 1 ||
    manifest.algorithm !== "xfeat256-int8-v1" ||
    !Array.isArray(manifest.shards) ||
    manifest.shards.length !== release.shardCount ||
    !Array.isArray(manifest.records) ||
    manifest.records.length !== release.referenceCount ||
    new Set(manifest.records.map((record) => record.identityKey)).size !==
      release.nameCount
  )
    fail("Pinned manifest does not match the supported release shape/counts.");
  const specs = [
    {
      file: MANIFEST,
      bytes: release.manifestBytes,
      sha256: release.manifestSha256,
    },
  ];
  const names = new Set([MANIFEST]);
  let records = 0,
    total = release.manifestBytes;
  for (const [index, shard] of manifest.shards.entries()) {
    if (
      shard.file !== `features-${String(index + 1).padStart(5, "0")}.bin` ||
      !safeName(shard.file) ||
      names.has(shard.file) ||
      !Number.isSafeInteger(shard.bytes) ||
      shard.bytes < 1 ||
      shard.bytes > MAX_FILE_BYTES ||
      !Number.isSafeInteger(shard.count) ||
      shard.count < 1 ||
      !SHA.test(shard.sha256)
    )
      fail(
        "Manifest contains an unsafe, duplicate, out-of-order, or invalid shard.",
      );
    names.add(shard.file);
    total += shard.bytes;
    records += shard.count;
    specs.push({ file: shard.file, bytes: shard.bytes, sha256: shard.sha256 });
  }
  if (total !== release.referenceBytes || records !== release.referenceCount)
    fail(
      "Manifest total bytes or shard record counts disagree with fixed pins.",
    );
  const entries = await readdir(source, { withFileTypes: true });
  if (
    entries.length !== specs.length ||
    entries.some((entry) => !entry.isFile() || !names.has(entry.name))
  )
    fail(
      "Reference source must contain exactly the pinned manifest and shards; extras/symlinks are rejected.",
    );
  for (const spec of specs.slice(1))
    await readChecked(join(source, spec.file), spec);
  return specs.map((spec) => ({
    path: `reference-data/${release.id}/${spec.file}`,
    source: join(source, spec.file),
    bytes: spec.bytes,
    sha256: spec.sha256,
  }));
}
async function buildPlan(build) {
  await inspectPath(build, "directory");
  const files = [];
  for (const entry of await readdir(build, { withFileTypes: true })) {
    if (entry.name === "_headers")
      fail(
        "Input _headers is not accepted; the packager generates reviewed rules.",
      );
    if (!safeName(entry.name)) fail(`Unsafe build entry: ${entry.name}`);
    if (entry.isDirectory() && BUILD_DIRS.has(entry.name)) {
      for (const child of await readdir(join(build, entry.name), {
        withFileTypes: true,
      })) {
        const path = `${entry.name}/${child.name}`;
        if (
          !child.isFile() ||
          !safeName(child.name) ||
          !(
            REQUIRED_SET.has(path) ||
            /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]+\.(js|css|wasm)$/.test(
              path,
            )
          )
        )
          fail(
            `Unapproved build entry (no images, private files, source maps, or hosting config): ${path}`,
          );
        files.push(path);
        if (files.length > MAX_FILES)
          fail("Build exceeds the conservative file-count ceiling.");
      }
    } else if (entry.isFile() && REQUIRED_SET.has(entry.name))
      files.push(entry.name);
    else fail(`Unapproved build entry: ${entry.name}`);
  }
  for (const path of REQUIRED_BUILD_FILES)
    if (!files.includes(path)) fail(`Missing runtime asset/notice: ${path}`);
  if (
    !files.some((file) => /^assets\/index-[\w-]+\.js$/.test(file)) ||
    !files.some((file) => /^assets\/index-[\w-]+\.css$/.test(file))
  )
    fail("Missing Vite index JS/CSS assets.");
  const staticChunks = files.filter((file) =>
    /^assets\/static-database-install-[\w-]+\.js$/.test(file),
  );
  if (staticChunks.length !== 1)
    fail(
      "Expected exactly one static installer chunk; rebuild with VITE_TCG_REFERENCE_MODE=static.",
    );
  const htmlFile = await readChecked(join(build, "index.html"), {
    collect: true,
  });
  if (htmlFile.bytes > 64 * 1024) fail("Unexpectedly large build entry HTML.");
  const html = htmlFile.contents.toString("utf8");
  if (/<base\b/i.test(html))
    fail("HTML base elements are not supported; use the Vite base setting.");
  const scripts = [
    ...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi),
  ];
  const entry =
    scripts.length === 1 &&
    scripts[0][1].match(
      /^(\/(?:[A-Za-z0-9._~-]+\/)*)assets\/(index-[\w-]+\.js)$/,
    );
  if (
    !entry ||
    entry[1].length > 2048 ||
    entry[1].split("/").some((part) => part === "." || part === "..") ||
    !files.includes(`assets/${entry[2]}`)
  )
    fail("Cannot safely infer a same-origin Vite base from index.html.");
  const basePath = entry[1],
    entryScript = `assets/${entry[2]}`;
  const links = [
    ...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi),
  ].map((match) => match[1]);
  if (
    !links.includes(`${basePath}favicon.svg`) ||
    !links.some(
      (link) =>
        link.startsWith(basePath) &&
        /^assets\/index-[\w-]+\.css$/.test(link.slice(basePath.length)),
    ) ||
    links.some(
      (link) =>
        !link.startsWith(basePath) ||
        !files.includes(link.slice(basePath.length)),
    )
  )
    fail(
      "Entry asset URLs do not share the inferred build base or are missing from the build.",
    );
  const entryFile = await readChecked(join(build, entryScript), {
    collect: true,
  });
  if (
    !entryFile.contents
      .toString("utf8")
      .includes(staticChunks[0].slice("assets/".length))
  )
    fail(
      "The entry bundle does not reference its static installer chunk; rebuild in static mode.",
    );
  const packsFile = await readChecked(join(build, "packs/manifest.json"), {
    collect: true,
  });
  const packs = JSON.parse(packsFile.contents.toString("utf8"));
  if (
    packs.version !== 1 ||
    !Array.isArray(packs.packs) ||
    packs.packs.length !== 0 ||
    Object.keys(packs).sort().join(",") !== "packs,version"
  )
    fail("The static build must contain only the empty public packs manifest.");
  const result = [];
  for (const path of files.sort())
    result.push({
      path,
      source: join(build, path),
      ...(await readChecked(join(build, path))),
    });
  // Preserve repository notices and refuse a stale built copy.
  for (const [source, path] of [
    ["THIRD_PARTY_NOTICES.md", "licenses/THIRD_PARTY_NOTICES.md"],
    ["LICENSE", "licenses/tcg-scan.txt"],
  ]) {
    await readChecked(
      join(ROOT, source),
      result.find((file) => file.path === path),
    );
  }
  return {
    files: result,
    basePath,
    entryScript,
    staticInstallerChunk: staticChunks[0],
  };
}
function generated(path, contents) {
  const data = Buffer.from(contents, "utf8");
  return {
    path,
    data,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
/** Only reviewed static response metadata. This cannot configure routing/404s. */
function cloudflareHeaders(files, release, basePath) {
  const immutable = "public, max-age=31536000, immutable";
  const rules = [
    [`${basePath}*`, [["X-Content-Type-Options", "nosniff"]]],
    [basePath, [["Cache-Control", "no-cache"]]],
    [`${basePath}index.html`, [["Cache-Control", "no-cache"]]],
  ];
  for (const { path } of [...files].sort((a, b) =>
    a.path.localeCompare(b.path, "en"),
  )) {
    if (path.startsWith("assets/")) {
      const mime = path.endsWith(".wasm")
        ? "application/wasm"
        : path.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8";
      rules.push([
        `${basePath}${path}`,
        [
          ["Content-Type", mime],
          ["Cache-Control", immutable],
        ],
      ]);
    } else if (path.endsWith(".wasm")) {
      // OCR/vision runtime names are not content-addressed: never mark immutable.
      rules.push([
        `${basePath}${path}`,
        [
          ["Content-Type", "application/wasm"],
          ["Cache-Control", "no-cache"],
        ],
      ]);
    }
  }
  rules.push(
    [
      `${basePath}reference-data/${release.id}/manifest.learned.json`,
      [
        ["Content-Type", "application/json; charset=utf-8"],
        ["Cache-Control", immutable],
      ],
    ],
    [
      `${basePath}reference-data/${release.id}/features-*.bin`,
      [
        ["Content-Type", "application/octet-stream"],
        ["Cache-Control", immutable],
      ],
    ],
  );
  if (rules.length > 100)
    fail(
      "Generated Cloudflare headers exceed 100 header rules; review the build asset count.",
    );
  const text =
    "# Generated by stage-static-reference-data.mjs. Do not edit.\n# Routing is separate: require missing-asset 404s, without an SPA fallback.\n\n" +
    rules
      .map(
        ([path, headers]) =>
          `${path}\n${headers.map(([name, value]) => `  ${name}: ${value}`).join("\n")}\n`,
      )
      .join("\n");
  if (text.split("\n").some((line) => line.length > 2000))
    fail("Generated Cloudflare header line exceeds 2,000 characters.");
  return generated("_headers", text);
}
function summary(files) {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largestFile: files.reduce(
      (largest, file) =>
        !largest || file.bytes > largest.bytes
          ? { path: file.path, bytes: file.bytes }
          : largest,
      null,
    ),
  };
}
function enforceLimits(files) {
  if (
    files.length > MAX_FILES ||
    files.some((file) => file.bytes > MAX_FILE_BYTES)
  )
    fail(
      `Bundle exceeds ${MAX_FILES} files or ${MAX_FILE_BYTES} bytes per file.`,
    );
}
async function createSubdirectories(root, file) {
  let current = root;
  await inspectPath(current, "directory");
  for (const component of file.split("/").slice(0, -1)) {
    if (!safeName(component)) fail("Unsafe destination component.");
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await inspectPath(current, "directory");
  }
}
async function writeGenerated(path, file) {
  await inspectPath(dirname(path), "directory");
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(file.data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function optionsFromArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--verify-only" && !options.verifyOnly)
      options.verifyOnly = true;
    else if (
      ["--source", "--build", "--output"].includes(argument) &&
      !options[argument.slice(2)]
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        fail(`Missing value for ${argument}`);
      options[argument.slice(2)] = resolve(value);
    } else fail(`Unknown or repeated argument: ${argument}`);
  }
  if (!options.source || !options.build || !options.output)
    fail(
      "Usage: node scripts/stage-static-reference-data.mjs --source <reference-pack> --build <static-build> --output <NEW-bundle-directory> [--verify-only]",
    );
  return options;
}
async function main() {
  const options = optionsFromArgs(process.argv.slice(2));
  const { source, build, output } = options;
  for (const input of [source, build, ROOT])
    if (overlaps(input, output) || overlaps(output, input))
      fail(
        "Output must be outside the checkout and disjoint from source/build directories.",
      );
  await inspectPath(dirname(output), "directory");
  if (!safeName(parse(output).base))
    fail("Output basename must use safe ASCII filename characters.");
  await assertAbsent(output);
  const release = await pinnedRelease();
  const { files: buildFiles, ...buildInfo } = await buildPlan(build);
  const files = [...buildFiles, ...(await referencePlan(source, release))];
  const providers = await readChecked(join(ROOT, "docs/providers.md"));
  files.push({
    path: "providers.md",
    source: join(ROOT, "docs/providers.md"),
    ...providers,
  });
  files.push(
    generated(
      "REFERENCE_DATA_NOTICE.md",
      `# Reference data notice\n\nRelease: ${release.id}\nManifest SHA-256: ${release.manifestSha256}\nArchive SHA-256: ${release.sha256}\n\nThis bundle contains numeric learned reference descriptors and catalog metadata from the fixed TCGdex English physical-card snapshot. It contains no raw card artwork, photos, user collections, camera frames, server cache, credentials, or source archives. Metadata includes provider image URLs; browser catalog/image requests remain subject to provider policies.\n\nThe application MIT license does not grant rights to provider data, card artwork, trademarks, or underlying game intellectual property. Preserve providers.md, licenses/, ocr/ notices, and vision-models/ notices. Review provider policies and rights-holder requirements before redistribution. No claim of a separate open-data license is made. Exact printing, finish, and condition remain unconfirmed.\n`,
    ),
  );
  // Include generated headers and both audit files in the total-count ceiling.
  if (files.length + 3 > MAX_FILES)
    fail(
      `Bundle exceeds ${MAX_FILES} files or ${MAX_FILE_BYTES} bytes per file.`,
    );
  files.push(cloudflareHeaders(buildFiles, release, buildInfo.basePath));
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    fail("Duplicate destination path.");
  enforceLimits(files);
  const report = {
    format: "tcg-scan-static-bundle-audit-v1",
    release,
    build: buildInfo,
    hosting: {
      headersFile: "_headers",
      requiredNotFoundHandling: "none",
      routingVerified: false,
    },
    limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES },
    payload: summary(files),
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    notes: [
      "The payload inventory excludes deployment-report.json and SHA256SUMS.",
      "SHA256SUMS covers every payload file plus deployment-report.json; it cannot include its own digest.",
      "Generated _headers controls static response metadata, not routing. Verify missing-asset HTTP 404s after publishing.",
      "Build mode checks identify the static chunk and its entry reference; they do not replace browser QA or attest provider permissions, account access, or deployment.",
    ],
  };
  const reportFile = generated(
    "deployment-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const checksums = generated(
    "SHA256SUMS",
    [...files, reportFile]
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(""),
  );
  files.push(reportFile, checksums);
  enforceLimits(files);
  // All bytes have been verified before reserving a new, private bundle directory.
  // A failed copy leaves only .staging. No site/ tree exists until every check passes.
  if (!options.verifyOnly) {
    await inspectPath(dirname(output), "directory");
    await mkdir(output, { mode: 0o700 }); // Exclusive: never reuse or wipe a directory.
    const staging = join(output, ".staging");
    await mkdir(staging, { mode: 0o700 });
    for (const file of files) {
      await createSubdirectories(staging, file.path);
      const destination = join(staging, file.path);
      if (file.data) await writeGenerated(destination, file);
      else await readChecked(file.source, { ...file, destination }); // Rehash during copy.
      await readChecked(destination, file); // Verify actual output bytes, not only source.
    }
    await inspectPath(output, "directory");
    await assertAbsent(join(output, "site"));
    await rename(staging, join(output, "site"));
  }
  console.log(
    JSON.stringify(
      {
        status: options.verifyOnly
          ? "verified-only-no-files-written"
          : "staged-locally-not-deployed",
        releaseId: release.id,
        build: buildInfo,
        manifestSha256: release.manifestSha256,
        referenceBytes: release.referenceBytes,
        referenceFileCount: release.shardCount + 1,
        ...summary(files),
        limits: report.limits,
        checksumsSha256: checksums.sha256,
        reportSha256: reportFile.sha256,
        siteDirectory: join(output, "site"),
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(`Static bundle refused: ${error.message}`);
  process.exitCode = 1;
});
