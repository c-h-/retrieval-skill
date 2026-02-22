#!/usr/bin/env python3
"""
ColQwen2.5 Vision Embedding Server — JSON-RPC over stdin/stdout.

Loads the merged ColQwen2.5-3b-multilingual model and serves
embedding requests from the Node.js bridge.

Protocol: One JSON object per line on stdin, one JSON response per line on stdout.
Requests:
  {"id": 1, "method": "embed_images", "params": {"paths": ["/path/to/img.png", ...]}}
  {"id": 2, "method": "embed_query", "params": {"text": "search query"}}
  {"id": 3, "method": "embed_queries", "params": {"texts": ["q1", "q2"]}}
  {"id": 4, "method": "extract_pages", "params": {"pdf_path": "/path/to/file.pdf", "output_dir": "/tmp/pages"}}
  {"id": 5, "method": "health"}
  {"id": 6, "method": "shutdown"}

Responses:
  {"id": 1, "result": {"embeddings": [[[0.1, 0.2, ...], ...], ...], "num_vectors": [700, 680]}}
  {"id": 2, "result": {"embedding": [[0.1, 0.2, ...], ...]}}
  {"id": 5, "result": {"status": "ok", "model": "...", "device": "mps", "dtype": "float32"}}
"""

import json
import math
import sys
import os
import traceback

import torch
import fitz  # PyMuPDF
from PIL import Image
from io import BytesIO
from prometheus_client import Counter, Histogram, Gauge, start_http_server


# Globals — set on init
model = None
processor = None
device = None
dtype = None
MODEL_ID = "tsystems/colqwen2.5-3b-multilingual-v1.0-merged"

# --- Prometheus metrics ---
EMBED_REQUESTS = Counter(
    "vision_embed_requests_total",
    "Total embedding requests",
    ["method"],
)
EMBED_DURATION = Histogram(
    "vision_embed_duration_seconds",
    "Embedding request duration in seconds",
    ["method"],
)
PAGES_PROCESSED = Counter(
    "vision_pages_processed_total",
    "Total pages processed for embedding",
)
MODEL_MEMORY = Gauge(
    "vision_model_memory_bytes",
    "Estimated model memory usage in bytes",
)


def start_metrics_server():
    """Start a Prometheus metrics HTTP server on a background thread."""
    port = int(os.environ.get("VISION_METRICS_PORT", "8300"))
    start_http_server(port)
    log(f"Prometheus metrics server listening on :{port}")


def _estimate_model_memory():
    """Estimate model parameter memory in bytes."""
    if model is None:
        return 0
    total = 0
    for p in model.parameters():
        total += p.nelement() * p.element_size()
    for b in model.buffers():
        total += b.nelement() * b.element_size()
    return total


def init_model():
    """Load model onto MPS with float32 or float16 (NOT bfloat16)."""
    global model, processor, device, dtype

    # Determine device and dtype
    if torch.backends.mps.is_available():
        device = "mps"
        # MPS does not support bfloat16 — use float32 for max quality
        dtype = torch.float32
    elif torch.cuda.is_available():
        device = "cuda:0"
        dtype = torch.bfloat16
    else:
        device = "cpu"
        dtype = torch.float32

    log(f"Loading {MODEL_ID} on {device} with {dtype}...")

    from colpali_engine.models import ColQwen2_5, ColQwen2_5_Processor

    model = ColQwen2_5.from_pretrained(
        MODEL_ID,
        dtype=dtype,
        device_map=device,
    ).eval()

    processor = ColQwen2_5_Processor.from_pretrained(MODEL_ID)
    log(f"Model loaded. Device={device}, dtype={dtype}")

    MODEL_MEMORY.set(_estimate_model_memory())


def log(msg):
    """Log to stderr (stdout is reserved for JSON-RPC)."""
    print(f"[vision-server] {msg}", file=sys.stderr, flush=True)


def _run_image_embedding(batch):
    """Run the model forward pass on a processed image batch."""
    with torch.no_grad():
        return model(**batch)  # shape: (batch, num_patches, dim)


def embed_images(paths):
    """Embed a list of image file paths. Returns list of multi-vector embeddings."""
    images = []
    for p in paths:
        img = Image.open(p).convert("RGB")
        images.append(img)

    batch = processor.process_images(images).to(model.device)
    # Cast to model dtype
    for k, v in batch.items():
        if isinstance(v, torch.Tensor) and v.is_floating_point():
            batch[k] = v.to(dtype)

    embeddings = _run_image_embedding(batch)

    # Detect NaN — MPS can produce transient NaN on certain inputs
    if torch.isnan(embeddings).any():
        log(f"WARNING: NaN detected in embeddings for {len(paths)} image(s). Retrying...")
        embeddings = _run_image_embedding(batch)

        if torch.isnan(embeddings).any():
            nan_pages = [i for i in range(embeddings.shape[0]) if torch.isnan(embeddings[i]).any()]
            log(f"WARNING: NaN persists after retry for page indices {nan_pages}. Replacing NaN with 0.0 (degraded).")
            embeddings = torch.nan_to_num(embeddings, nan=0.0)

    results = []
    num_vectors = []
    for i in range(embeddings.shape[0]):
        vecs = embeddings[i].cpu().float().numpy().tolist()
        results.append(vecs)
        num_vectors.append(len(vecs))

    return {"embeddings": results, "num_vectors": num_vectors}


def embed_queries(texts):
    """Embed query texts. Returns list of multi-vector embeddings."""
    batch = processor.process_queries(texts).to(model.device)
    for k, v in batch.items():
        if isinstance(v, torch.Tensor) and v.is_floating_point():
            batch[k] = v.to(dtype)

    with torch.no_grad():
        embeddings = model(**batch)

    results = []
    for i in range(embeddings.shape[0]):
        vecs = embeddings[i].cpu().float().numpy().tolist()
        results.append(vecs)

    return {"embeddings": results}


def extract_pages(pdf_path, output_dir):
    """Extract page images from a PDF using PyMuPDF.
    Returns list of output image paths and page count."""
    os.makedirs(output_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    paths = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        # Render at 2x for quality (144 DPI)
        pix = page.get_pixmap(dpi=144)
        img_path = os.path.join(output_dir, f"page_{page_num:04d}.png")
        pix.save(img_path)
        paths.append(img_path)
    doc.close()
    return {"paths": paths, "page_count": len(paths)}


def extract_text(pdf_path):
    """Extract text content from each page of a PDF using PyMuPDF.
    For pages with no embedded text (image-only), attempts OCR via pytesseract if available.
    Returns list of { page_number, text, method } objects."""
    doc = fitz.open(pdf_path)
    pages = []
    has_tesseract = False
    try:
        import pytesseract
        has_tesseract = True
    except ImportError:
        pass

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text().strip()
        method = "pymupdf"

        if not text and has_tesseract:
            # OCR fallback for image-only pages
            try:
                pix = page.get_pixmap(dpi=300)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                text = pytesseract.image_to_string(img).strip()
                method = "tesseract"
            except Exception as e:
                log(f"OCR failed on page {page_num}: {e}")
                method = "ocr_failed"

        pages.append({
            "page_number": page_num,
            "text": text,
            "method": method,
        })

    doc.close()
    return {"pages": pages, "has_tesseract": has_tesseract}


def handle_request(req):
    """Route a JSON-RPC request to the appropriate handler."""
    method = req.get("method")
    params = req.get("params", {})
    req_id = req.get("id")

    if method == "health":
        return {
            "id": req_id,
            "result": {
                "status": "ok",
                "model": MODEL_ID,
                "device": str(device),
                "dtype": str(dtype),
            },
        }
    elif method == "embed_images":
        EMBED_REQUESTS.labels(method="embed_images").inc()
        PAGES_PROCESSED.inc(len(params["paths"]))
        with EMBED_DURATION.labels(method="embed_images").time():
            result = embed_images(params["paths"])
        return {"id": req_id, "result": result}
    elif method == "embed_query":
        EMBED_REQUESTS.labels(method="embed_query").inc()
        with EMBED_DURATION.labels(method="embed_query").time():
            result = embed_queries([params["text"]])
        return {"id": req_id, "result": {"embedding": result["embeddings"][0]}}
    elif method == "embed_queries":
        EMBED_REQUESTS.labels(method="embed_queries").inc()
        with EMBED_DURATION.labels(method="embed_queries").time():
            result = embed_queries(params["texts"])
        return {"id": req_id, "result": result}
    elif method == "extract_pages":
        EMBED_REQUESTS.labels(method="extract_pages").inc()
        with EMBED_DURATION.labels(method="extract_pages").time():
            result = extract_pages(params["pdf_path"], params["output_dir"])
        return {"id": req_id, "result": result}
    elif method == "extract_text":
        result = extract_text(params["pdf_path"])
        return {"id": req_id, "result": result}
    elif method == "shutdown":
        return {"id": req_id, "result": {"status": "shutting_down"}}
    else:
        return {"id": req_id, "error": f"Unknown method: {method}"}


def safe_json_dumps(obj):
    """Serialize to JSON, replacing any NaN/Infinity with null.
    Python's json.dumps emits invalid JSON tokens (NaN, Infinity) by default."""
    try:
        return json.dumps(obj, allow_nan=False)
    except ValueError:
        # Fallback: sanitize floats manually
        log("WARNING: Response contained NaN/Infinity — sanitizing for valid JSON.")
        def sanitize(o):
            if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
                return None
            if isinstance(o, dict):
                return {k: sanitize(v) for k, v in o.items()}
            if isinstance(o, list):
                return [sanitize(v) for v in o]
            return o
        return json.dumps(sanitize(obj))


def main():
    log("Initializing vision server...")
    start_metrics_server()
    init_model()

    # Signal readiness
    ready_msg = json.dumps({"ready": True, "model": MODEL_ID, "device": str(device)})
    sys.stdout.write(ready_msg + "\n")
    sys.stdout.flush()

    log("Ready. Waiting for requests on stdin...")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("method") == "shutdown":
                response = handle_request(req)
                sys.stdout.write(safe_json_dumps(response) + "\n")
                sys.stdout.flush()
                log("Shutdown requested. Exiting.")
                break

            response = handle_request(req)
        except Exception as e:
            log(f"Error handling request: {traceback.format_exc()}")
            response = {
                "id": req.get("id") if isinstance(req, dict) else None,
                "error": str(e),
            }

        sys.stdout.write(safe_json_dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
