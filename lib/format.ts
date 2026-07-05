/** Formatting helpers — everything the model sees should be in Eastern Time. */

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

export function formatEt(epochSeconds: number): string {
  return timeFmt.format(new Date(epochSeconds * 1000));
}

export function minutesFromNow(epochSeconds: number): number {
  return Math.round((epochSeconds * 1000 - Date.now()) / 60_000);
}

export function formatDeparture(epochSeconds: number): string {
  const mins = minutesFromNow(epochSeconds);
  return `${formatEt(epochSeconds)} ET (${mins <= 0 ? "now" : `in ${mins} min`})`;
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}
