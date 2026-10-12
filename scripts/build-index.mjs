#!/usr/bin/env -S node --import tsx
/** Reproducible, resumable feature-only catalog builder. No image is copied to output. */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { once } from "node:events";
import { parseArgs } from "node:util";
import sharp from "sharp";
import cvModule from "@techstark/opencv-js";
import { extractReferenceFeatures } from "../src/lib/vision/features.ts";
import {
  validateFeaturePack,
  validateReferenceMetadata,
} from "../src/lib/reference-packs.ts";

const HELP = `Build local, feature-only card reference packs (no raw images in output).

node --import tsx scripts/build-index.mjs --game pokemon --sets base1,basep --out /tmp/pokemon-validation
node --import tsx scripts/build-index.mjs --game pokemon --all --out /path/to/private-packs
node --import tsx scripts/build-index.mjs --game mtg --all --out /path/to/private-packs
node --import tsx scripts/build-index.mjs --game yugioh --all --out /path/to/private-packs
node --import tsx scripts/build-index.mjs --fixture /path/manifest.json --out /tmp/fixture-packs

Options:
  --cache DIR          Durable private cache; default OS temp/tcg-scan-reference-cache
  --out DIR            Required output folder; never raw images
  --game GAME          pokemon | mtg | yugioh
  --sets IDS           Pokemon or MTG set IDs, comma-separated; explicit selection
  --all                Explicit full catalog request (provider scope, not all historical cards)
  --fixture FILE       Local manifest {name,cards:[{key,game,name,imagePath,...metadata}]}
  --concurrency N      1–4 concurrent downloads (default 2)
  --delay-ms N         Minimum 200 ms between requests globally (default 350)
  --shard-size N       1–1000 references per file (default 500)
  --limit N            Explicit test subset, labelled partial in coverage
  --refresh-catalog    Refresh provider metadata; images remain download-once cached
  --offline            Use cached metadata and images only; never fetch
  --help               Print this help

Ctrl-C safely cancels; run the exact command again to resume downloaded images/features.
Publishing derivative indexes requires a separate rights review. See docs/reference-packs.md.
`;
const { values: args } = parseArgs({
  options: {
    game: { type: "string" },
    sets: { type: "string" },
    all: { type: "boolean" },
    fixture: { type: "string" },
    out: { type: "string" },
    cache: { type: "string" },
    concurrency: { type: "string", default: "2" },
    "delay-ms": { type: "string", default: "350" },
    "shard-size": { type: "string", default: "500" },
    limit: { type: "string" },
    "refresh-catalog": { type: "boolean" },
    offline: { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (
  !args.out ||
  (!args.fixture && !["pokemon", "mtg", "yugioh"].includes(args.game)) ||
  (!args.fixture && !args.all && !args.sets)
)
  throw new Error(HELP);
if ((args.all && args.sets) || (args.fixture && (args.all || args.sets)))
  throw new Error("Choose exactly one scope: --all, --sets, or --fixture.");
if (args.game === "yugioh" && args.sets)
  throw new Error(
    "YGO set-specific image attribution is ambiguous. Use --all, then resolve printings separately.",
  );
function boundedNumber(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${name} must be ${min}–${max}.`);
  return n;
}
const concurrency = boundedNumber(args.concurrency, 1, 4, "concurrency"),
  delayMs = boundedNumber(args["delay-ms"], 200, 60000, "delay-ms"),
  shardSize = boundedNumber(args["shard-size"], 1, 1000, "shard-size"),
  limit = args.limit
    ? boundedNumber(args.limit, 1, 1000000, "limit")
    : Infinity;
const output = resolve(args.out),
  cache = resolve(args.cache ?? join(tmpdir(), "tcg-scan-reference-cache"));
if (
  output === cache ||
  output.startsWith(cache + "/") ||
  cache.startsWith(output + "/")
)
  throw new Error(
    "Keep output and private image cache in separate directories.",
  );
const selection =
  args.sets
    ?.split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .sort() ?? [];
if (selection.some((id) => !/^[a-zA-Z0-9_-]{1,50}$/.test(id)))
  throw new Error("Invalid set ID.");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    console.error(
      "Cancelling; completed downloads and extraction checkpoints are preserved.",
    );
    controller.abort();
  });
function checkCancelled() {
  controller.signal.throwIfAborted();
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, value);
  await rename(temp, path);
}
async function jsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function delay(ms) {
  return new Promise((resolve, reject) => {
    checkCancelled();
    const timer = setTimeout(done, ms);
    function done() {
      controller.signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(controller.signal.reason);
    }
    controller.signal.addEventListener("abort", abort, { once: true });
  });
}
let requestQueue = Promise.resolve(),
  nextRequest = 0;
async function throttle() {
  const next = requestQueue.then(async () => {
    await delay(Math.max(0, nextRequest - Date.now()));
    nextRequest = Date.now() + delayMs;
  });
  requestQueue = next.catch(() => {});
  await next;
}
const ALLOWED = new Set([
  "api.tcgdex.net",
  "assets.tcgdex.net",
  "api.scryfall.com",
  "data.scryfall.io",
  "cards.scryfall.io",
  "db.ygoprodeck.com",
  "images.ygoprodeck.com",
]);
function safeRemote(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED.has(url.hostname)
  )
    throw new Error(`Refused non-allowlisted HTTPS URL: ${url.hostname}`);
  return url.href;
}
function retryDelay(response, attempt) {
  const raw = response?.headers.get("retry-after");
  const seconds = Number(raw);
  const server = raw
    ? Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(raw) - Date.now()
    : 0;
  return Math.min(120000, Math.max(server || 0, 1000 * 2 ** attempt));
}
async function download(
  raw,
  {
    refresh = false,
    image = false,
    maxBytes = image ? 12 * 1024 * 1024 : 1024 * 1024 * 1024,
  } = {},
) {
  const url = safeRemote(raw),
    pointer = join(cache, "urls", `${digest(url)}.json`);
  const cached = await jsonFile(pointer);
  if (cached && (!refresh || args.offline)) {
    const path = join(cache, "objects", cached.sha256);
    try {
      const info = await stat(path);
      if (
        info.size === cached.bytes &&
        (await hashFile(path)) === cached.sha256
      )
        return { ...cached, path };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    console.error(`Cache verification failed; retrying ${url}`);
  }
  if (args.offline) throw new Error(`Offline cache miss: ${url}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    checkCancelled();
    await throttle();
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60000),
        ]),
        redirect: "error",
        headers: {
          "User-Agent":
            "tcg-scan-local-reference-builder/0.1 (private offline feature extraction)",
          Accept: image
            ? "image/webp,image/png,image/jpeg"
            : "application/json,application/x-ndjson,application/gzip,*/*;q=0.1",
        },
      });
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 4) {
        await response.body?.cancel();
        await delay(retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      if (Number(response.headers.get("content-length")) > maxBytes)
        throw new Error(`Download exceeds limit: ${url}`);
      const contentType =
        response.headers.get("content-type")?.split(";")[0] ?? "";
      if (
        image &&
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "application/octet-stream",
        ].includes(contentType)
      )
        throw new Error(`Unexpected image type ${contentType}: ${url}`);
      if (!response.body) throw new Error(`Empty response: ${url}`);
      await mkdir(join(cache, "downloads"), { recursive: true });
      const temporary = join(
        cache,
        "downloads",
        `${digest(url)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const stream = createWriteStream(temporary);
      const hash = createHash("sha256");
      let bytes = 0;
      // Install an error listener immediately, before the first asynchronous write.
      let streamError;
      stream.on("error", (error) => {
        streamError = error;
      });
      try {
        for await (const chunk of response.body) {
          checkCancelled();
          if (streamError) throw streamError;
          bytes += chunk.length;
          if (bytes > maxBytes)
            throw new Error(`Download exceeds limit: ${url}`);
          hash.update(chunk);
          if (!stream.write(chunk)) await once(stream, "drain");
        }
        stream.end();
        await once(stream, "finish");
      } catch (error) {
        stream.destroy();
        await unlink(temporary).catch(() => {});
        throw error;
      }
      const sha256 = hash.digest("hex"),
        path = join(cache, "objects", sha256);
      await mkdir(dirname(path), { recursive: true });
      await rename(temporary, path);
      const record = {
        sha256,
        bytes,
        contentType,
        downloadedAt: new Date().toISOString(),
      };
      await atomic(pointer, JSON.stringify(record));
      return { ...record, path };
    } catch (error) {
      checkCancelled();
      if (
        attempt === 4 ||
        /HTTP (400|401|403|404)|limit|Unexpected|redirect/i.test(error.message)
      )
        throw error;
      await delay(retryDelay(response, attempt));
    }
  }
  throw new Error("Download retry limit reached.");
}
async function downloadReference(record) {
  const original = record.downloadUrl;
  const high =
    record.game === "pokemon" &&
    /^https:\/\/assets\.tcgdex\.net\/.*\/low\.webp$/.test(original)
      ? original.replace(/\/low\.webp$/, "/high.webp")
      : undefined;
  const overridePath = join(
    cache,
    "reference-sources",
    `${digest(original)}.json`,
  );
  const override = high ? await jsonFile(overridePath) : undefined;
  if (override?.url === high)
    return {
      ...(await download(high, { image: true })),
      referenceImageUrl: high,
    };
  try {
    return {
      ...(await download(original, { image: true })),
      referenceImageUrl: original,
    };
  } catch (error) {
    // Some TCGdex records have a valid documented high asset but no low asset.
    // Never substitute another card, arbitrary host, or silently ignore failure.
    if (!high || !/^HTTP 404:/.test(error.message) || args.offline) throw error;
    try {
      const image = await download(high, { image: true });
      await atomic(
        overridePath,
        JSON.stringify({ url: high, discoveredAt: new Date().toISOString() }),
      );
      console.log(`${record.key}: using available high.webp fallback.`);
      return { ...image, referenceImageUrl: high };
    } catch (fallbackError) {
      throw new Error(
        `${error.message}; high.webp fallback failed: ${fallbackError.message}`,
      );
    }
  }
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function fetchJson(url) {
  const cached = await download(url, {
    refresh: args["refresh-catalog"],
    maxBytes: 100 * 1024 * 1024,
  });
  return JSON.parse(await readFile(cached.path, "utf8"));
}
async function pokemonCatalog() {
  const pocket = await fetchJson("https://api.tcgdex.net/v2/en/series/tcgp");
  if (!Array.isArray(pocket.sets))
    throw new Error("Cannot establish Pokémon Pocket exclusion set IDs.");
  const excluded = new Set(pocket.sets.map((set) => set.id));
  if (selection.some((id) => excluded.has(id)))
    throw new Error(
      "Pokémon TCG Pocket is excluded from physical-card reference packs.",
    );
  let records, sets;
  if (selection.length) {
    sets = [];
    for (const id of selection) {
      const set = await fetchJson(
        `https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(id)}`,
      );
      if (!Array.isArray(set.cards))
        throw new Error(`Invalid TCGdex set ${id}`);
      sets.push(set);
    }
    records = sets.flatMap((set) =>
      set.cards.map((card) => ({ ...card, setId: set.id })),
    );
  } else {
    [records, sets] = await Promise.all([
      fetchJson("https://api.tcgdex.net/v2/en/cards"),
      fetchJson("https://api.tcgdex.net/v2/en/sets"),
    ]);
  }
  if (!Array.isArray(records) || !Array.isArray(sets))
    throw new Error("Invalid TCGdex catalog.");
  const names = new Map(sets.map((set) => [set.id, set.name]));
  const setIds = [...names.keys()].sort((a, b) => b.length - a.length);
  const cards = [];
  let excludedCards = 0,
    missingImages = 0,
    catalogCards = 0;
  for (const row of records) {
    const setId = row.setId ?? setIds.find((id) => row.id.startsWith(`${id}-`));
    if (!setId) throw new Error(`Unresolved TCGdex set: ${row.id}`);
    if (excluded.has(setId)) {
      excludedCards++;
      continue;
    }
    catalogCards++;
    if (!row.image) {
      missingImages++;
      continue;
    }
    const image = `${row.image.replace(/\/$/, "")}/low.webp`;
    safeRemote(image);
    cards.push({
      key: `pokemon:${row.id}`,
      game: "pokemon",
      name: row.name,
      identityKey: `pokemon:${row.name.toLowerCase()}`,
      setName: names.get(setId),
      number: row.localId,
      imageUrl: image,
      sourceUrl: `https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(row.id)}`,
      downloadUrl: image,
    });
  }
  return {
    cards,
    coverage: {
      scope: selection.length ? "selected-sets" : "full-catalog",
      game: "pokemon",
      sets: selection,
      catalogCards,
      availableImages: cards.length,
      missingImages,
      excludedCards,
      provider: "TCGdex English physical-card catalog",
      note: "TCGdex's metadata snapshot; Pokémon TCG Pocket sets excluded. Language English. Catalog rows without images cannot be recognized. Finish and visually identical printings are not resolved.",
    },
  };
}
async function* bulkRows(path, format) {
  const handle = await open(path, "r");
  const header = Buffer.alloc(2);
  try {
    await handle.read(header, 0, 2, 0);
  } finally {
    await handle.close();
  }
  let stream = createReadStream(path);
  if (header[0] === 0x1f && header[1] === 0x8b)
    stream = stream.pipe(createGunzip());
  if (format === "jsonl") {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      checkCancelled();
      if (line.trim()) yield JSON.parse(line);
    }
  } else {
    // Legacy Scryfall bulk files are JSON arrays with one object per line.
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      checkCancelled();
      const cleaned = line.trim().replace(/,$/, "");
      if (!cleaned || cleaned === "[" || cleaned === "]") continue;
      if (!cleaned.startsWith("{"))
        throw new Error(
          "Unsupported legacy Scryfall bulk serialization. Use current JSONL bulk.",
        );
      yield JSON.parse(cleaned);
    }
  }
}
async function mtgCatalog() {
  const list = await fetchJson("https://api.scryfall.com/bulk-data");
  const bulk = list.data?.find((item) => item.type === "default_cards");
  if (!bulk) throw new Error("Scryfall default_cards bulk is unavailable.");
  const uri = bulk.jsonl_download_uri ?? bulk.download_uri;
  if (!uri)
    throw new Error(
      "Scryfall bulk has neither jsonl_download_uri nor download_uri.",
    );
  const file = await download(uri);
  let cards = [];
  let catalogCards = 0,
    missingImages = 0,
    excludedCards = 0;
  for await (const row of bulkRows(
    file.path,
    bulk.jsonl_download_uri ? "jsonl" : "json",
  )) {
    if (
      !row.games?.includes("paper") ||
      row.lang !== "en" ||
      (selection.length && !selection.includes(row.set))
    ) {
      excludedCards++;
      continue;
    }
    catalogCards++;
    const faces = row.image_uris
      ? [{ ...row, faceIndex: undefined }]
      : (row.card_faces ?? []).map((face, faceIndex) => ({
          ...face,
          faceIndex,
        }));
    let faceImages = 0;
    for (const face of faces) {
      const image = face.image_uris?.normal ?? face.image_uris?.large;
      if (!image) continue;
      safeRemote(image);
      faceImages++;
      cards.push({
        key: `mtg:${row.id}${face.faceIndex === undefined ? "" : `:face${face.faceIndex}`}`,
        game: "mtg",
        name: face.name ?? row.name,
        identityKey: `mtg:${row.oracle_id ?? row.id}`,
        artworkKey: face.illustration_id
          ? `mtg:${face.illustration_id}`
          : undefined,
        setName: row.set_name,
        number: String(row.collector_number),
        imageUrl: image,
        sourceUrl:
          row.scryfall_uri ?? `https://api.scryfall.com/cards/${row.id}`,
        downloadUrl: image,
      });
    }
    if (!faceImages) missingImages++;
  }
  let duplicateImages = 0;
  if (!selection.length) {
    const illustrations = new Map();
    for (const card of cards) {
      // Never merge different oracle identities just because they reuse an image.
      // Missing explicit art IDs stay distinct rather than inferring equivalence.
      const group = card.artworkKey
        ? `${card.identityKey}|${card.artworkKey}`
        : card.key;
      const previous = illustrations.get(group);
      if (!previous || card.key < previous.key) illustrations.set(group, card);
    }
    duplicateImages = cards.length - illustrations.size;
    cards = [...illustrations.values()];
    if (cards.length > 60_000)
      throw new Error(
        `MTG identity/art index now has ${cards.length} references, beyond the live engine's 60,000 capacity. Select sets or increase the index capacity before full-game installation.`,
      );
  }
  return {
    cards,
    coverage: {
      scope: selection.length ? "selected-sets" : "full-catalog",
      game: "mtg",
      sets: selection,
      catalogCards,
      availableImages: cards.length,
      missingImages,
      excludedCards,
      duplicateImages,
      provider: "Scryfall English paper default_cards bulk",
      note: selection.length
        ? "Selected-set English paper printings and available card faces. Shared illustration_id values preserve artwork-to-printing ambiguity; image recognition alone cannot guarantee edition or finish."
        : "English paper identity/artwork index, deduplicated only by explicit illustration_id plus oracle_id. Each artwork uses one representative printing; set/number/source metadata are representative, never a printing claim. Different identities sharing art remain separate candidates. Missing illustration IDs stay distinct. Other frames, language, finish and exact printing require review. duplicateImages counts omitted image-bearing printing/face rows, not missing art.",
    },
  };
}
async function yugiohCatalog() {
  const result = await fetchJson(
    "https://db.ygoprodeck.com/api/v7/cardinfo.php?format=tcg",
  );
  if (!Array.isArray(result.data))
    throw new Error("Invalid YGOPRODeck card catalog.");
  const cards = [];
  let missingImages = 0;
  for (const row of result.data) {
    if (!row.card_images?.length) {
      missingImages++;
      continue;
    }
    for (const image of row.card_images) {
      safeRemote(image.image_url);
      // Do not emit a remote image URL: the browser must never hotlink YGO artwork.
      cards.push({
        key: `yugioh:${row.id}:art${image.id}`,
        game: "yugioh",
        name: row.name,
        identityKey: `yugioh:${row.id}`,
        artworkKey: `yugioh:art${image.id}`,
        number: String(row.id),
        sourceUrl: row.ygoprodeck_url,
        downloadUrl: image.image_url,
      });
    }
  }
  return {
    cards,
    coverage: {
      scope: "full-catalog",
      game: "yugioh",
      catalogCards: result.data.length,
      availableImages: cards.length,
      missingImages,
      provider: "YGOPRODeck English TCG card/artwork catalog",
      note: "format=tcg provider scope; excludes Rush/Speed Duel-only cards. English artwork IDs identify art, not individual set printings. Images are downloaded once into a private content-addressed cache and never browser-hotlinked.",
    },
  };
}
async function fixtureCatalog() {
  const path = resolve(args.fixture),
    manifest = JSON.parse(await readFile(path, "utf8"));
  const rows = manifest.cards ?? manifest.reference_index;
  if (!Array.isArray(rows) || !rows.length)
    throw new Error("Fixture manifest must contain cards or reference_index.");
  const cards = rows.map((row) => {
    const { imagePath, image, id, printing_group, ...metadata } = row;
    const relative = imagePath ?? image;
    if (typeof relative !== "string" || !relative || relative.includes("://"))
      throw new Error("Fixture images must be local files.");
    const filename = isAbsolute(relative)
      ? relative
      : resolve(dirname(path), relative);
    const card = validateReferenceMetadata({
      key: metadata.key ?? `pokemon:${id}`,
      game: metadata.game ?? args.game ?? "pokemon",
      name: metadata.name ?? `Synthetic ${id}`,
      identityKey: printing_group ? `fixture:${printing_group}` : undefined,
      artworkKey: printing_group ? `fixture:${printing_group}` : undefined,
      ...metadata,
    });
    return { ...card, imagePath: filename };
  });
  return {
    cards,
    name: manifest.name ?? "Synthetic mechanics fixtures",
    coverage: {
      scope: "fixture",
      catalogCards: cards.length,
      availableImages: cards.length,
      missingImages: 0,
      provider: "Local synthetic fixtures",
      note:
        manifest.notice ??
        "Synthetic fixtures validate mechanics only, not commercial card accuracy or real camera performance.",
    },
  };
}
async function main() {
  await mkdir(cache, { recursive: true });
  await mkdir(output, { recursive: true });
  const scopeId = digest(
    JSON.stringify({
      game: args.game,
      sets: selection,
      fixture: args.fixture ? resolve(args.fixture) : undefined,
      ...(args.game === "mtg" && !selection.length
        ? { catalogVersion: "mtg-identity-art-v2" }
        : {}),
    }),
  );
  const snapshotPath = join(cache, "catalogs", `${scopeId}.json`);
  let catalog =
    !args.fixture && !args["refresh-catalog"]
      ? await jsonFile(snapshotPath)
      : undefined;
  if (!catalog) {
    console.log(
      `Enumerating ${args.fixture ? "local fixtures" : args.game} catalog…`,
    );
    catalog = args.fixture
      ? await fixtureCatalog()
      : args.game === "pokemon"
        ? await pokemonCatalog()
        : args.game === "mtg"
          ? await mtgCatalog()
          : await yugiohCatalog();
    catalog.coverage.catalogRetrievedAt = args.fixture
      ? new Date((await stat(resolve(args.fixture))).mtimeMs).toISOString()
      : new Date().toISOString();
    catalog.cards.sort((a, b) => a.key.localeCompare(b.key));
    if (
      new Set(catalog.cards.map((card) => card.key)).size !==
      catalog.cards.length
    )
      throw new Error("Provider returned duplicate reference keys.");
    await atomic(snapshotPath, JSON.stringify(catalog));
  }
  const selected = catalog.cards.slice(0, limit);
  if (!selected.length)
    throw new Error("The selected catalog has no usable images.");
  console.log(
    `${catalog.coverage.catalogCards} catalog cards, ${catalog.cards.length} image references, ${catalog.coverage.missingImages} missing images; extracting ${selected.length}.`,
  );
  const cv = await cvModule;
  if (!cv?.ORB || !cv?.Mat)
    throw new Error("OpenCV ORB runtime is unavailable.");
  const results = new Array(selected.length),
    failures = [];
  let cursor = 0,
    completed = 0;
  async function worker() {
    while (cursor < selected.length) {
      checkCancelled();
      const index = cursor++,
        record = selected[index];
      try {
        const image = record.imagePath
          ? { path: record.imagePath, sha256: await hashFile(record.imagePath) }
          : await downloadReference(record);
        const checkpoint = join(
          cache,
          "features",
          `${digest(`${record.key}|${image.sha256}|orb-phash-v1|96`)}.json`,
        );
        let feature = await jsonFile(checkpoint);
        if (!feature) {
          const { data, info } = await sharp(image.path, {
            limitInputPixels: 36_000_000,
            animated: false,
          })
            .rotate()
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          const rgba = {
            data: new Uint8ClampedArray(data),
            width: info.width,
            height: info.height,
          };
          feature = extractReferenceFeatures(cv, rgba, record.key, 96);
          if (feature.points.length < 40)
            throw new Error("Too few reference features.");
          await atomic(checkpoint, JSON.stringify(feature));
        }
        const { downloadUrl, imagePath, ...metadata } = record;
        void downloadUrl;
        void imagePath;
        if (metadata.imageUrl && image.referenceImageUrl)
          metadata.imageUrl = image.referenceImageUrl;
        const card = validateReferenceMetadata(metadata);
        validateFeaturePack({
          version: 1,
          algorithm: "orb-phash-v1",
          width: 240,
          height: 336,
          name: "checkpoint",
          cards: [card],
          features: [feature],
        });
        results[index] = { card, feature };
      } catch (error) {
        checkCancelled();
        failures.push({ key: record.key, error: error.message });
        console.error(`${record.key}: ${error.message}`);
      }
      completed++;
      if (completed % 25 === 0 || completed === selected.length)
        console.log(
          `${completed}/${selected.length} processed (${failures.length} failed).`,
        );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  checkCancelled();
  const good = results.filter(Boolean),
    shardCount = Math.ceil(good.length / shardSize),
    packs = [];
  if (!good.length)
    throw new Error(
      "No usable reference features were extracted; no manifest was published.",
    );
  const gameLabel = args.fixture ? "fixture" : args.game;
  const selectionLabel = selection.length ? selection.join("-") : "all";
  const baseName =
    catalog.name ??
    `${args.game} ${selection.length ? selection.join(", ") : "catalog"}`;
  const name =
    baseName +
    (limit < catalog.cards.length
      ? ` · subset ${selected.length}/${catalog.cards.length}`
      : "");
  for (let index = 0; index < shardCount; index++) {
    const rows = good.slice(index * shardSize, (index + 1) * shardSize);
    const coverage = {
      ...catalog.coverage,
      extractedImages: rows.length,
      failedImages: failures.length,
      shard: { index: index + 1, total: shardCount },
    };
    if (limit < catalog.cards.length) {
      coverage.scope = "custom";
      coverage.note += ` Explicit --limit=${limit} test subset; this is not full catalog coverage.`;
    }
    const pack = validateFeaturePack({
      version: 1,
      algorithm: "orb-phash-v1",
      width: 240,
      height: 336,
      name: `${name}${shardCount > 1 ? ` (${index + 1}/${shardCount})` : ""}`,
      source: coverage.provider,
      createdAt: catalog.coverage.catalogRetrievedAt,
      cards: rows.map((row) => row.card),
      features: rows.map((row) => row.feature),
      coverage,
    });
    const bytes = Buffer.from(JSON.stringify(pack)),
      sha256 = digest(bytes),
      filename = `${gameLabel}-${selectionLabel}-${String(index + 1).padStart(3, "0")}-${sha256.slice(0, 12)}.json`;
    await atomic(join(output, filename), bytes);
    await atomic(
      join(output, `${filename}.sha256`),
      `${sha256}  ${filename}\n`,
    );
    packs.push({
      id: `${gameLabel}-${selectionLabel}-${index + 1}-${sha256.slice(0, 12)}`,
      name: pack.name,
      file: `/packs/${filename}`,
      sha256,
      bytes: bytes.length,
      cards: rows.length,
      game: args.fixture ? undefined : args.game,
      coverage,
    });
  }
  const manifest = { version: 1, packs };
  await atomic(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await atomic(
    join(output, "build-report.json"),
    JSON.stringify(
      {
        algorithm: "orb-phash-v1",
        featuresPerReference: 96,
        catalog: catalog.coverage,
        selectedImages: selected.length,
        extractedImages: good.length,
        failures: failures.sort((a, b) => a.key.localeCompare(b.key)),
        completeSelectedScope:
          failures.length === 0 && limit >= catalog.cards.length,
        manifests: packs.map((pack) => ({
          file: pack.file,
          sha256: pack.sha256,
          bytes: pack.bytes,
          cards: pack.cards,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Wrote ${good.length} references in ${packs.length} shard(s) to ${output}. Raw images remain only in the private cache.`,
  );
  if (failures.length) {
    console.error(
      `Incomplete: ${failures.length} references failed. Resume this command to retry; inspect build-report.json.`,
    );
    process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error(
    controller.signal.aborted
      ? "Build cancelled safely. Resume with the same command."
      : (error.stack ?? error.message),
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
});
