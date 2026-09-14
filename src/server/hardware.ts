import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  NO_PREVIEW_CAPABILITY,
  PREVIEW_PROTOCOL_VERSION,
  PREVIEW_SDR_1080P_PROFILE,
  type PreviewCapability,
} from "./cluster.ts";
import type { HardwareBackend, HardwareInfo, PreviewH264Encoder } from "./types.ts";

const execFileAsync = promisify(execFile);

export type HardwareProbe = () => Promise<HardwareInfo>;

export type EncoderListing = {
  nvenc: boolean;
  vaapi: boolean;
  videotoolbox: boolean;
  nvencAv1: boolean;
  vaapiAv1: boolean;
  videotoolboxAv1: boolean;
  qsv: boolean;
};

export type EncodeDevices = {
  nvidia: boolean;
  vaapi: boolean;
  vaapiDevice: string | null;
  videotoolbox: boolean;
};

export function parseEncoders(text: string): EncoderListing {
  const lower = text.toLowerCase();
  return {
    nvenc: /\b(hevc_nvenc|h264_nvenc)\b/.test(lower),
    vaapi: /\b(hevc_vaapi|h264_vaapi)\b/.test(lower),
    videotoolbox: /\b(hevc_videotoolbox|h264_videotoolbox)\b/.test(lower),
    nvencAv1: /\bav1_nvenc\b/.test(lower),
    vaapiAv1: /\b(av1_vaapi|av1_qsv)\b/.test(lower),
    videotoolboxAv1: /\bav1_videotoolbox\b/.test(lower),
    qsv: /\b(h264_qsv|hevc_qsv|av1_qsv)\b/.test(lower),
  };
}

export function parseH264PreviewEncoders(text: string): { nvenc: boolean; vaapi: boolean; videotoolbox: boolean } {
  const lower = text.toLowerCase();
  return {
    nvenc: /\bh264_nvenc\b/.test(lower),
    vaapi: /\bh264_vaapi\b/.test(lower),
    videotoolbox: /\bh264_videotoolbox\b/.test(lower),
  };
}

export function choosePreviewEncoder(
  listed: { nvenc: boolean; vaapi: boolean; videotoolbox: boolean },
  backend: HardwareBackend,
): PreviewH264Encoder | null {
  if (backend === "cuda" && listed.nvenc) return "h264_nvenc";
  if (backend === "vaapi" && listed.vaapi) return "h264_vaapi";
  if (backend === "videotoolbox" && listed.videotoolbox) return "h264_videotoolbox";
  return null;
}

export type PreviewSmokeCheck = (input: {
  ffmpeg: string;
  encoder: PreviewH264Encoder;
  vaapiDevice?: string | null;
}) => Promise<boolean>;

export async function defaultPreviewSmoke(input: {
  ffmpeg: string;
  encoder: PreviewH264Encoder;
  vaapiDevice?: string | null;
}): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "polisharr-preview-smoke-"));
  const out = join(dir, "smoke.mp4");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=1:duration=1",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    "1",
    "-c:v",
    input.encoder,
    "-c:a",
    "aac",
    "-f",
    "mp4",
    "-y",
    out,
  ];
  if (input.encoder === "h264_vaapi" && input.vaapiDevice) {
    args.splice(3, 0, "-vaapi_device", input.vaapiDevice);
  }
  try {
    await execFileAsync(input.ffmpeg, args, { timeout: 8000 });
    const { stdout, stderr } = await execFileAsync("ffprobe", ["-hide_banner", "-print_format", "json", "-show_streams", out], { timeout: 5000 });
    const parsed: unknown = JSON.parse(`${stdout}`);
    const streams = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { streams?: unknown }).streams
      : null;
    if (!Array.isArray(streams)) return false;
    const hasH264 = streams.some((stream) => stream && typeof stream === "object" && (stream as { codec_name?: unknown }).codec_name === "h264");
    const hasAac = streams.some((stream) => stream && typeof stream === "object" && (stream as { codec_name?: unknown }).codec_name === "aac");
    return hasH264 && hasAac && !String(stderr).toLowerCase().includes("error");
  } catch {
    return false;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Temp smoke files may already be gone.
    }
  }
}

export async function probePreviewCapability(
  ffmpeg: string,
  hardware: HardwareInfo,
  listEncoders: () => Promise<string> = async () => {
    const { stdout, stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 8000 });
    return `${stdout}\n${stderr}`;
  },
  smoke: PreviewSmokeCheck = defaultPreviewSmoke,
): Promise<PreviewCapability> {
  if (hardware.backend === "none") return { ...NO_PREVIEW_CAPABILITY };
  let listing = "";
  try {
    listing = await listEncoders();
  } catch {
    return { ...NO_PREVIEW_CAPABILITY };
  }
  const encoder = choosePreviewEncoder(parseH264PreviewEncoders(listing), hardware.backend);
  if (!encoder) return { ...NO_PREVIEW_CAPABILITY };
  let ok = false;
  try {
    ok = await smoke({ ffmpeg, encoder, vaapiDevice: hardware.vaapiDevice });
  } catch {
    return { ...NO_PREVIEW_CAPABILITY };
  }
  if (!ok) return { ...NO_PREVIEW_CAPABILITY };
  return {
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    h264Encoder: encoder,
    profiles: [PREVIEW_SDR_1080P_PROFILE],
  };
}

export function probeEncodeDevices(
  dirents: string[] | null = null,
  platform: NodeJS.Platform = process.platform,
): EncodeDevices {
  const nvidia = existsSync("/dev/nvidia0") || existsSync("/dev/nvidiactl");
  const names = dirents ?? listRenderNodes();
  const preferred = names.includes("renderD128") ? "renderD128" : names[0];
  const vaapiDevice = preferred ? `/dev/dri/${preferred}` : null;
  return { nvidia, vaapi: Boolean(vaapiDevice), vaapiDevice, videotoolbox: platform === "darwin" };
}

export function chooseBackend(encoders: EncoderListing, devices: EncodeDevices): HardwareInfo {
  const cuda = encoders.nvenc && devices.nvidia;
  const vaapi = encoders.vaapi && devices.vaapi;
  const videotoolbox = encoders.videotoolbox && devices.videotoolbox;
  const backend: HardwareBackend = cuda ? "cuda" : vaapi ? "vaapi" : videotoolbox ? "videotoolbox" : "none";
  return {
    backend,
    cuda,
    vaapi,
    videotoolbox,
    av1: backend === "cuda"
      ? encoders.nvencAv1
      : backend === "vaapi"
        ? encoders.vaapiAv1
        : backend === "videotoolbox"
          ? encoders.videotoolboxAv1
          : false,
    reason: noneReason(encoders, devices, backend),
    vaapiDevice: backend === "vaapi" ? devices.vaapiDevice : null,
    qsv: Boolean(encoders.qsv && vaapi && !cuda),
  };
}

export function detectHardware(ffmpeg = "ffmpeg", devices: () => EncodeDevices = probeEncodeDevices): HardwareProbe {
  return async () => {
    try {
      const { stderr, stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 8000 });
      const info = chooseBackend(parseEncoders(`${stdout}\n${stderr}`), devices());
      return { ...info, gpuName: await probeGpuName() };
    } catch (error) {
      return {
        backend: "none",
        cuda: false,
        vaapi: false,
        videotoolbox: false,
        av1: false,
        reason: error instanceof Error ? error.message : "ffmpeg is not available.",
        vaapiDevice: null,
        gpuName: null,
        qsv: false,
      };
    }
  };
}

const PCI_GPU_NAMES: Record<string, string> = {
  "0x8086:0xe223": "Intel Battlemage G31",
  "0x1002:0x164e": "AMD Raphael",
};

export function gpuNameFromPci(vendor: string, device: string): string | null {
  const key = `${vendor.trim().toLowerCase()}:${device.trim().toLowerCase()}`;
  if (PCI_GPU_NAMES[key]) return PCI_GPU_NAMES[key];
  if (vendor.trim().toLowerCase() === "0x8086") return "Intel GPU";
  if (vendor.trim().toLowerCase() === "0x1002") return "AMD GPU";
  if (vendor.trim().toLowerCase() === "0x10de") return "NVIDIA GPU";
  return null;
}

export function encodeApiLabel(backend: HardwareBackend | undefined): string | null {
  if (backend === "cuda") return "CUDA";
  if (backend === "vaapi") return "VAAPI";
  if (backend === "videotoolbox") return "VideoToolbox";
  return null;
}

export function gpuNameFromSysctl(brand: string): string | null {
  const name = brand.trim();
  return name.length > 0 ? name : null;
}

export async function probeGpuName(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 3000 });
    const name = stdout.split("\n").map((line) => line.trim()).find(Boolean);
    if (name) return name;
  } catch {
    // No NVIDIA tool on this node.
  }
  try {
    const vendor = readFileSync("/sys/class/drm/renderD128/device/vendor", "utf8");
    const device = readFileSync("/sys/class/drm/renderD128/device/device", "utf8");
    return gpuNameFromPci(vendor, device);
  } catch {
    // No DRM sysfs on this node (typical on macOS).
  }
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 3000 });
    return gpuNameFromSysctl(stdout);
  } catch {
    return null;
  }
}

function listRenderNodes(): string[] {
  try {
    return readdirSync("/dev/dri").filter((name) => name.startsWith("renderD")).sort();
  } catch {
    return [];
  }
}

function noneReason(encoders: EncoderListing, devices: EncodeDevices, backend: HardwareBackend): string | null {
  if (backend !== "none") return null;
  if (encoders.nvenc && !devices.nvidia) {
    return "ffmpeg lists NVIDIA encode, but no NVIDIA device is visible to this container.";
  }
  if (encoders.vaapi && !devices.vaapi) {
    return "ffmpeg lists VAAPI encode, but /dev/dri is not visible to this container.";
  }
  if (encoders.videotoolbox && !devices.videotoolbox) {
    return "ffmpeg lists the Apple media engine, but this process is not running on macOS. A Linux container on a Mac cannot use that encoder.";
  }
  return "No NVIDIA, Intel/AMD, or Apple media engine encoder is visible to ffmpeg.";
}
