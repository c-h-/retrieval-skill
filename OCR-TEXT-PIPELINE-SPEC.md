# OCR Text Pipeline — GLM-OCR + Full Hybrid Search

**Status:** 🟡 In Progress
**Parent:** `~/personal/retrieval-skill/`
**Created:** 2026-02-16
**Branch:** `feat/ocr-text-pipeline`
**Hardware:** M3 Ultra, 256GB unified memory, macOS

---

## Goal

Add OCR-based text extraction alongside vision indexing for PDF cookbooks, enabling true 3-lane hybrid search (vision MaxSim + text vector + FTS keyword) and text readback for vision results.

## Key Decisions

**OCR Model: GLM-OCR** (`zai-org/GLM-OCR` on HuggingFace)
- 0.9B params, #1 on OmniDocBench v1.5 at 94.62
- Outputs structured Markdown natively (preserves headings, lists, tables)
- Available as MLX 4-bit quantized, Ollama, GGUF, vLLM, transformers
- ~1-2 pages/sec on M3 Ultra

**Runner-up:** LightOnOCR-2 (1B params, lightonai/LightOnOCR-2-1B) — fallback if GLM-OCR has issues.

## Architecture

### Current State
```
PDF → page images → ColQwen2.5 vision embeddings → page_vectors table
                                                          ↓
                                              MaxSim vision search → results (page numbers only)
```

### Target State
```
PDF → page images ──┬──→ ColQwen2.5 vision embeddings → page_vectors table
                    │                                          ↓
                    │                              MaxSim vision search ──┐
                    │                                                     │
                    └──→ GLM-OCR text extraction → page_texts table       │
                                │                                         │
                                ├──→ Octen text vector embeddings ──┐     │
                                │         (chunks table)            │     │
                                │                                   ├─→ RRF fusion → results
                                └──→ FTS5 keyword index ────────────┘     │    (with text!)
                                         (fts table)                      │
                                                                          │
                                              Vision result + page text ←─┘
```

### Key Design Points

1. **page_texts table** — stores extracted text per page, keyed by (document_id, page_number)
   - Links to page_images by page number for joining vision results with text
   - Schema: `page_texts(id, document_id, page_number, text, adapter_name, extracted_at)`

2. **Text chunking + embedding** — extracted page text gets chunked and embedded with Octen-Embedding-8B into the existing chunks/vectors tables, plus FTS5 indexing

3. **Vision-text join** — when a vision search returns page N, look up page_texts for that page to get readable text

4. **3-lane hybrid search** — RRF fusion across:
   - Vision MaxSim (page-level, from page_vectors)
   - Text vector cosine (chunk-level, from chunks/vectors)
   - FTS5 keyword (chunk-level, from FTS)

5. **Simultaneous indexing** — `index-vision` command now does both vision + OCR in one pass:
   - Extract page images (already done)
   - Embed with ColQwen2.5 (already done)
   - OCR each page with GLM-OCR → store text in page_texts
   - Chunk + embed text with Octen → store in chunks/vectors + FTS5

## Implementation Steps

### S1: GLM-OCR Server
- Create `src/ocr/server_glm.py` — GLM-OCR JSON-RPC server (same pattern as vision server)
  - Method: `ocr_pages(paths)` — takes list of page image paths, returns list of extracted text (Markdown)
  - Method: `health`, `shutdown`
  - Load GLM-OCR model (try MLX 4-bit first, fall back to transformers)
  - Prompt: instruct model to output structured Markdown (recipe title, ingredients, instructions, nutrition)
- Create `src/ocr/bridge.mjs` — Node.js bridge (same pattern as vision bridge)
- Create `src/ocr/requirements.txt` and `src/ocr/setup.sh`
- Test: OCR a single cookbook page, verify structured Markdown output

### S2: Schema — page_texts Table
- Add `page_texts` table to schema.mjs:
  ```sql
  CREATE TABLE IF NOT EXISTS page_texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    text TEXT NOT NULL,
    adapter_name TEXT,
    extracted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(document_id, page_number)
  );
  ```
- Migration: additive, bump schema version
- Test: CRUD operations on page_texts

### S3: OCR Indexing Pipeline
- Extend `src/vision-index.mjs` (or create `src/ocr-index.mjs`):
  - After vision embedding, run GLM-OCR on each page image
  - Store extracted text in page_texts
  - Chunk the text using existing recursive chunker
  - Embed chunks with Octen-Embedding-8B into chunks + vectors tables
  - Index chunks in FTS5
  - Incremental: skip pages already in page_texts (by document_id + page_number)
- CLI: `index-vision` now does both vision + OCR (add `--skip-ocr` flag to skip)
- Batch processing: OCR pages in batches (configurable batch size)

### S4: Vision-Text Join
- When search returns vision results (page numbers), join with page_texts to include extracted text
- Update search result format:
  ```json
  {
    "resultType": "vision",
    "page": 71,
    "score": 11.418,
    "documentId": "skinnytaste-one-and-done",
    "text": "## Sheet Pan Chicken...\n\n### Ingredients\n- 2 lbs chicken thighs\n..."
  }
  ```
- For text results, include the chunk text (already done) plus page reference if available

### S5: True 3-Lane Hybrid Search
- Update `--mode hybrid` to include all three lanes when available:
  1. Vision MaxSim → ranked page list
  2. Text vector cosine → ranked chunk list (map chunks back to pages)
  3. FTS5 keyword → ranked chunk list (map chunks back to pages)
- RRF fusion across all three (k=60)
- Deduplicate by page number (prefer highest-scoring lane per page)
- Results include text from page_texts

### S6: CLI + Skill Updates
- Update CLI help text
- Add `--with-text` flag to vision search (default: true) to include/exclude text in results
- Add `ocr` command for standalone OCR: `retrieve ocr <pdf-path> --page <N>` — extract text from a single page
- Update `~/.openclaw/skills/retrieve/SKILL.md` with new capabilities

### S7: Testing
- Unit tests for page_texts schema
- Unit tests for OCR bridge
- Integration test: index a test PDF with both vision + OCR
- Search test: verify 3-lane hybrid returns results with text
- Verify existing text-only and vision-only search still works (no regressions)
- E2E: index Skinnytaste One and Done, search for "chicken sheet pan", verify text in results

## GLM-OCR Prompt Template

For cookbook pages, use a structured prompt:
```
Extract all text from this cookbook page as structured Markdown. Preserve the layout:
- Recipe title as ## heading
- Ingredients as a bullet list
- Instructions as numbered steps
- Nutritional info as a table if present
- Any sidebars or tips as blockquotes
Output ONLY the Markdown text, nothing else.
```

## File Structure (Target)
```
src/
├── ocr/
│   ├── server_glm.py        # GLM-OCR JSON-RPC server
│   ├── bridge.mjs            # Node.js ↔ Python bridge
│   ├── requirements.txt      # Python deps
│   ├── setup.sh              # Install + verify
│   └── venv/                 # Python venv (gitignored)
├── ocr-index.mjs             # OCR text extraction + indexing
├── ... (existing files)
```

## Notes
- GLM-OCR model ID on HuggingFace: `zai-org/GLM-OCR`
- Check for MLX-converted version first (search mlx-community on HuggingFace)
- If MLX not available, use transformers with MPS backend
- The NaN issue in vision embeddings (some pages produce NaN) should NOT affect OCR — different model, different pipeline
- Page numbering must be consistent between page_images and page_texts (both use 0-indexed page numbers from PyMuPDF)

## Success Criteria
- [ ] GLM-OCR extracts readable structured Markdown from cookbook pages
- [ ] Extracted text stored in page_texts, linked by page number
- [ ] Text chunks embedded and FTS-indexed alongside vision embeddings
- [ ] Vision search results include extracted text
- [ ] 3-lane hybrid search works (vision + text vector + FTS keyword)
- [ ] `index-vision` does both vision + OCR in one pass
- [ ] All existing tests still pass (no regressions)
- [ ] E2E test on Skinnytaste One and Done succeeds
