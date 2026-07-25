# Artifact and supply-chain evidence

The alpha package is intentionally smaller than the repository. It contains
the built library and companion CLI, Python provider profile, Hermes manifest,
three compatibility shell wrappers, demo, license/readme/changelog, and the
user-facing architecture, configuration, compatibility, host-conformance, and
security documents. Test suites, findings ledgers, internal release reports,
workflows, conformance harnesses, caches, logs, and model artifacts are rejected
by the package gate.

Run the provenance gate only from a clean candidate commit:

```console
pnpm verify:artifact --output-dir /absolute/empty/output-directory \
  > alpha4-provenance.json
```

The JSON records the commit, dirty state, package identity, SHA-256, npm shasum
and integrity, packed/unpacked sizes, complete file inventory, modes, and direct
production dependency tree. It fails on a dirty worktree by default and rejects
recognizable machine home paths and repository-only payloads. `--allow-dirty`
exists only for rehearsal and leaves `dirty: true` in the evidence.

`artifacts/alpha4.cdx.json` is a reproducible CycloneDX 1.6 SBOM generated from
an isolated npm installation of the candidate tarball. It contains 272
components and has SHA-256
`17c056ec308f68598568a89586ef935b5db2a5898e23126bc88385a6a7ff7317`.
The final tarball checksum is recorded only after user-facing payload files are
frozen, avoiding a self-referential checksum inside the artifact.

`artifacts/beta1.cdx.json` repeats the isolated installed-tarball process for
0.1.0-beta.1. It contains 272 components and has SHA-256
`e058827a3b778b9cc97fc2ec9ca09d6c164c5831cc0ef889bdb3dd6d85cbec97`.
The beta tarball contains 25 files, is 48,734 bytes packed, and has SHA-256
`e00c545209d6ee2e38f6ea3cb3c7d7c6057a6bcb4ac553d37c8eb744ff24ac63`.

`artifacts/beta2.cdx.json` records the patched beta.2 installed dependency
graph. It contains 272 components and has SHA-256
`30fdfd5895e31326836bacadd8b72b8fa92729b581cade59d497e240dc87c5ea`.
The beta.2 tarball contains 25 files, is 48,796 bytes packed and 179,055 bytes
unpacked, and has SHA-256
`e6805136e10922f1256a3ec5e16b4e76e954a1d5ee93abcff8aa6c7b524d93be`.
The npm registry's Linux-packed archive has SHA-256
`5abc37b3e2547257a4e921a22ca4654afac1b709a7ad62adbc1220065345ed1c`
and npm shasum `7db978f80f165fa06cd49481a689478e7cb59362`. A recursive
comparison confirms that all 25 extracted files are byte-identical to the
reviewed macOS rehearsal; the archive-level checksum difference comes from tar
metadata. The registry records SLSA provenance for the published beta.2.

The protected prerelease publish workflow is manual, accepts an explicit ref,
targets the `npm-publish` environment, requires an alpha or beta version,
publishes with npm trusted publishing/provenance, and derives the matching
prerelease dist-tag from the package version. It has no stable publish path and
does not modify `latest`. The workflow remains at the npm trusted publisher's
registered `publish-alpha.yml` path so both prerelease channels share the same
reviewed publisher identity.

Repository secret scanning and push protection are enabled. CI and drift
workflows have read-only repository permission, actions are pinned to exact
revisions, CodeQL covers JavaScript/TypeScript and Python, and production
dependencies are audited at high severity. GitHub's dependency-review action
was validated but cannot run while the repository dependency graph is disabled;
the workflow is intentionally not left permanently red. Enabling that repository
setting is a separate owner decision. These controls do not replace review of
native QVAC dependencies or upstream release provenance.
