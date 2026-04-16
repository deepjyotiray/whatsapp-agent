from __future__ import annotations

from pathlib import Path

from common import HF_MODEL_DIR, PipelineConfig, hydrate_config, save_state, setup_logger, tokenizer_quality_check, write_json


def resolve_torch_dtype(dtype_name: str):
    import torch

    return getattr(torch, dtype_name)


def main() -> None:
    logger = setup_logger("phase2_acquire_model", "phase2_acquire_model.log")
    config = hydrate_config(PipelineConfig())

    from transformers import AutoModelForCausalLM, AutoTokenizer

    logger.info("Loading tokenizer for %s", config.model_id)
    tokenizer = AutoTokenizer.from_pretrained(
        config.model_id,
        trust_remote_code=config.trust_remote_code,
    )
    if not tokenizer_quality_check(tokenizer):
        raise RuntimeError("Tokenizer validation failed.")

    logger.info("Loading model for %s", config.model_id)
    model = AutoModelForCausalLM.from_pretrained(
        config.model_id,
        dtype=resolve_torch_dtype(config.quant_dtype),
        low_cpu_mem_usage=True,
        trust_remote_code=config.trust_remote_code,
    )
    logger.info("Saving HF snapshot to %s", HF_MODEL_DIR)
    model.save_pretrained(HF_MODEL_DIR, safe_serialization=True)
    tokenizer.save_pretrained(HF_MODEL_DIR)

    phase_result = {
        "model_id": config.model_id,
        "saved_to": str(HF_MODEL_DIR),
        "tokenizer_vocab_size": tokenizer.vocab_size,
        "parameter_count_estimate": getattr(model, "num_parameters", lambda: None)(),
    }
    config.phase_results["phase2"] = phase_result
    save_state(config)
    write_json(Path("logs") / "phase2_acquire_model.json", phase_result)
    logger.info("Phase 2 complete.")


if __name__ == "__main__":
    main()
