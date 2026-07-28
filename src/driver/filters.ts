/** Exponential low-pass stage used by {@link OneEuroFilter}. */
class LowPass {
  private y: number | null = null;

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

/**
 * One-Euro filter: a low-pass whose cutoff frequency rises with the signal's
 * speed. Slow drift gets smoothed hard, fast motion stays responsive.
 *
 * This is the difference between "janky" and "looks fine". Landmark noise from
 * a webcam is mostly high-frequency jitter around a stable mean, which is
 * exactly what this removes without adding the lag a fixed filter would.
 *
 * Deliberately NOT used for blinks — see AvatarDriver.
 */
export class OneEuroFilter {
  private value = new LowPass();
  private derivative = new LowPass();
  private lastTime: number | null = null;
  private lastValue = 0;

  constructor(
    /** Cutoff at rest, Hz. Lower = smoother but laggier when still. */
    private readonly minCutoff = 1.2,
    /** Speed coefficient. Higher = snappier on fast motion. */
    private readonly beta = 0.05,
    /** Cutoff for the speed estimate itself, Hz. */
    private readonly derivativeCutoff = 1.0,
  ) {}

  filter(x: number, timestamp: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      this.lastValue = x;
      return this.value.filter(x, 1);
    }

    // Clamp dt so a stalled tab cannot produce an absurd derivative.
    const dt = Math.min(Math.max((timestamp - this.lastTime) / 1000, 1e-4), 0.1);
    this.lastTime = timestamp;

    const speed = (x - this.lastValue) / dt;
    this.lastValue = x;

    const smoothedSpeed = this.derivative.filter(speed, alpha(this.derivativeCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedSpeed);
    return this.value.filter(x, alpha(cutoff, dt));
  }

  reset(): void {
    this.value.reset();
    this.derivative.reset();
    this.lastTime = null;
    this.lastValue = 0;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Collapses tiny values to zero so a resting face does not creep. */
export function deadzone(x: number, threshold = 0.04): number {
  if (Math.abs(x) < threshold) return 0;
  const sign = Math.sign(x);
  return sign * ((Math.abs(x) - threshold) / (1 - threshold));
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Pushes a 0..1 signal towards its extremes. Used on blinks: raw eyeBlink
 * coefficients hover around 0.3–0.6 during a real blink, which reads as a
 * permanently sleepy avatar unless the curve is made decisive.
 */
export function snap(x: number, knee = 0.35, gamma = 0.5): number {
  const t = clamp01((x - knee) / (1 - knee));
  return Math.pow(t, gamma);
}
