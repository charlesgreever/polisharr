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
