/** Coalesces presentation-only work. Evidence, storage and capture scheduling must
 * never wait for this timer. Important user-visible outcomes may flush at once. */
export function createPresentationScheduler(
  publish: () => void,
  intervalMs = 250,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = false;
  };
  const flush = () => {
    if (!pending) return;
    cancel();
    publish();
  };
  return {
    request(immediate = false) {
      pending = true;
      if (immediate) flush();
      else if (timer === undefined) timer = setTimeout(flush, intervalMs);
    },
    flush,
    cancel,
  };
}
