export type FrameRateSnapshot = { captured: number | null; submitted: number | null; upstream: number | null };
const WINDOW_MS = 5000;

/** Content-free monotonic browser and upstream transport measurements, not camera/model processing FPS. */
export class FrameRates {
  private captured: number[] = [];
  private submitted: number[] = [];
  private reports: { count: number; time: number }[] = [];
  reset(): void { this.captured = []; this.submitted = []; this.reports = []; }
  capture(now: number): void { this.record(this.captured, now); }
  submit(now: number): void { this.record(this.submitted, now); }
  private record(list: number[], now: number): void {
    if (!Number.isFinite(now) || (list.length && now < list[list.length - 1])) return;
    list.push(now);
    while (list.length > 256 || (list.length && list[0] < now - WINDOW_MS)) list.shift();
  }
  upstream(count: number, now: number): void {
    if (!Number.isFinite(count) || count < 0 || !Number.isFinite(now)) return;
    const last = this.reports.at(-1);
    if (last && now <= last.time) return;
    if (last && count < last.count) this.reports = [];
    this.reports.push({ count, time: now });
    while (this.reports.length > 120 || this.reports[0]?.time < now - WINDOW_MS) this.reports.shift();
  }
  read(now: number): FrameRateSnapshot {
    const rate = (list: number[]) => {
      while (list.length && list[0] < now - WINDOW_MS) list.shift();
      const last = list[list.length - 1];
      return list.length >= 2 && last > list[0] && now - last <= 2500
        ? (list.length - 1) * 1000 / (last - list[0]) : null;
    };
    while (this.reports.length && this.reports[0].time < now - WINDOW_MS) this.reports.shift();
    const first = this.reports[0], last = this.reports.at(-1);
    return { captured: rate(this.captured), submitted: rate(this.submitted), upstream:
      first && last && last.time > first.time && now - last.time <= 2500
        ? (last.count - first.count) * 1000 / (last.time - first.time) : null };
  }
}
