from __future__ import annotations

import shutil
import sys
from pathlib import Path

from common import MLX_MODEL_DIR, TURBOQUANT_MODEL_DIR, PipelineConfig, hydrate_config, run_command, save_state, setup_logger, write_json


def main() -> None:
    logger = setup_logger("phase4_convert_to_mlx", "phase4_convert_to_mlx.log")
    config = hydrate_config(PipelineConfig())
    phase3 = config.phase_results.get("phase3", {})

    if phase3.get("strategy") == "mlx":
        logger.info("MLX model already produced during fallback quantization.")
    else:
        if not TURBOQUANT_MODEL_DIR.exists():
            raise RuntimeError("TurboQuant output is missing; cannot convert to MLX.")
        if MLX_MODEL_DIR.exists():
            shutil.rmtree(MLX_MODEL_DIR)
        convert_cli = str(Path(sys.executable).with_name("mlx_lm.convert"))
        command = [
            convert_cli,
            "--hf-path",
            str(TURBOQUANT_MODEL_DIR),
            "--mlx-path",
            str(MLX_MODEL_DIR),
            "--dtype",
            config.quant_dtype,
        ]
        if config.trust_remote_code:
            command.append("--trust-remote-code")
        try:
            run_command(command, logger)
        except Exception:
            logger.warning("Conversion failed; retrying with float16 reformat.")
            command = [
                convert_cli,
                "--hf-path",
                str(TURBOQUANT_MODEL_DIR),
                "--mlx-path",
                str(MLX_MODEL_DIR),
                "--dtype",
                "float16",
            ]
            if config.trust_remote_code:
                command.append("--trust-remote-code")
            run_command(command, logger)

    required_files = [MLX_MODEL_DIR / "config.json"]
    weight_candidates = list(MLX_MODEL_DIR.glob("*.safetensors")) + list(MLX_MODEL_DIR.glob("*.npz"))
    if not weight_candidates:
        raise RuntimeError("No MLX weight files found after conversion.")
    if not all(path.exists() for path in required_files):
        raise RuntimeError("Missing config.json in MLX model directory.")

    result = {
        "mlx_model_dir": str(MLX_MODEL_DIR),
        "weight_files": [str(path) for path in weight_candidates],
        "config_exists": True,
    }
    config.phase_results["phase4"] = result
    save_state(config)
    write_json(Path("logs") / "phase4_convert_to_mlx.json", result)
    logger.info("Phase 4 complete.")


if __name__ == "__main__":
    main()
