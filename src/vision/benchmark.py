#!/usr/bin/env python3
"""
Benchmark: MLX vs PyTorch ColQwen2.5 on Apple Silicon.

Measures:
  - Model load time
  - Query embedding latency (single + batch)
  - Image embedding latency (single)
  - Memory usage
"""

import json
import os
import sys
import time
import resource

from PIL import Image

# ─── Configuration ─────────────────────────────────────────────
TEST_QUERY = "vegetarian pasta under 30 minutes"
TEST_QUERIES = [
    "vegetarian pasta under 30 minutes",
    "high protein meal prep",
    "quick breakfast ideas",
]
# Use a real page image if available, otherwise generate a synthetic one
REAL_PAGE = os.path.expanduser("~/Downloads/test_page.png")
SYNTHETIC_SIZE = (1200, 1600)  # typical PDF page at 144 DPI
N_WARMUP = 1
N_RUNS = 5


def get_peak_memory_mb():
    """Get peak memory usage in MB (macOS)."""
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return usage.ru_maxrss / (1024 * 1024)  # macOS reports in bytes


def make_test_image(path="/tmp/bench_page.png"):
    """Create a synthetic page image if no real one exists."""
    img = Image.new("RGB", SYNTHETIC_SIZE, color=(255, 255, 240))
    # Add some visual variation
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    for y in range(0, SYNTHETIC_SIZE[1], 40):
        draw.text((50, y), f"Recipe line {y//40}: Combine ingredients thoroughly.", fill=(40, 40, 40))
    img.save(path)
    return path


def benchmark_mlx():
    """Benchmark the MLX backend."""
    print("\n" + "=" * 60)
    print("  MLX Backend Benchmark")
    print("=" * 60)

    import mlx.core as mx
    from mlx_embeddings.utils import load
    from transformers import Qwen2VLImageProcessor
    from mlx_embeddings.models.base import normalize_embeddings

    # Model load
    t0 = time.time()
    model, tokenizer = load("qnguyen3/colqwen2.5-v0.2-mlx")
    image_processor = Qwen2VLImageProcessor.from_pretrained("Qwen/Qwen2.5-VL-3B-Instruct")
    load_time = time.time() - t0
    print(f"Model load time: {load_time:.2f}s")
    print(f"Peak memory after load: {get_peak_memory_mb():.0f} MB")

    def _forward(input_ids, pixel_values=None, image_grid_thw=None, attention_mask=None):
        position_ids, _ = model.vlm.language_model.get_rope_index(
            input_ids, image_grid_thw=image_grid_thw, attention_mask=attention_mask
        )
        inputs_embeds = model.get_input_embeddings_batch(
            input_ids, pixel_values, image_grid_thw
        )
        output_hidden = model.vlm.language_model.model(
            None, inputs_embeds=inputs_embeds, position_ids=position_ids
        )
        embeddings = model.embedding_proj_layer(output_hidden)
        embeddings = normalize_embeddings(embeddings)
        if attention_mask is not None:
            embeddings = embeddings * attention_mask[:, :, None]
        mx.eval(embeddings)
        return embeddings

    # Query embedding
    print(f"\n--- Query Embedding (single) ---")
    inputs = tokenizer(TEST_QUERY, return_tensors="np", padding="max_length", max_length=50, truncation=True)
    input_ids = mx.array(inputs["input_ids"])
    attention_mask = mx.array(inputs["attention_mask"])

    # Warmup
    for _ in range(N_WARMUP):
        _forward(input_ids, attention_mask=attention_mask)

    times = []
    for _ in range(N_RUNS):
        t0 = time.time()
        emb = _forward(input_ids, attention_mask=attention_mask)
        times.append(time.time() - t0)
    avg = sum(times) / len(times)
    n_vecs = int(mx.sum(attention_mask).item())
    print(f"  Avg latency: {avg*1000:.1f}ms ({n_vecs} vectors, {emb.shape[2]}d)")

    # Image embedding
    print(f"\n--- Image Embedding (single) ---")
    test_img_path = REAL_PAGE if os.path.exists(REAL_PAGE) else make_test_image()
    img = Image.open(test_img_path).convert("RGB")
    img_inputs = image_processor(images=[img], return_tensors="np")
    pv = mx.array(img_inputs["pixel_values"])
    igt = mx.array(img_inputs["image_grid_thw"])
    t_val, h_val, w_val = igt[0].tolist()
    n_tokens = int((h_val // 2) * (w_val // 2) * t_val)
    iids = mx.array([[model.image_token_id] * n_tokens])

    # Warmup
    for _ in range(N_WARMUP):
        _forward(iids, pixel_values=pv, image_grid_thw=igt)

    times = []
    for _ in range(N_RUNS):
        t0 = time.time()
        emb = _forward(iids, pixel_values=pv, image_grid_thw=igt)
        times.append(time.time() - t0)
    avg = sum(times) / len(times)
    print(f"  Avg latency: {avg*1000:.1f}ms ({emb.shape[1]} vectors, {emb.shape[2]}d)")
    print(f"  Image size: {img.size}")
    print(f"Peak memory: {get_peak_memory_mb():.0f} MB")

    return {
        "backend": "mlx",
        "model_load_s": round(load_time, 2),
        "query_latency_ms": round(avg * 1000, 1),
        "image_latency_ms": round(sum(times) / len(times) * 1000, 1),
        "image_vectors": int(emb.shape[1]),
        "query_vectors": n_vecs,
        "peak_memory_mb": round(get_peak_memory_mb()),
    }


def benchmark_torch():
    """Benchmark the PyTorch+MPS backend."""
    print("\n" + "=" * 60)
    print("  PyTorch + MPS Backend Benchmark")
    print("=" * 60)

    import torch
    from colpali_engine.models import ColQwen2_5, ColQwen2_5_Processor

    MODEL_ID = "tsystems/colqwen2.5-3b-multilingual-v1.0-merged"

    # Model load
    t0 = time.time()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float32

    torch_model = ColQwen2_5.from_pretrained(MODEL_ID, dtype=dtype, device_map=device).eval()
    processor = ColQwen2_5_Processor.from_pretrained(MODEL_ID)
    load_time = time.time() - t0
    print(f"Model load time: {load_time:.2f}s")
    print(f"Peak memory after load: {get_peak_memory_mb():.0f} MB")

    # Query embedding
    print(f"\n--- Query Embedding (single) ---")
    batch = processor.process_queries([TEST_QUERY]).to(device)
    for k, v in batch.items():
        if isinstance(v, torch.Tensor) and v.is_floating_point():
            batch[k] = v.to(dtype)

    # Warmup
    for _ in range(N_WARMUP):
        with torch.no_grad():
            torch_model(**batch)

    times = []
    for _ in range(N_RUNS):
        t0 = time.time()
        with torch.no_grad():
            emb = torch_model(**batch)
        times.append(time.time() - t0)
    avg = sum(times) / len(times)
    n_vecs = emb.shape[1]
    print(f"  Avg latency: {avg*1000:.1f}ms ({n_vecs} vectors, {emb.shape[2]}d)")

    # Image embedding
    print(f"\n--- Image Embedding (single) ---")
    test_img_path = REAL_PAGE if os.path.exists(REAL_PAGE) else make_test_image()
    img = Image.open(test_img_path).convert("RGB")

    batch = processor.process_images([img]).to(device)
    for k, v in batch.items():
        if isinstance(v, torch.Tensor) and v.is_floating_point():
            batch[k] = v.to(dtype)

    # Warmup
    for _ in range(N_WARMUP):
        with torch.no_grad():
            torch_model(**batch)

    times = []
    for _ in range(N_RUNS):
        t0 = time.time()
        with torch.no_grad():
            emb = torch_model(**batch)
        times.append(time.time() - t0)
    avg = sum(times) / len(times)
    print(f"  Avg latency: {avg*1000:.1f}ms ({emb.shape[1]} vectors, {emb.shape[2]}d)")
    print(f"  Image size: {img.size}")
    print(f"Peak memory: {get_peak_memory_mb():.0f} MB")

    return {
        "backend": "torch+mps",
        "model_load_s": round(load_time, 2),
        "query_latency_ms": round(avg * 1000, 1),
        "image_latency_ms": round(sum(times) / len(times) * 1000, 1),
        "image_vectors": int(emb.shape[1]),
        "query_vectors": int(n_vecs),
        "peak_memory_mb": round(get_peak_memory_mb()),
    }


if __name__ == "__main__":
    backend = sys.argv[1] if len(sys.argv) > 1 else "mlx"
    if backend == "mlx":
        result = benchmark_mlx()
    elif backend == "torch":
        result = benchmark_torch()
    elif backend == "both":
        # Can only run one at a time due to memory; just report
        print("Run separately: python3 benchmark.py mlx; python3 benchmark.py torch")
        sys.exit(1)
    else:
        print(f"Unknown backend: {backend}. Use 'mlx' or 'torch'.")
        sys.exit(1)

    print(f"\n--- Results ({backend}) ---")
    print(json.dumps(result, indent=2))
