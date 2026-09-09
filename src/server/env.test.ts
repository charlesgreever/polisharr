import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, readAppVersion } from "./env.ts";

describe("env", () => {
  it("renames an existing Optimizarr database to polisharr.db", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-env-"));
    writeFileSync(join(dir, "optimizarr.db"), "ok");
    const env = loadEnv({ CONFIG_DIR: dir });
    expect(env.dbPath).toBe(join(dir, "polisharr.db"));
  });

  it("accepts the previous widget key and trust-proxy names", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-env-"));
    const env = loadEnv({ CONFIG_DIR: dir, OPTIMIZARR_WIDGET_KEY: "k", OPTIMIZARR_TRUST_PROXY: "1" });
    expect(env.widgetKeyEnv).toBe("k");
    expect(env.trustProxy).toBe(true);
  });

  it("reads the package version for health and chrome", () => {
    expect(readAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("defaults cluster role to standalone and reads node env", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-env-"));
    expect(loadEnv({ CONFIG_DIR: dir }).role).toBe("standalone");
    expect(loadEnv({ CONFIG_DIR: dir }).nodeName).toBeNull();
    expect(loadEnv({ CONFIG_DIR: dir }).masterUrl).toBeNull();
    const worker = loadEnv({
      CONFIG_DIR: dir,
      POLISHARR_ROLE: "worker",
      POLISHARR_NODE_NAME: "5090",
      POLISHARR_MASTER_URL: "http://192.168.1.10:7373",
      POLISHARR_CLUSTER_TOKEN: "secret-token",
    });
    expect(worker.role).toBe("worker");
    expect(worker.nodeName).toBe("5090");
    expect(worker.masterUrl).toBe("http://192.168.1.10:7373");
    expect(worker.clusterTokenEnv).toBe("secret-token");
    expect(loadEnv({ CONFIG_DIR: dir, POLISHARR_ROLE: "master" }).role).toBe("master");
    expect(loadEnv({ CONFIG_DIR: dir, POLISHARR_ROLE: "replica" }).role).toBe("standalone");
  });

  it("reads an optional language-identification command", () => {
    const dir = mkdtempSync(join(tmpdir(), "opt-env-"));
    expect(loadEnv({ CONFIG_DIR: dir }).whisperLid).toBeNull();
    expect(loadEnv({ CONFIG_DIR: dir, WHISPER_LID: "/usr/local/bin/whisper-lid" }).whisperLid).toBe("/usr/local/bin/whisper-lid");
    expect(loadEnv({ CONFIG_DIR: dir }).pgsOcr).toBeNull();
    expect(loadEnv({ CONFIG_DIR: dir, PGS_OCR: "/usr/local/bin/pgs-ocr" }).pgsOcr).toBe("/usr/local/bin/pgs-ocr");
  });
});
