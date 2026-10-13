import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { prepare } from "./guided-pack-fixture";
import type { GuidedFixtureWindow } from "./guided-fixture-types";
import type { PackTraceSnapshot } from "../src/lib/pack-trace";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// Synthetic wiring only: native geometric video and real app/storage, explicitly
// mocked matcher replies. None of these cases measures card-recognition accuracy.
const clip = fileURLToPath(
  new URL("./fixtures/continuous-two-copies.mp4", import.meta.url),
);
const capClip = fileURLToPath(
  new URL("./fixtures/continuous-trace-cap.mp4", import.meta.url),
);
const pack = (page: Page) =>
  page.getByRole("region", { name: "Pack opening scanner" });
const checkbox = (page: Page) =>
  pack(page).getByRole("checkbox", {
    name: "Record bounded diagnostics for the next Pack session",
  });
const stored = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("tcg-scan:data:v1") || "{}").collection ??
      [],
  );

async function setup(
  page: Page,
  options: { holdResults?: boolean; storageFailure?: boolean } = {
    holdResults: false,
  },
) {
  await page.addInitScript(() => {
    (window as unknown as GuidedFixtureWindow).guidedQA = {
      ocrReads: 0,
      guidanceAnnouncements: [],
      ocrReplies: [],
      terminated: 0,
      holdOCR: false,
      ocrText: "PRIVATE OCR SENTINEL SHOULD NEVER ENTER TRACE",
      release() {
        this.ocrReplies.splice(0).forEach((f) => f());
      },
    };
  });
  await prepare(page, options);
  await openTrace(page);
}
async function openTrace(page: Page) {
  const details = pack(page).locator(".pack-trace-options");
  if ((await details.getAttribute("open")) === null)
    await details.locator("summary").click();
}
async function start(page: Page, path = clip) {
  await pack(page).getByLabel("Scan local video").setInputFiles(path);
  await expect(pack(page).locator("p[role=status]").first()).toContainText(
    "Playing local video at 1×",
    { timeout: 30000 },
  );
}
async function drained(page: Page) {
  await expect(pack(page).locator("p[role=status]").first()).toContainText(
    "Captured views processed.",
    { timeout: 30000 },
  );
}
async function exported(page: Page, info: TestInfo, name: string) {
  await openTrace(page);
  const pending = page.waitForEvent("download");
  await pack(page)
    .getByRole("button", { name: "Export local trace JSON", exact: true })
    .click();
  const download = await pending,
    path = info.outputPath(name + ".json");
  await download.saveAs(path);
  const bytes = await readFile(path),
    text = bytes.toString();
  expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
  for (const sentinel of [
    "PRIVATE OCR SENTINEL",
    "Synthetic pack lifecycle card",
    "fixture:pack-one",
    "pokemon:installer-fixture",
    "http://",
    "https://",
    "data:image",
    "capture:",
  ])
    expect(text).not.toContain(sentinel);
  const trace = JSON.parse(text) as PackTraceSnapshot;
  expect(trace.format).toBe("tcg-pack-local-trace-v1");
  expect(trace.records.length).toBeLessThanOrEqual(2048);
  expect(new Set(trace.records.map((r) => r.id)).size).toBe(
    trace.records.length,
  );
  for (const record of trace.records) {
    for (const [key, value] of Object.entries(record))
      expect(
        value === null ||
          typeof value === "number" ||
          (["kind", "schedule", "matcher", "reason", "save"].includes(key) &&
            typeof value === "string"),
      ).toBe(true);
  }
  return trace;
}
async function snapshot(page: Page) {
  await openTrace(page);
  await pack(page)
    .getByRole("button", {
      name: /^(Inspect local trace|Refresh trace snapshot)$/,
    })
    .click();
  return pack(page).locator(".pack-trace-inspection");
}

test("Pack trace stays default-off through native capture and is never persisted", async ({
  page,
}) => {
  await setup(page);
  await expect(checkbox(page)).not.toBeChecked();
  await expect(pack(page)).toContainText(
    "No trace was recorded for the current session",
  );
  await start(page);
  await drained(page);
  expect(await stored(page)).toHaveLength(1);
  await expect(
    pack(page).getByRole("button", { name: "Export local trace JSON" }),
  ).toHaveCount(0);
  expect(await page.locator("[data-trace-view-id]").count()).toBe(0);
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).some(
        ([k, v]) =>
          k.includes("trace") || String(v).includes("tcg-pack-local-trace-v1"),
      ),
    ),
  ).toBe(false);
});

test("Pack trace links reservoir, rejected and accepted views, durable saves, copies and exact Undo", async ({
  page,
}, info) => {
  await setup(page, { holdResults: true });
  // Change only two explicitly synthetic matcher responses to exercise rejection
  // classifications; the production accept/reject gates remain unchanged.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    let analyzed = 0;
    Worker.prototype.postMessage = function (
      message,
      transfer: Transferable[] | StructuredSerializeOptions = [],
    ) {
      const callback = this.onmessage;
      if (message?.type !== "analyze" || !callback)
        return Reflect.apply(post, this, [message, transfer]);
      const index = ++analyzed;
      this.onmessage = function (event: MessageEvent) {
        const result = event.data?.result;
        if (result && index === 1) result.detectionComplete = false;
        if (result && index === 2) {
          result.detections[0].candidates = [];
          result.detections[0].state = "unknown";
          result.detections[0].autoEligible = false;
        }
        callback.call(this, event);
      };
      const out = Reflect.apply(post, this, [message, transfer]);
      this.onmessage = callback;
      return out;
    };
  });
  await checkbox(page).check();
  await start(page);
  await expect(checkbox(page)).toBeDisabled();
  await page.waitForTimeout(1800);
  await pack(page)
    .getByRole("button", { name: "Pause pack", exact: true })
    .click();
  const paused = await exported(page, info, "paused-reservoir-trace");
  expect(paused.state).toBe("paused");
  expect(paused.counters.replaced).toBeGreaterThan(0);
  expect(paused.records.some((r) => r.schedule === "reservoir-replaced")).toBe(
    true,
  );
  await page.evaluate(() =>
    (
      window as unknown as { packFixture: { releaseResults(): void } }
    ).packFixture.releaseResults(),
  );
  await pack(page)
    .getByRole("button", { name: "Resume pack", exact: true })
    .click();
  await drained(page);
  const final = await exported(page, info, "drained-linkage-trace");
  expect(final.complete).toBe(true);
  expect(final.state).toBe("drained");
  expect(
    final.records.some((r) => r.reason === "incomplete-verification"),
  ).toBe(true);
  expect(final.records.some((r) => r.reason === "no-candidate")).toBe(true);
  const save = final.records.find((r) => r.save === "saved");
  expect(save).toBeDefined();
  expect(save!.eventView).toBe(save!.id);
  expect(save!.savedMs).toBeGreaterThanOrEqual(save!.decidedMs!);
  expect(
    final.records.some(
      (r) => r.save === "duplicate" && r.eventView === save!.id,
    ),
  ).toBe(true);
  expect(
    final.records.some(
      (r) =>
        r.deferredMs !== null &&
        r.admittedMs !== null &&
        r.admittedMs >= r.deferredMs,
    ),
  ).toBe(true);
  const views = final.records.filter((r) => r.kind === "view");
  for (let i = 1; i < views.length; i++)
    expect(views[i].sourceMediaSeconds).toBeGreaterThan(
      views[i - 1].sourceMediaSeconds!,
    );
  const receipt = pack(page).locator(
    `.pack-receipt[data-trace-view-id="${save!.id}"]`,
  );
  await expect(receipt).toHaveAttribute("data-status", "saved");
  expect(Number(await receipt.getAttribute("data-source-time"))).toBe(
    save!.sourceMediaSeconds,
  );
  const before = await stored(page);
  expect(before).toHaveLength(1);
  const captureId = await receipt.getAttribute("data-capture-id");
  expect(before[0].scanEventId).toBe(
    captureId!.replace(/:capture:\d+$/, `:pack:${save!.receiptFrame}`),
  );
  await receipt
    .getByRole("button", {
      name: "Add another copy of Synthetic pack lifecycle card",
      exact: true,
    })
    .click();
  expect(await stored(page)).toHaveLength(2);
  const copied = await exported(page, info, "explicit-copy-trace");
  const copy = copied.records.find((r) => r.kind === "explicit-copy");
  expect(copy).toBeDefined();
  expect(copy).toMatchObject({
    sourceView: save!.id,
    eventView: copy!.id,
    sourceMediaSeconds: null,
    matcher: "not-run",
    reason: "explicit-copy",
    save: "saved",
  });
  await pack(page)
    .getByRole("button", { name: /^Show recent captured-view details/ })
    .click();
  await pack(page)
    .locator(`.pack-receipt[data-trace-view-id="${copy!.id}"]`)
    .getByRole("button", { name: "Undo this copy", exact: true })
    .click();
  expect(await stored(page)).toEqual(before);
  const undone = await exported(page, info, "exact-undo-trace");
  expect(undone.records.find((r) => r.id === copy!.id)?.save).toBe("undone");
  expect(undone.records.find((r) => r.id === save!.id)?.save).toBe("saved");
  await page.setViewportSize({ width: 320, height: 900 });
  const inspect = await snapshot(page);
  await pack(page).getByLabel("Source time from (seconds)").fill("4");
  await pack(page).getByLabel("Source time through (seconds)").fill("1");
  await expect(inspect.getByRole("alert")).toContainText("Choose an end time");
  await pack(page).getByLabel("Source time from (seconds)").fill("0");
  await pack(page).getByLabel("Source time through (seconds)").fill("5");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("trace-inspection-320px.png"),
    fullPage: true,
  });
  const persisted = await stored(page);
  await page.reload();
  expect(await stored(page)).toEqual(persisted);
  if ((await pack(page).count()) === 0)
    await page
      .getByRole("button", { name: "Pack opening", exact: true })
      .click();
  await openTrace(page);
  await expect(checkbox(page)).not.toBeChecked();
  await expect(
    pack(page).getByRole("button", { name: "Export local trace JSON" }),
  ).toHaveCount(0);
});

test("Pack trace preserves failed preparation, replaces on successful start and clears leaving Pack", async ({
  page,
}, info) => {
  await setup(page);
  await checkbox(page).check();
  await start(page);
  await drained(page);
  const first = await exported(page, info, "before-invalid-replacement");
  await pack(page)
    .getByLabel("Scan local video")
    .setInputFiles({
      name: "wrong.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a video"),
    });
  await expect(pack(page).locator(".pack-error")).toBeVisible();
  expect(await exported(page, info, "after-invalid-replacement")).toEqual(
    first,
  );
  await start(page);
  await drained(page);
  const next = await exported(page, info, "after-successful-replacement");
  expect(next.counters.saveSucceeded).toBe(1);
  expect(next.records[0].id).toBe(1);
  expect(await stored(page)).toHaveLength(2);
  await page
    .getByRole("button", { name: "Live cards / binder", exact: true })
    .click();
  await page.getByRole("button", { name: "Pack opening", exact: true }).click();
  await openTrace(page);
  await expect(checkbox(page)).not.toBeChecked();
  await expect(
    pack(page).getByRole("button", { name: "Export local trace JSON" }),
  ).toHaveCount(0);
});

test("Pack trace End cancels held results and keeps cancelled metadata without a save", async ({
  page,
}, info) => {
  await setup(page, { holdResults: true });
  await checkbox(page).check();
  await start(page);
  await page.waitForTimeout(1000);
  await pack(page)
    .getByRole("button", { name: "End session", exact: true })
    .click();
  const ended = await exported(page, info, "cancelled-trace");
  expect(ended.state).toBe("cancelled");
  expect(ended.records.some((r) => r.matcher === "cancelled")).toBe(true);
  await page.evaluate(() =>
    (
      window as unknown as { packFixture: { releaseResults(): void } }
    ).packFixture.releaseResults(),
  );
  await page.waitForTimeout(250);
  expect(await stored(page)).toEqual([]);
  const late = await exported(page, info, "after-late-cancelled-result");
  expect(late.counters.saveSucceeded).toBe(0);
  expect(late.records.some((r) => r.save === "saved")).toBe(false);
});

test("Pack trace failed durable write retries the same diagnostic event and Undo remains durable", async ({
  page,
}, info) => {
  await setup(page, { holdResults: false, storageFailure: true });
  await checkbox(page).check();
  await start(page);
  await drained(page);
  expect(await stored(page)).toEqual([]);
  const failed = await exported(page, info, "failed-write-trace"),
    record = failed.records.find((r) => r.save === "failed");
  expect(record).toBeDefined();
  expect(failed.counters.saveSucceeded).toBe(0);
  await page.evaluate(
    () =>
      ((
        window as unknown as { packFixture: { storageFailure: boolean } }
      ).packFixture.storageFailure = false),
  );
  await pack(page)
    .getByRole("button", { name: "Retry save", exact: true })
    .click();
  const saved = await exported(page, info, "retried-write-trace");
  expect(saved.records.find((r) => r.id === record!.id)).toMatchObject({
    save: "saved",
    saveAttempts: 2,
    eventView: record!.eventView,
  });
  expect(saved.counters.retries).toBe(1);
  expect(await stored(page)).toHaveLength(1);
  await pack(page)
    .getByRole("button", { name: "Undo latest copy", exact: true })
    .click();
  const undo = await exported(page, info, "durable-undo-trace");
  expect(undo.records.find((r) => r.id === record!.id)?.save).toBe("undone");
  expect(await stored(page)).toEqual([]);
  await page.reload();
  expect(await stored(page)).toEqual([]);
});

test("Pack trace reports real native-acquisition overflow under its record and serialized byte caps", async ({
  page,
}, info) => {
  test.skip(
    info.project.name.includes("mobile"),
    "One desktop native synthetic overflow run; record/byte adversarial cases also have unit coverage.",
  );
  test.setTimeout(180000);
  await setup(page);
  await checkbox(page).check();
  await start(page, capClip);
  await expect(pack(page).locator("p[role=status]").first()).toContainText(
    "Captured views processed.",
    { timeout: 140000 },
  );
  const trace = await exported(page, info, "overflow-trace");
  expect(trace.complete).toBe(false);
  expect(trace.counters.overflowRecords).toBeGreaterThan(0);
  expect(trace.records).toHaveLength(672);
  expect(trace.records[0].id).toBe(1);
  expect(trace.counters.captured).toBeGreaterThan(672);
  expect(trace.counters.unretainedUpdates).toBeGreaterThan(0);
  const inspect = await snapshot(page);
  await expect(inspect).toContainText("Incomplete diagnostic trace");
  await expect(inspect).toContainText(
    `Overflow records: ${trace.counters.overflowRecords}`,
  );
  await expect(pack(page)).toContainText("at most 672 records");
  await page.screenshot({
    path: info.outputPath("explicit-overflow.png"),
    fullPage: true,
  });
});
