from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
LOGS_DIR = ROOT / "logs"
MODELS_DIR = ROOT / "artifacts"
HF_MODEL_DIR = MODELS_DIR / "hf_model"
TURBOQUANT_MODEL_DIR = MODELS_DIR / "turboquant_model"
MLX_MODEL_DIR = ROOT / "mlx_model"
DEFAULT_PROMPTS = [
    "What is AI?",
    "Explain recursion simply",
    "Write a short story about space",
]


def ensure_directories() -> None:
    for path in [LOGS_DIR, MODELS_DIR, HF_MODEL_DIR, TURBOQUANT_MODEL_DIR, MLX_MODEL_DIR]:
        path.mkdir(parents=True, exist_ok=True)


def setup_logger(name: str, log_filename: str) -> logging.Logger:
    ensure_directories()
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    file_handler = logging.FileHandler(LOGS_DIR / log_filename)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)
    return logger


@dataclass
class PipelineConfig:
    model_id: str = os.environ.get("MODEL_ID", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")
    prompt: str = os.environ.get("PROMPT", "Explain quantization in simple terms")
    max_tokens: int = int(os.environ.get("MAX_TOKENS", "100"))
    quant_bits: int = int(os.environ.get("QUANT_BITS", "4"))
    fallback_bits: int = int(os.environ.get("FALLBACK_BITS", "6"))
    group_size: int = int(os.environ.get("GROUP_SIZE", "128"))
    quant_dtype: str = os.environ.get("QUANT_DTYPE", "float16")
    use_turboquant: bool = os.environ.get("USE_TURBOQUANT", "1").lower() not in {"0", "false", "no"}
    trust_remote_code: bool = os.environ.get("TRUST_REMOTE_CODE", "0").lower() in {"1", "true", "yes"}
    retries: int = int(os.environ.get("PIPELINE_RETRIES", "2"))
    baseline_tokens: int = int(os.environ.get("BASELINE_TOKENS", "50"))
    python_bin: str | None = os.environ.get("PIPELINE_PYTHON")
    venv_dir: Path = Path(os.environ.get("PIPELINE_VENV", str(ROOT / ".venv")))
    phase_state_path: Path = ROOT / "artifacts" / "pipeline_state.json"
    phase_results: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "prompt": self.prompt,
            "max_tokens": self.max_tokens,
            "quant_bits": self.quant_bits,
            "fallback_bits": self.fallback_bits,
            "group_size": self.group_size,
            "quant_dtype": self.quant_dtype,
            "use_turboquant": self.use_turboquant,
            "trust_remote_code": self.trust_remote_code,
            "retries": self.retries,
            "baseline_tokens": self.baseline_tokens,
            "python_bin": self.python_bin,
            "venv_dir": str(self.venv_dir),
            "phase_results": self.phase_results,
        }


def save_state(config: PipelineConfig) -> None:
    ensure_directories()
    config.phase_state_path.parent.mkdir(parents=True, exist_ok=True)
    config.phase_state_path.write_text(json.dumps(config.to_json(), indent=2))


def load_state() -> dict[str, Any]:
    if not (ROOT / "artifacts" / "pipeline_state.json").exists():
        return {}
    return json.loads((ROOT / "artifacts" / "pipeline_state.json").read_text())


def hydrate_config(config: PipelineConfig) -> PipelineConfig:
    state = load_state()
    if state.get("phase_results"):
        config.phase_results.update(state["phase_results"])
    if state.get("python_bin") and not config.python_bin:
        config.python_bin = state["python_bin"]
    return config


def run_command(
    command: list[str],
    logger: logging.Logger,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    cmd_text = " ".join(command)
    logger.info("Running command: %s", cmd_text)
    result = subprocess.run(
        command,
        cwd=str(cwd or ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.stdout:
        logger.info("stdout:\n%s", result.stdout.strip())
    if result.stderr:
        logger.info("stderr:\n%s", result.stderr.strip())
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {cmd_text}")
    return result


def resolve_python(config: PipelineConfig, logger: logging.Logger) -> str:
    if config.python_bin:
        logger.info("Using configured Python interpreter: %s", config.python_bin)
        return config.python_bin

    candidates = [
        shutil.which("python3.11"),
        shutil.which("python3.12"),
        shutil.which("python3"),
        sys.executable,
    ]
    for candidate in candidates:
        if not candidate:
            continue
        probe = subprocess.run(
            [candidate, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
            text=True,
            capture_output=True,
            check=False,
        )
        if probe.returncode == 0 and probe.stdout.strip() in {"3.11", "3.12", "3.13"}:
            logger.info("Selected Python interpreter: %s", candidate)
            config.python_bin = candidate
            return candidate

    raise RuntimeError("No suitable Python interpreter found. Expected python3.11+.")


def create_venv(config: PipelineConfig, logger: logging.Logger) -> str:
    python_bin = resolve_python(config, logger)
    venv_python = config.venv_dir / "bin" / "python"
    if not venv_python.exists():
        logger.info("Creating virtual environment at %s", config.venv_dir)
        run_command([python_bin, "-m", "venv", str(config.venv_dir)], logger)
    else:
        logger.info("Reusing existing virtual environment at %s", config.venv_dir)
    return str(venv_python)


def file_size_bytes(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            total += child.stat().st_size
    return total


def human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1024 or unit == "TB":
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{num_bytes} B"


def semantic_quality_check(text: str) -> bool:
    cleaned = text.strip()
    if len(cleaned) < 40:
        return False
    tokens = cleaned.split()
    if len(set(tokens)) < max(8, len(tokens) // 6):
        return False
    garbage_markers = ["<unk>", "\ufffd", "�"]
    return not any(marker in cleaned for marker in garbage_markers)


def tokenizer_quality_check(tokenizer: Any) -> bool:
    return tokenizer is not None and getattr(tokenizer, "vocab_size", 0) > 0


def build_generation_prompt(tokenizer: Any, prompt: str) -> str:
    chat_template = getattr(tokenizer, "chat_template", None)
    if chat_template:
        return tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False,
            add_generation_prompt=True,
        )
    return prompt


def system_snapshot() -> dict[str, Any]:
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "python": sys.version,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))
