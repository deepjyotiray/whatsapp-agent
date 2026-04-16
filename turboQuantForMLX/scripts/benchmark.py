from __future__ import annotations

import time
from pathlib import Path

from common import HF_MODEL_DIR, MLX_MODEL_DIR, PipelineConfig, build_generation_prompt, hydrate_config, save_state, setup_logger, write_json


def benchmark_mlx(config: PipelineConfig, logger) -> dict:
    from mlx_lm import generate, load

    model, tokenizer = load(str(MLX_MODEL_DIR))
    prompt = build_generation_prompt(tokenizer, "Test")
    start = time.time()
    output = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=config.baseline_tokens,
        verbose=False,
    )
    end = time.time()
    latency = end - start
    tokens_generated = len(output.split())
    return {
        "latency_seconds": latency,
        "tokens_generated_estimate": tokens_generated,
        "tokens_per_second_estimate": tokens_generated / latency if latency > 0 else None,
    }


def benchmark_hf(config: PipelineConfig, logger) -> dict | None:
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as exc:
        logger.warning("Skipping HF baseline benchmark: %s", exc)
        return None

    model = AutoModelForCausalLM.from_pretrained(
        str(HF_MODEL_DIR),
        dtype=torch.float16,
        low_cpu_mem_usage=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(str(HF_MODEL_DIR))
    prompt = build_generation_prompt(tokenizer, "Test")
    inputs = tokenizer(prompt, return_tensors="pt")
    prompt_tokens = inputs["input_ids"].shape[-1]
    start = time.time()
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=config.baseline_tokens,
            do_sample=False,
        )
    end = time.time()
    generated_tokens = int(outputs.shape[-1] - prompt_tokens)
    latency = end - start
    return {
        "latency_seconds": latency,
        "tokens_generated_estimate": generated_tokens,
        "tokens_per_second_estimate": generated_tokens / latency if latency > 0 else None,
    }


def main() -> None:
    logger = setup_logger("benchmark", "benchmark.log")
    config = hydrate_config(PipelineConfig())
    mlx_result = benchmark_mlx(config, logger)
    hf_result = benchmark_hf(config, logger)

    try:
        import psutil

        process = psutil.Process()
        memory_mb = process.memory_info().rss / (1024 * 1024)
    except Exception:
        memory_mb = None

    result = {
        "mlx_quantized": mlx_result,
        "hf_fp16_baseline": hf_result,
        "speedup_vs_hf": (
            hf_result["latency_seconds"] / mlx_result["latency_seconds"]
            if hf_result and mlx_result["latency_seconds"] > 0
            else None
        ),
        "memory_rss_mb": memory_mb,
    }
    config.phase_results["phase6"] = result
    save_state(config)
    write_json(Path("logs") / "benchmark.json", result)
    logger.info("Phase 6 complete.")


if __name__ == "__main__":
    main()
