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
import sys
import os
import traceback

import torch
import fitz  # PyMuPDF
from PIL import Image
from io import BytesIO


# Globals — set on init
model = None
processor = None
device = None
dtype = None
MODEL_ID = "tsystems/colqwen2.5-3b-multilingual-v1.0-merged"


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


def log(msg):
    """Log to stderr (stdout is reserved for JSON-RPC)."""
    print(f"[vision-server] {msg}", file=sys.stderr, flush=True)


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

    with torch.no_grad():
        embeddings = model(**batch)  # shape: (batch, num_patches, dim)

    results = []
    num_vectors = []
    for i in range(embeddings.shape[0]):
        page_emb = embeddings[i].cpu().float()
        # Replace NaN with 0.0 to avoid JSON serialization errors
        if torch.isnan(page_emb).any():
            sys.stderr.write(f"[vision-server] WARNING: NaN detected in embedding for image {i} ({paths[i]}), replacing with zeros\n")
            page_emb = torch.nan_to_num(page_emb, nan=0.0)
        vecs = page_emb.numpy().tolist()
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
        result = embed_images(params["paths"])
        return {"id": req_id, "result": result}
    elif method == "embed_query":
        result = embed_queries([params["text"]])
        return {"id": req_id, "result": {"embedding": result["embeddings"][0]}}
    elif method == "embed_queries":
        result = embed_queries(params["texts"])
        return {"id": req_id, "result": result}
    elif method == "extract_pages":
        result = extract_pages(params["pdf_path"], params["output_dir"])
        return {"id": req_id, "result": result}
    elif method == "shutdown":
        return {"id": req_id, "result": {"status": "shutting_down"}}
    else:
        return {"id": req_id, "error": f"Unknown method: {method}"}


def main():
    log("Initializing vision server...")
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
                sys.stdout.write(json.dumps(response) + "\n")
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

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
