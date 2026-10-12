import {
  importLearnedPack,
  LEARNED_MAX_MANIFEST_BYTES,
  LEARNED_MAX_SHARD_BYTES,
  LearnedStorageError,
  type LearnedImportProgress,
  type LearnedPackFile,
  type LearnedPackMetadata,
} from "./learned-packs";

/** Deliberately bounded, ordinary single-disk ZIPs, not ZIP64 or installers. */
export const LEARNED_ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 1536 * 1024 * 1024,
  expandedBytes: 1536 * 1024 * 1024,
  centralDirectoryBytes: 4 * 1024 * 1024,
  entries: 4096,
  entryBytes: LEARNED_MAX_MANIFEST_BYTES,
  compressedEntryBytes: LEARNED_MAX_MANIFEST_BYTES + 65536,
  pathBytes: 512,
});
const MANIFEST = "manifest.learned.json";
const SHARD = /^features-[0-9]{5}\.bin$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
/** A stable, seekable byte source. Implementations must return only the requested
 * [start, end) range and honor cancellation, without buffering the full archive.
 */
export interface LearnedArchiveSource {
  readonly size: number;
  read(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer>;
}
interface ZipEntry {
  path: string;
  nameBytes: Uint8Array;
  directory: boolean;
  version: number;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  expanded: number;
  localOffset: number;
  dataOffset: number;
}
type ImportOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: LearnedImportProgress) => void;
  expectedManifestSha256?: string;
};
function invalid(message: string): never {
  throw new LearnedStorageError(
    "invalid",
    `Invalid learned-pack ZIP: ${message}`,
  );
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new LearnedStorageError(
      "aborted",
      "Learned-pack ZIP import cancelled.",
    );
}
async function readRange(
  file: LearnedArchiveSource,
  start: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  checkSignal(signal);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > file.size
  )
    invalid("entry extends beyond the archive.");
  const buffer = await file.read(start, start + length, signal);
  checkSignal(signal);
  if (buffer.byteLength !== length) invalid("the archive is truncated.");
  return new Uint8Array(buffer);
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function safePath(bytes: Uint8Array, flags: number): string {
  if (!bytes.length || bytes.length > LEARNED_ARCHIVE_LIMITS.pathBytes)
    invalid("filename is empty or too long.");
  if (!(flags & 0x0800) && bytes.some((byte) => byte > 127))
    invalid("non-ASCII filenames must be encoded as UTF-8.");
  let path: string;
  try {
    path = UTF8.decode(bytes);
  } catch {
    return invalid("filename is not valid UTF-8.");
  }
  const segments = path.replace(/\/$/, "").split("/");
  if (
    path.startsWith("/") ||
    /[\\:]/.test(path) ||
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    segments.length > 8 ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part !== part.trim() ||
        part.endsWith(".") ||
        part.length > 255,
    )
  )
    invalid("unsafe filename or directory traversal.");
  return path;
}
function pathKey(path: string): string {
  return path.replace(/\/$/, "").normalize("NFC").toLowerCase();
}
function validateExtra(bytes: Uint8Array): void {
  const data = view(bytes);
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) invalid("malformed ZIP extra field.");
    const id = data.getUint16(offset, true),
      length = data.getUint16(offset + 2, true);
    if (id === 0x0001) invalid("ZIP64 archives are not supported.");
    if (id === 0x0017 || id === 0x9901)
      invalid("encrypted archives are not supported.");
    offset += 4 + length;
    if (offset > bytes.length) invalid("truncated ZIP extra field.");
  }
}
function validateEncoding(
  version: number,
  flags: number,
  method: number,
): void {
  if (flags & 0x2041) invalid("encrypted archives are not supported.");
  if (method !== 0 && method !== 8)
    invalid("only Stored and Deflate compression are supported.");
  // Ordinary deflate tuning bits, data descriptor, and UTF-8 are the only flags
  // supported here. Patched data, masked headers, and reserved flags are unsafe.
  if (version > 20 || flags & ~(method === 8 ? 0x080e : 0x0808))
    invalid("unsupported ZIP version or flags.");
}
async function directoryEntries(
  file: LearnedArchiveSource,
  signal?: AbortSignal,
): Promise<ZipEntry[]> {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 22 ||
    file.size > LEARNED_ARCHIVE_LIMITS.archiveBytes
  )
    invalid("archive must be between 22 bytes and 1.5 GiB.");
  const tailStart = Math.max(0, file.size - (65535 + 22)),
    tail = await readRange(file, tailStart, file.size - tailStart, signal),
    endView = view(tail);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (
      endView.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + endView.getUint16(offset + 20, true) === tail.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalid("missing end record; the ZIP may be truncated.");
  const count = endView.getUint16(end + 10, true),
    directorySize = endView.getUint32(end + 12, true),
    directoryOffset = endView.getUint32(end + 16, true);
  if (
    endView.getUint16(end + 4, true) !== 0 ||
    endView.getUint16(end + 6, true) !== 0 ||
    endView.getUint16(end + 8, true) !== count
  )
    invalid("multidisk archives are not supported.");
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    invalid("ZIP64 archives are not supported.");
  if (!count || count > LEARNED_ARCHIVE_LIMITS.entries)
    invalid("archive must contain between 1 and 4,096 entries.");
  if (
    directorySize > LEARNED_ARCHIVE_LIMITS.centralDirectoryBytes ||
    directorySize < count * 46 ||
    directoryOffset + directorySize !== tailStart + end
  )
    invalid("central directory exceeds its 4 MiB limit or has invalid bounds.");
  const bytes = await readRange(file, directoryOffset, directorySize, signal),
    data = view(bytes),
    entries: ZipEntry[] = [],
    paths = new Map<string, boolean>();
  let offset = 0,
    totalExpanded = 0;
  for (let index = 0; index < count; index++) {
    checkSignal(signal);
    if (
      offset + 46 > bytes.length ||
      data.getUint32(offset, true) !== 0x02014b50
    )
      invalid("malformed central directory entry.");
    const version = data.getUint16(offset + 6, true),
      flags = data.getUint16(offset + 8, true),
      method = data.getUint16(offset + 10, true),
      crc = data.getUint32(offset + 16, true),
      compressed = data.getUint32(offset + 20, true),
      expanded = data.getUint32(offset + 24, true),
      nameLength = data.getUint16(offset + 28, true),
      extraLength = data.getUint16(offset + 30, true),
      commentLength = data.getUint16(offset + 32, true),
      attributes = data.getUint32(offset + 38, true),
      localOffset = data.getUint32(offset + 42, true),
      next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > bytes.length) invalid("truncated central directory entry.");
    validateEncoding(version, flags, method);
    if (data.getUint16(offset + 34, true) !== 0)
      invalid("multidisk entries are not supported.");
    if (
      compressed === 0xffffffff ||
      expanded === 0xffffffff ||
      localOffset === 0xffffffff
    )
      invalid("ZIP64 entries are not supported.");
    if (
      expanded > LEARNED_ARCHIVE_LIMITS.entryBytes ||
      compressed > LEARNED_ARCHIVE_LIMITS.compressedEntryBytes ||
      (method === 0 && compressed !== expanded)
    )
      invalid(
        "entry exceeds its bounded size or has inconsistent Stored sizes.",
      );
    totalExpanded += expanded;
    if (totalExpanded > LEARNED_ARCHIVE_LIMITS.expandedBytes)
      invalid("expanded archive exceeds the 1.5 GiB limit.");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength),
      path = safePath(nameBytes, flags),
      directory = path.endsWith("/"),
      mode = (attributes >>> 16) & 0xf000,
      key = pathKey(path);
    if (
      (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
      (mode === 0x4000 && !directory) ||
      (mode === 0x8000 && directory) ||
      ((attributes & 0x10) !== 0 && !directory)
    )
      invalid(
        "symlinks, special files, or conflicting file types are not allowed.",
      );
    if (directory && (expanded !== 0 || crc !== 0))
      invalid("directory entries cannot contain expanded data.");
    if (paths.has(key)) invalid("duplicate or ambiguous archive path.");
    paths.set(key, directory);
    validateExtra(
      bytes.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      ),
    );
    entries.push({
      path,
      nameBytes,
      directory,
      version,
      flags,
      method,
      crc,
      compressed,
      expanded,
      localOffset,
      dataOffset: 0,
    });
    offset = next;
  }
  if (offset !== bytes.length) invalid("unrecognized central directory data.");
  for (const path of paths.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index++)
      if (paths.get(segments.slice(0, index).join("/")) === false)
        invalid("a file is also used as a directory.");
  }
  // Verify every local header before exposing any lazy payload. Requiring a
  // contiguous layout also rejects hidden entries, overlap, and executable stubs.
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (sorted[0].localOffset !== 0)
    invalid("unexpected data before the first entry.");
  for (let index = 0; index < sorted.length; index++) {
    const entry = sorted[index],
      nextOffset = sorted[index + 1]?.localOffset ?? directoryOffset;
    if (entry.localOffset + 30 > nextOffset)
      invalid("overlapping or truncated local headers.");
    const header = view(await readRange(file, entry.localOffset, 30, signal));
    if (
      header.getUint32(0, true) !== 0x04034b50 ||
      header.getUint16(4, true) !== entry.version ||
      header.getUint16(6, true) !== entry.flags ||
      header.getUint16(8, true) !== entry.method
    )
      invalid("local header and central directory disagree.");
    const nameLength = header.getUint16(26, true),
      extraLength = header.getUint16(28, true);
    entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = entry.dataOffset + entry.compressed;
    if (nameLength !== entry.nameBytes.length || dataEnd > nextOffset)
      invalid("overlapping entry data or invalid local filename.");
    const fields = await readRange(
      file,
      entry.localOffset + 30,
      nameLength + extraLength,
      signal,
    );
    if (entry.nameBytes.some((byte, i) => byte !== fields[i]))
      invalid("local filename and central filename disagree.");
    validateExtra(fields.subarray(nameLength));
    const descriptor = (entry.flags & 8) !== 0;
    for (const [position, expected] of [
      [14, entry.crc],
      [18, entry.compressed],
      [22, entry.expanded],
    ]) {
      const actual = header.getUint32(position, true);
      if (actual !== expected && !(descriptor && actual === 0))
        invalid("local entry checksum or sizes disagree.");
    }
    const gap = nextOffset - dataEnd;
    if (!descriptor) {
      if (gap !== 0) invalid("unexpected bytes between ZIP entries.");
    } else {
      if (gap !== 12 && gap !== 16) invalid("invalid data descriptor bounds.");
      const data = view(await readRange(file, dataEnd, gap, signal)),
        base = gap === 16 ? 4 : 0;
      if (
        (gap === 16 && data.getUint32(0, true) !== 0x08074b50) ||
        data.getUint32(base, true) !== entry.crc ||
        data.getUint32(base + 4, true) !== entry.compressed ||
        data.getUint32(base + 8, true) !== entry.expanded
      )
        invalid("data descriptor and central directory disagree.");
    }
  }
  return entries;
}
function selectedEntries(entries: ZipEntry[]): ZipEntry[] {
  const manifests = entries.filter(
    (entry) => !entry.directory && entry.path.endsWith(".learned.json"),
  );
  if (
    manifests.length !== 1 ||
    manifests[0].path.split("/").at(-1) !== MANIFEST
  )
    invalid("select a ZIP containing exactly one manifest.learned.json pack.");
  const manifest = manifests[0],
    parts = manifest.path.split("/"),
    folders = parts.slice(0, -1);
  if (
    folders.length > 2 ||
    (folders.length === 2 && folders[1] !== "reference-pack")
  )
    invalid(
      "the manifest must be at the root or in reference-pack, optionally inside one enclosing folder.",
    );
  if (folders.length && folders[0] !== "reference-pack") {
    const root = `${folders[0]}/`;
    if (entries.some((entry) => !entry.path.startsWith(root)))
      invalid("the enclosing folder must contain the whole archive.");
  }
  const prefix = folders.length ? `${folders.join("/")}/` : "",
    selected = [manifest];
  for (const entry of entries) {
    if (entry.directory || entry === manifest) continue;
    const basename = entry.path.split("/").at(-1)!;
    if (!SHARD.test(basename)) continue;
    if (entry.path !== prefix + basename)
      invalid("all binary shards must be beside the manifest.");
    if (!entry.expanded || entry.expanded > LEARNED_MAX_SHARD_BYTES)
      invalid(
        `binary shard exceeds its ${LEARNED_MAX_SHARD_BYTES}-byte limit.`,
      );
    selected.push(entry);
  }
  return selected;
}
function decompressor(): DecompressionStream {
  try {
    return new DecompressionStream("deflate-raw");
  } catch {
    throw new LearnedStorageError(
      "unavailable",
      "This browser cannot safely open Deflate ZIPs. Update your browser or extract the ZIP and use Advanced setup to import its manifest and binary shards.",
    );
  }
}
/** Small input chunks bound the native inflater's output between size checks.
 * A 64 KiB read cache avoids thousands of tiny filesystem reads. No full-archive
 * arrayBuffer(), Blob.text(), Response.arrayBuffer(), or inflate fallback exists.
 */
function entryStream(
  file: LearnedArchiveSource,
  entry: ZipEntry,
  signal?: AbortSignal,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0,
    cached = new Uint8Array(0),
    cachedOffset = 0,
    cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        checkSignal(signal);
        if (offset === entry.compressed) {
          controller.close();
          return;
        }
        if (cachedOffset === cached.length) {
          cached = await readRange(
            file,
            entry.dataOffset + offset,
            Math.min(65536, entry.compressed - offset),
            signal,
          );
          cachedOffset = 0;
        }
        if (cancelled) return;
        const length = Math.min(1024, cached.length - cachedOffset);
        controller.enqueue(
          cached.subarray(cachedOffset, cachedOffset + length),
        );
        cachedOffset += length;
        offset += length;
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      cached = new Uint8Array(0);
    },
  });
}
async function extractEntry(
  file: LearnedArchiveSource,
  entry: ZipEntry,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  checkSignal(signal);
  const source = entryStream(file, entry, signal),
    stream = entry.method === 8 ? source.pipeThrough(decompressor()) : source,
    reader = stream.getReader(),
    output = new Uint8Array(entry.expanded);
  let offset = 0,
    crc = 0xffffffff;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkSignal(signal);
    while (true) {
      const { value, done } = await reader.read();
      checkSignal(signal);
      if (done) break;
      if (value.byteLength > output.length - offset)
        invalid(`expanded data exceeds the declared size: ${entry.path}.`);
      output.set(value, offset);
      offset += value.byteLength;
      for (const byte of value)
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
    }
    if (offset !== entry.expanded)
      invalid(`expanded size does not match the entry: ${entry.path}.`);
    if ((crc ^ 0xffffffff) >>> 0 !== entry.crc)
      throw new LearnedStorageError(
        "corrupt",
        `ZIP CRC32 checksum failed: ${entry.path}. Nothing from this import is ready.`,
      );
    return output.buffer;
  } catch (error) {
    await reader.cancel().catch(() => {});
    checkSignal(signal);
    if (error instanceof LearnedStorageError) throw error;
    throw new LearnedStorageError(
      "corrupt",
      `ZIP decompression failed: ${entry.path}. The archive may be damaged.`,
    );
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
/** Import one user-selected ZIP without unpacking it in memory or on disk.
 * ZIP structure and extracted-entry CRC32 are checked here; the existing pack
 * importer retains manifest/SHA-256 validation, quota checks, atomic readiness,
 * duplicate handling, cancellation, and token-scoped rollback.
 * Format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * Inflater: https://compression.spec.whatwg.org/
 */
export async function importLearnedArchive(
  file: File,
  options: ImportOptions = {},
): Promise<LearnedPackMetadata> {
  return importLearnedArchiveSource(
    {
      size: file.size,
      read: (start, end) => file.slice(start, end).arrayBuffer(),
    },
    options,
  );
}
/** Same bounded parser for an independently authorized stable byte-range source.
 * This adapter does not fetch, choose a URL, or grant network access itself.
 */
export async function importLearnedArchiveSource(
  file: LearnedArchiveSource,
  options: ImportOptions = {},
): Promise<LearnedPackMetadata> {
  checkSignal(options.signal);
  options.onProgress?.({
    phase: "validating",
    completed: 0,
    total: 0,
    text: "Checking the ZIP directory without unpacking the archive…",
  });
  const entries = selectedEntries(await directoryEntries(file, options.signal));
  // Check compatibility before the storage importer can reserve a pack.
  if (entries.some((entry) => entry.method === 8)) decompressor();
  let active = false;
  const files: LearnedPackFile[] = entries.map((entry) => ({
    name: entry.path.split("/").at(-1)!,
    size: entry.expanded,
    async arrayBuffer() {
      if (active) invalid("only one archive entry may be read at a time.");
      active = true;
      try {
        return await extractEntry(file, entry, options.signal);
      } finally {
        active = false;
      }
    },
  }));
  return importLearnedPack(files, options);
}
