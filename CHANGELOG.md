# Changelog

## Unreleased

- Present the project as Hermes + QVAC Quickstart while retaining the existing npm package, CLI, and provider identifiers for compatibility.
- Add an explicit `--fast` profile using QVAC 4B, a 16K context, and Hermes' terminal toolset, backed by a sanitized performance-attribution harness.
- Run the official QVAC JSON system preflight before beginner setup or model download.
- Add `hermes-qvac start`, a consent-gated beginner path that safely installs the provider, starts official managed QVAC, waits for model readiness, launches Hermes, and cleans up in one command.
- Persist explicit beginner configuration choices transactionally so a simple rerun retains the selected model and settings.
- Default to `reasoning_budget: 0` for predictable first-run output while preserving the explicit reasoning override.
- Make Bare desktop runtime packages and their loader dependency explicit so QVAC works from pnpm checkouts as well as npm installations, and fail fast when the platform runtime is incomplete.
- Verify the packed beginner path, cached 0.8B and default 9B live inference, download-consent boundary, Hermes 0.19 diagnostics, and pinned managed-fleet reuse.
- Update the `@fastify/static` security override to 10.1.2 and confirm the production audit is clean.
- Override newly disclosed vulnerable QVAC transitive dependencies `@fastify/static` and `brace-expansion` with their patched releases.
- Wait for cold managed servers to advertise every selected model instead of failing when the HTTP listener becomes ready before model download/load.
- Override QVAC CLI's transitive `find-my-way` router to patched 9.7.0 after GHSA-c96f-x56v-gq3h began flagging 9.6.0.
- Add consent-gated physical Linux inference and mandatory packed Hermes 0.19 transport gates for beta qualification.
- Prepare alpha.5 with explicit lifecycle states: a healthy stopped installation succeeds, while `status --require-running` supports monitoring.
- Propagate `--cwd` to the Hermes child and add outcome-verified physical tool smoke that requires the exact filesystem side effect.
- Add evidence-based model experience tiers so transport-smoke models are not presented as verified agent-tool models.
- Raise cold-start readiness to 15 minutes, add cache-aware disk preflight with a 2 GiB safety margin, and make timeout failures distinguish download/load readiness with resumable retry guidance.
- Clarify that the default API marker is not managed-server authentication and record the missing official managed-provider server-auth option without forking the QVAC supervisor.

- Add the `hermes-qvac` lifecycle CLI with setup, layered config, managed and external runs, foreground serve controls, diagnostics, and exact-response smoke tests.
- Use the official QVAC catalog and managed provider to generate all eight friendly model aliases, preload Hermes' main and auxiliary models, and preserve upstream reuse and cleanup behavior.
- Add atomic ownership-aware install/upgrade/uninstall behavior and isolated Hermes enablement/profile verification.
- Add fake-QVAC lifecycle, port-collision, cleanup, status/stop, fake-Hermes environment/signal, real-Hermes transport, and installed-tarball tests.
- Add Linux Node 22–26 and macOS CI coverage plus scheduled current-QVAC compatibility checks.
- Document configuration, architecture, resource safety, host limitations, and evidence-based OpenClaw parity.
- Harden hostile-state and endpoint handling with bounded parsing, strict session schemas, corrupt-record isolation, recursive secret redaction, subprocess/output limits, and authenticated control health.
- Make setup transactional and serialized, including enablement rollback, interrupted-backup recovery, payload-hashed ownership markers, symlink refusal, and disable-before-delete uninstall safety.
- Harden release-candidate behavior with explicit-only saved configuration, dead-owner lock recovery, exact published-legacy hashes, unexpected-file preservation, symlinked control-directory refusal, process-group cleanup, auxiliary endpoint verification, strict `pong`, and captured-secret redaction.
- Isolate each Vitest run under a private temporary root and remove it during global teardown.
- Add command-specific help, version, config path/validation, model inspection, human diagnostics, exact Hermes exit propagation, and official SDK-constant normalization.
- Expand the release-candidate evidence with requirements traceability, a threat/failure model, test inventory, compatibility/security guidance, adverse real-Hermes transport verification, and packed-product command coverage.
- Accept server-advertised custom model aliases for external endpoints while keeping managed QVAC runs restricted to the official catalog.
- Add release metadata verification and record the macOS clean-room, live-inference, concurrency, tool-use, and known-limitation evidence.
- Add bounded QVAC protocol conformance and moderator clean-room acceptance harnesses.
- Record packed-plugin compatibility with Hermes 0.19.0 and current `main`, plus session-resume and adverse-stream ownership findings.
- Minimize the npm payload, add reproducible provenance/SBOM gates, pin workflow actions, and add dependency/CodeQL review.
- Add bounded live request, concurrency, restart, setup, upgrade, uninstall, and reinstall soak evidence.

## v0.1.0-alpha.3 - 2026-07-19

- Add npm discovery keywords and a benefit-oriented package description.
- Clarify that this is an independent community project.
- Align the demo fallback URL with QVAC CLI's `127.0.0.1:11434` default.
- Upgrade npm in the release workflow to support OIDC trusted publishing.

## v0.1.0-alpha.2 - 2026-07-10

- Update `scripts/doctor.sh` to use the current `hermes plugins list` discovery
  surface and avoid removed provider-list commands.
- Add Python unittest coverage for install and doctor script behavior using
  fake local commands instead of a live QVAC server.
- Add package tarball verification for expected runtime assets.
- Add an MIT license and include it in the package.
- Document that Hermes currently has no clean model-provider-local service
  lifecycle hook, so QVAC startup remains manual for v0.2.
- Add lifecycle limitation metadata and tests for the preserved QVAC lifecycle
  config defaults.
- Add public scoped-package publish metadata, explicit Node 22-26 support,
  Node matrix CI, `verify:package` in CI, and a manual alpha publish workflow.
- Expand package verification to install the packed tarball into a clean npm
  consumer, smoke-test JS and Python imports from installed contents, and copy
  plugin assets into a clean `HERMES_HOME`.

## v0.1.0-alpha.1

- Initial repository scaffold.
- Add minimal Hermes QVAC provider descriptor and OpenAI-compatible config helper.
- Add QVAC local server reachability detection with a clear unavailable-server message.
- Add a curated QVAC model catalog with user override support.
- Add streaming capability metadata for the OpenAI-compatible provider path.
- Add Hermes model-provider plugin metadata, install/doctor scripts, and the
  Python provider profile for local QVAC models.
