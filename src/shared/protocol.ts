// Messages exchanged over the MessagePort between the content script and the tracker host iframe.
import type { FaceGeom } from './face';

export interface TrackOptions {
  mouthScale: number;
  maxFaces: number;
  smoothing: number;
  skinMatch: boolean;
  /** Skin and lip colours are measured when this is above 0 (or skinMatch is on). */
  objectFilter: number;
}

/** What a moutheyes picture depends on (see outputKey() in imagecache.ts). */
export interface ImageOptions {
  mouthScale: number;
  maxFaces: number;
  skinMatch: boolean;
  objectFilter: number;
}

export interface ImageResult {
  /** Faces given moutheyes (0: none found, or the picture couldn't be used). */
  faces: number;
  /** The moutheyes picture, when there were faces. */
  blob: Blob | null;
  /** Answered from the image cache. */
  cached: boolean;
  /** Why the picture couldn't be used. */
  error?: string;
  /**
   * Left alone because the extension may not read it: 'access', no site access to where it's
   * from; 'login', its site wants a login (the extension fetches pictures without cookies).
   */
  blocked?: Blocked;
}

export type Blocked = 'access' | 'login';

export type ToHost =
  /** Loads the face landmarkers (for video; pictures load them only when they need them). */
  | { type: 'init' }
  /** A picture to convert: its file if the page could read it, else it's fetched by URL. */
  | { type: 'image'; id: number; url: string; file: Blob | null; opts: ImageOptions }
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
  | { type: 'frame-error'; id: number; bitmap: ImageBitmap | null; message: string }
  | ({ type: 'image-done'; id: number } & ImageResult);

/**
 * Extension messages to the background script that guard the host connection: the content script
 * registers a one-time token, and the host page checks the token a connection brings.
 */
export type HostTokenMessage = { type: 'host-token'; token: string } | { type: 'host-token-check'; token: string };

/** What a frame's content script reports to the popup (see MoutheyesApi in content/index.ts). */
export interface FrameStatus {
  videos: number;
  active: number;
  /** Faces currently tracked across active videos. */
  faces: number;
  /** Pictures on the page shown with moutheyes. */
  images: number;
  /** Pictures left alone because the extension may not read them (see ImageResult.blocked). */
  blockedImages: Record<Blocked, number>;
  /**
   * Top frame only: origins of the embedded frames big enough to hold a video, so the popup can
   * tell which ones Moutheyes has no site access to.
   */
  frameOrigins?: string[];
  /** How prominent the frame's main video is (on-screen area, doubled if playing); 0: none. */
  score: number;
  /** Build of the content script that answered. */
  buildId: string;
  /** Why moutheyes last failed to start or stopped on its own in this frame, if it did. */
  error?: string;
}

declare global {
  /** Injected by build.mjs; unique per build. */
  const __BUILD_ID__: string;
}
