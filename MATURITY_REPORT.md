# Maturity Report

Public-readiness assessment for `retrieval-skill`.

## What was done

### Documentation
- **README.md** — Comprehensive README with: project description, architecture diagram, installation, quick start, full CLI reference with option tables, supported index sources, configuration, adapter development guide, search scoring formulas, development setup. Modeled on [agentctl](https://github.com/orgloop/agentctl) structure.
- **AGENTS.md** — Developer docs: directory structure, data flow, SQLite schema, adapter interface, build/test instructions, design decisions, code conventions.
- **LICENSE** — MIT license added.

### Code cleanup
- Removed unused `@huggingface/transformers` dependency (no imports found in src/).
- Updated `.gitignore` with `.env`, `.DS_Store`, `*.log` patterns.

### Package.json
- Added: `license`, `repository`, `homepage`, `bugs`, `keywords` (12 terms), `engines` (node >=18), `files` (src/, README.md, LICENSE).
- Removed unused dependency.

### CI
- Created `.github/workflows/ci.yml` — GitHub Actions running tests on Node.js 18, 20, 22 matrix on push/PR to main.

### Security audit
- **Result: CLEAN.** No hardcoded tokens, API keys, or personal paths found.
- Environment variables used correctly with safe defaults (`EMBEDDING_SERVER_URL`, `VISION_BACKEND`).
- Test fixtures use fictional data only.
- `.gitignore` properly excludes databases, venvs, models, node_modules.

### GitHub Issues filed
- [#3](https://github.com/c-h-/retrieval-skill/issues/3) — Add ANN indexing for vector search
- [#4](https://github.com/c-h-/retrieval-skill/issues/4) — Set up linting and formatting
- [#5](https://github.com/c-h-/retrieval-skill/issues/5) — Add OCR fallback for image-only PDFs
- [#6](https://github.com/c-h-/retrieval-skill/issues/6) — Add metadata filtering to search
- [#7](https://github.com/c-h-/retrieval-skill/issues/7) — Improve vision E2E test robustness
- [#8](https://github.com/c-h-/retrieval-skill/issues/8) — Add TypeScript type definitions

### Tests
- 63 unit tests pass across 6 test files (adapter, chunker, maxsim, recency, schema-vision, utils).
- Vision E2E tests skip when Python deps unavailable (expected).

## Gaps remaining

### High priority
1. **No linting/formatting** (#4) — No ESLint, Biome, or Prettier configured. Code style is consistent but unenforced.
2. **Vision E2E test fragility** (#7) — Tests hang when Python deps are missing instead of failing fast. The VisionBridge subprocess needs a startup timeout.
3. **No `npm run build`** — Pure ES modules with no build step. This is intentional but means no type checking, no minification, no tree-shaking.

### Medium priority
4. **Brute-force vector search** (#3) — Works fine under 100K chunks but won't scale for large archives.
5. **No TypeScript types** (#8) — Consumers using TypeScript get no type safety.
6. **No CONTRIBUTING.md** — Contribution workflow not documented beyond AGENTS.md.

### Low priority
7. **No `.env.example`** — Environment variables documented in README but no example file.
8. **No changelog** — Version 1.0.0 with no CHANGELOG.md.

## Risks before public release

| Risk | Severity | Mitigation |
|------|----------|------------|
| Embedding server dependency not bundled | Medium | Document clearly in README (done). Consider bundling a lightweight model. |
| Python subprocess for vision is fragile | Medium | File issue #7. Add startup timeout and better error messages. |
| No npm publish dry-run tested | Low | Run `npm pack --dry-run` before first publish. |
| SQLite native module (`better-sqlite3`) | Low | May need `node-gyp` build tools on some systems. Document in README. |
| Vision deps (PyTorch/MLX) are large | Low | Vision is optional. Text pipeline works standalone. |

## Recommended next steps

1. **Merge this PR** — All documentation, cleanup, and CI are ready.
2. **Fix linting** (#4) — Add Biome or ESLint before more contributors join.
3. **Fix vision test timeout** (#7) — Quick win, prevents CI hangs.
4. **Dry-run npm publish** — `npm pack --dry-run` to verify `files` field.
5. **Tag v1.0.0 release** — Create GitHub release with changelog.
6. **Consider scoped package name** — `@c-h-/retrieval-skill` or similar for npm namespace.
