#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { qvacCatalog } from "@qvac/ai-sdk-provider/models";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = readFileSync("plugin.yaml", "utf8");
const readme = readFileSync("README.md", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const compatibility = readFileSync("docs/compatibility.md", "utf8");
const configuration = readFileSync("docs/configuration.md", "utf8");
const releaseReadiness = readFileSync(
  "docs/beta3-release-readiness.md",
  "utf8",
);
const betaReadiness = readFileSync("docs/beta-readiness-plan.md", "utf8");
const pythonProvider = readFileSync("qvac_provider/__init__.py", "utf8");
const typescriptConfig = readFileSync("src/config.ts", "utf8");
const repositoryUrl =
  "git+https://github.com/localhost41/hermes-qvac-quickstart.git";

if (packageJson.repository?.url !== repositoryUrl) {
  throw new Error(`repository URL drifted: ${packageJson.repository?.url}`);
}
if (
  packageJson.bugs?.url !==
    "https://github.com/localhost41/hermes-qvac-quickstart/issues" ||
  packageJson.homepage !==
    "https://github.com/localhost41/hermes-qvac-quickstart#readme"
) {
  throw new Error("quickstart support URLs drifted");
}

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function yamlScalar(text, key) {
  return text.match(new RegExp(`^\\s*${key}:\\s*([^#\\n]+?)\\s*$`, "m"))?.[1];
}

const manifestVersion = manifest.match(/^version:\s*(\S+)\s*$/m)?.[1];
if (manifestVersion !== packageJson.version) {
  throw new Error(
    `version mismatch: package.json=${packageJson.version}, plugin.yaml=${manifestVersion ?? "missing"}`,
  );
}
if (!readme.includes(`${packageJson.name}@beta`)) {
  throw new Error(`README does not install ${packageJson.name}@beta`);
}
if (!/^## Unreleased\s*$/m.test(changelog)) {
  throw new Error("CHANGELOG.md has no Unreleased section");
}
if (!/^kind:\s*model-provider\s*$/m.test(manifest)) {
  throw new Error("plugin.yaml is not a Hermes model-provider manifest");
}
requireMatch(
  readme,
  /^# Hermes \+ QVAC Quickstart$/m,
  "README product title drifted",
);
if (!/description: Hermes \+ QVAC Quickstart provider/.test(manifest)) {
  throw new Error("plugin manifest product description drifted");
}
requireMatch(
  typescriptConfig,
  /^\s*profile: "full",$/m,
  "TypeScript default beginner profile drifted",
);
requireMatch(
  manifest,
  /^\s*profile:\s*\n\s*default:\s*full$/m,
  "manifest default beginner profile drifted",
);
requireMatch(
  readme,
  /Use `start --full` to restore 9B\/32K and normal Hermes tools/,
  "README fast/full profile guidance drifted",
);

const supportedNode = "22, 24, 26";
if (packageJson.engines?.node !== ">=22 <27") {
  throw new Error(`unexpected Node engine range: ${packageJson.engines?.node}`);
}
requireMatch(readme, /^- Node 22–26$/m, "README Node support drifted");
requireMatch(
  compatibility,
  new RegExp(`^\\| Node \\| ${supportedNode} \\|$`, "m"),
  "compatibility Node matrix drifted",
);
requireMatch(
  betaReadiness,
  /QVAC `serve openai --api-key` plus external mode/,
  "beta plan lost the supported authenticated QVAC boundary",
);
requireMatch(
  betaReadiness,
  /Change metadata to beta only after every required gate is passed/,
  "beta promotion rule drifted",
);
requireMatch(
  readme,
  /Session resume is not part of the supported surface/,
  "README must state the beta session-resume boundary",
);
if (/Node 20(?:\b|–|-)/.test(`${readme}\n${compatibility}`)) {
  throw new Error("maintained support docs still claim Node 20");
}

const defaults = {
  model: yamlScalar(manifest, "default_model"),
  auxModel: yamlScalar(manifest, "default_aux_model"),
  maxTokens: Number(yamlScalar(manifest, "default_max_tokens")),
  contextWindow: Number(yamlScalar(manifest, "context_window")),
};
if (!qvacCatalog.some((entry) => entry.id === defaults.model)) {
  throw new Error(
    `default model is absent from official catalog: ${defaults.model}`,
  );
}
if (!qvacCatalog.some((entry) => entry.id === defaults.auxModel)) {
  throw new Error(
    `default auxiliary model is absent from official catalog: ${defaults.auxModel}`,
  );
}
for (const [label, value] of [
  ["Main model", defaults.model],
  ["Auxiliary model", defaults.auxModel],
  ["Context", String(defaults.contextWindow)],
  ["Maximum output", String(defaults.maxTokens)],
]) {
  requireMatch(
    readme,
    new RegExp(`^- ${label}: .*${value}`, "m"),
    `README ${label.toLowerCase()} drifted`,
  );
}
requireMatch(
  configuration,
  new RegExp(
    "\\\\| Context \\\\|[^\\\\n]+\\\\| `" + defaults.contextWindow + "` \\\\|",
  ),
  "configuration context default drifted",
);
requireMatch(
  pythonProvider,
  new RegExp(`^DEFAULT_MAX_TOKENS = ${defaults.maxTokens}$`, "m"),
  "Python maximum-token default drifted",
);
requireMatch(
  pythonProvider,
  new RegExp(`^DEFAULT_CONTEXT_WINDOW = ${defaults.contextWindow}$`, "m"),
  "Python context default drifted",
);
requireMatch(
  releaseReadiness,
  new RegExp(`Candidate package.*${packageJson.version}`),
  "release report candidate version drifted",
);
requireMatch(
  compatibility,
  /^\| Python profile \| 3\.11–3\.13 CI matrix; real Hermes Python 3\.11 \|$/m,
  "Python compatibility claim drifted",
);

console.log(
  `ok - release metadata agrees on ${packageJson.version}; Node ${supportedNode}; ${qvacCatalog.length} official models`,
);
