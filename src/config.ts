import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { qvacCatalog } from "@qvac/ai-sdk-provider/models";

export interface HermesQvacConfig {
  profile: "full" | "fast";
  model: string;
  auxModel: string;
  host: string;
  port?: number;
  baseURL?: string;
  apiKey: string;
  qvacBin?: string;
  cwd?: string;
  ctxSize: number;
  reasoningBudget: number;
  tools: boolean;
  readyTimeoutMs: number;
  idleStopMs: number;
  timeoutSeconds: number;
  reuse: boolean;
}

export type ConfigOverrides = Partial<HermesQvacConfig>;
const MAX_NODE_TIMER_MS = 2_147_483_647;
const CONFIG_KEYS = new Set<keyof HermesQvacConfig>([
  "model",
  "profile",
  "auxModel",
  "host",
  "port",
  "baseURL",
  "apiKey",
  "qvacBin",
  "cwd",
  "ctxSize",
  "reasoningBudget",
  "tools",
  "readyTimeoutMs",
  "idleStopMs",
  "timeoutSeconds",
  "reuse",
]);

export const DEFAULT_CONFIG: Readonly<HermesQvacConfig> = Object.freeze({
  profile: "full",
  model: "qwen3.5-9b",
  auxModel: "qwen3.5-2b",
  host: "127.0.0.1",
  apiKey: "custom-local",
  ctxSize: 32768,
  reasoningBudget: 0,
  tools: true,
  readyTimeoutMs: 900_000,
  idleStopMs: 0,
  timeoutSeconds: 300,
  reuse: true,
});

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
  return join(home, "hermes-qvac", "config.json");
}

function optionalNumber(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new TypeError(`${name} must be a finite number`);
  return parsed;
}

function optionalBoolean(
  name: string,
  value: string | undefined,
): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new TypeError(`${name} must be a boolean`);
}

export function environmentOverrides(
  env: NodeJS.ProcessEnv = process.env,
): ConfigOverrides {
  const port = optionalNumber("QVAC_PORT", env.QVAC_PORT);
  const ctxSize = optionalNumber("QVAC_CTX_SIZE", env.QVAC_CTX_SIZE);
  const reasoningBudget = optionalNumber(
    "QVAC_REASONING_BUDGET",
    env.QVAC_REASONING_BUDGET,
  );
  const tools = optionalBoolean("QVAC_TOOLS", env.QVAC_TOOLS);
  const readyTimeoutMs = optionalNumber(
    "QVAC_READY_TIMEOUT_MS",
    env.QVAC_READY_TIMEOUT_MS,
  );
  const idleStopMs = optionalNumber("QVAC_IDLE_STOP_MS", env.QVAC_IDLE_STOP_MS);
  const timeoutSeconds = optionalNumber(
    "QVAC_TIMEOUT_SECONDS",
    env.QVAC_TIMEOUT_SECONDS,
  );
  const reuse = optionalBoolean("QVAC_REUSE", env.QVAC_REUSE);
  return {
    ...(env.HERMES_QVAC_PROFILE
      ? { profile: env.HERMES_QVAC_PROFILE as HermesQvacConfig["profile"] }
      : {}),
    ...(env.QVAC_MODEL ? { model: env.QVAC_MODEL } : {}),
    ...(env.QVAC_AUX_MODEL ? { auxModel: env.QVAC_AUX_MODEL } : {}),
    ...(env.QVAC_HOST ? { host: env.QVAC_HOST } : {}),
    ...(port === undefined ? {} : { port }),
    ...(env.QVAC_BASE_URL ? { baseURL: env.QVAC_BASE_URL } : {}),
    ...(env.QVAC_API_KEY ? { apiKey: env.QVAC_API_KEY } : {}),
    ...(env.QVAC_BIN ? { qvacBin: env.QVAC_BIN } : {}),
    ...(env.QVAC_CWD ? { cwd: env.QVAC_CWD } : {}),
    ...(ctxSize === undefined ? {} : { ctxSize }),
    ...(reasoningBudget === undefined ? {} : { reasoningBudget }),
    ...(tools === undefined ? {} : { tools }),
    ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    ...(idleStopMs === undefined ? {} : { idleStopMs }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(reuse === undefined ? {} : { reuse }),
  } as ConfigOverrides;
}

export async function readSavedConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigOverrides> {
  try {
    const path = configPath(env);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new TypeError("saved config path must be a regular file");
    if (info.size > 64 * 1024)
      throw new TypeError("saved config exceeds 64 KiB");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new TypeError("saved config must be a JSON object");
    for (const key of Object.keys(parsed))
      if (!CONFIG_KEYS.has(key as keyof HermesQvacConfig))
        throw new TypeError(`unknown saved config key: ${key}`);
    return parsed as ConfigOverrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Could not read ${configPath(env)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
}

export function validateConfig(input: HermesQvacConfig): HermesQvacConfig {
  const config = { ...input };
  for (const key of Object.keys(config))
    if (!CONFIG_KEYS.has(key as keyof HermesQvacConfig))
      throw new TypeError(`unknown config key: ${key}`);
  if (!(["full", "fast"] as const).includes(config.profile))
    throw new TypeError("profile must be full or fast");
  if (typeof config.model !== "string")
    throw new TypeError("model must be a string");
  if (typeof config.auxModel !== "string")
    throw new TypeError("auxModel must be a string");
  if (!config.model.trim()) throw new TypeError("model must not be empty");
  if (!config.auxModel.trim())
    throw new TypeError("auxModel must not be empty");
  const mainEntry = qvacCatalog.find(
    (entry) => entry.id === config.model || entry.constant === config.model,
  );
  const auxEntry = qvacCatalog.find(
    (entry) =>
      entry.id === config.auxModel || entry.constant === config.auxModel,
  );
  const externalEndpoint = config.baseURL !== undefined;
  if (!externalEndpoint && !mainEntry)
    throw new TypeError(`unknown model '${config.model}'`);
  if (!externalEndpoint && !auxEntry)
    throw new TypeError(`unknown auxiliary model '${config.auxModel}'`);
  config.model = mainEntry?.id ?? config.model.trim();
  config.auxModel = auxEntry?.id ?? config.auxModel.trim();
  if (config.host !== "localhost" && config.host !== "127.0.0.1") {
    throw new TypeError(
      "host must be the loopback address 127.0.0.1 or localhost",
    );
  }
  if (config.port !== undefined) {
    validatePositiveInteger("port", config.port);
    if (config.port > 65535) throw new TypeError("port must be at most 65535");
  }
  validatePositiveInteger("ctxSize", config.ctxSize);
  if (
    !Number.isSafeInteger(config.reasoningBudget) ||
    config.reasoningBudget < -1
  )
    throw new TypeError("reasoningBudget must be -1 or a non-negative integer");
  validatePositiveInteger("readyTimeoutMs", config.readyTimeoutMs);
  if (config.readyTimeoutMs > MAX_NODE_TIMER_MS)
    throw new TypeError(`readyTimeoutMs must be at most ${MAX_NODE_TIMER_MS}`);
  if (!Number.isSafeInteger(config.idleStopMs) || config.idleStopMs < 0)
    throw new TypeError("idleStopMs must be a non-negative integer");
  if (config.idleStopMs > MAX_NODE_TIMER_MS)
    throw new TypeError(`idleStopMs must be at most ${MAX_NODE_TIMER_MS}`);
  validatePositiveInteger("timeoutSeconds", config.timeoutSeconds);
  if (config.timeoutSeconds > Math.floor(MAX_NODE_TIMER_MS / 1_000))
    throw new TypeError(
      `timeoutSeconds must be at most ${Math.floor(MAX_NODE_TIMER_MS / 1_000)}`,
    );
  if (typeof config.tools !== "boolean")
    throw new TypeError("tools must be a boolean");
  if (typeof config.reuse !== "boolean")
    throw new TypeError("reuse must be a boolean");
  if (
    typeof config.apiKey !== "string" ||
    !config.apiKey.trim() ||
    /[\r\n]/.test(config.apiKey)
  )
    throw new TypeError("apiKey must be a non-empty single-line string");
  if (config.qvacBin !== undefined && typeof config.qvacBin !== "string")
    throw new TypeError("qvacBin must be a string");
  if (config.cwd !== undefined && typeof config.cwd !== "string")
    throw new TypeError("cwd must be a string");
  if (config.cwd && config.reuse)
    throw new TypeError(
      "cwd requires reuse=false because the official QVAC fleet key does not include working directory",
    );
  if (config.baseURL !== undefined) {
    if (typeof config.baseURL !== "string")
      throw new TypeError("baseURL must be a string");
    let url: URL;
    try {
      url = new URL(config.baseURL);
    } catch {
      throw new TypeError("baseURL must be a valid URL ending in /v1");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new TypeError("baseURL must use http or https");
    if (url.username || url.password)
      throw new TypeError(
        "baseURL must not embed credentials; use apiKey instead",
      );
    if (url.search || url.hash)
      throw new TypeError(
        "baseURL must not contain a query string or fragment",
      );
    if (!url.pathname.replace(/\/$/, "").endsWith("/v1"))
      throw new TypeError("baseURL path must end in /v1");
    config.baseURL = config.baseURL.replace(/\/$/, "");
  }
  if (config.cwd !== undefined && !config.cwd.trim()) delete config.cwd;
  if (config.qvacBin !== undefined && !config.qvacBin.trim())
    delete config.qvacBin;
  return config;
}

export async function resolveConfig(
  cli: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesQvacConfig> {
  const saved = await readSavedConfig(env);
  return validateConfig({
    ...DEFAULT_CONFIG,
    ...saved,
    ...environmentOverrides(env),
    ...cli,
  });
}

export async function saveConfig(
  overrides: ConfigOverrides,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HermesQvacConfig> {
  const current = await readSavedConfig(env);
  const candidate = { ...current, ...overrides };
  const resolved = validateConfig({
    ...DEFAULT_CONFIG,
    ...candidate,
  });
  const persisted: ConfigOverrides = {};
  for (const key of Object.keys(candidate) as (keyof HermesQvacConfig)[]) {
    const value = resolved[key];
    if (value !== undefined) Object.assign(persisted, { [key]: value });
  }
  const path = configPath(env);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Refusing unsafe configuration directory: ${directory}`);
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return resolved;
}

export async function resetConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await rm(configPath(env));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function publicConfig(
  config: HermesQvacConfig,
): Record<string, unknown> {
  return redactSecrets(config) as Record<string, unknown>;
}

const SECRET_KEY =
  /(?:api[-_]?key|authorization|control[-_]?token|password|secret|token)/i;

export function redactSecrets(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => redactSecrets(entry, seen));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key)
      ? key === "apiKey" && entry === "custom-local"
        ? "custom-local"
        : "[redacted]"
      : redactSecrets(entry, seen);
  }
  return result;
}

export function redactSecretText(
  value: string,
  secrets: readonly (string | undefined)[],
): string {
  let redacted = value;
  for (const secret of new Set(secrets)) {
    if (secret && secret !== "custom-local")
      redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}
