from __future__ import annotations

import subprocess

from common import PipelineConfig, ROOT, create_venv, hydrate_config, save_state, setup_logger, system_snapshot, write_json


REQUIRED_PACKAGES = [
    "pip",
    "setuptools<82",
    "wheel",
    "mlx",
    "mlx-lm",
    "transformers",
    "accelerate",
    "safetensors",
    "huggingface_hub",
    "psutil",
    "sentencepiece",
    "streamlit",
    "torch",
]
OPTIONAL_PACKAGES = ["turboquant"]


def install_packages(python_bin: str, logger) -> dict[str, str]:
    import subprocess

    install_report: dict[str, str] = {}
    for package in REQUIRED_PACKAGES:
        logger.info("Installing required package: %s", package)
        result = subprocess.run(
            [python_bin, "-m", "pip", "install", "--upgrade", package],
            text=True,
            capture_output=True,
            check=False,
        )
        install_report[package] = f"rc={result.returncode}"
        logger.info(result.stdout.strip() or f"{package}: no stdout")
        if result.stderr:
            logger.info(result.stderr.strip())
        if result.returncode != 0:
            raise RuntimeError(f"Failed to install required package: {package}")

    for package in OPTIONAL_PACKAGES:
        logger.info("Installing optional package: %s", package)
        result = subprocess.run(
            [python_bin, "-m", "pip", "install", "--upgrade", package],
            text=True,
            capture_output=True,
            check=False,
        )
        install_report[package] = f"rc={result.returncode}"
        logger.info(result.stdout.strip() or f"{package}: no stdout")
        if result.stderr:
            logger.info(result.stderr.strip())
        if result.returncode != 0:
            logger.warning("Optional package %s failed to install; fallback path will remain enabled.", package)
    return install_report


def validate_imports(python_bin: str, logger) -> dict[str, bool]:
    results = {}
    for module_name in ["mlx", "mlx_lm", "transformers", "torch", "safetensors"]:
        try:
            subprocess.run(
                [python_bin, "-c", f"import {module_name}"],
                text=True,
                capture_output=True,
                check=True,
            )
            logger.info("Import succeeded: %s", module_name)
            results[module_name] = True
        except Exception as exc:
            logger.exception("Import failed in venv: %s", module_name)
            results[module_name] = False
            raise RuntimeError(f"Import failed for {module_name}: {exc}") from exc
    try:
        subprocess.run(
            [python_bin, "-c", "import turboquant"],
            text=True,
            capture_output=True,
            check=True,
        )
        results["turboquant"] = True
    except Exception:
        logger.warning("turboquant import unavailable; MLX fallback will be used when needed.")
        results["turboquant"] = False
    return results


def main() -> None:
    logger = setup_logger("phase1_environment", "phase1_environment.log")
    config = hydrate_config(PipelineConfig())
    venv_python = create_venv(config, logger)
    install_report = install_packages(venv_python, logger)
    import_results = validate_imports(venv_python, logger)
    config.phase_results["phase1"] = {
        "venv_python": venv_python,
        "install_report": install_report,
        "import_results": import_results,
        "system_snapshot": system_snapshot(),
    }
    save_state(config)
    write_json(ROOT / "logs" / "phase1_environment.json", config.phase_results["phase1"])
    logger.info("Phase 1 complete.")


if __name__ == "__main__":
    main()
