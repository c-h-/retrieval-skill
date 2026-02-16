# Vision Embedding Adapter — ColQwen2.5

**Status:** :white_check_mark: Complete (S1–S7 implemented and tested, MLX backend added)
**Parent:** `~/personal/retrieval-skill/`
**Created:** 2026-02-15
**Completed:** 2026-02-15
**Updated:** 2026-02-16 (MLX backend port)
**Hardware:** M3 Ultra, 256GB unified memory, macOS (MPS + MLX backends)

---

## Goal

Add a **vision embedding pipeline** alongside the existing text pipeline in the retrieval skill. This enables indexing scanned cookbook PDFs as page images and searching them with natural language text queries — no OCR needed.

## Key Decision

**Model: ColQwen2.5-3B** (`tsystems/colqwen2.5-3b-multilingual-v1.0-merged`)
- Ranked #3 on ViDoRe leaderboard, #1 among <7B models
- Multi-vector ColBERT-style (late interaction, MaxSim scoring)
- ~760 vectors per page, 128-dim each (measured from Skinnytaste PDF)
- Runs on MPS (Apple Metal) — uses float32 (NOT bfloat16 which MPS doesn't support)
- Uses the **merged** variant (LoRA weights pre-merged into base) for simpler loading and faster inference
- Model loaded via `colpali_engine.models.ColQwen2_5` + `ColQwen2_5_Processor`

**Why not ColFlor (174M single-vector)?** Only 1.8% quality drop but we have 256GB RAM — prefer maximum quality. Multi-vector late interaction gives fine-grained matching on ingredient lists, recipe steps, etc.

## Design Principles

1. **Modular adapter pattern** — vision plugs in alongside existing text pipeline, no breaking changes
2. **Existing code untouched** — Octen text embedding, FTS5, chunking, RRF all stay as-is
3. **Parallel indexing lanes** — text chunks and page image embeddings live in separate tables, searched independently, fused at query time
4. **Model-agnostic** — adapter interface supports swapping models later
5. **Python bridge** — ColQwen2.5 runs via transformers + torch (or MLX); Node.js communicates via JSON-RPC over stdin/stdout
6. **Backend-agnostic** — supports both PyTorch+MPS and Apple MLX backends via `VISION_BACKEND` env var

## Architecture

### Current Pipeline (unchanged)
```
Markdown → recursive chunking → Octen-Embedding-8B embed → SQLite (chunks + vectors)
                                                                    ↓
                                                        FTS5 + vector search → RRF fusion → results
```

### New Vision Pipeline (additive)
```
PDF → page image extraction (PyMuPDF) → Python VisionBridge (ColQwen2.5) → SQLite (page_images + page_vectors)
                                                                                    ↓
                                                                      multi-vector MaxSim search → results
```

### Combined Query Flow (hybrid mode)
```
User query
    ├── TextEmbeddingAdapter.embed(query) → vector search on text chunks
    ├── FTS5 keyword search on text chunks
    ├── VisionBridge.embedQuery(query) → MaxSim on page images
    └── RRF fusion across all three result sets → final ranked results
```

## Implementation Steps

### S1: EmbeddingAdapter Interface :white_check_mark:
- Defined adapter interface in `src/adapters/adapter.mjs` (init, embedQuery, embedDocuments/embedImages, embeddingDim, modelId, dispose)
- Wrapped existing Octen embedder into `TextEmbeddingAdapter` (`src/adapters/text-adapter.mjs`)
- Added adapter registry with `registerAdapter()`, `getAdapter()`, `getAdaptersByType()`
- Added `validateAdapter()` for interface conformance checks
- **Zero functional changes** — all existing behavior preserved, 19 original tests still pass

### S2: Python Vision Backend :white_check_mark:
- `src/vision/server.py` — ColQwen2.5 JSON-RPC server over stdin/stdout
  - Methods: `embed_images`, `embed_query`, `embed_queries`, `extract_pages`, `health`, `shutdown`
  - Loads merged model on MPS with float32, auto-detects device
  - Page extraction via PyMuPDF at 144 DPI
- `src/vision/bridge.mjs` — Node.js ↔ Python subprocess bridge
  - Waits for ready signal, routes JSON-RPC requests, handles errors
  - Converts between nested arrays and Float32Arrays
- `src/vision/requirements.txt` — torch, transformers, colpali-engine, Pillow, PyMuPDF
- `src/vision/setup.sh` — creates venv, installs deps, verifies imports
- `src/adapters/vision-adapter.mjs` — VisionEmbeddingAdapter wrapping the bridge

### S3: Schema Changes :white_check_mark:
- Added `page_images` table: document_id, page_number, image_hash, adapter_name, num_vectors, source_path, indexed_at
- Added `page_vectors` table: page_image_id, vector_index, embedding (BLOB)
- Cascade deletes from page_images → page_vectors
- `openDb()` now accepts `{ vision: true }` option to create vision tables
- Schema version bumped to 3
- Additive migration: existing text DBs upgraded safely when opened with vision flag
- 5 schema tests covering creation, insertion, cascade, upgrade

### S4: Vision Indexer :white_check_mark:
- `src/vision-index.mjs` — `indexPdfVision(pdfPath, name, opts)` function
- Extracts page images via Python bridge (PyMuPDF, 144 DPI PNG)
- Embeds pages through VisionBridge → stores multi-vectors in page_vectors
- Incremental indexing: skips pages already indexed by image_hash
- CLI: `retrieve index-vision <pdf> [--name <name>] [--batch-size <n>]`
- Batched embedding (configurable batch size, default 2)

### S5: MaxSim Search :white_check_mark:
- `src/search/maxsim.mjs` — ColBERT-style MaxSim scoring
- `score(query, page) = Σ_i max_j cosine(q_i, p_j)` over all query tokens and page patches
- `searchVisionIndex(db, queryVectors, topK)` — brute-force MaxSim over all pages
- 4 unit tests covering similarity, orthogonality, identity, and scaling

### S6: Hybrid Search + RRF Integration :white_check_mark:
- Extended `search.mjs` with `--mode` parameter: `text` (default), `vision`, `hybrid`
- **Text mode**: unchanged original behavior (60% vector + 40% FTS hybrid scoring)
- **Vision mode**: MaxSim scoring only on page_vectors
- **Hybrid mode**: Three-lane RRF fusion:
  1. Text vector ranked list (by cosine score)
  2. Text FTS ranked list (by FTS5 rank)
  3. Vision MaxSim ranked list (by MaxSim score)
  - RRF formula: `score(d) = Σ_r 1/(k + rank_r(d))` with k=60
- Results include `resultType` ('text' | 'vision') for disambiguation

### S7: End-to-End Testing :white_check_mark:
- **Full Skinnytaste PDF (276 pages) indexed successfully:**
  - 276 pages extracted and embedded
  - 209,877 total vectors stored (~760 vectors/page avg)
  - 0 errors
  - Indexing time: ~349s (~1.3 pages/sec on MPS with float32)
- **Search results verified with 3 queries:**
  - "vegetarian pasta under 30 minutes" → relevant pages returned
  - "high protein meal prep" → relevant pages returned
  - "quick breakfast ideas" → pages 24, 23, 25 (scores: 11.68, 11.28, 11.18)
- **Incremental indexing confirmed:** second run skipped all 276 pages (0 re-embedded)
- **Existing text pipeline verified:** all 19 original tests pass unchanged
- **4 E2E tests pass, 36 total unit tests pass**

### S8: MLX Backend Port :white_check_mark:

Ported the vision embedding backend from PyTorch+MPS to Apple MLX for comparison.

**Approach:**
- Used `mlx-embeddings` v0.0.6 (from git main) which has native `colqwen2_5.py` model support
- Used `qnguyen3/colqwen2.5-v0.2-mlx` pre-converted F16 weights (based on `vidore/colqwen2.5-v0.2`)
- Replicated `colpali_engine`'s image/query processing in pure MLX:
  - Image: `Qwen2VLImageProcessor` with `max_pixels=602112` + visual prompt prefix
  - Query: text + 10x `<|endoftext|>` augmentation tokens
- Same JSON-RPC protocol, same bridge interface — only the Python backend differs

**Key findings:**
- MLX weights are from `vidore/colqwen2.5-v0.2` (not `tsystems` merged variant) — same architecture (Qwen2.5-VL-3B + ColBERT projection), near-identical ViDoRe scores
- `mlx-embeddings` colqwen2_5 model doesn't compute Qwen2.5-VL position IDs in its `__call__`; server_mlx.py manually calls `get_rope_index()` and passes `position_ids` through the language model
- The `colvision_processor.py` (abstract base class) is on git main but has no concrete ColQwen2.5 processor — we implement the processing directly

**MLX vs PyTorch Benchmark (M3 Ultra, 256GB, 1200x1600 synthetic page):**

| Metric | PyTorch+MPS (float32) | MLX (float16) | Comparison |
|---|---|---|---|
| Model load (cached) | 5.2s | 1.0s | **MLX 5.2x faster** |
| Query embedding (18 vecs) | 51ms | 30ms | **MLX 1.7x faster** |
| Image embedding (779 vecs) | 1043ms | 3056ms | **Torch 2.9x faster** |
| Batch 3 queries | 2026ms | 85ms | **MLX 23.7x faster** |
| Peak memory | 6.5 GB | 7.6 GB | Torch 14% less |

**Verdict:** MLX is viable as an alternative backend. It excels at query embedding (1.7x faster single, 24x faster batch) and model loading (5x faster). However, **image embedding is ~3x slower** than PyTorch+MPS, making it worse for bulk indexing. The MLX image embedding bottleneck is likely in the `mlx-vlm` vision tower implementation, which may improve as the library matures.

**Recommendation:** Use MLX backend for search-heavy workloads (many queries, few new pages). Use PyTorch backend for indexing-heavy workloads (many new pages).

**Files added:**
- `src/vision/server_mlx.py` — MLX JSON-RPC server (drop-in replacement for server.py)
- `src/vision/requirements-mlx.txt` — MLX Python deps
- `src/vision/setup-mlx.sh` — MLX venv setup script
- `src/vision/benchmark.py` — Benchmark script for both backends
- `src/vision/venv-mlx/` — MLX Python virtual environment (gitignored)

**Files modified:**
- `src/vision/bridge.mjs` — Backend selection via `{ backend: 'mlx' }` or `VISION_BACKEND=mlx`
- `src/adapters/vision-adapter.mjs` — Passes backend config through, reports correct model ID

**Usage:**
```bash
# Setup MLX backend
./src/vision/setup-mlx.sh

# Use MLX for queries/search
VISION_BACKEND=mlx retrieve search-vision "vegetarian pasta" --index skinnytaste

# Use PyTorch for indexing (faster for bulk pages)
retrieve index-vision ~/Downloads/cookbook.pdf
```

## File Structure (Implemented)
```
src/
├── adapters/
│   ├── adapter.mjs          # EmbeddingAdapter interface + registry
│   ├── text-adapter.mjs     # Wraps existing Octen embedder
│   └── vision-adapter.mjs   # ColQwen2.5 via Python bridge (backend-selectable)
├── vision/
│   ├── server.py             # PyTorch+MPS JSON-RPC server
│   ├── server_mlx.py         # Apple MLX JSON-RPC server (S8)
│   ├── bridge.mjs            # Node.js ↔ Python bridge (backend-selectable)
│   ├── benchmark.py          # Benchmark script for both backends (S8)
│   ├── requirements.txt      # PyTorch Python deps
│   ├── requirements-mlx.txt  # MLX Python deps (S8)
│   ├── setup.sh              # PyTorch venv setup
│   ├── setup-mlx.sh          # MLX venv setup (S8)
│   ├── venv/                 # PyTorch venv (gitignored)
│   └── venv-mlx/             # MLX venv (gitignored)
├── search/
│   └── maxsim.mjs            # MaxSim scoring for multi-vector
├── vision-index.mjs          # PDF vision indexing
├── cli.mjs                   # CLI (updated with index-vision, --mode)
├── search.mjs                # Search (updated with vision + hybrid modes)
├── schema.mjs                # Schema (updated with vision tables, v3)
├── ... (existing files unchanged)
__tests__/
├── adapter.test.mjs          # Adapter interface + registry tests
├── maxsim.test.mjs           # MaxSim scoring tests
├── schema-vision.test.mjs    # Vision schema tests
├── vision-e2e.test.mjs       # Full E2E test on Skinnytaste PDF
├── ... (existing tests unchanged)
```

## Test PDF
`~/Downloads/Skinnytaste meal prep gina homolka.pdf` — 276 pages, ~72MB. Used for E2E validation.

## Model Weights

### PyTorch backend (default)
- **Model:** `tsystems/colqwen2.5-3b-multilingual-v1.0-merged` (merged variant, ~7GB)
- **Location:** `~/.cache/huggingface/hub/models--tsystems--colqwen2.5-3b-multilingual-v1.0-merged/`
- **Dtype:** float32 (MPS does not support bfloat16)

### MLX backend
- **Model:** `qnguyen3/colqwen2.5-v0.2-mlx` (converted from `vidore/colqwen2.5-v0.2`, F16)
- **Location:** `~/.cache/huggingface/hub/models--qnguyen3--colqwen2.5-v0.2-mlx/`
- **Dtype:** float16 (MLX native)
- **Note:** Different training run (vidore v0.2 vs tsystems multilingual) but same architecture and near-identical ViDoRe benchmark scores (0.597 vs 0.599 nDCG@5)

### Shared notes
- The existing `vidore/colqwen2-base` and `vidore/colqwen2-v1.0` weights are NOT used. ColQwen2.5 is a different model that uses Qwen2.5-VL-3B as its backbone (vs Qwen2-VL for the old ColQwen2).

## Performance Benchmarks

### Indexing (Skinnytaste PDF, 276 pages)

| Metric | Value |
|--------|-------|
| PDF pages indexed | 276 |
| Total vectors stored | 209,877 |
| Avg vectors per page | ~760 |
| Vector dimension | 128 |
| Indexing time (full, torch) | ~349s (~1.3 pages/sec) |
| Model load time | ~2s (cached) |
| Search latency (3 queries) | ~12.7s total (~4.2s/query) |
| Incremental re-index | <1s (all skipped) |

### Backend Comparison (M3 Ultra, 256GB, 1200x1600 synthetic page)

| Metric | PyTorch+MPS (float32) | MLX (float16) |
|---|---|---|
| Model load (cached) | 5.2s | 1.0s |
| Query embedding (18 vecs) | 51ms | 30ms |
| Image embedding (779 vecs) | 1043ms | 3056ms |
| Batch 3 queries | 2026ms | 85ms |
| Peak memory | 6.5 GB | 7.6 GB |

**Key takeaway:** MLX is 1.7-24x faster for queries but 3x slower for image embedding. Use MLX for search, PyTorch for indexing.

## Success Criteria

- [x] Existing text-only search works identically (no regressions)
- [x] Can index a cookbook PDF with vision embeddings
- [x] Can search with text query and get relevant page results
- [ ] Hybrid mode returns better results than either alone (needs text+vision on same corpus to compare)
- [x] Query latency < 5 seconds for vision search (~4.2s/query)
- [x] Modular: can swap vision model by changing adapter config
- [x] All tests pass (36 unit + 4 E2E)
- [x] E2E test on Skinnytaste PDF succeeds

## Notes

- The `dtype` parameter in `from_pretrained()` replaced the deprecated `torch_dtype` in newer transformers versions
- The merged model variant is simpler to load (no separate LoRA adapter) and slightly faster at inference
- Query latency is dominated by model forward pass; could be improved with query vector caching
- The hybrid success criterion requires running both text and vision on the same corpus (e.g., if there were markdown transcripts alongside the PDF)

### MLX-specific notes
- `mlx-embeddings` v0.0.5 (PyPI) / v0.0.6 (git main) has the ColQwen2.5 model but no concrete processor class — the server implements processing directly
- The `colqwen2_5.py` model's `__call__` method doesn't compute `position_ids` correctly — server_mlx.py calls `get_rope_index()` manually and passes `position_ids` through the inner language model
- `transformers` v5.x has a bug in `AutoProcessor.from_pretrained()` for Qwen2.5-VL (TypeError in video_processor detection) — worked around by loading `Qwen2VLImageProcessor` directly
- The MLX image embedding slowdown is likely in `mlx-vlm`'s Qwen2.5-VL vision tower; this may improve with future `mlx-vlm` releases
- MLX weights are float16 vs PyTorch float32; this contributes to the slightly higher memory usage despite smaller weight precision (numpy/mlx conversion overhead)

## References
- Deep research report: Obsidian `OpenClaw/cooking/research/vision-embedding-sota-feb2026.md`
- Original vision adapter spec: Obsidian `OpenClaw/cooking/research/retrieval-vision-adapter-spec.md`
- OCR vs image embedding research: Obsidian `OpenClaw/cooking/research/ocr-vs-image-embedding-cookbook-retrieval.md`
- Qdrant ColPali tutorial: https://qdrant.tech/documentation/advanced-tutorials/pdf-retrieval-at-scale/
- ColQwen2 HF docs: https://huggingface.co/docs/transformers/en/model_doc/colqwen2
- ColQwen2.5 model card: https://huggingface.co/tsystems/colqwen2.5-3b-multilingual-v1.0-merged
- MPS bfloat16 workaround: use float32 or float16
- mlx-embeddings: https://github.com/Blaizzy/mlx-embeddings
- MLX ColQwen2.5 weights: https://huggingface.co/qnguyen3/colqwen2.5-v0.2-mlx
- mlx-vlm (Qwen2.5-VL backbone): https://github.com/Blaizzy/mlx-vlm
