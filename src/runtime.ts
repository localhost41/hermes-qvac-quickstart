import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createQvac, type ManagedQvacProvider } from "@qvac/ai-sdk-provider";
import {
  allModels,
  qvacCatalog,
  resolveModelConstant,
} from "@qvac/ai-sdk-provider/models";
import {
  publicConfig,
  redactSecrets,
  type HermesQvacConfig,
} from "./config.js";

export const EXIT = { ok: 0, usage: 2, unavailable: 3, failed: 4 } as const;
export const DEFAULT_MODEL = "qwen3.5-9b";
export const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function assertBareRuntimePlatform(): string {
  const key = `${process.platform}-${process.arch}`;
  const packages: Record<string, string> = {
    "darwin-arm64": "bare-runtime-darwin-arm64",
    "darwin-x64": "bare-runtime-darwin-x64",
    "linux-arm64": "bare-runtime-linux-arm64",
    "linux-x64": "bare-runtime-linux-x64",
    "win32-arm64": "bare-runtime-win32-arm64",
    "win32-x64": "bare-runtime-win32-x64",
  };
  const packageName = packages[key];
  if (!packageName) return key;
  try {
    createRequire(import.meta.url)(packageName);
  } catch (error) {
    throw new Error(
      `QVAC cannot load its Bare runtime for ${key}. Reinstall @localhost41/hermes-qvac-provider with npm so optional platform dependencies are included (missing ${packageName} or one of its dependencies).`,
      { cause: error },
    );
  }
  return packageName;
}

export interface Output {
  json: boolean;
  write(value: unknown): void;
}
export function output(json: boolean): Output {
  return {
    json,
    write(value) {
      process.stdout.write(
        typeof value === "string"
          ? `${value}\n`
          : `${JSON.stringify(redactSecrets(value))}\n`,
      );
    },
  };
}

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HERMES_HOME ?? join(homedir(), ".hermes"));
}

export function pluginDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(hermesHome(env), "plugins", "model-providers", "qvac");
}

export interface ServeState {
  owner: "hermes-qvac";
  cliPid: number;
  servePid: number;
  baseURL: string;
  model: string;
  startedAt: string;
  controlPort: number;
  controlToken: string;
}

export interface SessionControl {
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function createSessionControl(
  onStop: () => void = () => process.kill(process.pid, "SIGTERM"),
): Promise<SessionControl> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (
      !["POST", "GET"].includes(request.method ?? "") ||
      !["/stop", "/health"].includes(request.url ?? "")
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const supplied =
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const expectedBuffer = Buffer.from(token);
    const suppliedBuffer = Buffer.from(supplied);
    if (
      expectedBuffer.length !== suppliedBuffer.length ||
      !timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
      response.statusCode = 403;
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/stop") {
      response.statusCode = 405;
      response.end();
      return;
    }
    response.statusCode = 202;
    response.end();
    setImmediate(onStop);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("session control did not bind TCP");
  }
  return {
    port: address.port,
    token,
    close: () =>
      new Promise((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}

export function serveStatePath(
  env: NodeJS.ProcessEnv = process.env,
  cliPid = process.pid,
): string {
  return join(hermesHome(env), "hermes-qvac", "sessions", `${cliPid}.json`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function writeServeState(
  state: ServeState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = serveStatePath(env, state.cliPid);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Refusing unsafe session directory: ${directory}`);
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface SessionStateIssue {
  file: string;
  error: string;
}

function validateServeState(value: unknown, path: string): ServeState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("state must be an object");
  const state = value as Partial<ServeState>;
  const filePid = Number.parseInt(basename(path, ".json"), 10);
  if (state.owner !== "hermes-qvac") throw new Error("invalid owner");
  if (
    !Number.isSafeInteger(state.cliPid) ||
    state.cliPid! <= 0 ||
    state.cliPid !== filePid
  )
    throw new Error("invalid CLI pid");
  if (!Number.isSafeInteger(state.servePid) || state.servePid! <= 0)
    throw new Error("invalid serve pid");
  if (
    !Number.isSafeInteger(state.controlPort) ||
    state.controlPort! <= 0 ||
    state.controlPort! > 65535
  )
    throw new Error("invalid control port");
  if (
    typeof state.controlToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(state.controlToken)
  )
    throw new Error("invalid control token");
  if (
    typeof state.baseURL !== "string" ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1$/.test(state.baseURL)
  )
    throw new Error("invalid managed base URL");
  if (
    typeof state.model !== "string" ||
    state.model.length === 0 ||
    state.model.length > 200
  )
    throw new Error("invalid model");
  if (
    typeof state.startedAt !== "string" ||
    !Number.isFinite(Date.parse(state.startedAt))
  )
    throw new Error("invalid start time");
  return state as ServeState;
}

async function readStateFile(
  path: string,
): Promise<ServeState & { running: boolean }> {
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("state path is not a regular file");
    if (file.size > 64 * 1024) throw new Error("state file exceeds 64 KiB");
    const state = validateServeState(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      path,
    );
    return { ...state, running: pidAlive(state.cliPid) };
  } catch (error) {
    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readServeStateInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  states: Array<ServeState & { running: boolean }>;
  issues: SessionStateIssue[];
}> {
  const directory = dirname(serveStatePath(env));
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { states: [], issues: [] };
    throw error;
  }
  const states: Array<ServeState & { running: boolean }> = [];
  const issues: SessionStateIssue[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      states.push(await readStateFile(join(directory, file)));
    } catch (error) {
      issues.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { states, issues };
}

export async function readServeStates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<ServeState & { running: boolean }>> {
  return (await readServeStateInventory(env)).states;
}

export async function readServeState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<(ServeState & { running: boolean }) | null> {
  return (await readServeStates(env)).find((state) => state.running) ?? null;
}

export async function clearServeState(
  expectedCliPid = process.pid,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(serveStatePath(env, expectedCliPid), { force: true });
}

export async function stopOwnedServe(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  stopped: boolean;
  stoppedPids: number[];
  stalePids: number[];
  unreachablePids: number[];
  invalidStateFiles: string[];
  detail: string;
}> {
  const inventory = await readServeStateInventory(env);
  const states = inventory.states;
  const stoppedPids: number[] = [];
  const stalePids: number[] = [];
  const unreachablePids: number[] = [];
  for (const state of states) {
    if (!state.running) {
      await clearServeState(state.cliPid, env);
      stalePids.push(state.cliPid);
      continue;
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${state.controlPort}/stop`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${state.controlToken}` },
          signal: AbortSignal.timeout(2_000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      stoppedPids.push(state.cliPid);
    } catch {
      unreachablePids.push(state.cliPid);
    }
  }
  return {
    stopped: stoppedPids.length > 0,
    stoppedPids,
    stalePids,
    unreachablePids,
    invalidStateFiles: inventory.issues.map((issue) => issue.file),
    detail:
      stoppedPids.length > 0
        ? `Requested authenticated shutdown from hermes-qvac CLI pid(s) ${stoppedPids.join(", ")}; shared QVAC cleanup remains owned by the official supervisor.${unreachablePids.length > 0 ? ` Refused to signal live pid(s) ${unreachablePids.join(", ")} whose authenticated control endpoint was unreachable.` : ""}`
        : unreachablePids.length > 0
          ? `Refused to signal live pid(s) ${unreachablePids.join(", ")} because their authenticated control endpoint was unreachable.`
          : stalePids.length > 0
            ? `Removed stale state for CLI pid(s) ${stalePids.join(", ")}; no process was signaled.`
            : `No hermes-qvac managed sessions are registered.${inventory.issues.length > 0 ? ` Ignored ${inventory.issues.length} invalid state file(s).` : ""}`,
  };
}

export function publicServeState(
  state: ServeState & { running: boolean },
): Omit<ServeState, "controlToken"> & { running: boolean } {
  const { controlToken: _controlToken, ...visible } = state;
  return visible;
}

export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolvePromise) => {
    const keepAlive = setInterval(() => {}, 60_000);
    const done = (signal: NodeJS.Signals) => {
      clearInterval(keepAlive);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolvePromise(signal);
    };
    const onInt = () => done("SIGINT");
    const onTerm = () => done("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isPluginInstalled(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return exists(join(pluginDir(env), "plugin.yaml"));
}

export async function isPluginOwned(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return isOwnedPluginPath(pluginDir(env));
}

async function isOwnedPluginPath(target: string): Promise<boolean> {
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) return false;
    const markerPath = join(target, ".hermes-qvac-provider.json");
    const markerInfo = await lstat(markerPath);
    if (
      !markerInfo.isFile() ||
      markerInfo.isSymbolicLink() ||
      markerInfo.size > 16 * 1024
    )
      return false;
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    if (!marker || typeof marker !== "object" || Array.isArray(marker))
      return false;
    const owned = marker as {
      schema?: unknown;
      package?: unknown;
      pluginId?: unknown;
      files?: unknown;
    };
    if (
      owned.schema !== 1 ||
      owned.package !== "@localhost41/hermes-qvac-provider" ||
      owned.pluginId !== "qvac" ||
      !owned.files ||
      typeof owned.files !== "object" ||
      Array.isArray(owned.files)
    )
      return false;
    const expectedFiles = [
      "__init__.py",
      "plugin.yaml",
      "qvac_provider/__init__.py",
    ];
    for (const relative of expectedFiles) {
      const info = await lstat(join(target, relative));
      if (!info.isFile() || info.isSymbolicLink()) return false;
      const digest = createHash("sha256")
        .update(await readFile(join(target, relative)))
        .digest("hex");
      if ((owned.files as Record<string, unknown>)[relative] !== digest)
        return false;
    }
    if (Object.keys(owned.files as object).length !== expectedFiles.length)
      return false;
    const topLevel = await readdir(target);
    if (
      topLevel.some(
        (entry) =>
          ![
            "__init__.py",
            "plugin.yaml",
            "qvac_provider",
            "__pycache__",
            ".hermes-qvac-provider.json",
          ].includes(entry),
      )
    )
      return false;
    const providerEntries = await readdir(join(target, "qvac_provider"));
    return providerEntries.every((entry) =>
      ["__init__.py", "__pycache__"].includes(entry),
    );
  } catch {
    return false;
  }
}

async function isRecognizedLegacyPlugin(target: string): Promise<boolean> {
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) return false;
    const expected = {
      "__init__.py": new Set([
        "20896f6d333be289a2dc0ec1971ed994de31e9e2eb3a718612b1e2d83455a340",
      ]),
      "plugin.yaml": new Set([
        // Published 0.1.0-alpha.1 and 0.1.0-alpha.3 manifests.
        "2aefab42136f94a3bf3bff48ed23ea31c0f719f115307d18065ece338137f48d",
        "f85a38382695c86ee718fd5d352b8ea17679641dbd31adc49272b1d857a94a74",
      ]),
      "qvac_provider/__init__.py": new Set([
        "47ec80cd23582fb39a4aba9b1fe11964687cbe6cc5cd1606a17951b671427e53",
      ]),
    } as const;
    for (const [relative, digests] of Object.entries(expected)) {
      const path = join(target, relative);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024)
        return false;
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      if (!(digests as ReadonlySet<string>).has(digest)) return false;
    }
    const topLevel = await readdir(target);
    if (
      topLevel.some(
        (entry) =>
          ![
            "__init__.py",
            "plugin.yaml",
            "qvac_provider",
            "__pycache__",
          ].includes(entry),
      )
    )
      return false;
    const providerEntries = await readdir(join(target, "qvac_provider"));
    return providerEntries.every((entry) =>
      ["__init__.py", "__pycache__"].includes(entry),
    );
  } catch {
    return false;
  }
}

interface StagedPluginInstall {
  result: { path: string; upgraded: boolean };
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function stagePluginInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StagedPluginInstall> {
  const target = pluginDir(env);
  const upgraded = await pathExists(target);
  if (upgraded && (await lstat(target)).isSymbolicLink())
    throw new Error(`Refusing to replace symbolic-link plugin path: ${target}`);
  if (
    upgraded &&
    !(await isPluginOwned(env)) &&
    !(await isRecognizedLegacyPlugin(target))
  ) {
    throw new Error(
      `Refusing to replace unrecognized plugin directory: ${target}`,
    );
  }
  const parent = dirname(target);
  const nonce = `${process.pid}-${randomUUID()}`;
  const staging = join(parent, `.qvac.install-${nonce}`);
  const backup = join(parent, `.qvac.backup-${nonce}`);
  await mkdir(join(staging, "qvac_provider"), { recursive: true });
  try {
    for (const relative of [
      "__init__.py",
      "plugin.yaml",
      "qvac_provider/__init__.py",
    ]) {
      await cp(join(PACKAGE_ROOT, relative), join(staging, relative));
    }
    const files: Record<string, string> = {};
    for (const relative of [
      "__init__.py",
      "plugin.yaml",
      "qvac_provider/__init__.py",
    ]) {
      files[relative] = createHash("sha256")
        .update(await readFile(join(staging, relative)))
        .digest("hex");
    }
    await writeFile(
      join(staging, ".hermes-qvac-provider.json"),
      `${JSON.stringify({ schema: 1, package: "@localhost41/hermes-qvac-provider", pluginId: "qvac", installedAt: new Date().toISOString(), files }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (upgraded) await rename(target, backup);
    try {
      await rename(staging, target);
    } catch (error) {
      if (upgraded && (await exists(backup))) await rename(backup, target);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  let finished = false;
  return {
    result: { path: target, upgraded },
    async commit() {
      if (finished) return;
      finished = true;
      await rm(backup, { recursive: true, force: true });
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await rm(target, { recursive: true, force: true });
      if (upgraded && (await pathExists(backup))) await rename(backup, target);
    },
  };
}

async function recoverInterruptedInstall(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const target = pluginDir(env);
  const parent = dirname(target);
  let entries: string[];
  try {
    entries = (await readdir(parent)).filter((entry) =>
      entry.startsWith(".qvac.backup-"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length === 0) return;
  const backups = entries.map((entry) => join(parent, entry));
  for (const backup of backups) {
    const info = await lstat(backup);
    if (
      info.isSymbolicLink() ||
      (!(await isOwnedPluginPath(backup)) &&
        !(await isRecognizedLegacyPlugin(backup)))
    ) {
      throw new Error(
        `Refusing to alter unrecognized interrupted-install backup: ${backup}`,
      );
    }
  }
  if (!(await pathExists(target))) {
    if (backups.length !== 1)
      throw new Error(
        `Cannot safely recover ${backups.length} interrupted hermes-qvac backups below ${parent}`,
      );
    await rename(backups[0]!, target);
    return;
  }
  if (
    (await lstat(target)).isSymbolicLink() ||
    (!(await isOwnedPluginPath(target)) &&
      !(await isRecognizedLegacyPlugin(target)))
  ) {
    throw new Error(
      `Refusing to discard interrupted-install backup while an unrecognized plugin path exists: ${target}`,
    );
  }
  for (const backup of backups) await rm(backup, { recursive: true });
}

async function withInstallLock<T>(
  env: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = dirname(pluginDir(env));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error(`Refusing unsafe plugin parent directory: ${parent}`);
  const lockPath = join(parent, ".qvac.setup.lock");
  const deadline = Date.now() + 10_000;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const before = await lstat(lockPath);
        if (before.isFile() && !before.isSymbolicLink() && before.size <= 128) {
          const ownerText = (await readFile(lockPath, "utf8")).trim();
          const ownerPid = Number(ownerText);
          const ownerIsValid = Number.isSafeInteger(ownerPid) && ownerPid > 0;
          const stale = ownerIsValid
            ? !pidAlive(ownerPid)
            : Date.now() - before.mtimeMs > 2_000;
          const after = await lstat(lockPath);
          if (stale && before.dev === after.dev && before.ino === after.ino) {
            const quarantine = `${lockPath}.stale-${randomUUID()}`;
            await rename(lockPath, quarantine);
            const quarantined = await lstat(quarantine);
            if (
              quarantined.dev !== before.dev ||
              quarantined.ino !== before.ino
            ) {
              try {
                await rename(quarantine, lockPath);
              } catch {
                throw new Error(
                  `Setup lock changed during stale-lock recovery; preserved it at ${quarantine}`,
                );
              }
              throw new Error(
                "Setup lock changed during stale-lock recovery; retry safely",
              );
            }
            await rm(quarantine, { force: true });
            continue;
          }
        }
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT")
          continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for another hermes-qvac setup operation: ${lockPath}`,
        );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  const ownedLock = await handle.stat();
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close();
    try {
      const currentLock = await lstat(lockPath);
      if (
        currentLock.dev === ownedLock.dev &&
        currentLock.ino === ownedLock.ino
      )
        await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function installPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; upgraded: boolean }> {
  return withInstallLock(env, async () => {
    await recoverInterruptedInstall(env);
    const staged = await stagePluginInstall(env);
    await staged.commit();
    return staged.result;
  });
}

export async function setupPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; upgraded: boolean }> {
  return withInstallLock(env, async () => {
    await recoverInterruptedInstall(env);
    const staged = await stagePluginInstall(env);
    try {
      setPluginEnabled(true, env);
      await staged.commit();
      return staged.result;
    } catch (error) {
      await staged.rollback();
      throw error;
    }
  });
}

export function setPluginEnabled(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const args = enabled
    ? ["plugins", "enable", "qvac", "--no-allow-tool-override"]
    : ["plugins", "disable", "qvac"];
  const result = spawnSync("hermes", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Hermes could not ${enabled ? "enable" : "disable"} qvac: ${(result.stderr || result.error?.message || "unknown error").trim()}`,
    );
  }
}

export async function prepareIsolatedHermesHome(): Promise<{
  env: NodeJS.ProcessEnv;
  path: string;
  cleanup(): Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "hermes-qvac-smoke-"));
  const env = { HERMES_HOME: path };
  try {
    await setupPlugin(env);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return {
    env,
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}

export async function uninstallPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const target = pluginDir(env);
  if (!(await pathExists(target))) return false;
  if ((await lstat(target)).isSymbolicLink())
    throw new Error(`Refusing to remove symbolic-link plugin path: ${target}`);
  if (!(await isPluginOwned(env))) {
    throw new Error(
      `Refusing to remove plugin without ownership marker: ${target}`,
    );
  }
  await rm(target, { recursive: true });
  return true;
}

export async function uninstallOwnedPlugin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return withInstallLock(env, async () => {
    const target = pluginDir(env);
    if (!(await pathExists(target))) return false;
    if ((await lstat(target)).isSymbolicLink() || !(await isPluginOwned(env))) {
      throw new Error(
        `Refusing to disable or remove an unowned qvac plugin directory: ${target}`,
      );
    }
    setPluginEnabled(false, env);
    return uninstallPlugin(env);
  });
}

export function commandVersion(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
}

function hermesPluginState(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  detail: string;
} {
  const result = spawnSync(
    "hermes",
    ["plugins", "list", "--plain", "--no-bundled"],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0)
    return {
      ok: false,
      detail: (result.stderr || "could not list Hermes plugins").trim(),
    };
  const line = result.stdout
    .split("\n")
    .find((entry) => /^\s*(?:enabled\s+\S+\s+\S+\s+)?qvac(?:\s|$)/.test(entry));
  return {
    ok: /^\s*enabled(?:\s|$)/.test(line ?? ""),
    detail: line?.trim() ?? "qvac is not discovered",
  };
}

function hermesProfileState(
  versionOutput: string | null,
  config: HermesQvacConfig,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; detail: string } {
  const installDir = versionOutput
    ?.match(/^Install directory:\s*(.+)$/m)?.[1]
    ?.trim();
  if (!installDir)
    return {
      ok: false,
      detail:
        "Hermes version output did not expose its install directory, so ProviderProfile loading could not be verified",
    };
  const candidates = [
    ...(env.HERMES_PYTHON && isAbsolute(env.HERMES_PYTHON)
      ? [env.HERMES_PYTHON]
      : []),
    join(installDir, "venv", "bin", "python"),
    join(installDir, "venv", "Scripts", "python.exe"),
  ];
  const python = candidates.find((candidate) => existsSync(candidate));
  if (!python)
    return {
      ok: false,
      detail: `Hermes Python runtime was not found below ${installDir}; set HERMES_PYTHON to the absolute interpreter path for an official manual installation`,
    };
  const script = [
    "import json",
    "from providers import get_provider_profile",
    "p = get_provider_profile('qvac')",
    "assert p is not None, 'qvac profile was not registered'",
    "print(json.dumps({'class': type(p).__name__, 'provider_profile': any(c.__name__ == 'ProviderProfile' for c in type(p).__mro__), 'name': p.name, 'aliases': list(p.aliases), 'base_url': p.base_url, 'models_url': p.models_url, 'supports_vision': p.supports_vision, 'fallback_models': list(p.fallback_models), 'default_model': p.default_model, 'default_aux_model': p.default_aux_model, 'default_max_tokens': p.default_max_tokens, 'context_window': p.context_window}))",
  ].join("; ");
  const result = spawnSync(python, ["-c", script], {
    cwd: installDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      QVAC_BASE_URL:
        config.baseURL ?? `http://${config.host}:${config.port ?? 11434}/v1`,
    },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    return {
      ok: false,
      detail: (
        result.stderr ||
        result.stdout ||
        "ProviderProfile import failed"
      ).trim(),
    };
  try {
    const profile = JSON.parse(result.stdout.trim()) as {
      class: string;
      provider_profile: boolean;
      name: string;
      aliases: string[];
      base_url: string;
      models_url: string;
      supports_vision: boolean;
      fallback_models: string[];
      default_model: string;
      default_aux_model: string;
      default_max_tokens: number;
      context_window: number;
    };
    const expectedBaseURL =
      config.baseURL ?? `http://${config.host}:${config.port ?? 11434}/v1`;
    const expectedModels = qvacCatalog.map((entry) => entry.id);
    return {
      ok:
        profile.name === "qvac" &&
        profile.provider_profile &&
        profile.supports_vision &&
        profile.base_url === expectedBaseURL &&
        profile.models_url === "" &&
        profile.default_model === DEFAULT_MODEL &&
        profile.default_aux_model === "qwen3.5-2b" &&
        profile.default_max_tokens === 8192 &&
        profile.context_window === 32768 &&
        profile.aliases.includes("local-qvac") &&
        profile.aliases.includes("qvac-local") &&
        JSON.stringify(profile.fallback_models) ===
          JSON.stringify(expectedModels),
      detail: `${profile.class}(ProviderProfile) name=${profile.name} base_url=${profile.base_url} models_url=${JSON.stringify(profile.models_url)} defaults=${profile.default_model}/${profile.default_aux_model} catalog=${profile.fallback_models.length} vision=${profile.supports_vision}`,
    };
  } catch {
    return {
      ok: false,
      detail: `Hermes profile check returned invalid JSON: ${result.stdout.trim()}`,
    };
  }
}

const MAX_ENDPOINT_BYTES = 1024 * 1024;

async function boundedResponseText(
  response: Response,
  maxBytes = MAX_ENDPOINT_BYTES,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new Error(`models endpoint response exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new Error(`models endpoint response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function endpointModels(
  baseURL: string,
  timeoutMs = 2_000,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(`${baseURL.replace(/\/$/, "")}/models`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok)
    throw new Error(`models endpoint returned HTTP ${response.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await boundedResponseText(response));
  } catch (error) {
    throw new Error(
      `models endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    throw new Error("models endpoint response must contain a data array");
  }
  const data = (body as { data: unknown[] }).data;
  if (data.length > 10_000)
    throw new Error("models endpoint returned too many models");
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("models endpoint contains an invalid model entry");
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0 || id.length > 200)
      throw new Error("models endpoint contains an invalid model id");
    models.push(id);
  }
  return models;
}

export async function waitForEndpointModels(
  baseURL: string,
  requiredModels: string[],
  timeoutMs: number,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  sleepImpl: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "the endpoint did not respond";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      const models = await endpointModels(
        baseURL,
        Math.max(1, Math.min(5_000, remaining)),
        apiKey,
        fetchImpl,
      );
      const missing = requiredModels.filter((model) => !models.includes(model));
      if (missing.length === 0) return models;
      lastDetail = `missing ${missing.map((model) => `'${model}'`).join(", ")}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    const delay = Math.min(500, deadline - Date.now());
    if (delay > 0) await sleepImpl(delay);
  }
  throw new Error(
    `models endpoint did not advertise required models within ${timeoutMs}ms: ${lastDetail}`,
  );
}

function bundledQvacVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve("@qvac/cli");
    const result = spawnSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return result.status === 0 ? (result.stdout || result.stderr).trim() : null;
  } catch {
    return null;
  }
}

async function sessionControlHealthy(state: ServeState): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${state.controlPort}/health`,
      {
        headers: { authorization: `Bearer ${state.controlToken}` },
        signal: AbortSignal.timeout(1_000),
      },
    );
    return response.status === 204;
  } catch {
    return false;
  }
}

export async function doctor(
  config: HermesQvacConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const target = pluginDir(env);
  const checks: Array<{
    name: string;
    ok: boolean;
    required: boolean;
    detail: string;
  }> = [];
  const hermes = commandVersion("hermes", env);
  checks.push({
    name: "hermes",
    ok: hermes !== null,
    required: true,
    detail: hermes ?? "not found",
  });
  const hermesVersion = hermes?.match(/Hermes Agent v([^\s]+)/)?.[1];
  const fullyVerifiedHermesVersions = ["0.18.2", "0.19.0"];
  checks.push({
    name: "hermes-version",
    ok:
      hermesVersion !== undefined &&
      fullyVerifiedHermesVersions.includes(hermesVersion),
    required: false,
    detail: hermesVersion
      ? `detected ${hermesVersion}; fully verified baselines are ${fullyVerifiedHermesVersions.join(" and ")}`
      : "version could not be parsed; ProviderProfile compatibility is checked separately",
  });
  const qvac = commandVersion("qvac", env);
  const bundled = bundledQvacVersion();
  let configuredBinOk = true;
  const configuredBin =
    config.qvacBin && !isAbsolute(config.qvacBin) && config.cwd
      ? resolve(config.cwd, config.qvacBin)
      : config.qvacBin;
  if (config.qvacBin) {
    try {
      await access(configuredBin!, constants.X_OK);
    } catch {
      configuredBinOk = false;
    }
  }
  checks.push({
    name: "qvac",
    ok: config.qvacBin ? configuredBinOk : bundled !== null,
    required: true,
    detail: config.qvacBin
      ? `configured binary: ${configuredBin}${configuredBinOk ? "" : " (not executable)"}`
      : (bundled ?? qvac ?? "bundled @qvac/cli could not be executed"),
  });
  if (config.cwd) {
    let cwdOk = false;
    try {
      cwdOk = (await stat(config.cwd)).isDirectory();
    } catch {
      cwdOk = false;
    }
    checks.push({
      name: "cwd",
      ok: cwdOk,
      required: true,
      detail: `${config.cwd}${cwdOk ? "" : " is not a directory"}`,
    });
  }
  const installed = await exists(join(target, "plugin.yaml"));
  checks.push({
    name: "plugin",
    ok: installed,
    required: true,
    detail: installed ? target : `not installed at ${target}`,
  });
  const pluginOwned = await isPluginOwned(env);
  checks.push({
    name: "plugin-owned",
    ok: pluginOwned,
    required: true,
    detail: pluginOwned
      ? "valid localhost41 ownership marker"
      : "ownership marker missing or invalid",
  });
  const state = hermesPluginState(env);
  checks.push({
    name: "plugin-enabled",
    ok: state.ok,
    required: true,
    detail: state.detail,
  });
  const profile = hermesProfileState(hermes, config, env);
  checks.push({
    name: "provider-profile",
    ok: profile.ok,
    required: true,
    detail: profile.detail,
  });
  const selectedKnown = qvacCatalog.some(
    (m) => m.id === config.model || m.constant === config.model,
  );
  const auxKnown = qvacCatalog.some(
    (m) => m.id === config.auxModel || m.constant === config.auxModel,
  );
  checks.push({
    name: "catalog",
    ok: selectedKnown && auxKnown,
    required: true,
    detail: `${qvacCatalog.length} aliases; model=${config.model}; aux=${config.auxModel}`,
  });
  const baseURL =
    config.baseURL ?? `http://${config.host}:${config.port ?? 11434}/v1`;
  try {
    const models = await endpointModels(baseURL, 2_000, config.apiKey);
    const advertised = models.includes(config.model);
    const auxiliaryAdvertised = models.includes(config.auxModel);
    checks.push({
      name: "endpoint",
      ok: advertised && auxiliaryAdvertised,
      required: config.baseURL !== undefined,
      detail: `${baseURL} (${models.length} models${advertised ? "" : `; missing ${config.model}`}${auxiliaryAdvertised ? "" : `; missing auxiliary ${config.auxModel}`})`,
    });
  } catch (error) {
    checks.push({
      name: "endpoint",
      ok: false,
      required: config.baseURL !== undefined,
      detail: `${error instanceof Error ? error.message : String(error)}${config.baseURL ? "" : " (expected when managed QVAC is stopped)"}`,
    });
  }
  const inventory = await readServeStateInventory(env);
  const liveSessions = inventory.states.filter((session) => session.running);
  const controls = await Promise.all(liveSessions.map(sessionControlHealthy));
  checks.push({
    name: "sessions",
    ok: inventory.issues.length === 0 && controls.every(Boolean),
    required: false,
    detail: `${liveSessions.length} live, ${inventory.states.length - liveSessions.length} stale, ${inventory.issues.length} invalid, ${controls.filter(Boolean).length}/${controls.length} live controls healthy`,
  });
  return {
    ok: checks.every((c) => c.ok || !c.required),
    mode: config.baseURL ? "external" : "managed",
    baseURL,
    config: publicConfig(config),
    checks,
  };
}

export function listModels() {
  return qvacCatalog.map((model) => ({
    ...model,
    downloadBytes: allModels.find((entry) => entry.name === model.constant)
      ?.expectedSize,
    default: model.id === DEFAULT_MODEL,
    experience:
      model.id === "qwen3.5-0.8b"
        ? {
            tier: "smoke-chat",
            tools: "unsupported",
            guidance:
              "Use for transport smoke and basic chat, not agent tools.",
          }
        : model.id === "qwen3.5-2b" || model.id === "qwen3.5-4b"
          ? {
              tier: "chat",
              tools: "experimental",
              guidance: "Use outcome verification for every tool task.",
            }
          : model.id === "qwen3.5-9b"
            ? {
                tier: "agent-candidate",
                tools: "outcome-verified",
                guidance:
                  "Recommended agent candidate; validate concrete side effects with smoke --tool-task.",
              }
            : {
                tier: "untested",
                tools: "untested",
                guidance: "No local agent-quality claim has been established.",
              },
  }));
}

export function estimatedPreloadBytes(
  config: Pick<HermesQvacConfig, "model" | "auxModel">,
): number | null {
  const constants = new Set([
    resolveModelConstant(config.model),
    resolveModelConstant(config.auxModel),
  ]);
  let total = 0;
  for (const constant of constants) {
    const size = allModels.find(
      (entry) => entry.name === constant,
    )?.expectedSize;
    if (typeof size !== "number") return null;
    total += size;
  }
  return total;
}

export async function modelStoragePreflight(
  config: Pick<HermesQvacConfig, "model" | "auxModel">,
  env: NodeJS.ProcessEnv = process.env,
  freeBytesOverride?: number,
): Promise<{
  requiredDownloadBytes: number;
  freeBytes: number;
  safetyBytes: number;
}> {
  const constants = new Set([
    resolveModelConstant(config.model),
    resolveModelConstant(config.auxModel),
  ]);
  const modelDirectory = join(env.HOME?.trim() || homedir(), ".qvac", "models");
  let cachedFiles: string[] = [];
  try {
    cachedFiles = await readdir(modelDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let requiredDownloadBytes = 0;
  for (const constant of constants) {
    const metadata = allModels.find((entry) => entry.name === constant);
    if (!metadata || typeof metadata.expectedSize !== "number") continue;
    const candidate = cachedFiles.find((file) =>
      file.endsWith(`_${metadata.modelId}`),
    );
    let cachedBytes = 0;
    if (candidate) {
      try {
        cachedBytes = Math.min(
          metadata.expectedSize,
          (await stat(join(modelDirectory, candidate))).size,
        );
      } catch {
        cachedBytes = 0;
      }
    }
    requiredDownloadBytes += metadata.expectedSize - cachedBytes;
  }
  const filesystem = await statfs(env.HOME?.trim() || homedir());
  const freeBytes =
    freeBytesOverride ?? Number(filesystem.bavail) * Number(filesystem.bsize);
  const safetyBytes = 2 * 1024 ** 3;
  if (freeBytes < requiredDownloadBytes + safetyBytes)
    throw new Error(
      `Insufficient disk for QVAC preload: ${(freeBytes / 1024 ** 3).toFixed(2)} GiB free, ${(requiredDownloadBytes / 1024 ** 3).toFixed(2)} GiB still required for selected artifacts, plus a 2.00 GiB safety margin`,
    );
  return { requiredDownloadBytes, freeBytes, safetyBytes };
}

export function createManagedModels(
  config: Pick<
    HermesQvacConfig,
    "model" | "auxModel" | "ctxSize" | "reasoningBudget" | "tools"
  >,
) {
  const main = qvacCatalog.find(
    (entry) => entry.id === config.model || entry.constant === config.model,
  );
  const auxiliary = qvacCatalog.find(
    (entry) =>
      entry.id === config.auxModel || entry.constant === config.auxModel,
  );
  if (!main)
    throw new Error(
      `Unknown model '${config.model}'. Run 'hermes-qvac models' for supported aliases.`,
    );
  if (!auxiliary)
    throw new Error(
      `Unknown model '${config.auxModel}'. Run 'hermes-qvac models' for supported aliases.`,
    );
  return qvacCatalog.map((entry) => ({
    name: entry.id,
    config: {
      ctx_size: config.ctxSize,
      reasoning_budget: config.reasoningBudget,
      tools: config.tools,
    },
    preload: entry.id === main.id || entry.id === auxiliary.id,
    default: entry.id === main.id,
  }));
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }).catch((error) => {
    throw new Error(
      `Refusing to start QVAC on ${host}:${port}: the port is already in use`,
      { cause: error },
    );
  });
}

let managedStartQueue: Promise<void> = Promise.resolve();

export async function startManaged(
  config: HermesQvacConfig,
): Promise<ManagedQvacProvider> {
  const previous = managedStartQueue;
  let release!: () => void;
  managedStartQueue = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    return await startManagedSerialized(config);
  } finally {
    release();
  }
}

async function startManagedSerialized(
  config: HermesQvacConfig,
): Promise<ManagedQvacProvider> {
  assertBareRuntimePlatform();
  await modelStoragePreflight(config);
  // A reusable pinned-port fleet may already own this port. Let the official
  // manager decide whether to attach. Private starts cannot attach, so retain
  // the clearer collision preflight for that path.
  if (config.port !== undefined && !config.reuse)
    await assertPortAvailable(config.host, config.port);
  const previousCwd = process.cwd();
  if (config.cwd) process.chdir(config.cwd);
  try {
    let provider: ManagedQvacProvider;
    try {
      provider = await createQvac({
        mode: "managed",
        models: createManagedModels(config),
        serveHost: config.host,
        ...(config.port === undefined ? {} : { servePort: config.port }),
        serveStartTimeout: config.readyTimeoutMs,
        ...(config.qvacBin === undefined
          ? {}
          : { serveBinPath: config.qvacBin }),
        reuse: config.reuse,
        serveIdleTimeout: config.idleStopMs,
        apiKey: config.apiKey,
      });
    } catch (error) {
      throw new Error(
        `QVAC did not become ready within ${(config.readyTimeoutMs / 60_000).toFixed(1)} minute(s) while downloading or loading '${config.model}' and '${config.auxModel}'. Partial downloads are resumable; retry with more time using --ready-timeout-ms. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      await waitForEndpointModels(
        provider.baseURL,
        [...new Set([config.model, config.auxModel])],
        config.readyTimeoutMs,
        config.apiKey,
      );
      return provider;
    } catch (error) {
      await provider.close();
      throw error;
    }
  } finally {
    if (config.cwd) process.chdir(previousCwd);
  }
}

function hermesEnvironment(
  baseURL: string,
  config: Pick<HermesQvacConfig, "apiKey" | "timeoutSeconds">,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    QVAC_BASE_URL: baseURL,
    QVAC_API_KEY: config.apiKey,
    HERMES_API_TIMEOUT: String(config.timeoutSeconds),
  };
}

function childExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  return signal ? 128 + (osConstants.signals[signal] ?? 0) : 1;
}

const hermesDescendants = new WeakMap<object, number[]>();

function processDescendants(rootPid: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, parentText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const visit = (parent: number) => {
    for (const pid of children.get(parent) ?? []) {
      visit(pid);
      descendants.push(pid);
    }
  };
  visit(rootPid);
  return descendants;
}

function signalHermesProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
      if (code === "EPERM") {
        const descendants = processDescendants(child.pid);
        hermesDescendants.set(child, descendants);
      }
    }
  }
  for (const pid of hermesDescendants.get(child) ?? []) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return child.kill(signal);
}

export function runHermes(
  baseURL: string,
  model: string,
  extraArgs: string[] = [],
  config: Pick<HermesQvacConfig, "apiKey" | "timeoutSeconds"> &
    Partial<Pick<HermesQvacConfig, "cwd">> = {
    apiKey: "custom-local",
    timeoutSeconds: 300,
  },
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "hermes",
      ["--provider", "qvac", "-m", model, ...extraArgs],
      {
        stdio: "inherit",
        env: hermesEnvironment(baseURL, config, env),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        detached: process.platform !== "win32",
      },
    );
    let killTimer: NodeJS.Timeout | undefined;
    const forward = (signal: NodeJS.Signals) => {
      signalHermesProcess(child, signal);
      if (!killTimer) {
        killTimer = setTimeout(
          () => signalHermesProcess(child, "SIGKILL"),
          5_000,
        );
        killTimer.unref();
      }
    };
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolvePromise(childExitCode(code, signal));
    });
  });
}

export function runHermesCaptured(
  baseURL: string,
  model: string,
  extraArgs: string[],
  config: Pick<HermesQvacConfig, "apiKey" | "timeoutSeconds"> &
    Partial<Pick<HermesQvacConfig, "cwd">> = {
    apiKey: "custom-local",
    timeoutSeconds: 300,
  },
  env: NodeJS.ProcessEnv = {},
  processTimeoutMs = (config.timeoutSeconds + 15) * 1_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  terminationReason?: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "hermes",
      ["--provider", "qvac", "-m", model, ...extraArgs],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: hermesEnvironment(baseURL, config, env),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        detached: process.platform !== "win32",
      },
    );
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let forcedReason: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const maxOutputBytes = 2 * 1024 * 1024;
    const forward = (signal: NodeJS.Signals) =>
      signalHermesProcess(child, signal);
    const terminate = (reason: string) => {
      if (forcedReason) return;
      forcedReason = reason;
      child.stdout.pause();
      child.stderr.pause();
      signalHermesProcess(child, "SIGTERM");
      killTimer = setTimeout(() => signalHermesProcess(child, "SIGKILL"), 500);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      terminate(`Hermes process timed out after ${processTimeoutMs}ms`);
    }, processTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (outputBytes + chunk.byteLength > maxOutputBytes) {
        terminate(`Hermes output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      outputBytes += chunk.byteLength;
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (forcedReason) signalHermesProcess(child, "SIGKILL");
      cleanup();
      resolvePromise({
        code: forcedReason ? 124 : childExitCode(code, signal),
        stdout,
        stderr: forcedReason
          ? `${stderr}${stderr ? "\n" : ""}${forcedReason}`
          : stderr,
        ...(forcedReason ? { terminationReason: forcedReason } : {}),
      });
    });
  });
}

export interface MockQvacOptions {
  models?: string[];
  responseText?: string;
  chatStatus?: number;
  delayMs?: number;
  malformedSse?: boolean;
  nonStreaming?: boolean;
  closeEarly?: boolean;
}

export async function withMockQvac(
  options: MockQvacOptions = {},
): Promise<{ baseURL: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          object: "list",
          data: (options.models ?? [DEFAULT_MODEL]).map((id) => ({
            id,
            object: "model",
          })),
        }),
      );
      return;
    }
    if (request.url === "/v1/chat/completions") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) {
          response.statusCode = 413;
          response.end();
          request.destroy();
        }
      });
      request.on("end", () => {
        if (options.closeEarly) {
          request.socket.destroy();
          return;
        }
        let requestBody: { stream?: boolean; model?: string };
        try {
          requestBody = JSON.parse(body || "{}") as {
            stream?: boolean;
            model?: string;
          };
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
        if (
          requestBody.model &&
          !(options.models ?? [DEFAULT_MODEL]).includes(requestBody.model)
        ) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "model not found" }));
          return;
        }
        const send = () => {
          if (options.chatStatus && options.chatStatus !== 200) {
            response.statusCode = options.chatStatus;
            response.end(JSON.stringify({ error: "fixture failure" }));
            return;
          }
          const text = options.responseText ?? "pong";
          const useStream = requestBody.stream && !options.nonStreaming;
          response.setHeader(
            "content-type",
            useStream ? "text/event-stream" : "application/json",
          );
          if (useStream)
            response.end(
              options.malformedSse
                ? "data: definitely-not-json\n\n"
                : `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: text }, finish_reason: null, index: 0 }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\ndata: [DONE]\n\n`,
            );
          else
            response.end(
              JSON.stringify({
                choices: [
                  {
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                    index: 0,
                  },
                ],
              }),
            );
        };
        if (options.delayMs) setTimeout(send, options.delayMs);
        else send();
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mock server did not bind TCP");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}

export { resolveModelConstant };
