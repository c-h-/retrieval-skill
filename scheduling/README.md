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
2. Runs `node src/cli.mjs mirror sync` (SaaS connectors)
3. Indexes each available adapter directory (`slack`, `notion`, `linear`, `gog`)
4. Pulls and indexes any git repos configured via `RETRIEVE_GIT_REPOS`

Default interval is 30 minutes via launchd.

## Git Repo Indexing

To index local git repositories alongside SaaS data, set `RETRIEVE_GIT_REPOS` in `.env.local`:

```bash
# Semicolon-separated name:path pairs
RETRIEVE_GIT_REPOS="myrepo:/path/to/repo;docs:/path/to/docs-repo"
```

Each repo is `git pull --ff-only`'d and then indexed under the given name. The indexer is incremental — only changed files are re-embedded on subsequent runs.
