# Official OpenClaw parity and evidence matrix

Snapshot inspected 2026-07-21:

- QVAC source `af187820621943a77912867c32e44ab493a36556`
- published `@qvac/openclaw-plugin` 0.1.1, tarball SHA-256 `27199e28df3a68a1395bde151d7b1ce375dbce9396a79ca21a0def6959707482`
- published `@qvac/ai-sdk-provider` 0.3.0, tarball SHA-256 `bc1b014298f66cc1201c003e1568c94d84972d753a57961275e395691164261b`
- published `@qvac/cli` 0.8.1, tarball SHA-256 `4f0fef5744e5acad3c60948c07e96aeae92820d1c0fc3896281d6802a7d48e38`
- Hermes Agent 0.18.2, source `e361c5e20402375c74a65ca52810c6a380461226`

“Equivalent” means the same user outcome through a real Hermes API. It does not imply Hermes implements OpenClaw APIs. “Host limitation” means the corresponding hook does not exist in the inspected Hermes source.

| Official behavior | Hermes equivalent | Implementation | Automated evidence | Manual/real evidence | Status/difference | Cause |
|---|---|---|---|---|---|---|
| Provider registration | real `ProviderProfile` named `qvac` with aliases | `qvac_provider/__init__.py`, root entrypoint | Python constructor/discovery tests | isolated real-Hermes doctor | Equivalent | — |
| Manifest discovery | `kind: model-provider`, safe copied installation, explicit enable | `plugin.yaml`, `setupPlugin` | lifecycle/package tests | real setup and plugin list | Equivalent | — |
| Setup wizard | command-specific `hermes-qvac setup` | CLI/config/runtime | setup, rollback, upgrade tests | real isolated setup | Host-equivalent, noninteractive | Hermes has no third-party provider wizard hook |
| JSON plugin schema | validated CLI/env/saved schema and reference | `config.ts`, configuration docs | exhaustive validation tests | `config validate` | Host-equivalent | Hermes does not consume provider plugin schemas |
| Synthetic auth | child-only `QVAC_API_KEY` marker | `hermesEnvironment` | fake-Hermes environment tests | real transport smoke | Equivalent outcome | Hermes resolves environment credentials |
| Static catalog callback | `fallback_models`, `models`, `models info` | Python profile and official Node imports | exact ordered cross-runtime test | real profile inspection | Equivalent outcome | Different host surface |
| Model picker rows | eight ordered fallback IDs | Python profile | exact catalog parity test | ProviderProfile doctor | Equivalent IDs/order | — |
| Per-model modality | provider-wide vision plus exact Node descriptor modality | profile and `src/index.ts` | Python/TS catalog tests | real profile vision flag | Partial | Hermes profile metadata is provider-wide |
| `requiresStringContent` | copy-on-write text-block collapse, multimedia preservation | profile `prepare_messages` | message shape/nonmutation tests | real streaming smoke | Functional equivalent | — |
| Zero local cost | zero cost fields on portable descriptor/profile metadata | Python/TS descriptors | descriptor/profile tests | inspection | Equivalent metadata where host permits | Hermes has no native cost row |
| 32K context, 8192 output | `ctxSize=32768`, `default_max_tokens=8192` | config/profile | config/profile tests | doctor | Equivalent | — |
| Default model | `qwen3.5-9b` | config/profile/catalog | golden tests | models output | Equivalent | — |
| Main and auxiliary | main default/preload, `qwen3.5-2b` auxiliary preload | config/runtime/profile | golden config test | real profile | Exceeds OpenClaw for Hermes auxiliary work | Hermes exposes auxiliary default |
| Friendly ID mapping | official resolver/catalog; SDK constants normalize to friendly IDs | config/runtime | all-entry mapping and normalization tests | models info | Equivalent | — |
| Full lazy catalog | all eight aliases emitted, two preload, six lazy | `createManagedModels` | fake-QVAC golden test | generated config inspection | Exceeds selected-only OpenClaw launch config | — |
| `model` | `model` / `QVAC_MODEL` | config/CLI | precedence, validation, golden tests | config show | Equivalent | — |
| `host` | loopback-only `host` / `QVAC_HOST` | config/runtime | validation and lifecycle tests | doctor | Safer restriction | Security policy |
| `port` | pinned or automatic port | config/runtime | auto and collision tests | status | Exceeds with auto allocation | Official manager capability |
| `baseUrl` | `baseURL` / `QVAC_BASE_URL` external mode | config/CLI | external endpoint tests | doctor | Added capability | — |
| `apiKey` | marker/key with recursive redaction | config/runtime | auth/redaction tests | doctor | Equivalent plus redaction | — |
| `qvacCommand` | `qvacBin`, bundled CLI by default | config/runtime | package, relative path, fake binary tests | doctor | Equivalent | Official manager API names it `serveBinPath` |
| `cwd` | validated cwd; requires no reuse | config/runtime | spaces/relative binary test | doctor | Equivalent with explicit reuse guard | Upstream fleet key omits cwd |
| `ctxSize` | per-entry `ctx_size` | config/runtime | golden config | generated config | Equivalent | — |
| `reasoningBudget` | per-entry `reasoning_budget`, default `0` | config/runtime | golden config | generated config | Intentional difference | Disabled by default for predictable beginner output; configurable with `--reasoning-budget`. |
| `tools` | per-entry tool formatting flag | config/runtime | golden config | generated config | Equivalent | — |
| `readyTimeoutMs` | official `serveStartTimeout` | runtime | delayed readiness/timeout/exit tests | doctor | Equivalent | — |
| `idleStopMs` | official `serveIdleTimeout` | runtime | consumer cleanup tests | process inspection | Equivalent | — |
| `timeoutSeconds` | child `HERMES_API_TIMEOUT` | runtime | fake-Hermes tests | real smoke timeout cases | Equivalent default | Explicit Hermes provider/model timeout intentionally wins |
| compatible reuse | official fleet registry | runtime | compatible/incompatible fleet tests | process IDs | Equivalent | — |
| generated config | official synthesizer with all exact fields | official manager + runtime model declarations | full fake-QVAC golden | captured config | Equivalent/stronger | — |
| readiness | official manager plus selected main/aux advertisement | runtime | delay, early exit, missing model tests | status | Stronger | — |
| port collision | preflight refusal without signaling occupant | runtime | live occupant test | — | Safer explicit diagnostic | — |
| signal forwarding | CLI forwards INT/TERM to the detached Hermes process group, escalates resistant children, and detaches the QVAC consumer | runtime | fake-Hermes signal/reap/descendant tests | real adverse smoke suite | Stronger descendant cleanup on macOS/Linux | — |
| child exit propagation | exact Hermes exit status | runtime/CLI | exit 37 and signal 143 tests | — | Equivalent | — |
| shared cleanup | official detached runner and consumer markers | official manager | reuse/detach/reap tests | process inspection | Equivalent | — |
| foreground service | `serve`, multi-session `status`, authenticated `stop` | CLI/runtime | service, partial stop, invalid state tests | package verifier | Added capability | — |
| external endpoint | bounded authenticated catalog probe before Hermes | CLI/runtime | malformed/large/missing/auth tests | doctor | Added capability | — |
| doctor | dependency, ownership, enablement, real profile, catalog, endpoint, sessions/control | runtime/CLI | fake and package tests | real isolated doctor | Added capability | — |
| transport smoke | isolated profile + streaming fixture + real Hermes exact `pong` | CLI/runtime | fixture units | `pnpm smoke:transport`, `verify:hermes` | Stronger no-download verification | — |
| physical smoke | managed/external exact `pong`, official size estimate, `--yes` | CLI | consent and size tests | intentionally not run | Implemented, consent-gated | Multi-gigabyte download |
| package artifact | bin, JS/types, Python, manifest, docs, scripts | package metadata/verifier | isolated pack/install/product commands | manual tar listing | Stronger installed-product coverage | — |
| Linux/macOS | OS/Node/Python matrix | CI | workflow | local macOS | Equivalent portability target | — |
| current-package drift | scheduled no-save update and current Hermes source profile check | compatibility workflow | scheduled/manual workflow | authoritative local audit | Added capability | — |

## Remaining demonstrated limitations

1. Hermes 0.18.2 has no third-party provider setup-wizard, schema, synthetic-auth callback, static catalog callback, or provider-local service lifecycle hook. Implementing methods with those OpenClaw names would be inert. The ProviderProfile and companion CLI are the supported functional surfaces.
2. Hermes exposes provider-wide `supports_vision`, not per-model modality. The profile therefore cannot identify only `gpt-oss-20b` as text-only, although the Node catalog descriptor and `models info` do.
3. Hermes explicit `providers.qvac.request_timeout_seconds` or per-model timeout configuration has higher host-level precedence than `HERMES_API_TIMEOUT`.
4. Physical inference remains unexecuted. The 2026-07-21 review found 35 GiB free disk and 16 GiB RAM, which is plausibly sufficient for the smallest 1.69 GiB preload, but made a no-go decision without separate explicit download consent.
