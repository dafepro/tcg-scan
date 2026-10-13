/** Deterministic UI wiring fixtures only. They do not measure physical-card accuracy. */
export interface GuidedFixtureState {
  ocrReads: number;
  guidanceAnnouncements: string[];
  ocrReplies: (() => void)[];
  terminated: number;
  holdOCR: boolean;
  ocrText: string;
  release(): void;
}
export type GuidedFixtureWindow = Window & {
  guidedQA: GuidedFixtureState;
  makeGuidedCrop(sequence: number): ImageData;
};
export interface GuidedSavedRow {
  quantity: number;
  verification: string;
  condition: string;
  finish: string;
  scanEventId: string;
  printingRead?: unknown;
}
