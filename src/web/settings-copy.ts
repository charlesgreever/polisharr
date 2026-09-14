export function sizeCapLabel(key: string): string {
  if (key === "movie1080p") return "Movie 1080p";
  if (key === "movie4kSdr") return "Movie 4K SDR";
  if (key === "movie4kHdr") return "Movie 4K HDR";
  if (key === "tv1080p") return "TV 1080p";
  if (key === "tv4k") return "TV 4K SDR";
  if (key === "tv4kHdr") return "TV 4K HDR";
  return key;
}

export const SIZE_CAP_GRID: Array<{ heading: string; cells: Array<{ key: string; row: string }> }> = [
  {
    heading: "Movies",
    cells: [
      { key: "movie1080p", row: "1080p" },
      { key: "movie4kSdr", row: "4K SDR" },
      { key: "movie4kHdr", row: "4K HDR" },
    ],
  },
  {
    heading: "TV",
    cells: [
      { key: "tv1080p", row: "1080p" },
      { key: "tv4k", row: "4K SDR" },
      { key: "tv4kHdr", row: "4K HDR" },
    ],
  },
];

export function transcodeBelowTargetLabel(target: "hevc" | "av1"): string {
  return `Transcode video below Target Encode (${target === "av1" ? "AV1" : "HEVC"})`;
}

export function hardwareBackendLabel(backend: string): string {
  if (backend === "cuda") return "CUDA";
  if (backend === "vaapi") return "VAAPI";
  if (backend === "videotoolbox") return "VideoToolbox";
  return backend;
}

export const FIELD_CONTROL = "h-10 w-full";

export const PLAYBACK_OBSERVE_HELP =
  "When this is on, Polisharr records which Jellyfin player converted a file and why. It stores the device name and viewing time, not usernames or IP addresses.";

export const PLAYBACK_HISTORY_CLEARED =
  "Viewing history cleared. Live playback coverage is unchanged.";

export const PLAYBACK_HISTORY_CONFIRM =
  "Clear all viewing history and dismissed recommendations? Live playback coverage stays on.";

export function playbackFamilyLabel(family: string): string {
  if (family === "audio") return "Audio conversion";
  if (family === "video") return "Video conversion";
  if (family === "subtitle") return "Subtitle conversion";
  if (family === "container") return "Container conversion";
  if (family === "bitrate") return "Bitrate limit";
  if (family === "unknown") return "Unknown reason";
  if (family === "mixed") return "More than one reason";
  if (family === "other") return "Other conversion";
  return family;
}

export function playbackHealthLabel(status: string, stale = false): string {
  if (status === "off") return "Observation is off";
  if (stale || status === "stale") return "Last check is stale";
  if (status === "playing") return "Jellyfin is playing";
  if (status === "idle") return "Jellyfin is idle";
  if (status === "unknown") return "Playback status is not known yet";
  if (status === "error") return "Jellyfin could not be reached";
  if (status === "incomplete") return "The last Jellyfin response was incomplete";
  if (status === "unavailable") return "Jellyfin playback is unavailable";
  return status;
}
