from __future__ import annotations

from pathlib import Path

from common import (
    MLX_MODEL_DIR,
    PipelineConfig,
    build_generation_prompt,
    hydrate_config,
    save_state,
    semantic_quality_check,
    setup_logger,
    write_json,
)


def run_generation(config: PipelineConfig, logger, prompt: str) -> str:
    from mlx_lm import generate, load

    logger.info("Loading MLX model from %s", MLX_MODEL_DIR)
    model, tokenizer = load(str(MLX_MODEL_DIR))
    formatted_prompt = build_generation_prompt(tokenizer, prompt)
    return generate(
        model,
        tokenizer,
        prompt=formatted_prompt,
        max_tokens=config.max_tokens,
        verbose=False,
    )


def main() -> None:
    logger = setup_logger("phase5_run_inference", "phase5_run_inference.log")
    config = hydrate_config(PipelineConfig())

    output = run_generation(config, logger, config.prompt)
    quality_ok = semantic_quality_check(output)

    if not quality_ok:
        logger.warning("Inference quality check failed; retrying by reloading model.")
        output = run_generation(config, logger, config.prompt)
        quality_ok = semantic_quality_check(output)

    if not quality_ok:
        raise RuntimeError("Inference output failed semantic validation twice.")

    result = {
        "prompt": config.prompt,
        "output": output,
        "quality_ok": quality_ok,
    }
    config.phase_results["phase5"] = result
    save_state(config)
    write_json(Path("logs") / "phase5_run_inference.json", result)
    logger.info("Phase 5 complete.")


if __name__ == "__main__":
    main()
