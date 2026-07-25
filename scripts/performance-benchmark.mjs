#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const BODY_LIMIT = 2 * 1024 * 1024;

function parseArgs(argv) {
  const options = { iterations: 1, timeoutMs: 360_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") return { help: true };
    const value = argv[++index];
    if (!value) throw new TypeError(`${arg} requires a value`);
    if (arg === "--base-url") options.baseURL = value.replace(/\/$/, "");
    else if (arg === "--model") options.model = value;
    else if (arg === "--api-key") options.apiKey = value;
    else if (arg === "--hermes-home") options.hermesHome = value;
    else if (arg === "--iterations") options.iterations = Number(value);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value);
    else throw new TypeError(`unknown option: ${arg}`);
  }
  if (!options.baseURL || !options.model || !options.hermesHome)
    throw new TypeError(
      "usage: performance-benchmark --base-url URL --model ID --hermes-home PATH [--api-key KEY] [--iterations 5] [--timeout-ms 360000]",
    );
  for (const key of ["iterations", "timeoutMs"])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1)
      throw new TypeError(`${key} must be a positive integer`);
  return options;
}

async function boundedRequestBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) throw new Error(`request exceeds ${BODY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function summarizeBody(buffer) {
  let body;
  try {
    body = JSON.parse(buffer.toString("utf8"));
  } catch {
    return { bodyBytes: buffer.length, validJson: false };
  }
  return {
    bodyBytes: buffer.length,
    validJson: true,
    stream: body.stream === true,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    messageCharacters: Array.isArray(body.messages)
      ? body.messages.reduce(
          (total, message) =>
            total +
            (typeof message?.content === "string"
              ? message.content.length
              : JSON.stringify(message?.content ?? "").length),
          0,
        )
      : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolSchemaBytes: Array.isArray(body.tools)
      ? Buffer.byteLength(JSON.stringify(body.tools))
      : 0,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null,
    temperature: body.temperature ?? null,
  };
}

async function startRecordingProxy(options, records, laneRef) {
  const target = new URL(options.baseURL);
  const server = createServer(async (request, response) => {
    const started = performance.now();
    try {
      const requestBody = await boundedRequestBody(request);
      const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
      const targetPath = incoming.pathname.replace(/^\/v1(?=\/|$)/, "");
      const targetURL = `${options.baseURL}${targetPath}${incoming.search}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          !["host", "content-length", "connection"].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      if (options.apiKey && !headers.has("authorization"))
        headers.set("authorization", `Bearer ${options.apiKey}`);
      const upstream = await fetch(targetURL, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method ?? "GET")
          ? undefined
          : requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const headersMs = Math.round(performance.now() - started);
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!["content-encoding", "content-length", "connection"].includes(name))
          response.setHeader(name, value);
      }
      let firstByteMs = null;
      let responseBytes = 0;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          if (firstByteMs === null)
            firstByteMs = Math.round(performance.now() - started);
          responseBytes += chunk.length;
          response.write(chunk);
        }
      }
      response.end();
      if (incoming.pathname.endsWith("/chat/completions"))
        records.push({
          lane: laneRef.value,
          ...summarizeBody(requestBody),
          status: upstream.status,
          headersMs,
          firstByteMs,
          durationMs: Math.round(performance.now() - started),
          responseBytes,
        });
    } catch (error) {
      response.statusCode = 502;
      response.end("benchmark proxy error");
      records.push({
        lane: laneRef.value,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - started),
      });
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    ),
  };
}

async function request(proxyURL, body, options) {
  const response = await fetch(`${proxyURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey
        ? { authorization: `Bearer ${options.apiKey}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

async function runHermes(proxyURL, options, extraArgs = []) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "hermes",
      [
        "--provider",
        "qvac",
        "--model",
        options.model,
        "-z",
        "Reply exactly: OK",
        "--ignore-rules",
        "--cli",
        ...extraArgs,
      ],
      {
        env: {
          ...process.env,
          HERMES_HOME: options.hermesHome,
          QVAC_BASE_URL: proxyURL,
          QVAC_API_KEY: options.apiKey ?? "custom-local",
          HERMES_API_TIMEOUT: String(Math.ceil(options.timeoutMs / 1_000)),
          HERMES_MAX_TOKENS: "32",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    }, options.timeoutMs + 5_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function performanceBenchmark(options) {
  await stat(join(options.hermesHome, "plugins", "model-providers", "qvac", "plugin.yaml"));
  const records = [];
  const laneRef = { value: "idle" };
  const proxy = await startRecordingProxy(options, records, laneRef);
  const runs = [];
  try {
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      laneRef.value = "direct-minimal";
      await request(
        proxy.baseURL,
        {
          model: options.model,
          messages: [{ role: "user", content: "Reply exactly: OK" }],
          temperature: 0,
          max_tokens: 32,
          stream: false,
        },
        options,
      );

      laneRef.value = "hermes-normal";
      const normal = await runHermes(proxy.baseURL, options);
      runs.push({ iteration, lane: laneRef.value, ...normal });

      laneRef.value = "hermes-terminal-only";
      const restricted = await runHermes(proxy.baseURL, options, [
        "--toolsets",
        "terminal",
      ]);
      runs.push({ iteration, lane: laneRef.value, ...restricted });
    }
    const failedRuns = runs.filter(
      (run) => run.code !== 0 || run.stdout.trim() !== "OK",
    );
    return {
      schema: 1,
      generatedAt: new Date().toISOString(),
      target: {
        baseURL: options.baseURL,
        model: options.model,
        iterations: options.iterations,
      },
      note: "Bodies, credentials, and full prompts are deliberately omitted; character and schema byte counts are retained.",
      records,
      runs: runs.map((run) => ({
        iteration: run.iteration,
        lane: run.lane,
        exitCode: run.code,
        exactOK: run.stdout.trim() === "OK",
        stderr: run.stderr.slice(0, 500),
      })),
      ok: failedRuns.length === 0 && records.every((record) => !record.error),
    };
  } finally {
    await proxy.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: performance-benchmark --base-url URL --model ID --hermes-home PATH [--api-key KEY] [--iterations 5] [--timeout-ms 360000]\n",
      );
    } else {
      const result = await performanceBenchmark(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 2;
  }
}
