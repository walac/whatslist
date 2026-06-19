import { describe, it, expect, afterEach, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";

describe("getAuthDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses XDG_CONFIG_HOME when set", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/custom/config");
    const { getAuthDir } = await import("../src/config.js");
    expect(getAuthDir()).toBe("/custom/config/whatslist/auth");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is not set", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "");
    const { getAuthDir } = await import("../src/config.js");
    expect(getAuthDir()).toBe(join(homedir(), ".config", "whatslist", "auth"));
  });
});
