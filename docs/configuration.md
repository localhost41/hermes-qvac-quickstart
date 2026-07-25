# Configuration reference

Precedence is CLI option, environment variable, saved configuration, then default. `hermes-qvac config set` writes `$HERMES_HOME/hermes-qvac/config.json`; `config show` recursively redacts secret-bearing fields. `config validate` applies all layers without mutation, and `config path` prints the saved-file location.

| Setting | CLI | Environment | Default | Notes |
|---|---|---|---|---|
| Main model | `--model` | `QVAC_MODEL` | `qwen3.5-9b` | Must be a friendly ID or SDK constant in the official catalog; constants normalize to friendly IDs. |
| Auxiliary model | `--aux-model` | `QVAC_AUX_MODEL` | `qwen3.5-2b` | Same validation; preloaded for Hermes side tasks. |
| Host | `--host` | `QVAC_HOST` | `127.0.0.1` | Only `127.0.0.1` and `localhost` are accepted. |
| Port | `--port` | `QVAC_PORT` | automatic | Pin only when another process is not using it. |
| Existing endpoint | `--base-url` | `QVAC_BASE_URL` | unset | HTTP(S), no embedded credentials/query/fragment, path ending in `/v1`. Selects external mode. |
| API key/marker | `--api-key` | `QVAC_API_KEY` | `custom-local` | Authenticates probes and Hermes requests in external mode and is redacted from captured diagnostics. It is only a client marker in managed mode because the official managed-provider API does not expose the CLI's server-auth option. |
| QVAC executable | `--bin` | `QVAC_BIN` | bundled `@qvac/cli` | Absolute path recommended. |
| Working directory | `--cwd` | `QVAC_CWD` | current directory | Requires `--no-reuse` because upstream fleet identity does not include cwd. |
| Context | `--ctx-size` | `QVAC_CTX_SIZE` | `32768` | Positive integer, applied to every catalog entry. |
| Reasoning | `--reasoning-budget` | `QVAC_REASONING_BUDGET` | `0` | `-1` enables reasoning; `0` disables it. The beginner default avoids consuming the response budget with hidden reasoning. |
| Tool formatting | `--tools` / `--no-tools` | `QVAC_TOOLS` | `true` | Applied in QVAC serve model config. |
| Startup timeout | `--ready-timeout-ms` | `QVAC_READY_TIMEOUT_MS` | `900000` | Includes cold model preload/download time. Cache-aware disk preflight requires missing artifact bytes plus a 2 GiB safety margin. |
| Idle cleanup | `--idle-stop-ms` | `QVAC_IDLE_STOP_MS` | `0` | Time after the last upstream consumer detaches. |
| Request timeout | `--timeout-seconds` | `QVAC_TIMEOUT_SECONDS` | `300` | Passed to the Hermes child as `HERMES_API_TIMEOUT`. An explicit Hermes `providers.qvac.*.timeout_seconds` setting takes precedence inside Hermes. |
| Fleet reuse | `--reuse` / `--no-reuse` | `QVAC_REUSE` | `true` | Matching official managed-provider fleets can be shared. |

Boolean environment values accept `true/false`, `1/0`, `yes/no`, and `on/off` case-insensitively.

`HERMES_PYTHON` is a diagnostic-only override used by `doctor` when an
official manual Hermes source installation keeps its Python environment
outside the checkout. It must be an absolute interpreter path and is never
saved by `hermes-qvac config`.

Reads accept only regular non-symlink files no larger than 64 KiB. Writes persist only explicit saved overrides, use unique adjacent temporary files, mode `0600`, and atomic rename; the containing configuration directory is a real non-symlink directory with mode `0700`. Concurrent writers cannot produce partial JSON. Their documented conflict behavior is last completed atomic rename wins, so orchestration should serialize logically related field updates.

Examples:

```bash
hermes-qvac config set --model qwen3.5-9b --ctx-size 65536 --reasoning-budget -1 --tools
hermes-qvac run -- --cli

QVAC_BASE_URL=http://127.0.0.1:19000/v1 hermes-qvac run --external -- --cli
```

`setup` accepts the same configuration options. It validates the complete effective configuration but persists only options explicitly supplied to that setup invocation; temporary environment overrides are not captured. Setup, doctor, models, config, and transport-only smoke never initiate a QVAC model download.
