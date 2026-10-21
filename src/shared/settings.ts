export interface Settings {
  /** The popup's main switch: off, nothing runs on any page. */
  enabled: boolean;
  /** Moutheyes for videos: the hover button and Alt+Shift+E. */
  videos: boolean;
  /** Moutheyes for the pictures on pages, found and converted in the background. */
  images: boolean;
  /** Size of each mouth relative to its eye (the eye's corner-to-corner width). */
  mouthScale: number;
  /** Most faces given moutheyes per video or picture. */
  maxFaces: number;
  /** 0 = raw landmarks (jittery), close to 1 = very smooth but laggy. */
  smoothing: number;
  /**
   * Mouth echo, in seconds (0 to 0.5, off at 0): the eye on the left of the picture shows the
   * mouth from this long ago, the right eye from twice as long ago.
   */
  mouthEcho: number;
  /**
   * 0..1: how strongly to leave out of the mouth copies whatever is neither skin nor lips
   * (captions, a hand, a microphone). The mouth opening is exempt (teeth, tongue).
   */
  objectFilter: number;
  /** Feather the mouth only into skin and match its tone to the skin around each eye. */
  skinMatch: boolean;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  videos: true,
  images: false,
  mouthScale: 1.35,
  maxFaces: 2,
  smoothing: 0.5,
  mouthEcho: 0,
  objectFilter: 0.7,
  skinMatch: true,
  showStats: false,
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(null)) as Partial<Settings>;
  const s = { ...DEFAULT_SETTINGS, ...stored };
  // The echo used to reach back 2 s; the history now holds 1 s.
  s.mouthEcho = Math.min(s.mouthEcho, 0.5);
  return s;
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadSettings().then(cb);
  });
}
