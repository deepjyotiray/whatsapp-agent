from __future__ import annotations

from pathlib import Path

from common import (
    DEFAULT_PROMPTS,
    MLX_MODEL_DIR,
    PipelineConfig,
    build_generation_prompt,
    hydrate_config,
    save_state,
    semantic_quality_check,
    setup_logger,
    write_json,
)


def main() -> None:
    logger = setup_logger("phase7_quality_check", "phase7_quality_check.log")
    config = hydrate_config(PipelineConfig())

    from mlx_lm import generate, load

    model, tokenizer = load(str(MLX_MODEL_DIR))
    results = []
    for prompt in DEFAULT_PROMPTS:
        formatted_prompt = build_generation_prompt(tokenizer, prompt)
        output = generate(model, tokenizer, prompt=formatted_prompt, max_tokens=min(config.max_tokens, 120), verbose=False)
        is_ok = semantic_quality_check(output)
        results.append({"prompt": prompt, "output": output, "quality_ok": is_ok})
        logger.info("Prompt quality for '%s': %s", prompt, is_ok)

    if not all(item["quality_ok"] for item in results):
        raise RuntimeError("One or more quality prompts failed semantic validation.")

    payload = {"results": results}
    config.phase_results["phase7"] = payload
    save_state(config)
    write_json(Path("logs") / "phase7_quality_check.json", payload)
    logger.info("Phase 7 complete.")


if __name__ == "__main__":
    main()
