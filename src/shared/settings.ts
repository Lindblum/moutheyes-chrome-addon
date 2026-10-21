export interface Settings {
  /** Size of each mouth relative to its eye (the eye's corner-to-corner width). */
  mouthScale: number;
  /** Most faces tracked per video. */
  maxFaces: number;
  /** 0 = raw landmarks (jittery), close to 1 = very smooth but laggy. */
  smoothing: number;
  /** Feather the mouth only into skin and match its tone to the skin around each eye. */
  skinMatch: boolean;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mouthScale: 1.35,
  maxFaces: 2,
  smoothing: 0.5,
  skinMatch: true,
  showStats: false,
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(null)) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.local.set(patch);
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadSettings().then(cb);
  });
}
