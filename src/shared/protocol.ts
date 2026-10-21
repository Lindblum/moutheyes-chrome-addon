// Messages exchanged over the MessagePort between the content script and the tracker host iframe.
import type { FaceGeom } from './face';

export interface TrackOptions {
  mouthScale: number;
  maxFaces: number;
  smoothing: number;
  skinMatch: boolean;
}

export type ToHost =
  | { type: 'init' }
  /**
   * stream: which video the frame is from (each keeps its own face tracks). time: the video's
   * currentTime in seconds, for temporal smoothing. reset: drop smoothing history (seek).
   */
  | { type: 'frame'; id: number; stream: number; time: number; reset: boolean; bitmap: ImageBitmap; opts: TrackOptions };

export type FromHost =
  | { type: 'ready'; provider: string }
  | { type: 'error'; message: string }
  /**
   * The frame comes back with its faces so the picture and the landmarks always match.
   * searching: parts of this frame haven't been searched for faces yet; send it again if the
   * video is paused (a playing video's next frames continue the search).
   */
  | { type: 'faces'; id: number; bitmap: ImageBitmap; faces: FaceGeom[]; searching: boolean; ms: number }
  | { type: 'frame-error'; id: number; bitmap: ImageBitmap | null; message: string };

// Messages from the popup to content scripts.
export type PopupRequest = { type: 'toggle' } | { type: 'status' };

export interface PopupStatus {
  videos: number;
  active: number;
  /** Faces currently tracked across active videos. */
  faces: number;
  /** Build of the content script that answered; missing in builds before this field existed. */
  buildId?: string;
}

declare global {
  /** Injected by build.mjs; unique per build. */
  const __BUILD_ID__: string;
}
