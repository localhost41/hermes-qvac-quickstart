import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  configPath,
  publicConfig,
  readSavedConfig,
  redactSecretText,
  redactSecrets,
  resetConfig,
  resolveConfig,
  saveConfig,
  validateConfig,
} from "../src/config.js";
import {
  beginnerCapacityMessage,
  main,
  parseArgs,
  physicalDownloadConsentMessage,
} from "../src/cli.js";

describe("configuration", () => {
  it("matches the agent-safe OpenClaw defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      model: "qwen3.5-9b",
      ctxSize: 32768,
      reasoningBudget: 0,
      tools: true,
      readyTimeoutMs: 900000,
      timeoutSeconds: 300,
    });
  });

  it("applies CLI over environment over saved config over defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = {
      HERMES_HOME: home,
      QVAC_MODEL: "qwen3.5-4b",
      QVAC_CTX_SIZE: "65536",
      QVAC_TOOLS: "false",
    };
    await saveConfig(
      { model: "qwen3.5-2b", reasoningBudget: 0 },
      { HERMES_HOME: home },
    );
    expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
    await expect(
      resolveConfig({ model: "qwen3.5-9b" }, env),
    ).resolves.toMatchObject({
      model: "qwen3.5-9b",
      ctxSize: 65536,
      reasoningBudget: 0,
      tools: false,
    });
    expect(configPath(env)).toBe(join(home, "hermes-qvac", "config.json"));
    expect(await resetConfig(env)).toBe(true);
    expect(await resetConfig(env)).toBe(false);
  });

  it("rejects unknown keys in saved JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = { HERMES_HOME: home };
    await mkdir(join(home, "hermes-qvac"), { recursive: true });
    await writeFile(configPath(env), JSON.stringify({ surprise: true }));
    await expect(resolveConfig({}, env)).rejects.toThrow(
      "unknown saved config key",
    );
  });

  it("reports malformed saved JSON with its path", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = { HERMES_HOME: home };
    await mkdir(join(home, "hermes-qvac"), { recursive: true });
    await writeFile(configPath(env), "{not-json");
    await expect(resolveConfig({}, env)).rejects.toThrow(configPath(env));
  });

  it("rejects oversized and symbolic saved configuration files", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = { HERMES_HOME: home };
    await mkdir(join(home, "hermes-qvac"), { recursive: true });
    await writeFile(configPath(env), "x".repeat(64 * 1024 + 1));
    await expect(readSavedConfig(env)).rejects.toThrow("exceeds 64 KiB");

    await rm(configPath(env));
    const source = join(home, "outside-config.json");
    await writeFile(source, "{}");
    await symlink(source, configPath(env));
    await expect(readSavedConfig(env)).rejects.toThrow("regular file");
  });

  it("refuses to save through a symbolic configuration directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const outside = await mkdtemp(join(tmpdir(), "hermes-qvac-outside-"));
    await symlink(outside, join(home, "hermes-qvac"));
    await expect(
      saveConfig({ ctxSize: 65536 }, { HERMES_HOME: home }),
    ).rejects.toThrow("unsafe configuration directory");
    await expect(stat(join(outside, "config.json"))).rejects.toThrow();
  });

  it("rejects unsafe bind hosts and invalid resource values", () => {
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, host: "0.0.0.0" }),
    ).toThrow("loopback");
    expect(() => validateConfig({ ...DEFAULT_CONFIG, port: 70000 })).toThrow(
      "at most 65535",
    );
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, reasoningBudget: -2 }),
    ).toThrow("-1");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, cwd: "/tmp", reuse: true }),
    ).toThrow("reuse=false");
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        baseURL: "http://127.0.0.1:9000/not-v1",
      }),
    ).toThrow("end in /v1");
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        baseURL: "http://user:secret@127.0.0.1:9000/v1",
      }),
    ).toThrow("must not embed credentials");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, model: "not-real" }),
    ).toThrow("unknown model");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, surprise: true } as never),
    ).toThrow("unknown config key");
    expect(() => validateConfig({ ...DEFAULT_CONFIG, baseURL: "" })).toThrow(
      "baseURL",
    );
    expect(() => validateConfig({ ...DEFAULT_CONFIG, apiKey: "  " })).toThrow(
      "single-line",
    );
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, apiKey: "key\r\nheader: value" }),
    ).toThrow("single-line");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, readyTimeoutMs: 2_147_483_648 }),
    ).toThrow("at most");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, idleStopMs: 2_147_483_648 }),
    ).toThrow("at most");
    expect(() =>
      validateConfig({ ...DEFAULT_CONFIG, timeoutSeconds: 2_147_484 }),
    ).toThrow("at most");
  });

  it("persists only explicit overrides and stores normalized model IDs", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = { HERMES_HOME: home };
    const effective = await saveConfig(
      { model: "QWEN3_5_4B_MULTIMODAL_Q4_K_M", ctxSize: 65536 },
      env,
    );
    expect(effective).toMatchObject({ model: "qwen3.5-4b", ctxSize: 65536 });
    expect(JSON.parse(await readFile(configPath(env), "utf8"))).toEqual({
      model: "qwen3.5-4b",
      ctxSize: 65536,
    });
  });

  it("redacts a non-placeholder API key", () => {
    expect(publicConfig({ ...DEFAULT_CONFIG, apiKey: "secret" }).apiKey).toBe(
      "[redacted]",
    );
    expect(
      redactSecrets({
        nested: { authorization: "Bearer secret", controlToken: "secret" },
        value: "safe",
      }),
    ).toEqual({
      nested: { authorization: "[redacted]", controlToken: "[redacted]" },
      value: "safe",
    });
    expect(redactSecretText("before private-key after", ["private-key"])).toBe(
      "before [redacted] after",
    );
  });

  it("normalizes SDK constants to friendly IDs", () => {
    expect(
      validateConfig({
        ...DEFAULT_CONFIG,
        model: "QWEN3_5_4B_MULTIMODAL_Q4_K_M",
      }).model,
    ).toBe("qwen3.5-4b");
  });

  it("accepts endpoint-advertised custom aliases only in external mode", () => {
    expect(
      validateConfig({
        ...DEFAULT_CONFIG,
        baseURL: "http://127.0.0.1:11435/v1",
        model: "qvac-local",
        auxModel: "qvac-local",
      }),
    ).toMatchObject({ model: "qvac-local", auxModel: "qvac-local" });
    expect(() =>
      validateConfig({
        ...DEFAULT_CONFIG,
        model: "qvac-local",
        auxModel: "qvac-local",
      }),
    ).toThrow("unknown model");
  });

  it("uses unique atomic files for concurrent last-writer-wins saves", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-config-"));
    const env = { HERMES_HOME: home };
    await Promise.all([
      saveConfig({ model: "qwen3.5-2b" }, env),
      saveConfig({ model: "qwen3.5-4b" }, env),
      saveConfig({ model: "qwen3.5-9b" }, env),
    ]);
    const saved = JSON.parse(await readFile(configPath(env), "utf8")) as {
      model: string;
    };
    expect(["qwen3.5-2b", "qwen3.5-4b", "qwen3.5-9b"]).toContain(saved.model);
    expect((await stat(join(home, "hermes-qvac"))).mode & 0o777).toBe(0o700);
  });
});

describe("CLI parsing", () => {
  it("parses the complete OpenClaw-equivalent option surface", () => {
    expect(
      parseArgs([
        "run",
        "--model",
        "qwen3.5-4b",
        "--aux-model",
        "qwen3.5-0.8b",
        "--port",
        "11500",
        "--ctx-size",
        "65536",
        "--reasoning-budget",
        "0",
        "--no-tools",
        "--no-reuse",
        "--",
        "--cli",
      ]),
    ).toMatchObject({
      command: "run",
      hermesArgs: ["--cli"],
      config: {
        model: "qwen3.5-4b",
        auxModel: "qwen3.5-0.8b",
        port: 11500,
        ctxSize: 65536,
        reasoningBudget: 0,
        tools: false,
        reuse: false,
      },
    });
  });

  it("rejects unknown and valueless options", () => {
    expect(() => parseArgs(["run", "--wat"])).toThrow("unknown option");
    expect(() => parseArgs(["run", "--model"])).toThrow("requires a value");
  });

  it("supports conventional top-level help and version flags", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  it("parses the status-only running requirement", () => {
    expect(parseArgs(["status", "--require-running", "--json"])).toMatchObject({
      command: "status",
      requireRunning: true,
      json: true,
    });
  });

  it("requires an isolated non-reused directory for outcome-verified tool smoke", async () => {
    await expect(main(["smoke", "--tool-task", "--yes"])).resolves.toBe(2);
    expect(
      parseArgs([
        "smoke",
        "--tool-task",
        "--cwd",
        "/tmp/tool-proof",
        "--no-reuse",
        "--yes",
      ]),
    ).toMatchObject({
      command: "smoke",
      toolTask: true,
      yes: true,
      config: { cwd: "/tmp/tool-proof", reuse: false },
    });
  });

  it("returns the documented usage code for invalid command shapes", async () => {
    await expect(main(["models", "unexpected"])).resolves.toBe(2);
    await expect(main(["models", "list", "unexpected"])).resolves.toBe(2);
    await expect(main(["run", "--", "--provider=other"])).resolves.toBe(2);
    await expect(main(["run", "--", "-m", "other"])).resolves.toBe(2);
    await expect(main(["config", "set"])).resolves.toBe(2);
    await expect(main(["serve", "--", "--cli"])).resolves.toBe(2);
  });

  it("states the official main-plus-aux download estimate before physical smoke", () => {
    expect(
      physicalDownloadConsentMessage({
        ...DEFAULT_CONFIG,
        model: "qwen3.5-0.8b",
      }),
    ).toContain("approximately 1.69 GiB");
  });

  it("exposes start as the beginner managed path", () => {
    expect(parseArgs(["start", "--yes", "--", "--cli"])).toMatchObject({
      command: "start",
      yes: true,
      hermesArgs: ["--cli"],
    });
    expect(beginnerCapacityMessage(DEFAULT_CONFIG, 16 * 1024 ** 3)).toContain(
      "16.0 GiB total memory",
    );
  });

  it("keeps the beginner path managed", async () => {
    await expect(main(["start", "--external"])).resolves.toBe(2);
  });

  it("requires explicit download consent before beginner setup in automation", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-start-consent-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-start-bin-"));
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "Hermes Agent v0.19.0"; fi\nexit 0\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "start", "--model", "qwen3.5-0.8b"],
      {
        env: {
          ...process.env,
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Re-run with --yes");
    await expect(
      stat(join(home, ".hermes", "plugins", "model-providers", "qvac")),
    ).rejects.toThrow();
  });

  it("provides command-specific help, version, model info, and non-mutating validation", async () => {
    await expect(
      main(["models", "info", "qwen3.5-9b", "--json"]),
    ).resolves.toBe(0);
    await expect(main(["version", "--json"])).resolves.toBe(0);
    await expect(main(["doctor", "--help"])).resolves.toBe(0);
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-validate-"));
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "config", "validate", "--json"],
      { env: { ...process.env, HERMES_HOME: home }, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      valid: true,
      mutated: false,
    });
    await expect(stat(configPath({ HERMES_HOME: home }))).rejects.toThrow();
  });

  it("setup persists explicit CLI options without capturing environment overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-setup-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-setup-bin-"));
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo \'Hermes Agent test\'; fi\nexit 0\n',
      { mode: 0o755 },
    );
    await chmod(hermes, 0o755);
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "setup", "--ctx-size", "65536", "--json"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HERMES_HOME: home,
          QVAC_MODEL: "qwen3.5-4b",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const saved = JSON.parse(
      await readFile(configPath({ HERMES_HOME: home }), "utf8"),
    ) as { ctxSize: number };
    expect(saved).toEqual({ ctxSize: 65536 });
  });

  it("restores saved configuration when plugin setup fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-setup-rollback-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-setup-bin-"));
    const env = { HERMES_HOME: home };
    await saveConfig({ ctxSize: 16384 }, env);
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "Hermes Agent test"; exit 0; fi\nexit 23\n',
      { mode: 0o755 },
    );
    await chmod(hermes, 0o755);
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "setup", "--ctx-size", "65536", "--json"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HERMES_HOME: home,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(4);
    expect(JSON.parse(await readFile(configPath(env), "utf8"))).toEqual({
      ctxSize: 16384,
    });
  });

  it("restores saved configuration when beginner setup fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-start-rollback-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-start-bin-"));
    const hermesHome = join(home, ".hermes");
    const env = { HERMES_HOME: hermesHome };
    await saveConfig({ model: "qwen3.5-4b" }, env);
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "Hermes Agent v0.19.0"; exit 0; fi\nexit 23\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "start", "--model", "qwen3.5-0.8b", "--yes"],
      {
        env: {
          ...process.env,
          HOME: home,
          HERMES_HOME: hermesHome,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(4);
    expect(JSON.parse(await readFile(configPath(env), "utf8"))).toEqual({
      model: "qwen3.5-4b",
    });
  });
});
