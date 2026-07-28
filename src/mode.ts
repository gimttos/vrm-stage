/**
 * Which product this page instance is.
 *
 * The panel had grown into two products sharing one scrolling column: a rig
 * calibration bench (axis inverts, filter tuning, a numeric debug grid) and a
 * scene compositor. The meaningful seam is not obs/not-obs — it is rig vs
 * compositor vs clean output, so there are three modes rather than two.
 */
export type AppMode = 'studio' | 'live' | 'rig';

export function readMode(params: URLSearchParams): AppMode {
  const raw = params.get('mode');
  if (raw === 'live' || raw === 'studio' || raw === 'rig') return raw;
  // Permanent alias, not a deprecation: `?obs=1` URLs are already pasted into
  // people's OBS scenes and must keep working forever.
  if (params.get('obs') === '1') return 'live';
  return 'studio';
}

/**
 * Applies the mode to the document.
 *
 * `live` also gets the legacy `obs` class so every existing rule — the hidden
 * panel, the suppressed checkerboard, the repositioned licence badge — keeps
 * working untouched. Selectors can migrate to `.live` gradually, or never.
 */
export function applyModeClass(mode: AppMode): void {
  document.body.classList.add(mode);
  if (mode === 'live') document.body.classList.add('obs');
}

/** Scene items are draggable only in the compositor. */
export function sceneEditable(mode: AppMode): boolean {
  return mode === 'studio';
}
