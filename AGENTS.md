# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for this repo. See `docs/agents/issue-tracker.md`.

When using `gh`, load the repository `.envrc` first so `GH_TOKEN` is used instead of any token from `~/.config/gh/hosts.yml`. For one-off commands, run:

```sh
set -a; . ./.envrc; set +a; gh ...
```

### Triage labels

Triage uses the default five-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.
