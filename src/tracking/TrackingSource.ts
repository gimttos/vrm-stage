import type { PoseFrame } from '../types';

export interface TrackingSourceInfo {
  id: string;
  label: string;
  /** Shown in the UI so users understand what they are choosing. */
  detail: string;
}

/**
 * A producer of {@link PoseFrame}s.
 *
 * Webcam tracking is the default because it needs nothing but a browser, but it
 * is deliberately *not* privileged: VMC (VSeeFace/VNyan/Warudo) and
 * iFacialMocap sources implement the same interface, so a user can keep the
 * tracker they already trust and use this app purely as the scene compositor.
 */
export interface TrackingSource {
  readonly info: TrackingSourceInfo;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Most recent frame, or null before the first capture. */
  read(): PoseFrame | null;
}
