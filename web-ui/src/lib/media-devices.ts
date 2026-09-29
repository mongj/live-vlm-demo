/** Stands for "whatever the browser picks" for inputs and outputs alike. */
export const DEFAULT_DEVICE_ID = "default";

export type MediaDeviceOption = {
  deviceId: string;
  label: string;
};

export type MediaDeviceLists = {
  audioInputs: MediaDeviceOption[];
  audioOutputs: MediaDeviceOption[];
  videoInputs: MediaDeviceOption[];
  /** False until the browser exposes device labels, i.e. before a media permission is granted. */
  labelled: boolean;
};

export const EMPTY_DEVICE_LISTS: MediaDeviceLists = {
  audioInputs: [],
  audioOutputs: [],
  videoInputs: [],
  labelled: false,
};

const CAMERA_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: true,
  noiseSuppression: true,
};

type MediaDevice = "camera" | "microphone";

function deviceCopy(device: MediaDevice): { noun: string; label: string } {
  switch (device) {
    case "camera":
      return { noun: "camera", label: "Camera" };
    case "microphone":
      return { noun: "microphone", label: "Microphone" };
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

export function mediaDeviceErrorMessage(error: unknown, device: MediaDevice): string {
  const { noun, label } = deviceCopy(device);
  if (!(error instanceof Error)) {
    return `${label} access failed`;
  }
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return `${label} permission was denied`;
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return `No ${noun} was found`;
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return `The ${noun} is already in use`;
  }
  if (error.name === "SecurityError") {
    return `${label} access requires a secure browser context`;
  }
  return error.message || `${label} access failed`;
}

export function stopMediaStream(stream: MediaStream | null) {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function deviceConstraint(deviceId: string): MediaTrackConstraints {
  return deviceId === DEFAULT_DEVICE_ID ? {} : { deviceId: { exact: deviceId } };
}

export function cameraConstraints(deviceId: string): MediaTrackConstraints {
  return { ...CAMERA_VIDEO_CONSTRAINTS, ...deviceConstraint(deviceId) };
}

export function microphoneConstraints(deviceId: string): MediaTrackConstraints {
  return { ...MICROPHONE_CONSTRAINTS, ...deviceConstraint(deviceId) };
}

export function assertSecureMediaContext(device: MediaDevice) {
  if (!window.isSecureContext) {
    throw new DOMException(`${deviceCopy(device).label} access requires a secure browser context`, "SecurityError");
  }
}

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallbackLabel: string): MediaDeviceOption[] {
  const matching = devices.filter((device) => device.kind === kind && device.deviceId);
  const options = matching.map((device, index) => ({
    deviceId: device.deviceId,
    label: device.label || `${fallbackLabel} ${index + 1}`,
  }));
  if (!options.some((option) => option.deviceId === DEFAULT_DEVICE_ID)) {
    options.unshift({ deviceId: DEFAULT_DEVICE_ID, label: `Default ${fallbackLabel.toLowerCase()}` });
  }
  return options;
}

export async function listMediaDevices(): Promise<MediaDeviceLists> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return EMPTY_DEVICE_LISTS;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices.filter((device) => device.kind === "audiooutput" && device.deviceId);
  return {
    audioInputs: toOptions(devices, "audioinput", "Microphone"),
    audioOutputs: outputs.length > 0 ? toOptions(devices, "audiooutput", "Speaker") : [],
    videoInputs: toOptions(devices, "videoinput", "Camera"),
    labelled: devices.some((device) => device.label.length > 0),
  };
}

type SinkSelectableContext = AudioContext & { setSinkId: (sinkId: string) => Promise<void> };

export function supportsOutputSelection(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

export async function setContextSink(context: AudioContext, deviceId: string): Promise<void> {
  if (!("setSinkId" in context)) {
    return;
  }
  await (context as SinkSelectableContext).setSinkId(deviceId === DEFAULT_DEVICE_ID ? "" : deviceId);
}

type CapturableMediaElement = HTMLMediaElement & { captureStream: () => MediaStream };

/**
 * Taps a playing element's audio without affecting its own output. `captureStream` is
 * unaffected by `muted`, unlike `createMediaElementSource`, which also binds the element
 * to a single AudioContext for its lifetime.
 */
export function captureElementAudio(element: HTMLMediaElement): MediaStream | null {
  if (!("captureStream" in element)) {
    return null;
  }
  const captured = (element as CapturableMediaElement).captureStream();
  for (const track of captured.getVideoTracks()) {
    track.stop();
    captured.removeTrack(track);
  }
  return captured;
}
