# Performance attribution

This project distinguishes quickstart lifecycle time, QVAC model time, Hermes
prompt evaluation, and model-quality outcomes. It does not describe a single
prompt as a general model benchmark.

## Controlled 9B measurement

On 2026-07-25, one warmed QVAC 0.8.1 process served
`qwen3.5-9b` on a 16 GiB Apple silicon Mac with Metal acceleration. Each lane
ran three times with the same exact-response task. All nine requests succeeded.

| Lane | Mean duration | Request bytes | Message characters | Tools | Tool-schema bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Minimal direct OpenAI-compatible request | 0.38 s | 128 | 17 | 0 | 0 |
| Normal Hermes | 97.84 s | 70,362 | 17,063 | 28 | 52,862 |
| Hermes `--toolsets terminal` | 22.69 s | 17,505 | 10,397 | 2 | 6,772 |

The stable repeated results attribute the observed delay primarily to local
evaluation of the Hermes system prompt and tool schemas. Package installation,
managed-QVAC startup, and HTTP proxying were outside these recorded request
durations. A manual Hermes/QVAC setup using the same model, Hermes configuration,
and tool catalog should send the same class of request and therefore encounter
the same cost.

## Controlled 4B measurement

The same three-iteration matrix was repeated with `qwen3.5-4b` and a 16K
context. All nine requests again returned exact `OK`.

| Lane | Mean duration | Request bytes | Message characters | Tools | Tool-schema bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Minimal direct OpenAI-compatible request | 0.21 s | 128 | 17 | 0 | 0 |
| Normal Hermes | 59.36 s | 70,363 | 17,064 | 28 | 52,862 |
| Hermes `--toolsets terminal` | 12.79 s | 17,506 | 10,398 | 2 | 6,772 |

Together, the model and supported-toolset changes reduce the mean warmed
completion from 97.84 seconds in the full 9B lane to 12.79 seconds in the fast
lane on this machine. This supports the explicit profile; it does not establish
equivalent task quality.

## Fast beginner profile

`hermes-qvac start --fast` deliberately selects:

- official QVAC `qwen3.5-4b`;
- 16,384-token context;
- reasoning budget `0`;
- QVAC tool formatting enabled;
- Hermes' supported `terminal` toolset.

The first measured run downloaded the remaining 2.55 GiB of model data and
completed setup, model load, inference, and cleanup in 124 seconds. The cached
rerun completed in 18 seconds. Both returned exact `OK` and left no managed QVAC
process after the supervisor's asynchronous shutdown completed.

This is a responsiveness profile, not an assertion that 4B matches the 9B
model's tool reliability or that terminal-only Hermes can perform every normal
agent workflow. The default remains the full 9B agent.

## Reproduction

Start or connect to a QVAC endpoint, install the provider into an isolated
Hermes home, and run:

```bash
pnpm benchmark:performance -- \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen3.5-9b \
  --hermes-home /path/to/isolated-hermes-home \
  --iterations 5
```

The recording proxy forwards requests unchanged. Its machine-readable report
contains only aggregate request characteristics and timing evidence; request
bodies, full prompts, and credentials are not emitted.
