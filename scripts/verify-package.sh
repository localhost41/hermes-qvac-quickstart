#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"

npm pack --json --pack-destination "$TMP_DIR" >"$TMP_DIR/pack.json"

TARBALL_NAME="$(
  node -e "const fs = require('fs'); const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(data[0].filename);" "$TMP_DIR/pack.json"
)"
TARBALL_PATH="$TMP_DIR/$TARBALL_NAME"

if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "Packed tarball was not created at $TARBALL_PATH" >&2
  exit 1
fi

tar -tf "$TARBALL_PATH" >"$TMP_DIR/contents.txt"

require_file() {
  local file="$1"
  if ! grep -Fxq "package/$file" "$TMP_DIR/contents.txt"; then
    echo "Packed tarball is missing package/$file" >&2
    exit 1
  fi
}

reject_path() {
  local path="$1"
  if grep -Fq "$path" "$TMP_DIR/contents.txt"; then
    echo "Packed tarball unexpectedly includes $path" >&2
    exit 1
  fi
}

require_installed_file() {
  local file="$1"
  if [[ ! -f "$INSTALLED_PACKAGE_DIR/$file" ]]; then
    echo "Installed npm package is missing $file" >&2
    exit 1
  fi
}

require_copied_plugin_file() {
  local file="$1"
  if [[ ! -f "$INSTALLED_PLUGIN_DIR/$file" ]]; then
    echo "Copied Hermes plugin is missing $file" >&2
    exit 1
  fi
}

require_file "package.json"
require_file "README.md"
require_file "CONTRIBUTING.md"
require_file "CHANGELOG.md"
require_file "LICENSE"
require_file "__init__.py"
require_file "plugin.yaml"
require_file "dist/index.js"
require_file "dist/index.d.ts"
require_file "dist/cli.js"
require_file "dist/runtime.js"
require_file "dist/config.js"
require_file "docs/architecture-notes.md"
require_file "docs/configuration.md"
require_file "docs/hermes-host-conformance.md"
require_file "docs/compatibility.md"
require_file "docs/security.md"
require_file "examples/hermes-qvac-demo.mjs"
require_file "qvac_provider/__init__.py"
require_file "scripts/doctor.sh"
require_file "scripts/install.sh"
require_file "scripts/start-qvac.sh"

reject_path "docs/findings-ledger.md"
reject_path "docs/release-readiness-"
reject_path "docs/test-inventory.md"
reject_path "scripts/verify-"
reject_path "scripts/qvac-conformance.mjs"
reject_path "scripts/moderator-acceptance.mjs"
reject_path "scripts/artifact-provenance.mjs"

reject_path "node_modules/"
reject_path "__pycache__/"
reject_path ".pyc"
reject_path "test/"
reject_path "tests/"
reject_path ".git/"
reject_path "artifacts/"

CONSUMER_DIR="$TMP_DIR/npm-consumer"
mkdir -p "$CONSUMER_DIR"

printf '{"private":true,"type":"module"}\n' >"$CONSUMER_DIR/package.json"

(
  cd "$CONSUMER_DIR"
  npm install \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --cache "$TMP_DIR/npm-cache" \
    "$TARBALL_PATH" >/dev/null
)
# Resolution is complete. Release the isolated npm cache before exercising the
# real lifecycle disk preflight so this verifier does not create a false
# low-disk failure itself.
rm -rf "$TMP_DIR/npm-cache"

INSTALLED_PACKAGE_DIR="$CONSUMER_DIR/node_modules/@localhost41/hermes-qvac-provider"
if [[ ! -d "$INSTALLED_PACKAGE_DIR" ]]; then
  echo "Installed npm package was not created at $INSTALLED_PACKAGE_DIR" >&2
  exit 1
fi

require_installed_file "package.json"
require_installed_file "dist/index.js"
require_installed_file "dist/index.d.ts"
require_installed_file "dist/cli.js"
require_installed_file "dist/runtime.js"
require_installed_file "dist/config.js"
require_installed_file "__init__.py"
require_installed_file "plugin.yaml"
require_installed_file "qvac_provider/__init__.py"
require_installed_file "scripts/install.sh"
require_installed_file "scripts/doctor.sh"
require_installed_file "scripts/start-qvac.sh"

(
  cd "$CONSUMER_DIR"
  node --input-type=module <<'EOF'
import {
  DEFAULT_QVAC_MODEL,
  createHermesQvacProvider,
  hermesQvacProvider,
} from "@localhost41/hermes-qvac-provider";

const provider = createHermesQvacProvider();

if (DEFAULT_QVAC_MODEL !== "qwen3.5-9b") {
  throw new Error(`Unexpected default model: ${DEFAULT_QVAC_MODEL}`);
}

if (provider.id !== "qvac" || provider.protocol !== "openai-compatible") {
  throw new Error(`Unexpected provider descriptor: ${JSON.stringify(provider)}`);
}

if (hermesQvacProvider.defaultModel !== DEFAULT_QVAC_MODEL) {
  throw new Error("Default provider export does not use the default QVAC model");
}
EOF
)

(
  cd "$CONSUMER_DIR"
  ./node_modules/.bin/hermes-qvac --help >/dev/null
  ./node_modules/.bin/hermes-qvac version --json >/dev/null
  ./node_modules/.bin/hermes-qvac models --json >/dev/null
  ./node_modules/.bin/hermes-qvac models info qwen3.5-9b --json >/dev/null
)

CLI_BIN_DIR="$TMP_DIR/bin"
CLI_HERMES_HOME="$TMP_DIR/cli-hermes-home"
CLI_HERMES_LOG="$TMP_DIR/cli-hermes.log"
CLI_FAKE_INSTALL="$TMP_DIR/fake-hermes-install"
mkdir -p "$CLI_BIN_DIR"
mkdir -p "$CLI_FAKE_INSTALL/venv/bin"
cat >"$CLI_BIN_DIR/hermes" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CLI_HERMES_LOG"
if [[ "${1:-}" == "--version" ]]; then
  printf 'Hermes Agent v0.18.2\nInstall directory: %s\n' "$CLI_FAKE_INSTALL"
elif [[ "${1:-} ${2:-}" == "plugins list" ]]; then
  echo "enabled user 0.1.0-alpha.4 qvac"
elif [[ " $* " == *" -z "* ]]; then
  echo "pong"
fi
exit 0
EOF
chmod +x "$CLI_BIN_DIR/hermes"
cat >"$CLI_FAKE_INSTALL/venv/bin/python" <<'EOF'
#!/usr/bin/env bash
printf '{"class":"QvacProviderProfile","provider_profile":true,"name":"qvac","aliases":["local-qvac","qvac-local"],"base_url":"%s","models_url":"","supports_vision":true,"fallback_models":["qwen3.5-0.8b","qwen3.5-2b","qwen3.5-4b","qwen3.5-9b","qwen3.6-27b","qwen3.6-35b-a3b","gpt-oss-20b","gemma4-31b"],"default_model":"qwen3.5-9b","default_aux_model":"qwen3.5-2b","default_max_tokens":8192,"context_window":32768}\n' "$QVAC_BASE_URL"
EOF
chmod +x "$CLI_FAKE_INSTALL/venv/bin/python"
cat >"$CLI_BIN_DIR/qvac-fake.mjs" <<'EOF'
#!/usr/bin/env node
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args[0] !== "serve" || args[1] !== "openai") process.exit(64);
const configPath = value("--config");
const host = value("--host");
const port = Number(value("--port"));
copyFileSync(configPath, process.env.FAKE_QVAC_CAPTURE);
writeFileSync(process.env.FAKE_QVAC_CAPTURE + ".pid", String(process.pid));
const ids = Object.keys(JSON.parse(readFileSync(configPath, "utf8")).serve.models);
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/models") response.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  else { response.statusCode = 404; response.end(); }
});
server.listen(port, host);
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop); process.on("SIGTERM", stop);
EOF
chmod +x "$CLI_BIN_DIR/qvac-fake.mjs"

# Fake QVAC cannot consume model payloads. Sparse metadata-sized cache entries
# keep the real storage preflight deterministic without downloading models.
CLI_HOME="$TMP_DIR/cli-user-home"
mkdir -p "$CLI_HOME/.qvac/models"
(
  cd "$CONSUMER_DIR"
  HOME="$CLI_HOME" node --input-type=module <<'EOF'
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allModels, resolveModelConstant } from "@qvac/ai-sdk-provider/models";
for (const id of ["qwen3.5-4b", "qwen3.5-2b"]) {
  const metadata = allModels.find((model) => model.name === resolveModelConstant(id));
  if (!metadata || typeof metadata.expectedSize !== "number") throw new Error(`Missing model metadata for ${id}`);
  const path = join(process.env.HOME, ".qvac", "models", `package-verifier_${metadata.modelId}`);
  await writeFile(path, "");
  await truncate(path, metadata.expectedSize);
}
EOF
)
export HOME="$CLI_HOME"

# Exercise the actual public beginner path from packed files in a fresh Hermes
# home: consent, copied setup, managed QVAC, Hermes launch, and cleanup.
CLI_START_HOME="$TMP_DIR/cli-start-hermes-home"
(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_START_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" FAKE_QVAC_CAPTURE="$TMP_DIR/start-qvac-config.json" \
    ./node_modules/.bin/hermes-qvac start --model qwen3.5-4b --bin "$CLI_BIN_DIR/qvac-fake.mjs" --no-reuse --yes >/dev/null
)
if [[ ! -f "$CLI_START_HOME/plugins/model-providers/qvac/.hermes-qvac-provider.json" ]]; then
  echo "Packed beginner start did not install its owned provider" >&2
  exit 1
fi
node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (config.model !== "qwen3.5-4b" || config.reuse !== false) {
  throw new Error(`Beginner start did not persist explicit choices: ${JSON.stringify(config)}`);
}
' "$CLI_START_HOME/hermes-qvac/config.json"

(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac setup --model qwen3.5-4b --reasoning-budget 0 --no-tools --json >/dev/null
)

(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac setup --json >"$TMP_DIR/repeated-setup.json"
)
node -e 'const r=require(process.argv[1]); if (!r.upgraded) throw new Error("Repeated packaged setup was not reported as an upgrade")' "$TMP_DIR/repeated-setup.json"

if [[ ! -f "$CLI_HERMES_HOME/plugins/model-providers/qvac/.hermes-qvac-provider.json" ]]; then
  echo "Packaged CLI setup did not install its ownership marker" >&2
  exit 1
fi
if ! grep -Fq "plugins enable qvac --no-allow-tool-override" "$CLI_HERMES_LOG"; then
  echo "Packaged CLI setup did not enable qvac through Hermes" >&2
  exit 1
fi

# The single-quoted body is intentional: this is JavaScript, not shell expansion.
# shellcheck disable=SC2016
node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (config.model !== "qwen3.5-4b" || config.reasoningBudget !== 0 || config.tools !== false) {
  throw new Error(`Unexpected saved CLI config: ${JSON.stringify(config)}`);
}
' "$CLI_HERMES_HOME/hermes-qvac/config.json"

FAKE_QVAC_CAPTURE="$TMP_DIR/packaged-qvac-config.json"
(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" FAKE_QVAC_CAPTURE="$FAKE_QVAC_CAPTURE" \
    ./node_modules/.bin/hermes-qvac run --bin "$CLI_BIN_DIR/qvac-fake.mjs" --no-reuse --json >/dev/null
)
if [[ ! -f "$FAKE_QVAC_CAPTURE" ]]; then
  echo "Packaged run did not start the configured fake QVAC executable" >&2
  exit 1
fi

(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac config path >/dev/null
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac config validate --json >/dev/null
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac doctor --json >/dev/null
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$TMP_DIR/packaged-smoke-home" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac smoke --transport-only --json >/dev/null
)

(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" FAKE_QVAC_CAPTURE="$TMP_DIR/packaged-serve-config.json" \
    ./node_modules/.bin/hermes-qvac serve --bin "$CLI_BIN_DIR/qvac-fake.mjs" --no-reuse --json >"$TMP_DIR/packaged-serve.out" &
  serve_cli_pid=$!
  state_file="$CLI_HERMES_HOME/hermes-qvac/sessions/$serve_cli_pid.json"
  for _attempt in $(seq 1 100); do
    [[ -f "$state_file" ]] && break
    sleep 0.1
  done
  [[ -f "$state_file" ]]
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac status --json >/dev/null
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac stop --json >/dev/null
  wait "$serve_cli_pid"
)

(
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac uninstall --json >/dev/null
)

if [[ -d "$CLI_HERMES_HOME/plugins/model-providers/qvac" ]]; then
  echo "Packaged CLI uninstall left the owned plugin directory behind" >&2
  exit 1
fi

mkdir -p "$CLI_HERMES_HOME/plugins/model-providers/qvac"
printf 'id: unrelated\n' >"$CLI_HERMES_HOME/plugins/model-providers/qvac/plugin.yaml"
if (
  cd "$CONSUMER_DIR"
  PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$CLI_HERMES_HOME" CLI_HERMES_LOG="$CLI_HERMES_LOG" CLI_FAKE_INSTALL="$CLI_FAKE_INSTALL" \
    ./node_modules/.bin/hermes-qvac setup --json >/dev/null 2>&1
); then
  echo "Packaged setup replaced an unrecognized plugin directory" >&2
  exit 1
fi

PYTHONPATH="$INSTALLED_PACKAGE_DIR" python3 <<'EOF'
import qvac_provider

profile = qvac_provider.register()

if getattr(profile, "name", None) != "qvac":
    raise SystemExit(f"Unexpected provider profile name: {profile!r}")

if getattr(profile, "default_model", None) != "qwen3.5-9b":
    raise SystemExit(f"Unexpected default model: {profile!r}")
EOF

PATH="$CLI_BIN_DIR:$PATH" HERMES_HOME="$TMP_DIR/hermes-home" CLI_HERMES_LOG="$CLI_HERMES_LOG" \
  bash "$INSTALLED_PACKAGE_DIR/scripts/install.sh" --copy >/dev/null
INSTALLED_PLUGIN_DIR="$TMP_DIR/hermes-home/plugins/model-providers/qvac"

if [[ ! -d "$INSTALLED_PLUGIN_DIR" || -L "$INSTALLED_PLUGIN_DIR" ]]; then
  echo "Copied Hermes plugin was not created as a real directory at $INSTALLED_PLUGIN_DIR" >&2
  exit 1
fi

require_copied_plugin_file "__init__.py"
require_copied_plugin_file "plugin.yaml"
require_copied_plugin_file "qvac_provider/__init__.py"
require_copied_plugin_file ".hermes-qvac-provider.json"

echo "ok - package tarball installs and verifies runtime assets: $TARBALL_NAME"
