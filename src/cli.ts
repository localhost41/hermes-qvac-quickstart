#!/usr/bin/env node
import {
  configPath,
  publicConfig,
  readSavedConfig,
  redactSecretText,
  redactSecrets,
  resetConfig,
  resolveConfig,
  saveConfig,
  type ConfigOverrides,
  type HermesQvacConfig,
} from "./config.js";
import {
  clearServeState,
  commandVersion,
  createSessionControl,
  doctor,
  endpointModels,
  estimatedPreloadBytes,
  EXIT,
  listModels,
  modelStoragePreflight,
  output,
  prepareIsolatedHermesHome,
  publicServeState,
  readServeStateInventory,
  runHermes,
  runHermesCaptured,
  setupPlugin,
  startManaged,
  stopOwnedServe,
  uninstallOwnedPlugin,
  waitForShutdownSignal,
  withMockQvac,
  writeServeState,
} from "./runtime.js";
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { totalmem } from "node:os";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface ParsedArgs {
  command?: string;
  positional: string[];
  hermesArgs: string[];
  json: boolean;
  yes: boolean;
  transportOnly: boolean;
  external: boolean;
  requireRunning: boolean;
  toolTask: boolean;
  config: ConfigOverrides;
}

class UnavailableError extends Error {}

const VALUE_OPTIONS: Record<string, keyof ConfigOverrides> = {
  "--model": "model",
  "--aux-model": "auxModel",
  "--host": "host",
  "--port": "port",
  "--base-url": "baseURL",
  "--api-key": "apiKey",
  "--bin": "qvacBin",
  "--cwd": "cwd",
  "--ctx-size": "ctxSize",
  "--reasoning-budget": "reasoningBudget",
  "--ready-timeout-ms": "readyTimeoutMs",
  "--idle-stop-ms": "idleStopMs",
  "--timeout-seconds": "timeoutSeconds",
};
const NUMBER_KEYS = new Set<keyof ConfigOverrides>([
  "port",
  "ctxSize",
  "reasoningBudget",
  "readyTimeoutMs",
  "idleStopMs",
  "timeoutSeconds",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === "--help" || argv[0] === "-h")
    argv = ["help", ...argv.slice(1)];
  if (argv[0] === "--version" || argv[0] === "-V")
    argv = ["version", ...argv.slice(1)];
  const separator = argv.indexOf("--");
  const ownArgs = separator < 0 ? argv : argv.slice(0, separator);
  const result: ParsedArgs = {
    command: ownArgs[0],
    positional: [],
    hermesArgs: separator < 0 ? [] : argv.slice(separator + 1),
    json: false,
    yes: false,
    transportOnly: false,
    external: false,
    requireRunning: false,
    toolTask: false,
    config: {},
  };
  for (let index = 1; index < ownArgs.length; index += 1) {
    const arg = ownArgs[index]!;
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--yes") {
      result.yes = true;
      continue;
    }
    if (arg === "--transport-only") {
      result.transportOnly = true;
      continue;
    }
    if (arg === "--tool-task") {
      result.toolTask = true;
      continue;
    }
    if (arg === "--external") {
      result.external = true;
      continue;
    }
    if (arg === "--require-running") {
      result.requireRunning = true;
      continue;
    }
    if (arg === "--tools") {
      result.config.tools = true;
      continue;
    }
    if (arg === "--no-tools") {
      result.config.tools = false;
      continue;
    }
    if (arg === "--reuse") {
      result.config.reuse = true;
      continue;
    }
    if (arg === "--no-reuse") {
      result.config.reuse = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      result.positional.push("help");
      continue;
    }
    const key = VALUE_OPTIONS[arg];
    if (key) {
      const value = ownArgs[index + 1];
      if (value === undefined) throw new TypeError(`${arg} requires a value`);
      (result.config as Record<string, unknown>)[key] = NUMBER_KEYS.has(key)
        ? Number(value)
        : value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw new TypeError(`unknown option: ${arg}`);
    result.positional.push(arg);
  }
  return result;
}

const packageJson = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function usage(command?: string): string {
  const commandHelp: Record<string, string> = {
    setup:
      "Usage: hermes-qvac setup [configuration options] [--json]\n\nInstall or safely upgrade the Hermes profile, enable it, and persist only options explicitly supplied on this command.",
    config:
      "Usage: hermes-qvac config <show|set|reset|path|validate> [configuration options] [--json]\n\nshow resolves every precedence layer; validate performs the same validation without mutation; set persists only supplied fields.",
    models:
      "Usage: hermes-qvac models [list] [--json]\n       hermes-qvac models info <MODEL> [--json]\n\nList the authoritative QVAC catalog or inspect one friendly ID/SDK constant.",
    doctor:
      "Usage: hermes-qvac doctor [configuration options] [--json]\n\nCheck dependencies, plugin ownership/enablement/loading, catalog, sessions, and endpoint health without starting QVAC.",
    run: "Usage: hermes-qvac run [configuration options] [--external] [--json] -- [Hermes arguments]\n\nStart or reuse managed QVAC, or use a verified external endpoint, and run Hermes.",
    start:
      "Usage: hermes-qvac start [configuration options] [--yes] -- [Hermes arguments]\n\nBeginner path: check capacity, explain any model download, install/upgrade the provider, start managed QVAC, and launch Hermes. Defaults to Hermes' interactive CLI.",
    serve:
      "Usage: hermes-qvac serve [configuration options] [--json]\n\nHold an official managed QVAC consumer in the foreground until signaled or stopped through authenticated session control.",
    status:
      "Usage: hermes-qvac status [configuration options] [--require-running] [--json]\n\nReport explicit stopped/ready/degraded/failed lifecycle state. A healthy stopped managed installation succeeds unless --require-running is set.",
    stop: "Usage: hermes-qvac stop [--json]\n\nRequest authenticated shutdown from registered hermes-qvac owners; never signal recorded PIDs directly.",
    smoke:
      "Usage: hermes-qvac smoke --transport-only [configuration options] [--json]\n       hermes-qvac smoke [configuration options] --yes [--json]\n       hermes-qvac smoke --tool-task --cwd EMPTY_DIR --no-reuse [configuration options] --yes [--json]\n\nRun transport, physical inference, or outcome-verified file-tool tests. Tool-task success requires the requested file and exact content, not the model's claim.",
    uninstall:
      "Usage: hermes-qvac uninstall [--json]\n\nDisable and remove only an installation carrying a valid ownership marker. Saved configuration is preserved.",
    version: "Usage: hermes-qvac version [--json]",
  };
  if (command && commandHelp[command]) return commandHelp[command]!;
  return `Usage: hermes-qvac <start|setup|config|doctor|models|run|serve|smoke|status|stop|uninstall|version> [options]

Begin here: hermes-qvac start
Lifecycle: start, setup, run, serve, status, stop, uninstall
Config:    config show | set | reset | path | validate
Testing:   doctor, smoke --transport-only, smoke --model ID --yes

Options:
  --model ID                 Default catalog model (qwen3.5-9b)
  --aux-model ID             Hermes auxiliary model (qwen3.5-2b)
  --host HOST                Loopback bind host
  --port PORT                Pin port; omitted means auto-allocate
  --base-url URL             Use an existing OpenAI-compatible endpoint
  --external                 Require an existing endpoint; do not start QVAC
  --bin PATH                 Override the bundled qvac executable
  --cwd PATH                 Working directory inherited by QVAC
  --ctx-size TOKENS          QVAC context size (32768)
  --reasoning-budget N       -1 enables reasoning; 0 disables it
  --tools | --no-tools       Toggle QVAC tool-call formatting
  --tool-task                Verify a real Hermes file-tool side effect
  --ready-timeout-ms MS      Startup/model-download timeout (900000)
  --idle-stop-ms MS          Shared serve idle lifetime (0)
  --timeout-seconds SEC      Hermes request timeout (300)
  --reuse | --no-reuse       Share a matching managed QVAC serve
  --yes                       Confirm a model download for start/smoke
  --require-running           Make status fail unless an endpoint is ready
  --json                     Structured output
  --                         Remaining arguments are passed to Hermes

Run 'hermes-qvac <command> --help' for command-specific help.`;
}

function hasConfigOverrides(config: ConfigOverrides): boolean {
  return Object.keys(config).length > 0;
}
function formatBytes(bytes: number | undefined): string {
  return bytes === undefined
    ? "size unknown"
    : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function formatDoctor(result: Awaited<ReturnType<typeof doctor>>): string {
  const lines = [
    `Hermes/QVAC doctor: ${result.ok ? "healthy" : "problems found"} (${result.mode})`,
  ];
  for (const check of result.checks)
    lines.push(
      `${check.ok ? "ok" : check.required ? "ERROR" : "warning"}  ${check.name}: ${check.detail}`,
    );
  return lines.join("\n");
}
function formatConfigResult(heading: string, config: HermesQvacConfig): string {
  return `${heading}\n${Object.entries(publicConfig(config))
    .map(([key, value]) => `  ${key}: ${String(value)}`)
    .join("\n")}`;
}

export function physicalDownloadConsentMessage(
  config: HermesQvacConfig,
): string {
  const bytes = estimatedPreloadBytes(config);
  const size =
    bytes === null
      ? "an unknown amount of model data"
      : `approximately ${(bytes / 1024 ** 3).toFixed(2)} GiB of model payload`;
  return `Real smoke may download ${size} for main '${config.model}' plus auxiliary '${config.auxModel}'. A cold run can transfer up to that payload, needs at least comparable free disk and RAM plus cache/context/runtime overhead, and can take minutes depending on hardware and network speed. Re-run with --yes only after reviewing those impacts, or use --transport-only.`;
}

export function beginnerCapacityMessage(
  config: HermesQvacConfig,
  memoryBytes = totalmem(),
): string {
  const payload = estimatedPreloadBytes(config);
  const memory = (memoryBytes / 1024 ** 3).toFixed(1);
  const estimate = payload === null ? "unknown" : formatBytes(payload);
  return `Selected '${config.model}' with auxiliary '${config.auxModel}' (${estimate} model payload). This machine reports ${memory} GiB total memory. Model payload is only a lower bound; QVAC also needs memory for context and runtime overhead.`;
}

async function confirmBeginnerDownload(
  config: HermesQvacConfig,
  requiredDownloadBytes: number,
  confirmed: boolean,
): Promise<void> {
  if (requiredDownloadBytes === 0 || confirmed) return;
  const message = `${beginnerCapacityMessage(config)}\nQVAC needs to download approximately ${(requiredDownloadBytes / 1024 ** 3).toFixed(2)} GiB before first use.`;
  if (!stdin.isTTY || !stderr.isTTY)
    throw new Error(`${message}\nRe-run with --yes to approve this download.`);
  stderr.write(`${message}\n`);
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(
      "Download the models and continue? [y/N] ",
    );
    if (!/^(y|yes)$/i.test(answer.trim()))
      throw new Error(
        "Model download was not approved; no plugin files were changed.",
      );
  } finally {
    prompt.close();
  }
}

const COMMANDS = new Set([
  "help",
  "setup",
  "config",
  "doctor",
  "models",
  "start",
  "run",
  "serve",
  "smoke",
  "status",
  "stop",
  "uninstall",
  "version",
]);

function validateInvocation(parsed: ParsedArgs): void {
  if (parsed.command && !COMMANDS.has(parsed.command))
    throw new TypeError(`unknown command: ${parsed.command}`);
  if (parsed.command === "config") {
    if (parsed.positional.length > 1)
      throw new TypeError("config accepts one action: show, set, or reset");
    const action = parsed.positional[0] ?? "show";
    if (!["show", "set", "reset", "path", "validate", "help"].includes(action))
      throw new TypeError(
        "config action must be show, set, reset, path, or validate",
      );
    if (action === "set" && !hasConfigOverrides(parsed.config))
      throw new TypeError(
        "config set requires at least one configuration option",
      );
    if (["reset", "path"].includes(action) && hasConfigOverrides(parsed.config))
      throw new TypeError(
        `config ${action} does not accept configuration options`,
      );
  } else if (parsed.command === "models") {
    if (parsed.positional.includes("help")) return;
    if (!(
      parsed.positional.length === 0 ||
      (parsed.positional.length === 1 && parsed.positional[0] === "list") ||
      (parsed.positional.length === 2 && parsed.positional[0] === "info")
    ))
      throw new TypeError("models accepts 'list' or 'info MODEL'");
    if (parsed.positional[0] === "info" && parsed.positional.length !== 2)
      throw new TypeError("models info requires a model ID or SDK constant");
    if (hasConfigOverrides(parsed.config))
      throw new TypeError("models does not accept configuration options");
  } else if (
    parsed.positional.length > 0 &&
    !parsed.positional.includes("help")
  ) {
    throw new TypeError(
      `${parsed.command} does not accept positional arguments; pass Hermes arguments after --`,
    );
  }
  if (
    parsed.hermesArgs.length > 0 &&
    parsed.command !== "run" &&
    parsed.command !== "start"
  )
    throw new TypeError(`only start and run accept Hermes arguments after --`);
  if (
    parsed.hermesArgs.some(
      (argument) =>
        argument === "-m" ||
        argument === "--model" ||
        argument.startsWith("--model=") ||
        argument === "--provider" ||
        argument.startsWith("--provider="),
    )
  )
    throw new TypeError(
      "Hermes provider/model overrides are reserved; use hermes-qvac --model instead",
    );
  if (parsed.transportOnly && parsed.command !== "smoke")
    throw new TypeError("--transport-only is valid only with smoke");
  if (parsed.yes && parsed.command !== "smoke" && parsed.command !== "start")
    throw new TypeError("--yes is valid only with start or smoke");
  if (
    parsed.external &&
    parsed.command !== "start" &&
    parsed.command !== "run" &&
    parsed.command !== "smoke"
  )
    throw new TypeError("--external is valid only with start, run, or smoke");
  if (parsed.toolTask && parsed.command !== "smoke")
    throw new TypeError("--tool-task is valid only with smoke");
  if (parsed.toolTask && parsed.transportOnly)
    throw new TypeError("--tool-task cannot be combined with --transport-only");
  if (parsed.toolTask && (!parsed.config.cwd || parsed.config.reuse !== false))
    throw new TypeError(
      "--tool-task requires --cwd EMPTY_DIR and --no-reuse so the verified side effect is isolated",
    );
  if (
    hasConfigOverrides(parsed.config) &&
    ![
      "start",
      "setup",
      "config",
      "doctor",
      "run",
      "serve",
      "smoke",
      "status",
    ].includes(parsed.command ?? "")
  ) {
    throw new TypeError(
      `${parsed.command} does not accept configuration options`,
    );
  }
}

const TOOL_PROOF_FILE = "qvac-proof.txt";
const TOOL_PROOF_CONTENT = "QVAC-HERMES-OK";

async function assertFreshToolWorkspace(
  config: HermesQvacConfig,
): Promise<void> {
  if (!config.cwd) throw new TypeError("tool-task requires cwd");
  const proof = join(config.cwd, TOOL_PROOF_FILE);
  try {
    await access(proof, constants.F_OK);
    throw new TypeError(
      `Refusing tool-task because ${proof} already exists; use an empty disposable directory`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function toolOutcomeVerified(config: HermesQvacConfig): Promise<boolean> {
  if (!config.cwd) return false;
  try {
    return (
      (await readFile(join(config.cwd, TOOL_PROOF_FILE), "utf8")).trim() ===
      TOOL_PROOF_CONTENT
    );
  } catch {
    return false;
  }
}

async function runAgainstEndpoint(
  config: HermesQvacConfig,
  hermesArgs: string[],
  capture: boolean,
) {
  if (!config.baseURL)
    throw new Error("external mode requires --base-url or QVAC_BASE_URL");
  let models: string[];
  try {
    models = await endpointModels(
      config.baseURL,
      Math.min(config.readyTimeoutMs, 10_000),
      config.apiKey,
    );
  } catch (error) {
    throw new UnavailableError(
      `External endpoint ${config.baseURL} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!models.includes(config.model))
    throw new UnavailableError(
      `Endpoint ${config.baseURL} does not advertise model '${config.model}'`,
    );
  if (!models.includes(config.auxModel))
    throw new UnavailableError(
      `Endpoint ${config.baseURL} does not advertise auxiliary model '${config.auxModel}'`,
    );
  return capture
    ? runHermesCaptured(config.baseURL, config.model, hermesArgs, config, {
        HERMES_MAX_TOKENS: "256",
      })
    : runHermes(config.baseURL, config.model, hermesArgs, config);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
    validateInvocation(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      argv.includes("--json")
        ? `${JSON.stringify({ ok: false, error: message })}\n`
        : `hermes-qvac: ${message}\n`,
    );
    return EXIT.usage;
  }
  const out = output(parsed.json);
  const { command } = parsed;
  let effectiveConfig: HermesQvacConfig | undefined;
  if (!command || command === "help" || parsed.positional.includes("help")) {
    out.write(usage(command === "help" ? undefined : command));
    return command ? EXIT.ok : EXIT.usage;
  }
  try {
    if (command === "version") {
      out.write(
        parsed.json
          ? { ok: true, version: packageJson.version }
          : `hermes-qvac ${packageJson.version}`,
      );
      return EXIT.ok;
    }
    if (command === "config") {
      const action = parsed.positional[0] ?? "show";
      if (action === "reset") {
        const removed = await resetConfig();
        out.write(
          parsed.json
            ? { ok: true, removed, path: configPath() }
            : `${removed ? "Removed" : "No saved configuration at"} ${configPath()}`,
        );
        return EXIT.ok;
      }
      if (action === "path") {
        out.write(
          parsed.json ? { ok: true, path: configPath() } : configPath(),
        );
        return EXIT.ok;
      }
      if (action === "set") {
        const saved = await saveConfig(parsed.config);
        out.write(
          parsed.json
            ? { ok: true, path: configPath(), config: publicConfig(saved) }
            : formatConfigResult(
                `Saved configuration at ${configPath()}:`,
                saved,
              ),
        );
        return EXIT.ok;
      }
      if (action === "validate") {
        const config = await resolveConfig(parsed.config);
        out.write(
          parsed.json
            ? {
                ok: true,
                valid: true,
                path: configPath(),
                config: publicConfig(config),
                mutated: false,
              }
            : formatConfigResult(
                "Configuration is valid (no files changed):",
                config,
              ),
        );
        return EXIT.ok;
      }
      if (action !== "show")
        throw new TypeError(
          "config action must be show, set, reset, path, or validate",
        );
      const config = (effectiveConfig = await resolveConfig(parsed.config));
      out.write(
        parsed.json
          ? { ok: true, path: configPath(), config: publicConfig(config) }
          : formatConfigResult(
              `Effective configuration (${configPath()}):`,
              config,
            ),
      );
      return EXIT.ok;
    }
    if (command === "setup") {
      if (!commandVersion("hermes"))
        throw new UnavailableError(
          "Hermes is not installed or 'hermes --version' failed",
        );
      const changesConfig = hasConfigOverrides(parsed.config);
      const priorConfig = changesConfig ? await readSavedConfig() : undefined;
      if (changesConfig) {
        await resolveConfig(parsed.config);
        await saveConfig(parsed.config);
      }
      let installed: Awaited<ReturnType<typeof setupPlugin>>;
      try {
        installed = await setupPlugin();
      } catch (error) {
        if (priorConfig) {
          try {
            await resetConfig();
            if (Object.keys(priorConfig).length > 0)
              await saveConfig(priorConfig);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              "Setup failed and the previous saved configuration could not be restored",
            );
          }
        }
        throw error;
      }
      const result = {
        ok: true,
        enabled: true,
        ...installed,
        configPath: configPath(),
      };
      out.write(
        parsed.json
          ? result
          : `QVAC provider ${installed.upgraded ? "upgraded" : "installed"} and enabled at ${installed.path}\nConfiguration: ${configPath()}`,
      );
      return EXIT.ok;
    }
    if (command === "uninstall") {
      const removed = await uninstallOwnedPlugin();
      out.write(
        parsed.json
          ? { ok: true, removed, configPreserved: true }
          : `${removed ? "Removed the owned QVAC provider." : "QVAC provider was not installed."}\nSaved configuration was preserved at ${configPath()}.`,
      );
      return EXIT.ok;
    }
    if (command === "models") {
      const models = listModels();
      if (parsed.positional[0] === "info") {
        const query = parsed.positional[1]!;
        const model = models.find(
          (entry) => entry.id === query || entry.constant === query,
        );
        if (!model) throw new TypeError(`unknown model '${query}'`);
        out.write(
          parsed.json
            ? { ok: true, model }
            : `${model.id}\n  Name: ${model.name}\n  SDK constant: ${model.constant}\n  Modality: ${model.constant.includes("MULTIMODAL") ? "text, image" : "text"}\n  Download: ${formatBytes(model.downloadBytes)}\n  Default: ${model.default ? "yes" : "no"}\n  Experience: ${model.experience.tier}\n  Tools: ${model.experience.tools}\n  Guidance: ${model.experience.guidance}`,
        );
        return EXIT.ok;
      }
      out.write(
        parsed.json
          ? { ok: true, models }
          : models
              .map(
                (m) =>
                  `${m.default ? "*" : " "} ${m.id}\t${m.name}\t${formatBytes(m.downloadBytes)}\t${m.experience.tier}\ttools:${m.experience.tools}`,
              )
              .join("\n"),
      );
      return EXIT.ok;
    }
    if (command === "doctor") {
      const config = (effectiveConfig = await resolveConfig(parsed.config));
      const result = await doctor(config);
      out.write(parsed.json ? result : formatDoctor(result));
      return result.ok ? EXIT.ok : EXIT.unavailable;
    }
    if (command === "status") {
      const config = (effectiveConfig = await resolveConfig(parsed.config));
      const inventory = await readServeStateInventory();
      const sessions = inventory.states;
      const live = sessions.find((session) => session.running);
      const health = await doctor(
        config.baseURL === undefined && live
          ? { ...config, baseURL: live.baseURL }
          : config,
      );
      const staleCount = sessions.filter((session) => !session.running).length;
      const state =
        inventory.issues.length > 0
          ? "failed"
          : staleCount > 0
            ? "degraded"
            : live
              ? health.ok
                ? "ready"
                : "degraded"
              : config.baseURL !== undefined
                ? health.ok
                  ? "ready"
                  : "failed"
                : health.ok
                  ? "stopped"
                  : "failed";
      const installed =
        health.checks.find((check) => check.name === "plugin")?.ok === true;
      const endpointCheck = health.checks.find(
        (check) => check.name === "endpoint",
      );
      const running = state === "ready";
      const ok =
        (state === "ready" || state === "stopped") &&
        (!parsed.requireRunning || running);
      const result = {
        ok,
        installed,
        state,
        running,
        requireRunning: parsed.requireRunning,
        endpoint: {
          reachable: endpointCheck?.ok === true,
          expected: config.baseURL !== undefined || live !== undefined,
        },
        sessions: sessions.map(publicServeState),
        invalidStateFiles: inventory.issues,
        health,
      };
      out.write(
        parsed.json
          ? result
          : `State: ${state}${parsed.requireRunning ? " (running required)" : ""}\n${sessions.length} valid session(s), ${sessions.filter((session) => session.running).length} live, ${inventory.issues.length} invalid state file(s)\n${formatDoctor(health)}`,
      );
      return ok ? EXIT.ok : EXIT.unavailable;
    }
    if (command === "stop") {
      const result = await stopOwnedServe();
      const ok =
        result.unreachablePids.length === 0 &&
        result.invalidStateFiles.length === 0;
      out.write(parsed.json ? { ok, ...result } : result.detail);
      return ok ? EXIT.ok : EXIT.unavailable;
    }
    if (command === "smoke" && parsed.transportOnly) {
      const config = await resolveConfig(parsed.config);
      const isolated = await prepareIsolatedHermesHome();
      try {
        const mock = await withMockQvac();
        try {
          const result = await runHermesCaptured(
            mock.baseURL,
            config.model,
            ["-z", "Reply with exactly pong.", "--ignore-user-config", "--cli"],
            config,
            { ...isolated.env, HERMES_MAX_TOKENS: "256" },
          );
          const passed = result.code === 0 && result.stdout.trim() === "pong";
          const smokeResult = {
            ok: passed,
            event: "result",
            mode: "transport-only",
            isolatedHermesHome: true,
            hermesExitCode: result.code,
            response: redactSecretText(result.stdout.trim(), [config.apiKey]),
            ...(passed
              ? {}
              : {
                  stderr: redactSecretText(result.stderr.trim(), [
                    config.apiKey,
                  ]),
                }),
          };
          out.write(
            parsed.json
              ? smokeResult
              : passed
                ? "Transport smoke passed: Hermes returned exactly pong."
                : `Transport smoke failed (Hermes exit ${result.code}): ${redactSecretText((result.stderr || result.stdout).trim(), [config.apiKey])}`,
          );
          return passed ? EXIT.ok : EXIT.failed;
        } finally {
          await mock.close();
        }
      } finally {
        await isolated.cleanup();
      }
    }
    if (command === "start") {
      if (parsed.external || parsed.config.baseURL)
        throw new TypeError(
          "start is the managed beginner path; use run --external for an existing endpoint",
        );
      if (!commandVersion("hermes"))
        throw new UnavailableError(
          "Hermes is not installed or 'hermes --version' failed. Install Hermes using its current official instructions, then re-run this command.",
        );
      const config = (effectiveConfig = await resolveConfig(parsed.config));
      const storage = await modelStoragePreflight(config);
      await confirmBeginnerDownload(
        config,
        storage.requiredDownloadBytes,
        parsed.yes,
      );
      const changesConfig = hasConfigOverrides(parsed.config);
      const priorConfig = changesConfig ? await readSavedConfig() : undefined;
      if (changesConfig) await saveConfig(parsed.config);
      let installed: Awaited<ReturnType<typeof setupPlugin>>;
      try {
        installed = await setupPlugin();
      } catch (error) {
        if (priorConfig) {
          try {
            await resetConfig();
            if (Object.keys(priorConfig).length > 0)
              await saveConfig(priorConfig);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              "Beginner setup failed and the previous saved configuration could not be restored",
            );
          }
        }
        throw error;
      }
      stderr.write(
        `QVAC provider ${installed.upgraded ? "upgraded" : "installed"}. ${beginnerCapacityMessage(config)}\nStarting QVAC; the first model load may take several minutes...\n`,
      );
      parsed.command = "run";
      parsed.hermesArgs =
        parsed.hermesArgs.length > 0 ? parsed.hermesArgs : ["--cli"];
    }
    if (
      parsed.command === "run" ||
      command === "serve" ||
      command === "smoke"
    ) {
      const config = (effectiveConfig = await resolveConfig(parsed.config));
      if (parsed.toolTask) await assertFreshToolWorkspace(config);
      if (command === "smoke" && !parsed.yes && !config.baseURL) {
        throw new Error(physicalDownloadConsentMessage(config));
      }
      const hermesArgs = parsed.toolTask
        ? [
            "-z",
            `Create a file named ${TOOL_PROOF_FILE} containing exactly ${TOOL_PROOF_CONTENT}, then reply exactly DONE. Do not claim success unless the tool completed successfully.`,
            "--ignore-rules",
          ]
        : command === "smoke"
          ? ["-z", "Reply with exactly pong.", "--ignore-user-config", "--cli"]
          : parsed.hermesArgs;
      if (parsed.external || config.baseURL) {
        if (command === "serve")
          throw new Error(
            "serve manages a QVAC process; remove --external/--base-url or use doctor for an existing endpoint",
          );
        const result = await runAgainstEndpoint(
          config,
          hermesArgs,
          command === "smoke",
        );
        if (typeof result === "number") return result;
        const sideEffectVerified = parsed.toolTask
          ? await toolOutcomeVerified(config)
          : undefined;
        const passed = parsed.toolTask
          ? result.code === 0 && sideEffectVerified === true
          : result.code === 0 && result.stdout.trim() === "pong";
        const smokeResult = {
          ok: passed,
          event: "result",
          mode: "physical-external",
          hermesExitCode: result.code,
          response: redactSecretText(result.stdout.trim(), [config.apiKey]),
          ...(parsed.toolTask ? { sideEffectVerified } : {}),
          ...(passed
            ? {}
            : {
                stderr: redactSecretText(result.stderr.trim(), [config.apiKey]),
              }),
        };
        out.write(
          parsed.json
            ? smokeResult
            : passed
              ? parsed.toolTask
                ? "External tool smoke passed: Hermes created the verified proof file."
                : "External physical smoke passed: Hermes returned exactly pong."
              : `External physical smoke failed (Hermes exit ${result.code}): ${redactSecretText((result.stderr || result.stdout).trim(), [config.apiKey])}`,
        );
        return passed ? EXIT.ok : EXIT.failed;
      }
      let provider: Awaited<ReturnType<typeof startManaged>>;
      try {
        provider = await startManaged(config);
      } catch (error) {
        throw new UnavailableError(
          `Managed QVAC is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let control: Awaited<ReturnType<typeof createSessionControl>>;
      try {
        control = await createSessionControl();
      } catch (error) {
        try {
          await provider.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "Could not create session control or release managed QVAC",
          );
        }
        throw error;
      }
      try {
        await writeServeState({
          owner: "hermes-qvac",
          cliPid: process.pid,
          servePid: provider.pid,
          baseURL: provider.baseURL,
          model: config.model,
          startedAt: new Date().toISOString(),
          controlPort: control.port,
          controlToken: control.token,
        });
        out.write(
          parsed.json
            ? {
                ok: true,
                event: "ready",
                state: "ready",
                baseURL: provider.baseURL,
                port: provider.port,
                pid: provider.pid,
                model: config.model,
              }
            : `QVAC ready at ${provider.baseURL} (pid ${provider.pid})`,
        );
        if (command === "serve") {
          const signal = await waitForShutdownSignal();
          out.write(
            parsed.json
              ? { ok: true, event: "stopping", state: "stopping", signal }
              : `Stopping after ${signal}`,
          );
          return EXIT.ok;
        }
        if (command === "smoke") {
          const result = await runHermesCaptured(
            provider.baseURL,
            config.model,
            hermesArgs,
            config,
            { HERMES_MAX_TOKENS: "256" },
          );
          const sideEffectVerified = parsed.toolTask
            ? await toolOutcomeVerified(config)
            : undefined;
          const passed = parsed.toolTask
            ? result.code === 0 && sideEffectVerified === true
            : result.code === 0 && result.stdout.trim() === "pong";
          const smokeResult = {
            ok: passed,
            event: "result",
            mode: "physical-managed",
            hermesExitCode: result.code,
            response: redactSecretText(result.stdout.trim(), [config.apiKey]),
            ...(parsed.toolTask ? { sideEffectVerified } : {}),
            ...(passed
              ? {}
              : {
                  stderr: redactSecretText(result.stderr.trim(), [
                    config.apiKey,
                  ]),
                }),
          };
          out.write(
            parsed.json
              ? smokeResult
              : passed
                ? parsed.toolTask
                  ? "Managed tool smoke passed: Hermes created the verified proof file."
                  : "Managed physical smoke passed: Hermes returned exactly pong."
                : `Managed physical smoke failed (Hermes exit ${result.code}): ${redactSecretText((result.stderr || result.stdout).trim(), [config.apiKey])}`,
          );
          return passed ? EXIT.ok : EXIT.failed;
        }
        const code = await runHermes(
          provider.baseURL,
          config.model,
          hermesArgs,
          config,
        );
        return code;
      } finally {
        const cleanup = await Promise.allSettled([
          clearServeState(),
          control.close(),
          provider.close(),
        ]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            "One or more managed-session cleanup operations failed",
          );
      }
    }
    out.write(usage());
    return EXIT.usage;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    message = redactSecretText(message, [
      parsed.config.apiKey,
      effectiveConfig?.apiKey,
      process.env.QVAC_API_KEY,
    ]);
    message = (redactSecrets({ error: message }) as { error: string }).error;
    process.stderr.write(
      parsed.json
        ? `${JSON.stringify({ ok: false, error: message })}\n`
        : `hermes-qvac: ${message}\n`,
    );
    return error instanceof TypeError
      ? EXIT.usage
      : error instanceof UnavailableError
        ? EXIT.unavailable
        : EXIT.failed;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) process.exitCode = await main();
