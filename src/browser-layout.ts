export function browserMaximumWidth(areaWidth: number): number {
  return areaWidth < 880 ? Math.max(320, areaWidth) : areaWidth - 560;
}

export function browserVisibleWidth(areaWidth: number, preferredWidth: number | null): number {
  if (areaWidth < 880) return Math.max(0, areaWidth);
  const initial = preferredWidth ?? 420;
  return Math.max(320, Math.min(initial, browserMaximumWidth(areaWidth)));
}

export function browserReleaseWidth(rawWidth: number, areaWidth: number): number | null {
  if (rawWidth < 260) return null;
  return Math.max(320, Math.min(Math.round(rawWidth), browserMaximumWidth(areaWidth)));
}
