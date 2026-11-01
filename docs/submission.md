# Community submission

Publication repository: [Abenovv/quiz-maker-obsidian-edition](https://github.com/Abenovv/quiz-maker-obsidian-edition). A GitHub release is separate from acceptance into the Obsidian Community directory. This document is a preflight guide, not an approval or certification.

## Identity and source

Use `Quiz maker` as the display name and `quiz-maker` as the permanent plugin ID. No exact name or ID match appeared among 9,649 entries in the [official published registry](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json) checked on 30 October 2026. That check does not reserve either identifier; the directory validates the submission. Obsidian restricts changing published identifiers, so confirm the choice before submitting. [Manifest reference](https://docs.obsidian.md/Reference/Manifest), [directory FAQ](https://docs.obsidian.md/community-directory/faq).

This project must contain its own implementation. Renaming or moving a fork does not remove Obsidian's fork requirements: the directory requires publicly verifiable author approval, or its documented inactivity/contact process. The independent-project path must not inherit another plugin's code without explicit permission. Keep inspiration credit distinct from code authorship and retain any license notices required by code actually included. [Developer policies](https://docs.obsidian.md/community-directory/developer-policies).

## Before submitting

| Check | Required result |
| --- | --- |
| Repository | Public source, root `README.md`, standard `LICENSE`, and committed `manifest.json`. |
| Manifest | Unique ID; tested minimum Obsidian version; desktop/mobile declaration matching the runtime; short action-led description, at most 250 characters, ending in a period; author URL pointing to the maintainer's public profile. |
| Release | Published tag exactly matching the manifest version; attach only `main.js`, `manifest.json`, and `styles.css`. |
| Build | Committed dependency lockfile; the production command is `build`, which the directory scanner checks first. |
| README | Explain operation, installation, provider accounts and charges, network destinations, note-content transmission, local data, and any external-file access. |
| Runtime | No telemetry, ads, self-updater, hidden code purpose, or unexpected network access. |
| Interface | Sentence case, scoped CSS and native variables, no default command hotkeys, no redundant plugin-name prefixes in command IDs or names. |
| Mobile | No Node.js or Electron imports in the mobile runtime; test layout, controls, storage, and networking on supported devices. |

The source and release checks above come from the [submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin), [submission requirements](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins), [plugin guidelines](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Releasing/Plugin%20guidelines.md), and [mobile guide](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development).

Run the project's type checks, tests, production build, and release checks. Use the [official Obsidian ESLint plugin](https://github.com/obsidianmd/eslint-plugin). Keep development helpers in the scanner's conventional `scripts/`, `tests/`, and `docs/` paths. [Directory FAQ](https://docs.obsidian.md/community-directory/faq).

## Submit through the directory

1. Sign in at [community.obsidian.md](https://community.obsidian.md) and connect the GitHub account that owns the repository.
2. Open **Plugins → New plugin**.
3. Enter `https://github.com/Abenovv/quiz-maker-obsidian-edition` and select the person or organization responsible for maintenance.
4. The maintainer must personally review the developer policies and accept the ongoing support commitment shown on the form.
5. Submit, resolve any automated review errors, and publish the listing when the directory permits it.

These are the current [account and submission steps](https://docs.obsidian.md/community-directory/set-up-and-claim). The old registry pull-request process is not the current submission route.

When setting the listing's payment category, use **Optional payment** while hosted providers can require paid API access. A local or free alternative does not make such a listing **Free** under the directory's classification. Explain that Quiz maker itself has no purchase requirement and that third-party services control their charges. [Directory FAQ](https://docs.obsidian.md/community-directory/faq).

Use **Review branch** to scan a branch, tag, or commit before releasing. Listed plugins receive updates through new releases; **Check for new releases** requests another check if detection is delayed. [Directory FAQ](https://docs.obsidian.md/community-directory/faq).

## License and release evidence

Use an unmodified, GitHub-recognizable MIT license for the project's own code and include applicable dependency notices. A valid software license is not a promise of directory acceptance. Do not add invented security, compliance, or Obsidian approval certificates.

From 1.2.3, releases attach only the three installable files. Their SHA-256 hashes appear in the release body's **Verify release files** disclosure. GitHub's automatic source archives are development snapshots. Earlier published releases keep their original attachments.

The build still creates `SHA256SUMS` locally and uses all three hashes as attestation subjects. [`actions/attest`](https://github.com/actions/attest/tree/v4) signs the provenance and registers it through GitHub's attestations API. The release body links to that record; an additional attestation attachment is not needed. The workflow verifies the published attachment names after upload.

Checksums establish whether a downloaded file matches the published bytes. Users can verify the recorded repository and build provenance for each file:

```sh
gh attestation verify main.js --repo Abenovv/quiz-maker-obsidian-edition
gh attestation verify manifest.json --repo Abenovv/quiz-maker-obsidian-edition
gh attestation verify styles.css --repo Abenovv/quiz-maker-obsidian-edition
```

An attestation identifies the build origin; it is not an audit or an Obsidian endorsement. Offer that verification command only for releases where an attestation was actually generated. [GitHub verification guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Dependency audit status

The verified 2.0.0 baseline reports zero vulnerabilities in both the full dependency audit and `npm audit --omit=dev`. The development lint runner uses pinned minimatch 11.0.1 with a tested compatibility adapter for older lint rules. Run `npm run lint`; direct ESLint invocations bypass that adapter. Dependency changes require fresh audit, lint and compatibility checks.

Moment remains pinned to 2.31.0. Dependabot proposes updates through review; the plugin does not update its own dependencies at runtime. A clean audit is a result for a particular dependency set, not a permanent security guarantee.
