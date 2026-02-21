#!/usr/bin/env python3
"""
ColQwen2.5 Vision Embedding Server (MLX backend) — JSON-RPC over stdin/stdout.

Drop-in replacement for server.py that uses Apple MLX instead of PyTorch+MPS.
Same JSON-RPC protocol, same request/response format.

Uses:
  - mlx-embeddings for the ColQwen2.5 model
  - mlx-vlm's Qwen2.5-VL backbone
  - transformers' Qwen2VLImageProcessor for image preprocessing
"""

import json
import os
import sys
import time
import traceback

import mlx.core as mx
import numpy as np
import fitz  # PyMuPDF
from PIL import Image
from transformers import Qwen2VLImageProcessor, AutoTokenizer

# Globals — set on init
model = None
image_processor = None
tokenizer = None
MODEL_ID = "qnguyen3/colqwen2.5-v0.2-mlx"
BACKEND = "mlx"

# Match colpali_engine's ColQwen2_5_Processor settings exactly
VISUAL_PROMPT_PREFIX = (
    "<|im_start|>user\n<|vision_start|><|image_pad|><|vision_end|>"
    "Describe the image.<|im_end|><|endoftext|>"
)
QUERY_AUGMENTATION_TOKEN = "<|endoftext|>"
QUERY_AUGMENTATION_COUNT = 10
# colpali_engine uses max_pixels=602112 to constrain image resolution
COLPALI_MAX_PIXELS = 602112
COLPALI_MIN_PIXELS = 3136


def init_model():
    """Load ColQwen2.5 on MLX (Apple Metal GPU)."""
    global model, image_processor, tokenizer

    log(f"Loading {MODEL_ID} on MLX...")

    from mlx_embeddings.utils import load

    model, tokenizer = load(MODEL_ID)

    # Load the Qwen2.5-VL image processor with colpali's resolution constraints
    image_processor = Qwen2VLImageProcessor.from_pretrained(
        "Qwen/Qwen2.5-VL-3B-Instruct",
        max_pixels=COLPALI_MAX_PIXELS,
        min_pixels=COLPALI_MIN_PIXELS,
    )

    log(f"Model loaded. Backend={BACKEND}, device=gpu")


def log(msg):
    """Log to stderr (stdout is reserved for JSON-RPC)."""
    print(f"[vision-server-mlx] {msg}", file=sys.stderr, flush=True)


def _compute_position_ids(input_ids, image_grid_thw=None, attention_mask=None):
    """Compute Qwen2.5-VL multimodal rotary position IDs."""
    return model.vlm.language_model.get_rope_index(
        input_ids,
        image_grid_thw=image_grid_thw,
        attention_mask=attention_mask,
    )


def _forward(input_ids, pixel_values=None, image_grid_thw=None, attention_mask=None):
    """Run the full ColQwen2.5 forward pass and return L2-normalized embeddings."""
    from mlx_embeddings.models.base import normalize_embeddings

    # Compute position IDs
    position_ids, _ = _compute_position_ids(
        input_ids, image_grid_thw=image_grid_thw, attention_mask=attention_mask
    )

    # Get input embeddings (merges image features if pixel_values provided)
    inputs_embeds = model.get_input_embeddings_batch(
        input_ids, pixel_values, image_grid_thw
    )

    # Language model forward pass
    output_hidden = model.vlm.language_model.model(
        None, inputs_embeds=inputs_embeds, position_ids=position_ids
    )

    # Project to embedding dim (128) and L2 normalize
    embeddings = model.embedding_proj_layer(output_hidden)
    embeddings = normalize_embeddings(embeddings)

    # Apply attention mask if provided (zero out padding positions)
    if attention_mask is not None:
        embeddings = embeddings * attention_mask[:, :, None]

    # Force evaluation
    mx.eval(embeddings)

    return embeddings


def embed_images(paths):
    """Embed a list of image file paths. Returns list of multi-vector embeddings.

    Matches colpali_engine's ColQwen2_5_Processor.process_images() behavior:
    - Uses VISUAL_PROMPT_PREFIX to wrap image tokens with context
    - Constrains resolution via max_pixels=602112
    """
    all_embeddings = []
    num_vectors = []

    for p in paths:
        img = Image.open(p).convert("RGB")

        # Process image with constrained resolution (matching colpali_engine)
        img_inputs = image_processor(images=[img], return_tensors="np")
        pixel_values = mx.array(img_inputs["pixel_values"])
        image_grid_thw = mx.array(img_inputs["image_grid_thw"])

        # Tokenize the visual prompt prefix (contains <|image_pad|> placeholder)
        # The tokenizer converts this to the right token IDs including the image token
        prefix_tokens = tokenizer.encode(VISUAL_PROMPT_PREFIX, add_special_tokens=False)
        image_token_id = model.image_token_id

        # Count how many image tokens the processor expects
        t_val, h_val, w_val = image_grid_thw[0].tolist()
        merge_size = 2  # Qwen2.5-VL spatial_merge_size
        n_image_tokens = int((h_val // merge_size) * (w_val // merge_size) * t_val)

        # Replace the single <|image_pad|> token in prefix with n_image_tokens
        expanded = []
        for tid in prefix_tokens:
            if tid == image_token_id:
                expanded.extend([image_token_id] * n_image_tokens)
            else:
                expanded.append(tid)

        input_ids = mx.array([expanded])

        # Forward pass
        embeddings = _forward(
            input_ids, pixel_values=pixel_values, image_grid_thw=image_grid_thw
        )

        # Convert to nested lists (float32)
        vecs = np.array(embeddings[0].astype(mx.float32)).tolist()
        all_embeddings.append(vecs)
        num_vectors.append(len(vecs))

    return {"embeddings": all_embeddings, "num_vectors": num_vectors}


def embed_queries(texts):
    """Embed query texts. Returns list of multi-vector embeddings.

    Matches colpali_engine's ColQwen2_5_Processor.process_queries() behavior:
    - Appends 10x <|endoftext|> tokens as query augmentation
    - No padding beyond that
    """
    results = []

    for text in texts:
        # Add query augmentation suffix (10x <|endoftext|>)
        augmented = text + (QUERY_AUGMENTATION_TOKEN * QUERY_AUGMENTATION_COUNT)

        # Tokenize without extra padding
        inputs = tokenizer(
            augmented,
            return_tensors="np",
            padding=False,
            truncation=True,
        )
        input_ids = mx.array(inputs["input_ids"])
        attention_mask = mx.array(inputs["attention_mask"])

        # Forward pass (text-only, no pixel_values)
        embeddings = _forward(
            input_ids, attention_mask=attention_mask
        )

        # All positions are active (no padding)
        vecs = np.array(embeddings[0].astype(mx.float32)).tolist()
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
                "device": "gpu",
                "dtype": "float16",
                "backend": BACKEND,
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
    elif method == "extract_text":
        result = extract_text(params["pdf_path"])
        return {"id": req_id, "result": result}
    elif method == "shutdown":
        return {"id": req_id, "result": {"status": "shutting_down"}}
    else:
        return {"id": req_id, "error": f"Unknown method: {method}"}


def main():
    log("Initializing vision server (MLX backend)...")
    init_model()

    # Signal readiness
    ready_msg = json.dumps({"ready": True, "model": MODEL_ID, "device": "gpu", "backend": BACKEND})
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
