/** Fixed, public numeric reference data. No card photographs or credentials. */
export const POKEMON_REFERENCE_RELEASE = {
  id: "pokemon-en-learned-2026-10-12",
  filename: "TCG-Scan-Pokemon-English-Learned-References-2026-10-12.zip",
  // GitHub asset 635091640, verified against its uploaded SHA-256 digest.
  url: "https://github.com/dafepro/tcg-scan/releases/download/reference-data-pokemon-en-2026-10-12/TCG-Scan-Pokemon-English-Learned-References-2026-10-12.zip",
  sizeBytes: 358_031_963,
  referenceBytes: 391_001_940,
  manifestBytes: 8_394_772,
  shardCount: 154,
  sha256: "a57c832645744a7766473c2bda188f83e9cd4fa5f4e0aaf7c894242133fd585f",
  manifestSha256:
    "82efef2f91f2d2338c4634a0284912679f994c835b3eef5d3632bcb9c10f5d19",
  referenceCount: 19_665,
  nameCount: 4_416,
} as const;

export const POKEMON_REFERENCE_API_BASE = "/__tcg_scan/reference/pokemon";

export interface PokemonReferenceDownloadStatus {
  state: "idle" | "downloading" | "paused" | "verifying" | "ready" | "error";
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}
