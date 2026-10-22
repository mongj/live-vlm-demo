export type MicrophoneMode = "push-to-talk" | "always-listening";

type PreferenceValues = {
  microphoneMode: MicrophoneMode;
  modelVolume: number;
  captionsEnabled: boolean;
};
type PreferenceName = keyof PreferenceValues;

const DEFAULTS: PreferenceValues = {
  microphoneMode: "push-to-talk",
  modelVolume: 1,
  captionsEnabled: true,
};

function validPreference(name: PreferenceName, value: unknown): value is PreferenceValues[PreferenceName] {
  switch (name) {
    case "microphoneMode":
      return value === "push-to-talk" || value === "always-listening";
    case "modelVolume":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
    case "captionsEnabled":
      return typeof value === "boolean";
    default:
      return false;
  }
}

export function readPreference(name: "microphoneMode"): MicrophoneMode;
export function readPreference(name: "modelVolume"): number;
export function readPreference(name: "captionsEnabled"): boolean;
export function readPreference(name: PreferenceName): PreferenceValues[PreferenceName] {
  try {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(`vlm-playground:${name}:v1`);
      const value: unknown = stored === null ? null : JSON.parse(stored);
      if (validPreference(name, value)) return value;
    }
  } catch {
    // Corrupt, blocked or unavailable storage must not prevent using the app.
  }
  return DEFAULTS[name];
}

export function writePreference(name: "microphoneMode", value: MicrophoneMode): void;
export function writePreference(name: "modelVolume", value: number): void;
export function writePreference(name: "captionsEnabled", value: boolean): void;
export function writePreference(name: PreferenceName, value: PreferenceValues[PreferenceName]): void {
  if (!validPreference(name, value)) return;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`vlm-playground:${name}:v1`, JSON.stringify(value));
    }
  } catch {
    // Remembering a display/input preference is best effort, never permission.
  }
}
