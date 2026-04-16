from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from common import LOGS_DIR, PipelineConfig, create_venv, hydrate_config, setup_logger


PHASES = [
    ("phase1_environment.py", "phase1"),
    ("phase2_acquire_model.py", "phase2"),
    ("phase3_quantize.py", "phase3"),
    ("phase4_convert_to_mlx.py", "phase4"),
    ("phase5_run_inference.py", "phase5"),
    ("benchmark.py", "phase6"),
    ("phase7_quality_check.py", "phase7"),
]


def run_phase(venv_python: str, script_name: str, logger, env: dict[str, str]) -> None:
    script_path = Path(__file__).resolve().parent / script_name
    logger.info("Starting phase script: %s", script_path.name)
    result = subprocess.run(
        [venv_python, str(script_path)],
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if result.stdout:
        logger.info("stdout:\n%s", result.stdout.strip())
    if result.stderr:
        logger.info("stderr:\n%s", result.stderr.strip())
    if result.returncode != 0:
        raise RuntimeError(f"Phase failed: {script_name}")


def main() -> None:
    logger = setup_logger("pipeline", "pipeline.log")
    config = hydrate_config(PipelineConfig())
    venv_python = create_venv(config, logger)

    env = dict(os.environ)
    env["PATH"] = f"{config.venv_dir / 'bin'}:{env.get('PATH', '')}"
    env["PIPELINE_VENV"] = str(config.venv_dir)
    env["PIPELINE_PYTHON"] = venv_python

    for script_name, phase_name in PHASES:
        attempts = 0
        while attempts <= config.retries:
            try:
                run_phase(venv_python, script_name, logger, env)
                break
            except Exception as exc:
                attempts += 1
                logger.exception("Phase %s failed on attempt %s.", phase_name, attempts)
                if phase_name == "phase3":
                    env["USE_TURBOQUANT"] = "0"
                if phase_name == "phase4":
                    env["QUANT_DTYPE"] = "float16"
                if phase_name == "phase5":
                    env["PIPELINE_FORCE_RELOAD"] = "1"
                if attempts > config.retries:
                    raise RuntimeError(f"Phase {phase_name} exhausted retries: {exc}") from exc
                logger.info("Retrying phase %s with fallback adjustments.", phase_name)

    logger.info("Pipeline complete.")
    print(json.dumps({"status": "ok", "logs": str(LOGS_DIR)}, indent=2))


if __name__ == "__main__":
    main()
