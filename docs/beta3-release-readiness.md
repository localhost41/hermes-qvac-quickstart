# Beta.3 release readiness

Candidate package: `@localhost41/hermes-qvac-provider@0.1.0-beta.3`.

Recommendation: **GO AS BETA WITH EXPLICIT LIMITATIONS**, subject to CI and the protected beta publish workflow. Do not move the npm `latest` tag.

## Beginner outcome

The public path is now `hermes-qvac start`. It performs capacity and cache checks, obtains consent before a required download, transactionally remembers explicit choices, safely installs or upgrades the copied Hermes provider, starts the official managed QVAC provider, waits for both selected models, launches Hermes, and releases its managed session when Hermes exits.

The project is presented publicly as **Hermes + QVAC Quickstart** while retaining the existing npm package, `hermes-qvac` command, and `qvac` provider identifiers. `start --fast` persistently selects QVAC 4B, a 16K context, and Hermes' terminal toolset; `start --full` restores the default 9B/32K full agent.

On 2026-07-25, three independent isolated-`HERMES_HOME` runs on macOS arm64, Node 26.3.0, Hermes 0.19.0, Python 3.11.15, QVAC CLI 0.8.1, and 16 GiB memory produced exact `OK` responses:

- Source checkout, fresh Hermes home, cached `qwen3.5-0.8b` plus `qwen3.5-2b`: 19 seconds, including setup, readiness, inference, and cleanup. The explicit main-model choice was persisted.
- Packed npm artifact, fresh Hermes home, default cached `qwen3.5-9b` plus `qwen3.5-2b`, one-shot Hermes: 176 seconds.
- The same packed installation and Hermes home, reinstall/upgrade followed by the default interactive Hermes CLI: 195 seconds end to end; the response arrived after 147 seconds and `/exit` cleaned up normally.

Each run reached QVAC readiness, invoked real Hermes, and left no managed QVAC process after completion. The source and first packed runs installed an owned provider into an empty isolated Hermes home; the third deliberately proved safe idempotent upgrade behavior. Models were already present in the shared QVAC cache, so these are not cold-download measurements. The test isolated `HERMES_HOME` but retained the real user `HOME` to reuse that cache; the interactive Hermes lane therefore exposed an unrelated existing OpenClaw migration notice.

A subsequent fast-profile run exercised the download boundary with 2.55 GiB of missing 4B model data and completed preflight, download, setup, model load, exact `OK` inference, and cleanup in 124 seconds. Its cached rerun completed in 18 seconds.

## Corrected findings

- QVAC's Bare runtime could be present in pnpm's store but unusable because the platform package or its `require-asset` dependency was not resolvable. Desktop platform packages are now direct optional dependencies, the loader is explicit, and managed startup fails immediately with a useful reinstall message if resolution is incomplete.
- The first-run reasoning default is now `0`. This matches the predictable no-hidden-reasoning setup used for the successful exact-response path; users may explicitly select `-1`.
- Explicit `start` choices are persisted before setup and rolled back if setup fails, so an unsuccessful beginner install cannot silently replace the previous saved configuration.
- Beginner startup now runs the official QVAC `doctor --json` system preflight before changing plugin files or downloading models.
- A three-iteration warmed 9B benchmark isolated the performance cost: minimal direct requests averaged 0.38 seconds, normal Hermes with 28 tools averaged 97.84 seconds, and terminal-only Hermes with two tools averaged 22.69 seconds. All requests returned exact `OK`; bodies, prompts, and credentials were not retained.
- The corresponding 4B/16K matrix averaged 0.21 seconds direct, 59.36 seconds with normal Hermes, and 12.79 seconds with terminal-only Hermes. Explicit and inherited fast-profile end-to-end reruns completed in 19 and 20 seconds.
- Compatible official managed fleets may now be reused on a pinned port. Private `--no-reuse` starts retain the collision preflight.
- The production dependency audit identified `@fastify/static` 10.1.1 as vulnerable; the override is now 10.1.2 and `pnpm audit --prod` reports no known vulnerabilities.

## Verification

- TypeScript build and Vitest: 94 passed.
- Python unittest: 24 passed.
- Type checking, formatting, and metadata verification: passed.
- Packed npm consumer: install, public imports, beginner `start`, copied ownership, lifecycle, doctor, transport smoke, status/stop, and uninstall passed.
- Live macOS arm64 inference: smallest cached model and advertised default passed with exact output.

## Explicit limitations

- Hermes must already be installed; the package does not own Hermes installation.
- A first model run may download several GiB and take minutes. The CLI asks first and requires `--yes` in automation.
- Model payload estimates are lower bounds and cannot guarantee sufficient runtime memory.
- The default 9B model was functionally correct but slow in this 16 GiB review; the README records the measurement and QVAC's lighter 4B option without promising equivalent agent quality.
- Native Windows is not claimed; Linux live validation remains a protected CI/release gate.
- Session resume remains outside the advertised supported surface for the upstream reasons documented in the host-conformance report.
- QVAC context-boundary and structured-output upstream defects remain visible and are not patched in this plugin.
- This is an independent community integration, not an official or endorsed QVAC or Hermes component.
