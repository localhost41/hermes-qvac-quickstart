# Hermes + QVAC Quickstart

A community-maintained one-command quickstart for running Hermes Agent with
private, on-device QVAC models.

> Independent project maintained by localhost41. Not affiliated with or endorsed by Tether, QVAC, or Hermes Agent.

The npm package remains `@localhost41/hermes-qvac-provider` and the command
remains `hermes-qvac`, preserving compatibility for existing beta users. The
Python plugin makes `qvac` a real Hermes model provider. The companion CLI adds
the lifecycle surface Hermes model-provider plugins do not currently have. It
deliberately reuses the official QVAC catalog, config synthesizer, and managed
supervisor rather than maintaining a parallel runtime.

## Requirements

- Node 22–26
- Hermes Agent available as `hermes` (fully verified with 0.18.2 and 0.19.0)
- Python 3.11–3.13 (normally supplied by Hermes)
- Enough RAM and disk for the selected local model

The npm package includes the official `@qvac/cli`. A separate global `qvac` installation is not required unless you select one with `--bin`.

## What this adds to QVAC's OpenAI-compatible setup

QVAC's [HTTP-server connection guide](https://docs.qvac.tether.io/cli/http-server/connection/)
documents the authoritative manual OpenAI-compatible setup. This community
package automates that supported integration for a first-time Hermes user. It
adds download consent and disk checks, copied plugin installation, official
catalog-to-config generation, loopback process supervision, readiness checks,
Hermes environment wiring, cleanup, diagnostics, upgrades, and owned uninstall.
It does not replace QVAC or Hermes behavior, patch either upstream, or imply
endorsement by either project.

## Install

For a new local setup, install Hermes using its current official instructions,
install this package, then use one integration command:

```bash
npm install -g @localhost41/hermes-qvac-provider@beta
hermes-qvac start
```

Choose the full local agent or an explicitly reduced-capability fast profile:

```bash
# QVAC 9B, 32K context, normal Hermes tool catalog
hermes-qvac start

# QVAC 4B, 16K context, Hermes terminal toolset only
hermes-qvac start --fast
```

`start` checks available disk, shows the selected models and estimated download,
asks before downloading anything, safely installs or upgrades the provider,
starts QVAC on loopback, waits for it to become ready, and opens Hermes. On
later runs it remembers explicit configuration choices, reuses cached models,
and repeats the safe installation check.
Non-interactive automation must pass `--yes` to approve a required download.

The default 9B model follows QVAC's current local-agent guidance, but local
inference is hardware-dependent. A controlled 2026-07-25 review found that the
dominant cost was evaluating Hermes' normal prompt and tool schemas, not the
quickstart lifecycle: the same warmed 9B QVAC process averaged 0.38 seconds for
a minimal direct request, 97.84 seconds for normal Hermes (28 tools), and 22.69
seconds for Hermes restricted to the terminal toolset (2 tools). `--fast`
therefore makes both tradeoffs explicit instead of silently weakening the
agent. On the same 16 GiB Apple silicon Mac, its cached end-to-end rerun took
18–20 seconds; its warmed request-only benchmark averaged 12.79 seconds. The
0.8B model remains a connectivity check, not an agent model.

`setup` atomically copies the minimal Python assets into `$HERMES_HOME/plugins/model-providers/qvac` and enables the plugin through Hermes. It supports upgrades from owned and recognized earlier alpha installations, refuses unrelated directories, and never downloads a model.

From this checkout:

```bash
pnpm install
pnpm build
node dist/cli.js setup
```

## Advanced/manual lifecycle

```bash
hermes-qvac run --model qwen3.5-9b -- --cli
```

The CLI asks the official QVAC managed provider to:

1. map every friendly catalog ID to its SDK model constant;
2. generate a private `qvac.config.json`;
3. preload the main `qwen3.5-9b` and auxiliary `qwen3.5-2b` models;
4. expose the remaining catalog entries for lazy loading;
5. choose a free loopback port, start QVAC, and wait for model readiness;
6. launch Hermes with the resolved endpoint; and
7. detach safely when Hermes exits or receives a signal.

Compatible sessions can share the official managed QVAC fleet. The CLI never kills a process merely because it occupies a port.

## Commands

```text
hermes-qvac start [configuration options] [--yes] -- [Hermes arguments]
hermes-qvac setup [configuration options]
hermes-qvac config show [--json]
hermes-qvac config set [configuration options]
hermes-qvac config reset
hermes-qvac config path
hermes-qvac config validate [configuration options] [--json]
hermes-qvac doctor [configuration options] [--json]
hermes-qvac models [list] [--json]
hermes-qvac models info MODEL [--json]
hermes-qvac run [configuration options] -- [Hermes arguments]
hermes-qvac serve [configuration options]
hermes-qvac status [--json]
hermes-qvac stop [--json]
hermes-qvac smoke --transport-only
hermes-qvac smoke --model ID --yes
hermes-qvac uninstall
hermes-qvac version
```

- `start` is the beginner path: consent, setup, managed QVAC, and Hermes in one command.
- `run` holds QVAC while a child Hermes process runs.
- `serve` holds QVAC in the foreground for separately launched clients.
- `status` reports every managed CLI session in the active `HERMES_HOME` and checks the live endpoint.
- `stop` sends an authenticated shutdown request only to recorded `hermes-qvac` CLI owners. It never signals a recorded PID or kills QVAC directly; the official supervisor preserves a serve used by another application.
- `config validate` resolves and validates configuration without writing anything.
- `models info` reports the official SDK constant, modality, size metadata, and default status.
- `uninstall` verifies ownership before disabling or removing the plugin. Saved configuration remains until `config reset`.
- `start --fast` persists the 4B/16K profile and restricts current and later starts to Hermes' supported terminal toolset. Use `start --full` to restore 9B/32K and normal Hermes tools.

CLI-owned exit codes are `0` success, `2` invalid usage/configuration, `3` unavailable dependencies/endpoints/health, and `4` execution or internal failure. `run` propagates a launched Hermes process's exit code. `--json` returns one compact JSON object for finite commands. Managed `serve` and physical smoke emit newline-delimited event objects (`event: "ready"`, then `"stopping"` or `"result"`); managed `run` emits its ready event and then deliberately attaches Hermes' own standard streams. Non-placeholder API keys are redacted.

See [configuration.md](docs/configuration.md) for every CLI option and environment variable. Precedence is CLI, environment, saved configuration, defaults.

## Defaults

- Main model: `qwen3.5-9b`
- Auxiliary model: `qwen3.5-2b`
- Context: 32768 tokens
- Maximum output: 8192 tokens
- Reasoning budget: `0` (disabled for predictable first-run output)
- QVAC tool-call formatting: enabled
- Bind: `127.0.0.1`, automatic free port
- Startup/model-download timeout: 900 seconds
- Hermes request timeout: 300 seconds
- API marker: `custom-local`

The marker satisfies OpenAI-compatible clients but does not enable authentication on a managed QVAC 0.8.1 server. Managed QVAC remains loopback-only. When bearer enforcement is required, start QVAC separately with its supported `serve openai --api-key` option and use the external mode below. The current official managed-provider API does not expose that server option.

`hermes-qvac status` treats a healthy stopped managed installation as success and reports `state: "stopped"`. Monitoring that requires a live endpoint should use `hermes-qvac status --require-running`.

Model guidance from `hermes-qvac models` separates transport smoke from agent-tool capability. Verify a concrete file-tool outcome in an empty disposable directory with:

```bash
hermes-qvac smoke --tool-task --cwd /tmp/hermes-qvac-tool-check --no-reuse --yes --json
```

This gate checks the file and exact content; a model saying it succeeded is not sufficient.

Run `hermes-qvac models` for the authoritative model list and SDK mappings. The list comes directly from `@qvac/ai-sdk-provider/models`.

## Existing QVAC endpoint

To use a server you already manage:

```bash
export QVAC_API_KEY='replace-with-a-private-value'
# In a separate terminal, using your verified QVAC model/configuration:
qvac serve openai --model qvac-local --port 19000 --api-key "$QVAC_API_KEY"

QVAC_BASE_URL=http://127.0.0.1:19000/v1 QVAC_API_KEY="$QVAC_API_KEY" \
  hermes-qvac run --external --model qwen3.5-9b -- --cli
```

Replace `qvac-local` and the Hermes model alias with names configured and advertised by your server. The CLI authenticates the `/models` probe, passes the key only through the Hermes child environment, redacts it from captured diagnostics, and refuses to launch Hermes unless the endpoint advertises the selected model.

## Smoke tests

The safe transport test creates an isolated `HERMES_HOME`, installs and enables the packaged profile there, starts an OpenAI-compatible streaming fixture, and invokes the real local Hermes executable:

```bash
hermes-qvac smoke --transport-only
```

Success requires the exact visible response `pong`. This proves real plugin discovery, real `ProviderProfile` loading, base-URL injection, chat-completions streaming, and Hermes response handling without starting QVAC or downloading a model.

Physical inference is opt-in because a cold QVAC model can require a multi-gigabyte download. The CLI derives the estimate from official SDK metadata and includes both preloaded models in its consent error. At the current catalog sizes, the smallest example below is approximately 1.69 GiB of model payload (`0.8b` main plus `2b` auxiliary); the defaults total approximately 6.48 GiB. A cold run can transfer up to that payload and needs at least comparable free disk and RAM plus cache, context, and runtime overhead. Startup may take minutes depending on hardware and network speed:

```bash
hermes-qvac smoke --model qwen3.5-0.8b --yes
```

The physical test starts managed QVAC, waits for model readiness, invokes real Hermes, and requires exact `pong`. No model download occurs during setup, doctor, models, config, package verification, or transport-only smoke.

## Performance attribution

With a QVAC endpoint already running and an isolated installed provider, record
a sanitized direct-versus-Hermes comparison:

```bash
pnpm benchmark:performance -- \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen3.5-9b \
  --hermes-home /path/to/isolated-hermes-home \
  --iterations 5
```

The report retains timings, payload byte counts, message character counts, tool
counts, and tool-schema size. It deliberately omits credentials, bodies, and
full prompts. See [the measured performance report](docs/performance.md).

## Supported host surface

The release candidate supports fresh one-shot and interactive Hermes sessions.
Session resume is not part of the supported surface: current Hermes dispatches a
one-shot `--resume` request before its interactive restoration path, and a fully
automated second interactive turn has not been demonstrated. Invoke a fresh
session or follow Hermes' own resume guidance without treating this plugin as a
resume compatibility layer.

`hermes-qvac smoke` is a bounded acceptance command and forcibly terminates a
Hermes process group that exceeds its deadline or output cap. `hermes-qvac run`
is an interactive pass-through; its lifetime belongs to Hermes and it is not a
bounded adverse-stream test. Use `smoke` or the conformance harness for release
health checks.

## Doctor and troubleshooting

`hermes-qvac doctor` verifies:

- the Hermes command and version;
- plugin files and enabled state;
- loading as Hermes' real `ProviderProfile`, including the effective endpoint and vision flag;
- the bundled or configured QVAC executable;
- saved configuration and official catalog membership for main and auxiliary models; and
- endpoint reachability and selected-model advertisement.

An offline endpoint is an expected warning in managed mode because QVAC starts on demand. It is an error when `QVAC_BASE_URL` selects external mode.

Common fixes:

- Plugin missing or disabled: run `hermes-qvac setup` under the same `HERMES_HOME` as Hermes.
- Pinned port occupied: omit `--port` for automatic allocation or stop the process you own.
- Custom working directory: combine `--cwd PATH --no-reuse`; upstream fleet identity does not include cwd.
- Model absent from an external endpoint: configure the endpoint with the same friendly alias returned by `hermes-qvac models`.
- Cold startup timeout: increase `--ready-timeout-ms`; downloads can take minutes.
- Weak agent behavior: use the default 9B model or a larger catalog model and keep tools/context enabled.

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm test:python
pnpm smoke:transport
pnpm verify:hermes
pnpm verify:package
```

The test suite covers full generated QVAC configuration, main/aux preload, lifecycle readiness and cleanup, port conflicts, multiple owned-session records, status/stop, Hermes arguments and environment, signal forwarding, safe plugin ownership, real-Hermes isolated transport, and an installed npm tarball.

Engineering evidence:

- [architecture](docs/architecture-notes.md)
- [moderator architecture map](docs/moderator-architecture.md)
- [OpenClaw parity matrix](docs/openclaw-parity.md)
- [requirements traceability](docs/requirements-traceability.md)
- [threat and failure model](docs/threat-model.md)
- [test inventory](docs/test-inventory.md)
- [compatibility](docs/compatibility.md)
- [Hermes host conformance](docs/hermes-host-conformance.md)
- [QVAC conformance report](docs/qvac-conformance-report.md)
- [model experience](docs/model-experience-2026-07-22.md)
- [performance attribution](docs/performance.md)
- [resilience and soak](docs/resilience-soak-report.md)
- [moderator architecture](docs/moderator-architecture.md)
- [security and privacy](docs/security.md)
- [artifact and supply-chain evidence](docs/artifact-and-supply-chain.md)
- [maintenance contract](docs/maintenance.md)
- [contributing](CONTRIBUTING.md)

Legacy `scripts/install.sh`, `scripts/doctor.sh`, and `scripts/start-qvac.sh` remain as thin compatibility wrappers around the authoritative CLI; they no longer implement a separate manual lifecycle.
