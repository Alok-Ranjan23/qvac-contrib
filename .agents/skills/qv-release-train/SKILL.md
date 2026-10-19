---
name: qv-release-train
description: Release the packages of a release train (inference, sdk, cli, ai-sdk-provider, the two plugins) together from one branch and one publish run. Use when releasing the SDK chain, writing a version plan, or invoking /qv-release-train.
---

# Release train

Follow `docs/ci/RELEASE-TRAIN.md`. It holds the procedure, the configuration
and the checks CI runs. This skill adds what an agent does differently.

## When to use

- The user asks to release the SDK chain or the train, or invokes
  `/qv-release-train`.

A hotfix of one train package, and any package outside every train
(`registry-server`, `rag`, `logging`, `error`, `test-suite`), stays on the
per-package flow in `docs/gitflow.md`.

## Agent rules

- Run `/qv-agent-stack-sync --plan` first and show the user its table. Every
  train package moves; ask the user for the bump of each when the plan and the
  work do not make it clear.
- Before the version pass, set every range between train packages to the
  current workspace version, then run `pnpm install --lockfile-only`.
- Regenerate each train package's NOTICE (`qv-sdk-changelog` Step 6) before the
  version pass. The generator runs `npm install` in the package directory, and
  after the version pass that install asks npm for train versions it does not
  have yet. The generator also replaces the package's `node_modules`, so run
  `pnpm install --frozen-lockfile` afterwards.
- Every version plan needs a message line after the frontmatter; nx rejects a
  plan without one.
- Show the user the `nx release version --dry-run` output before applying it.
- Do not run Step 2 of `/qv-sdk-inference-version`: the version pass writes the
  `@qvac/inference` range. Regenerate `packages/sdk-python` and
  `packages/sdk-kotlin` (Steps 3 and 3b) per `qv-sdk-changelog` Step 7.
- Open both PRs with `qv-sdk-pr-create`: one release PR, one backmerge, for the
  whole train.
- Do not merge the release PR until its `Release Train (nx)` run, the dry run
  of `release-train.yml`, has passed.
- Never approve the `npm` or `pypi` deployment; tell the user when each waits.
- Merge the backmerge only after the push run has published to npm.
- On a failed run, report it. Do not publish a package by hand and do not move
  or delete a tag.
