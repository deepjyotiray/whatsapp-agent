from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from scripts.common import MLX_MODEL_DIR, ROOT, build_generation_prompt, load_state


HF_CACHE_ROOT = Path("/Users/deepjyotiray/.cache/huggingface/hub")


def run_pipeline(
    model_id: str,
    use_turboquant: bool,
    quant_bits: int,
    fallback_bits: int,
    group_size: int,
    max_tokens: int,
    prompt: str,
) -> dict[str, Any]:
    env = dict(os.environ)
    env.update(
        {
            "MODEL_ID": model_id,
            "USE_TURBOQUANT": "1" if use_turboquant else "0",
            "QUANT_BITS": str(quant_bits),
            "FALLBACK_BITS": str(fallback_bits),
            "GROUP_SIZE": str(group_size),
            "MAX_TOKENS": str(max_tokens),
            "PROMPT": prompt,
        }
    )

    started = time.time()
    result = subprocess.run(
        [str(ROOT / ".venv" / "bin" / "python"), str(ROOT / "scripts" / "pipeline.py")],
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    elapsed = time.time() - started
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "elapsed_seconds": elapsed,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "state": load_state(),
    }


def run_mlx_inference(prompt: str, max_tokens: int, model_path: str | None = None) -> dict[str, Any]:
    from mlx_lm import generate, load

    resolved_model_path = str(Path(model_path).expanduser()) if model_path else str(MLX_MODEL_DIR)
    started = time.time()
    model, tokenizer = load(resolved_model_path)
    formatted_prompt = build_generation_prompt(tokenizer, prompt)
    output = generate(model, tokenizer, prompt=formatted_prompt, max_tokens=max_tokens, verbose=False)
    elapsed = time.time() - started
    return {
        "provider": "mlx",
        "model": resolved_model_path,
        "prompt": prompt,
        "formatted_prompt": formatted_prompt,
        "output": output,
        "latency_seconds": elapsed,
    }


def request_openai_compatible(
    base_url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    api_key: str | None = None,
    extra_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base = base_url.rstrip("/")
    payload_dict: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }
    if extra_body:
        payload_dict.update(extra_body)
    payload = json.dumps(payload_dict).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        f"{base}/chat/completions",
        data=payload,
        headers=headers,
        method="POST",
    )
    started = time.time()
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.loads(response.read().decode("utf-8"))
    elapsed = time.time() - started
    try:
        output = body["choices"][0]["message"]["content"]
    except Exception as exc:
        raise RuntimeError(f"Unexpected OpenAI-compatible response: {body}") from exc
    return {
        "provider": "openai-compatible",
        "endpoint": base,
        "model": model,
        "prompt": prompt,
        "output": output,
        "latency_seconds": elapsed,
        "raw": body,
    }


def run_ollama_inference(model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    payload = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "options": {"num_predict": max_tokens},
            "stream": False,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError("Could not reach Ollama at http://127.0.0.1:11434. Start Ollama first.") from exc
    elapsed = time.time() - started
    return {
        "provider": "ollama",
        "model": model,
        "prompt": prompt,
        "output": body.get("response", ""),
        "latency_seconds": elapsed,
        "raw": body,
    }


def run_turboquant_inference(base_url: str, model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    try:
        result = request_openai_compatible(base_url=base_url, model=model, prompt=prompt, max_tokens=max_tokens)
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach TurboQuant runtime at {base_url}. Start the TurboQuant-backed server first."
        ) from exc
    result["provider"] = "turboquant-runtime"
    return result


def run_g0dm0d3_inference(
    base_url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    api_key: str | None = None,
    openrouter_api_key: str | None = None,
) -> dict[str, Any]:
    extra_body: dict[str, Any] = {
        "godmode": True,
        "autotune": True,
        "parseltongue": True,
        "stm_modules": ["hedge_reducer", "direct_mode"],
    }
    if openrouter_api_key:
        extra_body["openrouter_api_key"] = openrouter_api_key

    try:
        result = request_openai_compatible(
            base_url=base_url,
            model=model,
            prompt=prompt,
            max_tokens=max_tokens,
            api_key=api_key,
            extra_body=extra_body,
        )
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        message = body or str(exc)
        raise RuntimeError(f"G0DM0D3 request failed ({exc.code}): {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Could not reach G0DM0D3 at {base_url}. Start the G0DM0D3 API server first."
        ) from exc

    result["provider"] = "g0dm0d3"
    result["pipeline"] = result.get("raw", {}).get("x_g0dm0d3")
    return result


def run_provider(
    provider: str,
    prompt: str,
    max_tokens: int,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    openrouter_api_key: str | None = None,
) -> dict[str, Any]:
    if provider == "mlx":
        return run_mlx_inference(prompt=prompt, max_tokens=max_tokens, model_path=model)
    if provider == "ollama":
        if not model:
            raise RuntimeError("Ollama requires a model name.")
        return run_ollama_inference(model=model, prompt=prompt, max_tokens=max_tokens)
    if provider == "turboquant-runtime":
        if not model or not base_url:
            raise RuntimeError("TurboQuant runtime requires both a base URL and model name.")
        return run_turboquant_inference(base_url=base_url, model=model, prompt=prompt, max_tokens=max_tokens)
    if provider == "g0dm0d3":
        if not model or not base_url:
            raise RuntimeError("G0DM0D3 requires both a base URL and model name.")
        return run_g0dm0d3_inference(
            base_url=base_url,
            model=model,
            prompt=prompt,
            max_tokens=max_tokens,
            api_key=api_key,
            openrouter_api_key=openrouter_api_key,
        )
    raise RuntimeError(f"Unsupported provider: {provider}")


def summarize_latest_run() -> dict[str, Any]:
    state = load_state()
    phase3 = state.get("phase_results", {}).get("phase3", {})
    phase5 = state.get("phase_results", {}).get("phase5", {})
    phase6 = read_json_file(ROOT / "logs" / "benchmark.json")
    return {
        "strategy": phase3.get("strategy"),
        "quantization_message": phase3.get("message"),
        "quantized_size": phase3.get("quantized_size"),
        "latest_output": phase5.get("output"),
        "benchmark": phase6,
    }


def discover_cached_hf_models() -> list[dict[str, str]]:
    models: list[dict[str, str]] = []
    if not HF_CACHE_ROOT.exists():
        return models

    for model_dir in sorted(HF_CACHE_ROOT.glob("models--*")):
        model_id = model_dir.name[len("models--") :].replace("--", "/")
        snapshots_dir = model_dir / "snapshots"
        snapshots = sorted(snapshots_dir.glob("*")) if snapshots_dir.exists() else []
        if not snapshots:
            continue
        latest = snapshots[-1]
        files = [x.name for x in latest.iterdir() if x.is_file()]
        has_config = "config.json" in files
        has_weights = any(name.endswith((".safetensors", ".bin", ".gguf", ".npz")) for name in files)
        if not (has_config and has_weights):
            continue
        models.append(
            {
                "model_id": model_id,
                "snapshot_path": str(latest),
                "label": f"{model_id} ({latest.name[:8]})",
            }
        )
    return models


def read_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def read_text_file(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text()
