import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { main } from "../src/cli.js";
import { endpointModels, installPlugin, startManaged } from "../src/runtime.js";

const originalCapture = process.env.FAKE_QVAC_CAPTURE;
afterEach(() => {
  if (originalCapture === undefined) delete process.env.FAKE_QVAC_CAPTURE;
  else process.env.FAKE_QVAC_CAPTURE = originalCapture;
});

async function fakeQvac(
  behavior: {
    delayMs?: number;
    earlyExit?: number;
    advertisedIds?: string[];
  } = {},
): Promise<{ bin: string; capture: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-fake-"));
  const bin = join(dir, "qvac-fake.mjs");
  const capture = join(dir, "captured-config.json");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args[0] !== "serve" || args[1] !== "openai") process.exit(64);
const configPath = value("--config");
const host = value("--host");
const port = Number(value("--port"));
copyFileSync(configPath, process.env.FAKE_QVAC_CAPTURE);
writeFileSync(process.env.FAKE_QVAC_CAPTURE + ".pid", String(process.pid));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const ids = Object.keys(config.serve.models);
writeFileSync(process.env.FAKE_QVAC_CAPTURE + ".cwd", process.cwd());
const advertisedIds = ${JSON.stringify(behavior.advertisedIds ?? null)} ?? ids;
const earlyExit = ${JSON.stringify(behavior.earlyExit ?? null)};
if (earlyExit !== null) process.exit(earlyExit);
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/models") response.end(JSON.stringify({ data: advertisedIds.map((id) => ({ id })) }));
  else { response.statusCode = 404; response.end(JSON.stringify({ error: "not found" })); }
});
setTimeout(() => server.listen(port, host), ${behavior.delayMs ?? 0});
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop); process.on("SIGTERM", stop);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(bin, 0o755);
  return { bin, capture };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (processAlive(pid)) throw new Error(`fake QVAC pid ${pid} was not reaped`);
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), ...args], {
    cwd: resolve("."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  return { code, stdout, stderr };
}

describe("official managed lifecycle integration", () => {
  it("writes an OpenClaw-parity config, becomes ready, and reaps the serve", async () => {
    const fake = await fakeQvac();
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    const provider = await startManaged({
      ...DEFAULT_CONFIG,
      qvacBin: fake.bin,
      reuse: false,
      readyTimeoutMs: 5_000,
    });
    const pid = provider.pid;
    try {
      await expect(endpointModels(provider.baseURL)).resolves.toHaveLength(8);
      const config = JSON.parse(await readFile(fake.capture, "utf8")) as {
        serve: {
          models: Record<
            string,
            {
              model: string;
              preload: boolean;
              default?: boolean;
              config: Record<string, unknown>;
            }
          >;
        };
      };
      const common = { ctx_size: 32768, reasoning_budget: -1, tools: true };
      expect(config).toEqual({
        serve: {
          models: {
            "qwen3.5-0.8b": {
              model: "QWEN3_5_0_8B_MULTIMODAL_Q4_K_M",
              preload: false,
              config: common,
            },
            "qwen3.5-2b": {
              model: "QWEN3_5_2B_MULTIMODAL_Q4_K_M",
              preload: true,
              config: common,
            },
            "qwen3.5-4b": {
              model: "QWEN3_5_4B_MULTIMODAL_Q4_K_M",
              preload: false,
              config: common,
            },
            "qwen3.5-9b": {
              model: "QWEN3_5_9B_MULTIMODAL_Q4_K_M",
              preload: true,
              default: true,
              config: common,
            },
            "qwen3.6-27b": {
              model: "QWEN3_6_27B_MULTIMODAL_Q4_K_XL",
              preload: false,
              config: common,
            },
            "qwen3.6-35b-a3b": {
              model: "QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M",
              preload: false,
              config: common,
            },
            "gpt-oss-20b": {
              model: "GPT_OSS_20B_INST_Q4_K_M",
              preload: false,
              config: common,
            },
            "gemma4-31b": {
              model: "GEMMA4_31B_MULTIMODAL_Q4_K_M",
              preload: false,
              config: common,
            },
          },
        },
      });
    } finally {
      await provider.close();
    }
    await waitForExit(pid);
  }, 15_000);

  it("fails a pinned-port collision without terminating the occupant", async () => {
    const occupant = createTcpServer();
    await new Promise<void>((resolve) =>
      occupant.listen(0, "127.0.0.1", resolve),
    );
    const address = occupant.address();
    if (!address || typeof address === "string")
      throw new Error("occupant did not bind TCP");
    const fake = await fakeQvac();
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    try {
      await expect(
        startManaged({
          ...DEFAULT_CONFIG,
          qvacBin: fake.bin,
          port: address.port,
          reuse: false,
          readyTimeoutMs: 2_000,
        }),
      ).rejects.toThrow();
      expect(occupant.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupant.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 10_000);

  it("waits through delayed readiness and surfaces early child exit", async () => {
    const delayed = await fakeQvac({ delayMs: 250 });
    process.env.FAKE_QVAC_CAPTURE = delayed.capture;
    const provider = await startManaged({
      ...DEFAULT_CONFIG,
      qvacBin: delayed.bin,
      reuse: false,
      readyTimeoutMs: 3_000,
    });
    await provider.close();
    await waitForExit(provider.pid);

    const failing = await fakeQvac({ earlyExit: 73 });
    process.env.FAKE_QVAC_CAPTURE = failing.capture;
    await expect(
      startManaged({
        ...DEFAULT_CONFIG,
        qvacBin: failing.bin,
        reuse: false,
        readyTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/73|exited/i);
  }, 15_000);

  it("rejects a managed endpoint that omits the selected or auxiliary model", async () => {
    const fake = await fakeQvac({ advertisedIds: ["qwen3.5-9b"] });
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    await expect(
      startManaged({
        ...DEFAULT_CONFIG,
        qvacBin: fake.bin,
        reuse: false,
        readyTimeoutMs: 3_000,
      }),
    ).rejects.toThrow("missing 'qwen3.5-2b'");
    const pid = Number(await readFile(`${fake.capture}.pid`, "utf8"));
    await waitForExit(pid);
  }, 15_000);

  it("honors a relative QVAC binary and paths with spaces under configured cwd", async () => {
    const fake = await fakeQvac();
    const cwd = await mkdtemp(join(tmpdir(), "hermes qvac cwd-"));
    const relativeBin = "./qvac fake.mjs";
    await writeFile(join(cwd, relativeBin.slice(2)), await readFile(fake.bin), {
      mode: 0o755,
    });
    await chmod(join(cwd, relativeBin.slice(2)), 0o755);
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    const provider = await startManaged({
      ...DEFAULT_CONFIG,
      cwd,
      qvacBin: relativeBin,
      reuse: false,
      readyTimeoutMs: 3_000,
    });
    expect(await realpath(await readFile(`${fake.capture}.cwd`, "utf8"))).toBe(
      await realpath(cwd),
    );
    await provider.close();
    await waitForExit(provider.pid);
  }, 15_000);

  it("reuses compatible official fleets and separates incompatible configuration", async () => {
    const fake = await fakeQvac();
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    const base = {
      ...DEFAULT_CONFIG,
      qvacBin: fake.bin,
      reuse: true,
      readyTimeoutMs: 3_000,
    };
    const first = await startManaged(base);
    const second = await startManaged(base);
    const incompatible = await startManaged({ ...base, ctxSize: 65536 });
    expect(second.pid).toBe(first.pid);
    expect(incompatible.pid).not.toBe(first.pid);
    await first.close();
    expect(processAlive(second.pid)).toBe(true);
    await second.close();
    await incompatible.close();
    await Promise.all([waitForExit(second.pid), waitForExit(incompatible.pid)]);
  }, 20_000);

  it("authenticates endpoint probes with the configured API marker", async () => {
    let authorization = "";
    const server = createHttpServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end('{"data":[{"id":"qwen3.5-9b"},{"id":"qwen3.5-2b"}]}');
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind");
    try {
      await endpointModels(
        `http://127.0.0.1:${address.port}/v1`,
        1_000,
        "private-marker",
      );
      expect(authorization).toBe("Bearer private-marker");
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("runs against a verified external endpoint without starting QVAC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-external-"));
    const hermesLog = join(dir, "hermes.json");
    const qvacMarker = join(dir, "qvac-started");
    const hermesBin = join(dir, "hermes");
    const qvacBin = join(dir, "qvac");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HERMES_LOG, JSON.stringify({ args: process.argv.slice(2), baseURL: process.env.QVAC_BASE_URL, apiKey: process.env.QVAC_API_KEY }));
`,
      { mode: 0o755 },
    );
    await writeFile(
      qvacBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.QVAC_MARKER, "started");
`,
      { mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    await chmod(qvacBin, 0o755);
    const authorization: Array<string | undefined> = [];
    const server = createHttpServer((request, response) => {
      authorization.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end('{"data":[{"id":"qwen3.5-9b"},{"id":"qwen3.5-2b"}]}');
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HERMES_LOG: hermesLog,
      QVAC_MARKER: qvacMarker,
      HERMES_HOME: join(dir, "home"),
    };
    try {
      const result = await runCli(
        [
          "run",
          "--external",
          "--base-url",
          baseURL,
          "--api-key",
          "external-secret",
          "--bin",
          qvacBin,
        ],
        env,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(hermesLog, "utf8"))).toMatchObject({
        baseURL,
        apiKey: "external-secret",
        args: ["--provider", "qvac", "-m", "qwen3.5-9b"],
      });
      expect(authorization).toEqual(["Bearer external-secret"]);
      await expect(access(qvacMarker)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("refuses an external endpoint missing the selected model before Hermes starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-external-"));
    const marker = join(dir, "hermes-started");
    const hermesBin = join(dir, "hermes");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HERMES_MARKER, "started");
`,
      { mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    const server = createHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[{"id":"other"}]}');
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind");
    try {
      const result = await runCli(
        [
          "run",
          "--external",
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
          "--json",
        ],
        {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          HERMES_MARKER: marker,
          HERMES_HOME: join(dir, "home"),
        },
      );
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stderr).error).toContain("does not advertise");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("redacts an API marker echoed by a captured Hermes failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-redaction-"));
    const hermesBin = join(dir, "hermes");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env node
process.stdout.write(process.env.QVAC_API_KEY);
process.stderr.write(process.env.QVAC_API_KEY);
process.exit(9);
`,
      { mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    const server = createHttpServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"data":[{"id":"qwen3.5-9b"},{"id":"qwen3.5-2b"}]}');
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture did not bind");
    try {
      const result = await runCli(
        [
          "smoke",
          "--external",
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
          "--api-key",
          "super-private-marker",
          "--json",
        ],
        {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          HERMES_HOME: join(dir, "home"),
        },
      );
      expect(result.code).toBe(4);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "super-private-marker",
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        response: "[redacted]",
        stderr: "[redacted]",
      });
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("launches Hermes with the managed endpoint, selected model, and timeout", async () => {
    const fake = await fakeQvac();
    const binDir = await mkdtemp(join(tmpdir(), "hermes-qvac-hermes-"));
    const hermesLog = join(binDir, "hermes.json");
    const hermesBin = join(binDir, "hermes");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HERMES_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), baseURL: process.env.QVAC_BASE_URL, apiKey: process.env.QVAC_API_KEY, timeout: process.env.HERMES_API_TIMEOUT }));
`,
      { encoding: "utf8", mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    const previousPath = process.env.PATH;
    const previousLog = process.env.HERMES_FAKE_LOG;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.HERMES_FAKE_LOG = hermesLog;
    process.env.FAKE_QVAC_CAPTURE = fake.capture;
    try {
      await expect(
        main([
          "run",
          "--bin",
          fake.bin,
          "--no-reuse",
          "--timeout-seconds",
          "412",
          "--",
          "--cli",
        ]),
      ).resolves.toBe(0);
      const invocation = JSON.parse(await readFile(hermesLog, "utf8")) as {
        args: string[];
        baseURL: string;
        apiKey: string;
        timeout: string;
      };
      expect(invocation.args).toEqual([
        "--provider",
        "qvac",
        "-m",
        "qwen3.5-9b",
        "--cli",
      ]);
      expect(invocation.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(invocation.apiKey).toBe("custom-local");
      expect(invocation.timeout).toBe("412");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.HERMES_FAKE_LOG;
      else process.env.HERMES_FAKE_LOG = previousLog;
    }
  }, 15_000);

  it("forwards SIGTERM to Hermes and reaps the managed QVAC consumer", async () => {
    const fake = await fakeQvac();
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-signal-"));
    const started = join(dir, "hermes-started");
    const signaled = join(dir, "hermes-signaled");
    const hermesBin = join(dir, "hermes");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HERMES_STARTED, "started");
process.on("SIGTERM", () => { writeFileSync(process.env.HERMES_SIGNALED, "SIGTERM"); process.exit(143); });
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HERMES_HOME: join(dir, "home"),
      HERMES_STARTED: started,
      HERMES_SIGNALED: signaled,
      FAKE_QVAC_CAPTURE: fake.capture,
    };
    for (const key of ["QVAC_BASE_URL", "QVAC_MODEL", "QVAC_BIN", "QVAC_PORT"])
      delete env[key];
    const cli = spawn(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "run",
        "--bin",
        fake.bin,
        "--no-reuse",
        "--",
        "--cli",
      ],
      { cwd: resolve("."), env, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolvePromise, reject) => {
      cli.once("error", reject);
      cli.once("exit", (code) => resolvePromise(code));
    });
    await waitForFile(started);
    cli.kill("SIGTERM");
    await expect(exited).resolves.toBe(143);
    await expect(readFile(signaled, "utf8")).resolves.toBe("SIGTERM");
    const qvacPid = Number(await readFile(`${fake.capture}.pid`, "utf8"));
    await waitForExit(qvacPid);
  }, 20_000);

  it("propagates a nonzero Hermes child exit code and still reaps QVAC", async () => {
    const fake = await fakeQvac();
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-exit-"));
    const hermesBin = join(dir, "hermes");
    await writeFile(hermesBin, "#!/usr/bin/env bash\nexit 37\n", {
      mode: 0o755,
    });
    await chmod(hermesBin, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HERMES_HOME: join(dir, "home"),
      FAKE_QVAC_CAPTURE: fake.capture,
    };
    for (const key of ["QVAC_BASE_URL", "QVAC_MODEL", "QVAC_BIN", "QVAC_PORT"])
      delete env[key];
    const cli = spawn(
      process.execPath,
      [resolve("dist/cli.js"), "run", "--bin", fake.bin, "--no-reuse"],
      { cwd: resolve("."), env, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolvePromise, reject) => {
      cli.once("error", reject);
      cli.once("exit", resolvePromise);
    });
    await expect(exited).resolves.toBe(37);
    const qvacPid = Number(await readFile(`${fake.capture}.pid`, "utf8"));
    await waitForExit(qvacPid);
  }, 20_000);

  it("reports and safely stops a foreground serve through its owned CLI state", async () => {
    const fake = await fakeQvac();
    const dir = await mkdtemp(join(tmpdir(), "hermes-qvac-serve-"));
    const home = join(dir, "home");
    const fakeInstall = join(dir, "hermes-install");
    const python = join(fakeInstall, "venv", "bin", "python");
    await mkdir(join(fakeInstall, "venv", "bin"), { recursive: true });
    await installPlugin({ HERMES_HOME: home });
    await writeFile(
      python,
      `#!/usr/bin/env bash
printf '{"class":"QvacProviderProfile","provider_profile":true,"name":"qvac","aliases":["local-qvac","qvac-local"],"base_url":"%s","models_url":"","supports_vision":true,"fallback_models":["qwen3.5-0.8b","qwen3.5-2b","qwen3.5-4b","qwen3.5-9b","qwen3.6-27b","qwen3.6-35b-a3b","gpt-oss-20b","gemma4-31b"],"default_model":"qwen3.5-9b","default_aux_model":"qwen3.5-2b","default_max_tokens":8192,"context_window":32768}\n' "$QVAC_BASE_URL"
`,
      { mode: 0o755 },
    );
    await chmod(python, 0o755);
    const hermesBin = join(dir, "hermes");
    await writeFile(
      hermesBin,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  printf 'Hermes Agent test\nInstall directory: ${fakeInstall}\n'
elif [[ "$1 $2" == "plugins list" ]]; then
  echo 'enabled user 0.1.0-beta.2 qvac'
else
  exit 0
fi
`,
      { mode: 0o755 },
    );
    await chmod(hermesBin, 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      HERMES_HOME: home,
      FAKE_QVAC_CAPTURE: fake.capture,
    };
    for (const key of ["QVAC_BASE_URL", "QVAC_MODEL", "QVAC_BIN", "QVAC_PORT"])
      delete env[key];
    const cli = spawn(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "serve",
        "--bin",
        fake.bin,
        "--no-reuse",
        "--json",
      ],
      { cwd: resolve("."), env, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolvePromise, reject) => {
      cli.once("error", reject);
      cli.once("exit", resolvePromise);
    });
    if (!cli.pid) throw new Error("serve CLI did not start");
    const statePath = join(home, "hermes-qvac", "sessions", `${cli.pid}.json`);
    await waitForFile(statePath);
    const status = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "status", "--json"],
      { cwd: resolve("."), env, encoding: "utf8" },
    );
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).not.toContain("controlToken");
    expect(
      JSON.parse(status.stdout),
      `serve exitCode=${cli.exitCode} status=${status.stdout}`,
    ).toMatchObject({
      ok: true,
      state: "ready",
      running: true,
      sessions: [{ running: true, model: "qwen3.5-9b" }],
    });
    const stop = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "stop", "--json"],
      { cwd: resolve("."), env, encoding: "utf8" },
    );
    expect(stop.status, stop.stderr).toBe(0);
    expect(JSON.parse(stop.stdout)).toMatchObject({ ok: true, stopped: true });
    await expect(exited).resolves.toBe(0);
    await expect(access(statePath)).rejects.toThrow();
    const qvacPid = Number(await readFile(`${fake.capture}.pid`, "utf8"));
    await waitForExit(qvacPid);
    const stopped = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "status", "--json"],
      { cwd: resolve("."), env, encoding: "utf8" },
    );
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      ok: true,
      installed: true,
      state: "stopped",
      running: false,
      endpoint: { reachable: false, expected: false },
      sessions: [],
    });
    const requireRunning = spawnSync(
      process.execPath,
      [resolve("dist/cli.js"), "status", "--require-running", "--json"],
      { cwd: resolve("."), env, encoding: "utf8" },
    );
    expect(requireRunning.status).toBe(3);
    expect(JSON.parse(requireRunning.stdout)).toMatchObject({
      ok: false,
      state: "stopped",
      running: false,
      requireRunning: true,
    });
  }, 20_000);
});
