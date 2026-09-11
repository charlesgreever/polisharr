import { describe, expect, it } from "vitest";
import { chooseBackend, encodeApiLabel, gpuNameFromPci, gpuNameFromSysctl, parseEncoders, probeEncodeDevices } from "./hardware.ts";

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
