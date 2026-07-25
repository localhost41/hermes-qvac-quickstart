import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("performance benchmark", () => {
  it("compares minimal, normal Hermes, and restricted Hermes payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-qvac-perf-test-"));
    const hermesHome = join(root, "hermes-home");
    const bin = join(root, "bin");
    await mkdir(join(hermesHome, "plugins", "model-providers", "qvac"), {
      recursive: true,
    });
    await mkdir(bin);
    await writeFile(
      join(hermesHome, "plugins", "model-providers", "qvac", "plugin.yaml"),
      "id: qvac\n",
    );
    const hermes = join(bin, "hermes");
    await writeFile(
      hermes,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const restricted = args.includes("terminal");
const tools = Array.from({ length: restricted ? 2 : 5 }, (_, index) => ({ type: "function", function: { name: "tool_" + index, parameters: { type: "object" } } }));
const response = await fetch(process.env.QVAC_BASE_URL + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "test-model", messages: [{ role: "system", content: "system" }, { role: "user", content: "Reply exactly: OK" }], tools, max_tokens: 32, stream: false }) });
if (!response.ok) process.exit(3);
console.log("OK");
`,
    );
    await chmod(hermes, 0o755);

    const server = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture failed");
    try {
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolve("scripts/performance-benchmark.mjs"),
            "--base-url",
            `http://127.0.0.1:${address.port}/v1`,
            "--model",
            "test-model",
            "--hermes-home",
            hermesHome,
          ],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
      });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        records: Array<{ lane: string; toolCount: number }>;
      };
      expect(report.ok).toBe(true);
      expect(
        report.records.map(({ lane, toolCount }) => ({ lane, toolCount })),
      ).toEqual([
        { lane: "direct-minimal", toolCount: 0 },
        { lane: "hermes-normal", toolCount: 5 },
        { lane: "hermes-terminal-only", toolCount: 2 },
      ]);
    } finally {
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });
});
