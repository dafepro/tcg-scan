import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentationScheduler } from "./presentation-scheduler";

afterEach(() => vi.useRealTimers());
describe("bounded presentation snapshots", () => {
  it("coalesces repeated changes without extending the initial deadline", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const scheduler = createPresentationScheduler(publish);
    scheduler.request();
    vi.advanceTimersByTime(200);
    for (let i = 0; i < 1000; i++) scheduler.request();
    vi.advanceTimersByTime(50);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("flushes important outcomes immediately and cancels the queued duplicate", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const scheduler = createPresentationScheduler(publish);
    scheduler.request();
    scheduler.request(true);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1);
    scheduler.request(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("cancels old-generation updates while allowing a later session", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const scheduler = createPresentationScheduler(publish);
    scheduler.request();
    scheduler.cancel();
    scheduler.flush();
    vi.advanceTimersByTime(1000);
    expect(publish).not.toHaveBeenCalled();
    scheduler.request();
    vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
