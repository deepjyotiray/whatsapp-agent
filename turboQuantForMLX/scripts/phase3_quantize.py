from __future__ import annotations

import shutil
import sys
from pathlib import Path

from common import (
    HF_MODEL_DIR,
    MLX_MODEL_DIR,
    TURBOQUANT_MODEL_DIR,
    PipelineConfig,
    file_size_bytes,
    hydrate_config,
    human_size,
    run_command,
    save_state,
    setup_logger,
    write_json,
)


def resolve_torch_dtype(dtype_name: str):
    import torch

    return getattr(torch, dtype_name)


def try_turboquant(config: PipelineConfig, logger) -> tuple[bool, str]:
    if not config.use_turboquant:
        return False, "TurboQuant disabled by configuration."
    try:
        import turboquant
        from transformers import AutoModelForCausalLM

        quantize_model = getattr(turboquant, "quantize_model", None)
        if quantize_model is None:
            return False, "TurboQuant package is installed but does not expose quantize_model; using MLX fallback."

        logger.info("Attempting TurboQuant quantization.")
        model = AutoModelForCausalLM.from_pretrained(
            HF_MODEL_DIR,
            dtype=resolve_torch_dtype(config.quant_dtype),
            low_cpu_mem_usage=True,
            trust_remote_code=config.trust_remote_code,
        )
        quantized_model = quantize_model(
            model,
            bits=config.quant_bits,
            group_size=config.group_size,
        )
        if TURBOQUANT_MODEL_DIR.exists():
            shutil.rmtree(TURBOQUANT_MODEL_DIR)
        TURBOQUANT_MODEL_DIR.mkdir(parents=True, exist_ok=True)
        quantized_model.save_pretrained(TURBOQUANT_MODEL_DIR, safe_serialization=True)
        shutil.copy2(HF_MODEL_DIR / "config.json", TURBOQUANT_MODEL_DIR / "config.json")
        for extra_file in ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "tokenizer.model"]:
            source = HF_MODEL_DIR / extra_file
            if source.exists():
                shutil.copy2(source, TURBOQUANT_MODEL_DIR / extra_file)
        return True, "TurboQuant succeeded."
    except Exception as exc:
        logger.exception("TurboQuant failed.")
        return False, f"TurboQuant failed: {exc}"


def quantize_with_mlx(config: PipelineConfig, logger, target_bits: int) -> tuple[bool, str]:
    logger.info("Falling back to MLX conversion and quantization.")
    if MLX_MODEL_DIR.exists():
        shutil.rmtree(MLX_MODEL_DIR)
    convert_cli = str(Path(sys.executable).with_name("mlx_lm.convert"))
    command = [
        convert_cli,
        "--hf-path",
        str(HF_MODEL_DIR),
        "--mlx-path",
        str(MLX_MODEL_DIR),
        "-q",
        "--q-bits",
        str(target_bits),
        "--q-group-size",
        str(config.group_size),
        "--dtype",
        config.quant_dtype,
    ]
    if config.trust_remote_code:
        command.append("--trust-remote-code")
    try:
        run_command(command, logger)
        return True, f"MLX quantization succeeded with {target_bits} bits."
    except Exception as exc:
        logger.exception("MLX quantization failed.")
        return False, f"MLX quantization failed: {exc}"


def main() -> None:
    logger = setup_logger("phase3_quantize", "quantization.log")
    config = hydrate_config(PipelineConfig())

    turboquant_ok, turboquant_message = try_turboquant(config, logger)
    result = {
        "strategy": None,
        "message": turboquant_message,
        "hf_model_size": human_size(file_size_bytes(HF_MODEL_DIR)),
        "quantized_size": None,
    }

    if turboquant_ok:
        result["strategy"] = "turboquant"
        result["quantized_path"] = str(TURBOQUANT_MODEL_DIR)
        result["quantized_size"] = human_size(file_size_bytes(TURBOQUANT_MODEL_DIR))
    else:
        mlx_ok, mlx_message = quantize_with_mlx(config, logger, config.quant_bits)
        result["message"] = mlx_message
        if not mlx_ok:
            logger.warning("Retrying MLX quantization with fallback bit precision: %s", config.fallback_bits)
            mlx_ok, mlx_message = quantize_with_mlx(config, logger, config.fallback_bits)
            result["message"] = mlx_message
            result["fallback_bits_used"] = config.fallback_bits
        if not mlx_ok:
            raise RuntimeError(mlx_message)
        result["strategy"] = "mlx"
        result["quantized_path"] = str(MLX_MODEL_DIR)
        result["quantized_size"] = human_size(file_size_bytes(MLX_MODEL_DIR))

    config.phase_results["phase3"] = result
    save_state(config)
    write_json(Path("logs") / "phase3_quantize.json", result)
    logger.info("Phase 3 complete with strategy: %s", result["strategy"])


if __name__ == "__main__":
    main()
