import type { Browser, Page, TestInfo } from "@playwright/test";

/** Test-only, metadata-only diagnostics. Extra native clock reads and bounded
 * bookkeeping can perturb scheduling or hide a precision race. A passing run
 * with this observer is not evidence that the production issue was fixed. */
export async function installNativeFrameDiagnostics(page: Page) {
  await page.addInitScript(() => {
    type NumberRecord = number | string | null;
    type EventRecord = Record<string, NumberRecord>;
    const frameLimit = 256;
    const clockLimit = 1024;
    const frames: EventRecord[] = [];
    const clocks: EventRecord[] = [];
    let frameCount = 0;
    let clockCount = 0;
    let sequence = 0;
    let requestCount = 0;
    let activeRequest: number | null = null;
    let latestRequest: number | null = null;
    let latestNative: {
      callbackAt: number;
      presentationTime: number;
    } | null = null;
    const anomalousCallsites: {
      sequence: number;
      bundleOffsets: { line: number; column: number }[];
    }[] = [];
    let clockWrapped = false;
    let callbackWrapped = false;
    const numberRecord = (value: unknown): NumberRecord =>
      typeof value === "number"
        ? Number.isFinite(value)
          ? value
          : String(value)
        : null;
    const chronological = (
      ring: EventRecord[],
      count: number,
      limit: number,
    ) =>
      count <= limit
        ? ring.slice()
        : ring.slice(count % limit).concat(ring.slice(0, count % limit));

    // Save the original before wrapping. Diagnostic reads use the original;
    // production calls return exactly the native value, with unchanged args.
    const originalNow = performance.now;
    const readNativeNow = () =>
      Reflect.apply(originalNow, performance, []) as number;
    let clockOwner: object | null = performance;
    while (clockOwner && !Object.hasOwn(clockOwner, "now"))
      clockOwner = Object.getPrototypeOf(clockOwner) as object | null;
    const clockDescriptor = clockOwner
      ? Object.getOwnPropertyDescriptor(clockOwner, "now")
      : undefined;
    if (clockOwner && typeof clockDescriptor?.value === "function") {
      try {
        Object.defineProperty(clockOwner, "now", {
          ...clockDescriptor,
          value: function (this: Performance, ...args: unknown[]) {
            const value = Reflect.apply(originalNow, this, args) as number;
            try {
              const eventSequence = ++sequence;
              clocks[clockCount++ % clockLimit] = {
                sequence: eventSequence,
                type: "performance-now",
                value: numberRecord(value),
                activeRequest,
                latestRequest,
                nowMinusCallbackMs: latestNative
                  ? numberRecord(value - latestNative.callbackAt)
                  : null,
                nowMinusPresentationMs: latestNative
                  ? numberRecord(value - latestNative.presentationTime)
                  : null,
              };
              if (
                latestNative &&
                anomalousCallsites.length < 8 &&
                (value < latestNative.callbackAt ||
                  value < latestNative.presentationTime)
              ) {
                // Rare anomaly only: retain public app-bundle line/column
                // offsets, never the raw stack, URLs or source filenames.
                const stack = new Error().stack ?? "";
                const bundleOffsets = [
                  ...stack.matchAll(
                    /\/assets\/index-[^/?#\s)]+\.js:(\d+):(\d+)/g,
                  ),
                ]
                  .slice(0, 6)
                  .map((match) => ({
                    line: Number(match[1]),
                    column: Number(match[2]),
                  }));
                anomalousCallsites.push({
                  sequence: eventSequence,
                  bundleOffsets,
                });
              }
            } catch {
              // Observability must not change the original call's outcome.
            }
            return value;
          },
        });
        clockWrapped = true;
      } catch {
        // Do not alter browser flags or force replacement of a locked method.
      }
    }

    const prototype = HTMLVideoElement.prototype;
    const callbackDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "requestVideoFrameCallback",
    );
    const originalRequest = callbackDescriptor?.value as
      HTMLVideoElement["requestVideoFrameCallback"] | undefined;
    if (typeof originalRequest === "function") {
      try {
        Object.defineProperty(prototype, "requestVideoFrameCallback", {
          ...callbackDescriptor,
          value: function (this: HTMLVideoElement, ...args: unknown[]) {
            const callback = args[0];
            // Preserve native validation/timing for an invalid callback too.
            if (typeof callback !== "function")
              return Reflect.apply(originalRequest, this, args);
            const request = ++requestCount;
            const requestIdentity: { id?: number } = {};
            const forwarded = args.slice();
            forwarded[0] = function (
              this: HTMLVideoElement,
              ...callbackArgs: Parameters<VideoFrameRequestCallback>
            ) {
              const [callbackAt, metadata] = callbackArgs;
              const previousActive = activeRequest;
              activeRequest = request;
              latestRequest = request;
              latestNative = {
                callbackAt,
                presentationTime: metadata.presentationTime,
              };
              try {
                frames[frameCount++ % frameLimit] = {
                  sequence: ++sequence,
                  type: "native-callback-enter",
                  request,
                  requestId: numberRecord(requestIdentity.id),
                  observedNow: numberRecord(readNativeNow()),
                  callbackAt: numberRecord(callbackAt),
                  presentationTime: numberRecord(metadata.presentationTime),
                  expectedDisplayTime: numberRecord(
                    metadata.expectedDisplayTime,
                  ),
                  mediaTime: numberRecord(metadata.mediaTime),
                  presentedFrames: numberRecord(metadata.presentedFrames),
                };
              } catch {
                // Never suppress or replace the production callback.
              }
              try {
                return Reflect.apply(callback, this, callbackArgs);
              } finally {
                try {
                  frames[frameCount++ % frameLimit] = {
                    sequence: ++sequence,
                    type: "native-callback-return",
                    request,
                    requestId: numberRecord(requestIdentity.id),
                    observedNow: numberRecord(readNativeNow()),
                  };
                } catch {
                  // The original return value/exception is preserved.
                }
                activeRequest = previousActive;
              }
            };
            const requestId = Reflect.apply(
              originalRequest,
              this,
              forwarded,
            ) as number;
            requestIdentity.id = requestId;
            return requestId;
          },
        });
        callbackWrapped = true;
      } catch {
        // Unsupported methods are not polyfilled.
      }
    }
    Object.defineProperty(window, "__tcgNativeFrameDiagnostics", {
      configurable: true,
      enumerable: false,
      value: {
        snapshot: () => ({
          schema: 1,
          clockWrapped,
          callbackWrapped,
          crossOriginIsolated,
          timeOrigin: performance.timeOrigin,
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          frameLimit,
          clockLimit,
          totalFrameEvents: frameCount,
          totalClockReads: clockCount,
          totalRequests: requestCount,
          anomalousCallsites,
          frames: chronological(frames, frameCount, frameLimit),
          clocks: chronological(clocks, clockCount, clockLimit),
        }),
      },
    });
  });
}

export async function attachNativeFrameDiagnosticsOnFailure(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
) {
  if (
    testInfo.status === testInfo.expectedStatus ||
    testInfo.status === "skipped"
  )
    return;
  let nativeTiming: unknown = { unavailable: "Page could not be inspected" };
  try {
    nativeTiming = await page.evaluate(() => {
      const state = (
        window as Window & {
          __tcgNativeFrameDiagnostics?: { snapshot(): unknown };
        }
      ).__tcgNativeFrameDiagnostics;
      return state?.snapshot() ?? { unavailable: "Observer was not installed" };
    });
  } catch {
    // No exception stacks, filesystem paths or page/collection contents.
  }
  await testInfo.attach("native-frame-timing.json", {
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify(
        {
          browserVersion: browser.version(),
          caveat:
            "Test-only pass-through observer. Extra native clock reads and bounded bookkeeping may perturb timing or hide a race. At most 8 negative-delta anomalies capture app-bundle line/column offsets; no raw stack is retained. Values are not normalized; callback arguments, native IDs, return values and property flags are preserved. expectedDisplayTime may legitimately be future and is diagnostic only, never a production validation input. No pixels, collection data, URLs or private paths are collected.",
          nativeTiming,
        },
        null,
        2,
      ),
    ),
  });
}
