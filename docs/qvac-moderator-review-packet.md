# Draft QVAC maintainer review packet

Status: prepared for user approval; not sent.

## Purpose

`@localhost41/hermes-qvac-provider` is an independent standalone Hermes
model-provider plugin and companion lifecycle CLI. It reuses official QVAC
packages rather than implementing a server, model registry, downloader, or
supervisor. It does not claim QVAC endorsement.

## QVAC surfaces reused

- `@qvac/ai-sdk-provider` 0.3.0: managed process ownership, reuse, and cleanup.
- `@qvac/cli` 0.8.1: OpenAI-compatible server.
- The SDK `allModels` metadata and exported constants: eight friendly aliases,
  artifact-size estimates, and generated serve configuration.
- OpenAI-compatible `/v1/models` and `/v1/chat/completions`: discovery and
  inference boundary.

The generated configuration sets `ctx_size: 32768`, `reasoning_budget: 0`,
and `tools: true` for each official alias. The selected main and auxiliary
models alone are preloaded. Current defaults are Qwen3.5 9B main and Qwen3.5 2B
auxiliary. Managed mode rejects aliases outside the official catalog; external
mode accepts only aliases advertised by the configured endpoint.

## Recorded conformance

- QVAC 0.8.1 with cached Qwen3.5 0.8B: 8/8 bounded protocol cases.
- QVAC 0.8.1 with cached Qwen3.5 9B: 8/8 bounded protocol cases after a clean
  restart.
- Independently installed QVAC 0.8.0 with cached 1B validation model: 8/8.
- Two live soak runs: 240 total requests, zero failures, no observed RSS growth.
- Ten real managed start/ready/stop cycles: all passed with listener and worker
  cleanup.

Full details are in `docs/qvac-conformance-report.md`,
`docs/model-experience-2026-07-22.md`, and
`docs/resilience-soak-report.md`.

## Known upstream behavior kept visible

- QVAC #3384: context-boundary streaming can remain open. The bounded 2K
  reproduction remains a known upstream failure, not a plugin pass.
- QVAC #3225: structured output terminal-state behavior remains tracked and
  was not reclassified without a current bounded rerun.
- Cancelling a long Hermes-driven 9B request did not immediately free the QVAC
  worker; a managed restart restored service.

The plugin does not synthesize finish reasons, rewrite server errors, impose a
server-side retry policy, or otherwise hide these behaviors.

## Requested technical corrections

1. Are the generated QVAC configuration and eight model mappings correct for
   current official packages?
2. Are Qwen3.5 9B main and Qwen3.5 2B auxiliary defensible community defaults?
3. Are `ctx_size: 32768`, `reasoning_budget: 0`, and `tools: true` appropriate
   defaults for Hermes agent use?

This asks for correction of technical assumptions, not endorsement.
