# Retrieval Scheduler (Option C)

This replaces the old `saas-mirror` launchd job (`com.saas-mirror.sync`) with a retrieval-skill-native scheduler.

## Install

```bash
bash scheduling/setup.sh install
```

## Uninstall

```bash
bash scheduling/setup.sh uninstall
```

## What it runs

`scheduling/sync-and-index.sh`:
1. Loads `.env.local` / `.env`
2. Runs `node src/cli.mjs mirror sync`
3. Indexes each available adapter directory (`slack`, `notion`, `linear`, `gog`)

Default interval is 30 minutes via launchd.
