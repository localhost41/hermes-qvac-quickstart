import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  clearServeState,
  createManagedModels,
  createSessionControl,
  doctor,
  endpointModels,
  waitForEndpointModels,
  estimatedPreloadBytes,
  modelStoragePreflight,
  installPlugin,
  listModels,
  pluginDir,
  qvacSystemPreflight,
  readServeState,
  readServeStateInventory,
  readServeStates,
  resolveModelConstant,
  runHermesCaptured,
  assertBareRuntimePlatform,
  setupPlugin,
  startManaged,
  stopOwnedServe,
  uninstallOwnedPlugin,
  uninstallPlugin,
  withMockQvac,
  writeServeState,
} from "../src/runtime.js";

describe("official QVAC catalog", () => {
  it("can resolve the installed Bare runtime for this platform", () => {
    expect(assertBareRuntimePlatform()).toContain(`${process.platform}-`);
  });
  it("resolves every friendly Hermes id to an SDK constant", () => {
    const models = listModels();
    expect(models).toHaveLength(8);
    expect(
      models.filter((model) => model.default).map((model) => model.id),
    ).toEqual(["qwen3.5-9b"]);
    for (const model of models)
      expect(resolveModelConstant(model.id)).toBe(model.constant);
  });

  it("rejects an unknown model before starting a process", async () => {
    await expect(
      startManaged({ ...DEFAULT_CONFIG, model: "definitely-not-a-qvac-model" }),
    ).rejects.toThrow("Unknown model");
  });

  it("returns a complete OpenAI stream with one terminal outcome", async () => {
    const fixture = await withMockQvac();
    try {
      const response = await fetch(`${fixture.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: DEFAULT_CONFIG.model,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      });
      const body = await response.text();
      expect(body.match(/finish_reason":"stop"/g)).toHaveLength(1);
      expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("configures the full catalog and preloads main plus auxiliary models", () => {
    const models = createManagedModels(DEFAULT_CONFIG);
    const config = { ctx_size: 32768, reasoning_budget: 0, tools: true };
    expect(models).toEqual([
      { name: "qwen3.5-0.8b", config, preload: false, default: false },
      { name: "qwen3.5-2b", config, preload: true, default: false },
      { name: "qwen3.5-4b", config, preload: false, default: false },
      { name: "qwen3.5-9b", config, preload: true, default: true },
      { name: "qwen3.6-27b", config, preload: false, default: false },
      { name: "qwen3.6-35b-a3b", config, preload: false, default: false },
      { name: "gpt-oss-20b", config, preload: false, default: false },
      { name: "gemma4-31b", config, preload: false, default: false },
    ]);
  });

  it("derives preload download estimates from official SDK metadata", () => {
    expect(estimatedPreloadBytes(DEFAULT_CONFIG)).toBe(
      5_680_522_464 + 1_280_835_840,
    );
    expect(
      estimatedPreloadBytes({ model: "qwen3.5-0.8b", auxModel: "qwen3.5-2b" }),
    ).toBe(532_517_120 + 1_280_835_840);
  });

  it("fails disk preflight before a cold model download can exhaust storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-storage-"));
    await expect(
      modelStoragePreflight(
        { model: "qwen3.5-0.8b", auxModel: "qwen3.5-2b" },
        { HOME: home },
        1024 ** 3,
      ),
    ).rejects.toThrow("Insufficient disk");
    await expect(
      modelStoragePreflight(
        { model: "qwen3.5-0.8b", auxModel: "qwen3.5-2b" },
        { HOME: home },
        10 * 1024 ** 3,
      ),
    ).resolves.toMatchObject({
      requiredDownloadBytes: 532_517_120 + 1_280_835_840,
      safetyBytes: 2 * 1024 ** 3,
    });
  });

  it("uses the official QVAC doctor report for system preflight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hermes-qvac-doctor-"));
    const binary = join(directory, "qvac");
    await writeFile(
      binary,
      `#!/bin/sh
printf '%s\\n' '{"ok":true,"platform":"darwin","arch":"arm64","nodeVersion":"26.3.0","sections":[{"checks":[{"id":"memory-total","label":"Total RAM","status":"pass","severity":"required","value":"16 GB"}]}]}'
`,
      { mode: 0o755 },
    );
    expect(qvacSystemPreflight({ qvacBin: binary })).toMatchObject({
      ok: true,
      platform: "darwin",
      arch: "arm64",
      checks: [{ id: "memory-total", value: "16 GB" }],
    });
  });

  it("rejects malformed QVAC doctor output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hermes-qvac-doctor-bad-"));
    const binary = join(directory, "qvac");
    await writeFile(binary, "#!/bin/sh\nprintf nope\n", { mode: 0o755 });
    expect(() => qvacSystemPreflight({ qvacBin: binary })).toThrow(
      "invalid JSON",
    );
  });

  it("exposes exact official ordering and expected sizes for every catalog entry", () => {
    expect(
      Object.fromEntries(
        listModels().map((model) => [model.id, model.downloadBytes]),
      ),
    ).toEqual({
      "qwen3.5-0.8b": 532_517_120,
      "qwen3.5-2b": 1_280_835_840,
      "qwen3.5-4b": 2_740_937_888,
      "qwen3.5-9b": 5_680_522_464,
      "qwen3.6-27b": 17_612_564_704,
      "qwen3.6-35b-a3b": 22_134_528_992,
      "gpt-oss-20b": 11_624_759_488,
      "gemma4-31b": 19_598_488_192,
    });
  });

  it("separates protocol smoke capability from verified agent-tool capability", () => {
    expect(
      listModels().find((model) => model.id === "qwen3.5-0.8b"),
    ).toMatchObject({
      experience: { tier: "smoke-chat", tools: "unsupported" },
    });
    expect(
      listModels().find((model) => model.id === "qwen3.5-9b"),
    ).toMatchObject({
      experience: { tier: "agent-candidate", tools: "outcome-verified" },
    });
  });
});

describe("Hermes plugin installation", () => {
  it("uses an explicit Hermes Python runtime for manual source installations", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-bin-"));
    const fixture = await withMockQvac();
    const hermes = join(bin, "hermes");
    const python = join(bin, "hermes-python");
    const source = join(home, "manual-hermes-source");
    await mkdir(source);
    await writeFile(
      hermes,
      `#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then printf "Hermes Agent v0.19.0\\nInstall directory: ${source}\\n"; else printf "enabled qvac 0.1.0-beta.3 copied\\n"; fi\n`,
      { mode: 0o755 },
    );
    const profile = {
      class: "QvacProviderProfile",
      provider_profile: true,
      name: "qvac",
      aliases: ["local-qvac", "qvac-local"],
      base_url: fixture.baseURL,
      models_url: "",
      supports_vision: true,
      fallback_models: listModels().map((model) => model.id),
      default_model: "qwen3.5-9b",
      default_aux_model: "qwen3.5-2b",
      default_max_tokens: 8192,
      context_window: 32768,
    };
    await writeFile(
      python,
      `#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify(profile)}'\n`,
      { mode: 0o755 },
    );
    const env = {
      HERMES_HOME: home,
      HERMES_PYTHON: python,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    try {
      await installPlugin(env);
      const result = await doctor(
        { ...DEFAULT_CONFIG, baseURL: fixture.baseURL },
        env,
      );
      expect(
        result.checks.find((check) => check.name === "provider-profile"),
      ).toMatchObject({ ok: true, required: true });
      expect(
        result.checks.find((check) => check.name === "hermes-version"),
      ).toMatchObject({ ok: true, required: false });
    } finally {
      await fixture.close();
    }
  });

  it("installs, upgrades, and removes only an owned plugin", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const env = { HERMES_HOME: home };
    expect((await installPlugin(env)).upgraded).toBe(false);
    expect(
      (await stat(join(pluginDir(env), ".hermes-qvac-provider.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect((await installPlugin(env)).upgraded).toBe(true);
    expect(await uninstallPlugin(env)).toBe(true);
    expect(await uninstallPlugin(env)).toBe(false);
  });

  it("refuses to replace an unrelated directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const target = pluginDir({ HERMES_HOME: home });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "plugin.yaml"), "id: somebody-else\n");
    await expect(installPlugin({ HERMES_HOME: home })).rejects.toThrow(
      "Refusing to replace",
    );
  });

  it("does not treat a forgeable package-name marker as deletion authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const env = { HERMES_HOME: home };
    const target = pluginDir(env);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, ".hermes-qvac-provider.json"),
      '{"package":"@localhost41/hermes-qvac-provider"}\n',
    );
    await writeFile(join(target, "valuable-user-file"), "preserve");

    await expect(uninstallPlugin(env)).rejects.toThrow("ownership marker");
    await expect(
      readFile(join(target, "valuable-user-file"), "utf8"),
    ).resolves.toBe("preserve");
  });

  it("refuses removal after an installed plugin payload is tampered with", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const env = { HERMES_HOME: home };
    await installPlugin(env);
    await writeFile(join(pluginDir(env), "plugin.yaml"), "id: altered\n");

    await expect(uninstallPlugin(env)).rejects.toThrow("ownership marker");
    await expect(stat(pluginDir(env))).resolves.toBeDefined();
  });

  it("refuses to delete unexpected files added to an owned plugin directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const env = { HERMES_HOME: home };
    await installPlugin(env);
    await writeFile(join(pluginDir(env), "user-notes"), "preserve");
    await expect(uninstallPlugin(env)).rejects.toThrow("ownership marker");
    await expect(
      readFile(join(pluginDir(env), "user-notes"), "utf8"),
    ).resolves.toBe("preserve");
  });

  it("refuses symbolic-link plugin targets", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hermes-qvac-other-"));
    await mkdir(join(home, "plugins", "model-providers"), { recursive: true });
    await symlink(elsewhere, pluginDir({ HERMES_HOME: home }));
    await expect(installPlugin({ HERMES_HOME: home })).rejects.toThrow(
      "symbolic-link",
    );
    await expect(uninstallPlugin({ HERMES_HOME: home })).rejects.toThrow(
      "symbolic-link",
    );
  });

  it("refuses a symbolic-link plugin parent directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "hermes-qvac-other-"));
    await mkdir(join(home, "plugins"), { recursive: true });
    await symlink(elsewhere, join(home, "plugins", "model-providers"));
    await expect(installPlugin({ HERMES_HOME: home })).rejects.toThrow(
      "unsafe plugin parent",
    );
  });

  it("rolls back an owned upgrade when Hermes enablement fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-bin-"));
    const env = { HERMES_HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
    await installPlugin(env);
    const previousManifest = await readFile(
      join(pluginDir(env), "plugin.yaml"),
      "utf8",
    );
    const hermes = join(bin, "hermes");
    await writeFile(hermes, "#!/usr/bin/env bash\nexit 19\n", { mode: 0o755 });
    await chmod(hermes, 0o755);
    await expect(setupPlugin(env)).rejects.toThrow("could not enable");
    await expect(
      readFile(join(pluginDir(env), "plugin.yaml"), "utf8"),
    ).resolves.toBe(previousManifest);
  });

  it("leaves no plugin after a clean setup enablement failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-bin-"));
    const hermes = join(bin, "hermes");
    await writeFile(hermes, "#!/usr/bin/env bash\nexit 20\n", { mode: 0o755 });
    await chmod(hermes, 0o755);
    const env = { HERMES_HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
    await expect(setupPlugin(env)).rejects.toThrow("could not enable");
    await expect(stat(pluginDir(env))).rejects.toThrow();
  });

  it("preserves an owned plugin when Hermes disablement fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-test-"));
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-bin-"));
    const env = { HERMES_HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
    await installPlugin(env);
    const hermes = join(bin, "hermes");
    await writeFile(hermes, "#!/usr/bin/env bash\nexit 21\n", { mode: 0o755 });
    await chmod(hermes, 0o755);
    await expect(uninstallOwnedPlugin(env)).rejects.toThrow(
      "could not disable",
    );
    await expect(stat(pluginDir(env))).resolves.toBeDefined();
  });

  it("serializes concurrent plugin installations", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes qvac concurrent-"));
    const env = { HERMES_HOME: home };
    await Promise.all([
      installPlugin(env),
      installPlugin(env),
      installPlugin(env),
    ]);
    await expect(
      readFile(join(pluginDir(env), ".hermes-qvac-provider.json"), "utf8"),
    ).resolves.toContain("@localhost41/hermes-qvac-provider");
  });

  it("recovers a setup lock whose recorded owner is no longer alive", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-stale-lock-"));
    const env = { HERMES_HOME: home };
    const target = pluginDir(env);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(join(dirname(target), ".qvac.setup.lock"), "2147483647\n", {
      mode: 0o600,
    });
    await expect(installPlugin(env)).resolves.toMatchObject({
      upgraded: false,
    });
  });

  it("recovers a recognized interrupted-upgrade backup before installing", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-recover-"));
    const env = { HERMES_HOME: home };
    await installPlugin(env);
    const target = pluginDir(env);
    const backup = join(dirname(target), ".qvac.backup-interrupted");
    await rename(target, backup);
    await expect(installPlugin(env)).resolves.toMatchObject({
      upgraded: true,
      path: target,
    });
    await expect(
      readFile(join(target, ".hermes-qvac-provider.json"), "utf8"),
    ).resolves.toContain("@localhost41/hermes-qvac-provider");
    await expect(stat(backup)).rejects.toThrow();
  });

  it("preserves a valid interrupted backup when the target was replaced by an unrelated directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-recover-"));
    const env = { HERMES_HOME: home };
    await installPlugin(env);
    const target = pluginDir(env);
    const backup = join(dirname(target), ".qvac.backup-interrupted");
    await rename(target, backup);
    await mkdir(target);
    await writeFile(join(target, "user-data"), "preserve");

    await expect(installPlugin(env)).rejects.toThrow(
      "Refusing to discard interrupted-install backup",
    );
    await expect(readFile(join(target, "user-data"), "utf8")).resolves.toBe(
      "preserve",
    );
    await expect(stat(backup)).resolves.toBeDefined();
  });
});

describe("transport fixture", () => {
  it("exposes an OpenAI-compatible model endpoint", async () => {
    const mock = await withMockQvac();
    try {
      await expect(endpointModels(mock.baseURL)).resolves.toEqual([
        "qwen3.5-9b",
      ]);
    } finally {
      await mock.close();
    }
  });

  it("rejects malformed, oversized, and structurally invalid model responses", async () => {
    const malformed = async () => new Response("not json", { status: 200 });
    const oversized = async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(2 * 1024 * 1024) },
      });
    const invalid = async () =>
      new Response('{"data":[{"id":7}]}', { status: 200 });
    await expect(
      endpointModels("http://127.0.0.1:1/v1", 100, undefined, malformed),
    ).rejects.toThrow("invalid JSON");
    await expect(
      endpointModels("http://127.0.0.1:1/v1", 100, undefined, oversized),
    ).rejects.toThrow("exceeds");
    await expect(
      endpointModels("http://127.0.0.1:1/v1", 100, undefined, invalid),
    ).rejects.toThrow("invalid model id");
  });

  it("waits for a cold managed endpoint to advertise every required model", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return new Response(
        attempts === 1
          ? '{"data":[]}'
          : '{"data":[{"id":"main"},{"id":"aux"}]}',
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await expect(
      waitForEndpointModels(
        "http://127.0.0.1:1/v1",
        ["main", "aux"],
        1_000,
        undefined,
        fetchImpl,
        async () => {},
      ),
    ).resolves.toEqual(["main", "aux"]);
    expect(attempts).toBe(2);
  });

  it("preserves a confirmed missing-model diagnosis at the timeout boundary", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1)
        return new Response('{"data":[{"id":"main"}]}', { status: 200 });
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    };
    await expect(
      waitForEndpointModels(
        "http://127.0.0.1:1/v1",
        ["main", "aux"],
        20,
        undefined,
        fetchImpl,
        () => new Promise((resolvePromise) => setTimeout(resolvePromise, 2)),
      ),
    ).rejects.toThrow("missing 'aux'");
  });

  it("bounds captured Hermes process duration", async () => {
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-hang-"));
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
      { mode: 0o755 },
    );
    await chmod(hermes, 0o755);
    await expect(
      runHermesCaptured(
        "http://127.0.0.1:1/v1",
        "qwen3.5-9b",
        [],
        DEFAULT_CONFIG,
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
        100,
      ),
    ).resolves.toMatchObject({
      code: 124,
      stderr: expect.stringContaining("timed out"),
    });
  });

  it("runs Hermes in the configured working directory", async () => {
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-cwd-bin-"));
    const cwd = await mkdtemp(join(tmpdir(), "hermes-qvac-cwd-target-"));
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      '#!/usr/bin/env node\nprocess.stdout.write(process.cwd() + "\\n");\n',
      { mode: 0o755 },
    );
    await chmod(hermes, 0o755);
    await expect(
      runHermesCaptured(
        "http://127.0.0.1:1/v1",
        "qwen3.5-9b",
        [],
        { ...DEFAULT_CONFIG, cwd },
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
      ),
    ).resolves.toMatchObject({ code: 0, stdout: `${await realpath(cwd)}\n` });
  });

  it("terminates a timed-out Hermes process group including descendants", async () => {
    const bin = await mkdtemp(join(tmpdir(), "hermes-qvac-tree-"));
    const hermes = join(bin, "hermes");
    const grandchildPidPath = join(bin, "grandchild.pid");
    await writeFile(
      hermes,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.GRANDCHILD_PID_PATH, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    await chmod(hermes, 0o755);
    await runHermesCaptured(
      "http://127.0.0.1:1/v1",
      "qwen3.5-9b",
      [],
      DEFAULT_CONFIG,
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GRANDCHILD_PID_PATH: grandchildPidPath,
      },
      1_000,
    );
    const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    let alive = true;
    const deadline = Date.now() + 3_000;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(alive).toBe(false);
  }, 10_000);
});

describe("foreground serve ownership", () => {
  it("requires the random control token for health and shutdown", async () => {
    let stopped = false;
    const control = await createSessionControl(() => {
      stopped = true;
    });
    try {
      const denied = await fetch(`http://127.0.0.1:${control.port}/stop`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
      expect(denied.status).toBe(403);
      const healthy = await fetch(`http://127.0.0.1:${control.port}/health`, {
        headers: { authorization: `Bearer ${control.token}` },
      });
      expect(healthy.status).toBe(204);
      expect(stopped).toBe(false);
    } finally {
      await control.close();
    }
  });

  it("tracks and signals multiple explicitly registered CLI owners", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-state-"));
    const env = { HERMES_HOME: home };
    const children = [0, 1].map(() =>
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      }),
    );
    if (children.some((child) => !child.pid))
      throw new Error("test owner did not start");
    const exited = children.map(
      (child) =>
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
    );
    const controls = await Promise.all(
      children.map((child) =>
        createSessionControl(() => child.kill("SIGTERM")),
      ),
    );
    for (const [index, child] of children.entries())
      await writeServeState(
        {
          owner: "hermes-qvac",
          cliPid: child.pid!,
          servePid: 987654 + index,
          baseURL: `http://127.0.0.1:${19000 + index}/v1`,
          model: "qwen3.5-9b",
          startedAt: new Date().toISOString(),
          controlPort: controls[index]!.port,
          controlToken: controls[index]!.token,
        },
        env,
      );
    expect(await readServeStates(env)).toHaveLength(2);
    expect(await readServeState(env)).toMatchObject({ running: true });
    await expect(stopOwnedServe(env)).resolves.toMatchObject({
      stopped: true,
      stoppedPids: expect.arrayContaining(children.map((child) => child.pid)),
    });
    await Promise.all(exited);
    await Promise.all(controls.map((control) => control.close()));
    for (const child of children) await clearServeState(child.pid!, env);
    expect(await readServeState(env)).toBeNull();
  });

  it("removes stale state without signaling any process", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-state-"));
    const env = { HERMES_HOME: home };
    await writeServeState(
      {
        owner: "hermes-qvac",
        cliPid: 2_000_000_000,
        servePid: 2_000_000_001,
        baseURL: "http://127.0.0.1:19000/v1",
        model: "qwen3.5-9b",
        startedAt: new Date().toISOString(),
        controlPort: 1,
        controlToken: "a".repeat(64),
      },
      env,
    );
    await expect(stopOwnedServe(env)).resolves.toMatchObject({
      stopped: false,
      detail: expect.stringContaining("stale"),
    });
    expect(await readServeState(env)).toBeNull();
  });

  it("isolates corrupted and symlinked state files without breaking valid sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-state-"));
    const env = { HERMES_HOME: home };
    const sessions = join(home, "hermes-qvac", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "bad.json"), "{bad-json");
    await symlink(join(sessions, "bad.json"), join(sessions, "123.json"));
    const inventory = await readServeStateInventory(env);
    expect(inventory.states).toEqual([]);
    expect(inventory.issues).toHaveLength(2);
    await expect(stopOwnedServe(env)).resolves.toMatchObject({
      stopped: false,
      invalidStateFiles: ["123.json", "bad.json"],
    });
  });

  it("reports partial stop and never signals a live PID with unreachable authentication", async () => {
    const home = await mkdtemp(join(tmpdir(), "hermes-qvac-state-"));
    const env = { HERMES_HOME: home };
    const stoppable = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    if (!stoppable.pid || !unrelated.pid)
      throw new Error("fixture did not start");
    const control = await createSessionControl(() => stoppable.kill("SIGTERM"));
    await writeServeState(
      {
        owner: "hermes-qvac",
        cliPid: stoppable.pid,
        servePid: 900001,
        baseURL: "http://127.0.0.1:19001/v1",
        model: "qwen3.5-9b",
        startedAt: new Date().toISOString(),
        controlPort: control.port,
        controlToken: control.token,
      },
      env,
    );
    await writeServeState(
      {
        owner: "hermes-qvac",
        cliPid: unrelated.pid,
        servePid: 900002,
        baseURL: "http://127.0.0.1:19002/v1",
        model: "qwen3.5-9b",
        startedAt: new Date().toISOString(),
        controlPort: 1,
        controlToken: "b".repeat(64),
      },
      env,
    );
    const stoppableExit = new Promise<void>((resolvePromise) =>
      stoppable.once("exit", () => resolvePromise()),
    );
    try {
      await expect(stopOwnedServe(env)).resolves.toMatchObject({
        stopped: true,
        stoppedPids: [stoppable.pid],
        unreachablePids: [unrelated.pid],
      });
      await stoppableExit;
      expect(unrelated.exitCode).toBeNull();
    } finally {
      await control.close();
      unrelated.kill("SIGTERM");
      await Promise.all([
        clearServeState(stoppable.pid, env),
        clearServeState(unrelated.pid, env),
      ]);
    }
  });
});
