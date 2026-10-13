import type { DiagnosticFields } from "./diagnostics";
import { sanitizeDiagnosticFields } from "./diagnostics";
import type { PrintingResolution } from "./printing-refinement";
/** Only structured, non-identifying measurements enter the optional Debug panel. */
export function printingDiagnosticFields(
  resolution: PrintingResolution,
): DiagnosticFields {
  const last = resolution.evidence.at(-1),
    regions = last?.regions ?? [],
    region = regions.at(-1);
  return sanitizeDiagnosticFields({
    printingState: resolution.state,
    printingReason:
      resolution.state === "catalog-printing-read"
        ? "catalog-fields-match"
        : (resolution.reasons[0] ?? "unknown"),
    printingObservations: new Set(
      resolution.evidence.map((observation) => observation.frameId),
    ).size,
    printingRegions: regions.length,
    ...(region
      ? {
          printingNativeEdge: region.sourceMinEdge,
          printingRegionWidth: region.width,
          printingRegionHeight: region.height,
          printingHighlightPercent:
            region.metrics.highlightClippedFraction * 100,
          printingEdgeEnergyPercent: region.metrics.sharpness * 100,
        }
      : {}),
  });
}
