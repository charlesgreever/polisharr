import { describe, expect, it } from "vitest";
import { chooseBackend, choosePreviewEncoder, createPreviewCapabilityProbe, encodeApiLabel, gpuNameFromPci, gpuNameFromSysctl, parseEncoders, parseH264PreviewEncoders, probeEncodeDevices, probePreviewCapability } from "./hardware.ts";

const jellyfinBoth = `
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V..... av1_nvenc            NVIDIA NVENC av1 encoder (codec av1)
 V..... h264_vaapi           H.264 (VAAPI) (codec h264)
 V..... hevc_vaapi           H.265/HEVC (VAAPI) (codec hevc)
 V..... av1_vaapi            AV1 (VAAPI) (codec av1)
 V..... av1_qsv              AV1 (Intel Quick Sync Video acceleration) (codec av1)
`;

const hevcOnly = `
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
`;

const brewVideotoolbox = `
 V..... h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V..... hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 V..... av1_videotoolbox     VideoToolbox AV1 Encoder (codec av1)
`;

describe("hardware encoder listing", () => {
  it("marks NVIDIA AV1 when av1_nvenc is listed", () => {
    const encoders = parseEncoders(jellyfinBoth);
    expect(encoders.nvenc).toBe(true);
    expect(encoders.vaapi).toBe(true);
    expect(encoders.videotoolbox).toBe(false);
    expect(encoders.nvencAv1).toBe(true);
    expect(encoders.vaapiAv1).toBe(true);
  });

  it("hides AV1 when only HEVC NVENC is listed", () => {
    const encoders = parseEncoders(hevcOnly);
    expect(encoders.nvenc).toBe(true);
    expect(encoders.nvencAv1).toBe(false);
  });

  it("marks the Apple media engine when VideoToolbox encoders are listed", () => {
    const encoders = parseEncoders(brewVideotoolbox);
    expect(encoders.videotoolbox).toBe(true);
    expect(encoders.videotoolboxAv1).toBe(true);
    expect(encoders.nvenc).toBe(false);
  });
});

describe("hardware backend choice", () => {
  it("uses VAAPI when ffmpeg lists NVENC but the container has no NVIDIA device", () => {
    const hw = chooseBackend(parseEncoders(jellyfinBoth), {
      nvidia: false,
      vaapi: true,
      vaapiDevice: "/dev/dri/renderD128",
      videotoolbox: false,
    });
    expect(hw.backend).toBe("vaapi");
    expect(hw.cuda).toBe(false);
    expect(hw.vaapi).toBe(true);
    expect(hw.av1).toBe(true);
    expect(hw.qsv).toBe(true);
    expect(hw.vaapiDevice).toBe("/dev/dri/renderD128");
    expect(hw.reason).toBeNull();
  });

  it("uses CUDA when an NVIDIA device is visible", () => {
    const hw = chooseBackend(parseEncoders(jellyfinBoth), {
      nvidia: true,
      vaapi: true,
      vaapiDevice: "/dev/dri/renderD128",
      videotoolbox: false,
    });
    expect(hw.backend).toBe("cuda");
    expect(hw.cuda).toBe(true);
    expect(hw.av1).toBe(true);
    expect(hw.qsv).toBe(false);
  });

  it("uses VideoToolbox on macOS when ffmpeg lists the Apple media engine", () => {
    const hw = chooseBackend(parseEncoders(brewVideotoolbox), {
      nvidia: false,
      vaapi: false,
      vaapiDevice: null,
      videotoolbox: true,
    });
    expect(hw.backend).toBe("videotoolbox");
    expect(hw.videotoolbox).toBe(true);
    expect(hw.av1).toBe(true);
    expect(hw.reason).toBeNull();
  });

  it("does not treat a Linux container on a Mac as VideoToolbox", () => {
    const hw = chooseBackend(parseEncoders(brewVideotoolbox), {
      nvidia: false,
      vaapi: false,
      vaapiDevice: null,
      videotoolbox: false,
    });
    expect(hw.backend).toBe("none");
    expect(hw.reason).toMatch(/not running on macOS/i);
  });

  it("names PCI devices and maps backends to CUDA, VAAPI, or VideoToolbox, not QuickSync", () => {
    expect(gpuNameFromPci("0x8086", "0xe223")).toBe("Intel Battlemage G31");
    expect(gpuNameFromPci("0x1002", "0x164e")).toBe("AMD Raphael");
    expect(gpuNameFromPci("0x8086", "0x1234")).toBe("Intel GPU");
    expect(gpuNameFromSysctl("Apple M4 Pro")).toBe("Apple M4 Pro");
    expect(encodeApiLabel("cuda")).toBe("CUDA");
    expect(encodeApiLabel("vaapi")).toBe("VAAPI");
    expect(encodeApiLabel("videotoolbox")).toBe("VideoToolbox");
    expect(encodeApiLabel("vaapi")).not.toBe("QuickSync");
    expect(encodeApiLabel("none")).toBeNull();
  });

  it("fails closed when encoders are listed but no GPU device is visible", () => {
    const hw = chooseBackend(parseEncoders(jellyfinBoth), {
      nvidia: false,
      vaapi: false,
      vaapiDevice: null,
      videotoolbox: false,
    });
    expect(hw.backend).toBe("none");
    expect(hw.reason).toMatch(/no NVIDIA device/i);
  });

  it("treats darwin as the Apple media engine device and linux as not", () => {
    expect(probeEncodeDevices([], "darwin").videotoolbox).toBe(true);
    expect(probeEncodeDevices([], "linux").videotoolbox).toBe(false);
  });
});

describe("H.264 preview capability", () => {
  it("does not treat HEVC-only listing as H.264 preview support", () => {
    const hevcNvencOnly = `
 V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
`;
    expect(parseH264PreviewEncoders(hevcNvencOnly).nvenc).toBe(false);
    expect(parseEncoders(hevcNvencOnly).nvenc).toBe(true);
    expect(choosePreviewEncoder(parseH264PreviewEncoders(hevcNvencOnly), "cuda")).toBeNull();
  });

  it("advertises a profile only after a successful smoke check", async () => {
    const hw = { backend: "cuda" as const, cuda: true, vaapi: false, av1: false, reason: null };
    const listing = `
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V..... hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
`;
    const ok = await probePreviewCapability("ffmpeg", hw, async () => listing, async () => true);
    expect(ok.h264Encoder).toBe("h264_nvenc");
    expect(ok.profiles).toEqual(["sdr-1080p-h264"]);
    const failed = await probePreviewCapability("ffmpeg", hw, async () => listing, async () => false);
    expect(failed.h264Encoder).toBeNull();
    expect(failed.profiles).toEqual([]);
  });

  it("fails closed when smoke throws or the backend is none", async () => {
    const none = await probePreviewCapability("ffmpeg", { backend: "none", cuda: false, vaapi: false, av1: false, reason: null }, async () => "h264_nvenc", async () => true);
    expect(none.h264Encoder).toBeNull();
    const threw = await probePreviewCapability(
      "ffmpeg",
      { backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null },
      async () => "h264_nvenc",
      async () => {
        throw new Error("encoder missing");
      },
    );
    expect(threw.h264Encoder).toBeNull();
  });

  it("smokes H.264 once per encoder and keeps the profile if a later smoke would fail", async () => {
    const listing = `
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
`;
    let smokes = 0;
    const get = createPreviewCapabilityProbe({
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      hardware: async () => ({ backend: "cuda", cuda: true, vaapi: false, av1: false, reason: null }),
      listEncoders: async () => listing,
      smoke: async () => {
        smokes += 1;
        return smokes === 1;
      },
    });
    expect((await get()).h264Encoder).toBe("h264_nvenc");
    expect((await get()).h264Encoder).toBe("h264_nvenc");
    expect((await get()).profiles).toEqual(["sdr-1080p-h264"]);
    expect(smokes).toBe(1);
  });

  it("stops advertising preview when the hardware backend disappears", async () => {
    const listing = `
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
`;
    let backend: "cuda" | "none" = "cuda";
    const get = createPreviewCapabilityProbe({
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      hardware: async () => ({
        backend,
        cuda: backend === "cuda",
        vaapi: false,
        av1: false,
        reason: backend === "none" ? "No GPU." : null,
      }),
      listEncoders: async () => listing,
      smoke: async () => true,
    });
    expect((await get()).h264Encoder).toBe("h264_nvenc");
    backend = "none";
    expect((await get()).h264Encoder).toBeNull();
  });
});
