# Test inventory

| Layer | Fixtures | What it proves | Command |
|---|---|---|---|
| Pure TypeScript units | no processes | parsing, precedence, validation, redaction, model mapping, estimates, output semantics | `pnpm test` |
| Python units | fallback and simulated ProviderProfile signatures | discovery entrypoint, profile fields/hooks, message copy-on-write, exact fallback order, bounded authenticated catalog fetch | `pnpm test:python` |
| Fake QVAC integration | executable reads generated config and serves `/v1/models` | exact golden config, readiness delay/failure, selected main/aux, port safety, cwd/binary, cleanup, official reuse/separation | `pnpm test` |
| Fake Hermes integration | executable records arguments/environment/exits/signals/hangs | selected provider/model, reserved-override rejection, endpoint/key/timeout, exit propagation, signal forwarding, descendant cleanup, duration/output bounds, echoed-secret redaction | `pnpm test` |
| OpenAI-compatible fixtures | bounded local HTTP server | authenticated model parsing and malformed/large schemas in units; streaming/nonstream/error/delay/close behavior through real Hermes | `pnpm test`, `pnpm verify:hermes` |
| Foreground service integration | real CLI subprocesses and fake QVAC | multi-session state, status, token redaction, authenticated stop, partial/unreachable/stale/corrupt behavior | `pnpm test` |
| Isolated npm consumer | packed tarball, fake Hermes/QVAC | exports/types/assets/bin/help/models/setup/repeat/config/run/serve/status/stop/doctor/smoke/uninstall/refusal/wrappers | `pnpm verify:package` |
| Real local Hermes | isolated `HERMES_HOME`, actual provider discovery/transport | setup, enable, actual subclass loading, streaming exact `pong`, adverse HTTP/SSE/timeout behavior, uninstall | `pnpm smoke:transport`, `pnpm verify:hermes`, isolated doctor workflow |
| Official packages | locked published runtime and scheduled latest compatible packages | official config synthesizer/manager behavior and drift detection | normal suite and compatibility workflow |
| Physical inference | real QVAC/model | exact `pong`, download/runtime behavior | `hermes-qvac smoke --model … --yes`; intentionally not run without consent |
| Performance attribution | recording loopback proxy, real Hermes/QVAC | minimal API versus normal and terminal-only Hermes payload size and latency without recording prompts/secrets | `pnpm benchmark:performance -- ...` |

Tests use bounded polling for asynchronous process/file readiness. Vitest assigns each run a private temporary root and removes that root during global teardown, including after ordinary failures; spawned CLI and fixture processes inherit it. There are no committed `.skip`, `xit`, or equivalent exclusions.
