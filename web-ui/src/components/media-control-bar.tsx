"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VideoLibraryDialog } from "@/components/video-library-dialog";
import { VideoThumbnail } from "@/components/video-thumbnail";
import {
  DEFAULT_SOURCE_GAIN,
  MAX_SOURCE_GAIN,
  microphoneSourceId,
  VIDEO_AUDIO_SOURCE_ID,
  type AudioInputsState,
} from "@/hooks/use-audio-inputs";
import type { CameraViewState, PlaygroundState, VideoInput } from "@/hooks/use-playground";
import type { VideoLibraryState } from "@/hooks/use-video-library";
import { supportsOutputSelection } from "@/lib/media-devices";
import { cn } from "@/lib/utils";
import { videoKey } from "@/lib/video-library/types";
import {
  ChevronUpIcon,
  FilmIcon,
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
} from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

type MediaControlBarProps = {
  playground: PlaygroundState;
  videoLibrary: VideoLibraryState;
  className?: string;
};

const LIBRARY_RADIO_VALUE = "library";
const CAMERA_RADIO_PREFIX = "camera:";
const ROUND_BUTTON_CLASS = "size-12 rounded-full [&_svg:not([class*='size-'])]:size-5";

function videoInputRadioValue(input: VideoInput): string {
  switch (input.kind) {
    case "camera":
      return `${CAMERA_RADIO_PREFIX}${input.deviceId}`;
    case "library":
      return LIBRARY_RADIO_VALUE;
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

function isVideoEngaged(playground: PlaygroundState): boolean {
  switch (playground.videoSource) {
    case "file":
      return true;
    case "camera":
    case "none":
      return isCameraViewEngaged(playground.cameraView, playground.cameraError);
    default: {
      const exhaustive: never = playground.videoSource;
      return exhaustive;
    }
  }
}

function isCameraViewEngaged(view: CameraViewState, cameraError: string | null): boolean {
  switch (view) {
    case "connecting":
    case "live":
      return true;
    case "permission":
      return cameraError === null;
    case "empty":
    case "error":
      return false;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

function SplitControl({ label, menu, children }: { label: string; menu: ReactNode; children: ReactNode }) {
  return (
    <div aria-label={label} className="flex items-center rounded-full bg-muted/60" role="group">
      {menu}
      {children}
    </div>
  );
}

function CaretButton({ label, open, ...props }: ComponentProps<typeof Button> & { label: string; open: boolean }) {
  return (
    <Button
      {...props}
      aria-label={label}
      className="h-12 w-8 rounded-l-full rounded-r-none pr-0 pl-2 text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent"
      size="icon"
      type="button"
      variant="ghost"
    >
      <ChevronUpIcon className={cn("transition-transform", open && "rotate-180")} />
    </Button>
  );
}

function GainSlider({ audio, sourceId, label }: { audio: AudioInputsState; sourceId: string; label: string }) {
  const gain = audio.gains[sourceId] ?? DEFAULT_SOURCE_GAIN;
  return (
    <div className="flex items-center gap-2 pl-6">
      <Slider
        aria-label={`${label} gain`}
        className="flex-1"
        max={MAX_SOURCE_GAIN * 100}
        min={0}
        onValueChange={([value]) => audio.setGain(sourceId, (value ?? 100) / 100)}
        step={5}
        value={[Math.round(gain * 100)]}
      />
      <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {Math.round(gain * 100)}%
      </span>
    </div>
  );
}

function AudioSourceRow({
  id,
  label,
  checked,
  onCheckedChange,
  audio,
  sourceId,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: () => void;
  audio: AudioInputsState;
  sourceId: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <div className="flex min-w-0 items-center gap-2">
        <Checkbox checked={checked} id={id} onCheckedChange={onCheckedChange} />
        <Label className="min-w-0 flex-1 cursor-pointer truncate font-normal" htmlFor={id} title={label}>
          {label}
        </Label>
      </div>
      {checked ? <GainSlider audio={audio} label={label} sourceId={sourceId} /> : null}
    </div>
  );
}

function AudioMenu({ playground }: { playground: PlaygroundState }) {
  const [open, setOpen] = useState(false);
  const { audio, devices } = playground;
  const outputSelectable = supportsOutputSelection() && devices.audioOutputs.length > 0;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <CaretButton label="Audio settings" open={open} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 p-2" side="top" sideOffset={12}>
        <div className="flex flex-col gap-1">
          <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">Audio (input)</p>
          {devices.audioInputs.map((device) => (
            <AudioSourceRow
              audio={audio}
              checked={audio.selectedMicrophoneIds.includes(device.deviceId)}
              id={`audio-input-${device.deviceId}`}
              key={device.deviceId}
              label={device.label}
              onCheckedChange={() => audio.toggleMicrophone(device.deviceId)}
              sourceId={microphoneSourceId(device.deviceId)}
            />
          ))}
          {!devices.labelled ? (
            <p className="px-2 text-xs text-muted-foreground">Turn audio on to see device names.</p>
          ) : null}
        </div>
        {audio.videoAudioAvailable ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1">
              <p className="px-2 text-xs font-medium text-muted-foreground">Video</p>
              <AudioSourceRow
                audio={audio}
                checked={audio.videoAudioSelected}
                id="audio-input-video"
                label="Video audio"
                onCheckedChange={() => audio.setVideoAudioSelected(!audio.videoAudioSelected)}
                sourceId={VIDEO_AUDIO_SOURCE_ID}
              />
            </div>
          </>
        ) : null}
        {outputSelectable ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1.5 px-2 pb-1">
              <Label className="text-xs font-medium text-muted-foreground" htmlFor="audio-output">
                Audio (output)
              </Label>
              <Select onValueChange={audio.setOutputDeviceId} value={audio.outputDeviceId}>
                <SelectTrigger className="w-full min-w-0" id="audio-output">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {devices.audioOutputs.map((device) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function VideoMenu({
  playground,
  videoLibrary,
  onBrowseLibrary,
}: {
  playground: PlaygroundState;
  videoLibrary: VideoLibraryState;
  onBrowseLibrary: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { devices, lastLibraryVideo } = playground;
  const rememberedVideo = lastLibraryVideo
    ? videoLibrary.videos.find((video) => videoKey(video) === videoKey(lastLibraryVideo))
    : undefined;

  function handleValueChange(value: string) {
    if (value === LIBRARY_RADIO_VALUE) {
      if (rememberedVideo) {
        playground.selectVideo(rememberedVideo);
      }
      return;
    }
    if (value.startsWith(CAMERA_RADIO_PREFIX)) {
      playground.selectCamera(value.slice(CAMERA_RADIO_PREFIX.length));
    }
  }

  return (
    <DropdownMenu modal={false} onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <CaretButton label="Video settings" open={open} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" side="top" sideOffset={12}>
        <DropdownMenuRadioGroup onValueChange={handleValueChange} value={videoInputRadioValue(playground.videoInput)}>
          <DropdownMenuLabel>Camera</DropdownMenuLabel>
          {devices.videoInputs.map((device) => (
            <DropdownMenuRadioItem key={device.deviceId} value={`${CAMERA_RADIO_PREFIX}${device.deviceId}`}>
              <span className="truncate">{device.label}</span>
            </DropdownMenuRadioItem>
          ))}
          {rememberedVideo ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Video library</DropdownMenuLabel>
              <DropdownMenuRadioItem value={LIBRARY_RADIO_VALUE}>
                <VideoThumbnail className="w-12" video={rememberedVideo} />
                <span className="truncate">{rememberedVideo.name}</span>
              </DropdownMenuRadioItem>
            </>
          ) : null}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onBrowseLibrary}>
          <FilmIcon />
          Browse video library…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MediaControlBar({ playground, videoLibrary, className }: MediaControlBarProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { audio, activeVideo, videoSource, cameraView, videoInput, lastLibraryVideo } = playground;
  const audioLabel = audio.enabled ? "Turn audio off" : "Turn audio on";
  const videoEngaged = isVideoEngaged(playground);
  const videoPending = videoEngaged && cameraView !== "live";
  const videoLabel = videoEngaged ? "Turn video off" : "Turn video on";
  const fileActive = videoSource === "file";
  const rememberedAvailable = lastLibraryVideo
    ? videoLibrary.videos.some((video) => videoKey(video) === videoKey(lastLibraryVideo))
    : false;

  function handleVideoToggle() {
    if (!videoEngaged && videoInput.kind === "library" && !rememberedAvailable) {
      setLibraryOpen(true);
      return;
    }
    playground.toggleVideo();
  }

  return (
    <div className={cn("flex shrink-0 flex-col items-center gap-2", className)}>
      {audio.error ? <p className="px-4 text-center text-xs text-destructive">{audio.error}</p> : null}
      <div
        aria-label="Media controls"
        className="flex items-center gap-3 rounded-full bg-background p-2 ring-1 ring-foreground/10"
        role="toolbar"
      >
        <SplitControl label="Audio" menu={<AudioMenu playground={playground} />}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={audioLabel}
                aria-pressed={audio.enabled}
                className={ROUND_BUTTON_CLASS}
                onClick={audio.toggle}
                size="icon"
                type="button"
                variant={audio.enabled ? "secondary" : "destructive"}
              >
                {audio.pending ? <Spinner className="size-5" /> : audio.enabled ? <MicIcon /> : <MicOffIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{audioLabel}</TooltipContent>
          </Tooltip>
        </SplitControl>
        <SplitControl
          label="Video"
          menu={
            <VideoMenu
              onBrowseLibrary={() => setLibraryOpen(true)}
              playground={playground}
              videoLibrary={videoLibrary}
            />
          }
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={videoLabel}
                aria-pressed={videoEngaged}
                className={ROUND_BUTTON_CLASS}
                onClick={handleVideoToggle}
                size="icon"
                type="button"
                variant={videoEngaged ? "secondary" : "destructive"}
              >
                {videoPending ? <Spinner className="size-5" /> : videoEngaged ? <VideoIcon /> : <VideoOffIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{videoLabel}</TooltipContent>
          </Tooltip>
        </SplitControl>
      </div>
      <VideoLibraryDialog
        activeVideoKey={fileActive && activeVideo ? videoKey(activeVideo) : null}
        library={videoLibrary}
        onClearVideo={playground.clearVideo}
        onOpenChange={setLibraryOpen}
        onSelectVideo={playground.selectVideo}
        open={libraryOpen}
      />
    </div>
  );
}
