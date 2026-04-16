from __future__ import annotations

import pandas as pd
import streamlit as st

from scripts.common import LOGS_DIR, ROOT
from scripts.ui_backend import (
    discover_cached_hf_models,
    read_json_file,
    read_text_file,
    run_pipeline,
    run_provider,
    summarize_latest_run,
)


st.set_page_config(page_title="TurboQuant Runtime Bench", layout="wide")

st.title("TurboQuant Runtime Bench")
st.caption("Build a local MLX baseline, then benchmark the same prompt against MLX, Ollama, or a TurboQuant-backed runtime.")

st.warning(
    "To benchmark Google TurboQuant for real, the `TurboQuant Runtime` target must point at a server that actually implements "
    "Google's TurboQuant method. This UI can compare it, but it does not create that runtime by itself."
)

tab_build, tab_benchmark, tab_chat, tab_logs = st.tabs(["Build MLX Baseline", "Benchmark", "Chat", "Logs"])


with tab_build:
    st.subheader("1. Build Local MLX Baseline")
    st.write(
        "This step downloads a Hugging Face source model and converts it into a local MLX model. "
        "Use this only for the MLX baseline. It is separate from TurboQuant runtime benchmarking."
    )
    cached_hf_models = discover_cached_hf_models()
    cached_hf_labels = ["Custom..."] + [item["label"] for item in cached_hf_models]
    if cached_hf_models:
        st.success(f"Discovered {len(cached_hf_models)} usable cached Hugging Face models.")
        st.code("\n".join(item["label"] for item in cached_hf_models), language="text")
    else:
        st.warning("No usable cached Hugging Face models were discovered.")
    selected_cached_label = st.selectbox(
        "Cached Hugging Face models",
        options=cached_hf_labels,
        index=1 if len(cached_hf_labels) > 1 else 0,
        key="cached_hf_model_picker",
        help="Auto-detected usable models already present in your local Hugging Face cache.",
    )
    selected_cached_model = next(
        (item for item in cached_hf_models if item["label"] == selected_cached_label),
        None,
    )
    col1, col2 = st.columns(2)
    with col1:
        source_model = st.text_input(
            "Source model (Hugging Face)",
            value=selected_cached_model["model_id"] if selected_cached_model else "TinyLlama/TinyLlama-1.1B-Chat-v1.0",
            help="Original Hugging Face checkpoint to download and convert into MLX format.",
        )
        use_turboquant_first = st.toggle(
            "Try TurboQuant first during build",
            value=True,
            help="Only affects the local build pipeline. If unsupported, the pipeline falls back to MLX quantization.",
        )
        primary_bits = st.selectbox(
            "Primary quant bits",
            options=[4, 6, 8],
            index=0,
            help="First precision to try for the local MLX build.",
        )
    with col2:
        fallback_bits = st.selectbox(
            "Fallback bits",
            options=[6, 8],
            index=0,
            help="Retry precision for the local MLX build if the first attempt fails or quality drops.",
        )
        group_size = st.selectbox(
            "Group size",
            options=[32, 64, 128, 256],
            index=2,
            help="Quantization block size for the local MLX build.",
        )
        build_prompt = st.text_area(
            "Sanity-check prompt",
            value="Explain quantization in simple terms",
            height=100,
            help="Prompt used during the build pipeline to verify the converted MLX model still responds coherently.",
        )

    if selected_cached_model:
        st.caption(f"Using cached snapshot: `{selected_cached_model['snapshot_path']}`")

    if st.button("Build / Rebuild MLX Baseline", use_container_width=True):
        with st.spinner("Running MLX build pipeline..."):
            result = run_pipeline(
                model_id=source_model,
                use_turboquant=use_turboquant_first,
                quant_bits=primary_bits,
                fallback_bits=fallback_bits,
                group_size=group_size,
                max_tokens=100,
                prompt=build_prompt,
            )
        if result["ok"]:
            st.success(f"MLX baseline built in {result['elapsed_seconds']:.2f}s")
        else:
            st.error(f"Build failed with exit code {result['returncode']}")
        st.json(result["state"])
        if result["stderr"]:
            st.code(result["stderr"], language="text")

    latest = summarize_latest_run()
    benchmark = latest.get("benchmark")
    if latest:
        st.markdown(
            f"- Latest local build strategy: `{latest.get('strategy') or 'n/a'}`\n"
            f"- Quantized size: `{latest.get('quantized_size') or 'n/a'}`\n"
            f"- Quantization note: `{latest.get('quantization_message') or 'n/a'}`"
        )
    if benchmark:
        col_a, col_b, col_c = st.columns(3)
        col_a.metric("MLX latency", f"{benchmark['mlx_quantized']['latency_seconds']:.3f}s")
        hf = benchmark.get("hf_fp16_baseline")
        col_b.metric("HF baseline", f"{hf['latency_seconds']:.3f}s" if hf else "n/a")
        col_c.metric("MLX speedup", f"{benchmark['speedup_vs_hf']:.2f}x" if benchmark.get("speedup_vs_hf") else "n/a")


def provider_editor(prefix: str, default_provider: str) -> dict[str, str]:
    provider = st.selectbox(
        f"{prefix} provider",
        options=["mlx", "ollama", "turboquant-runtime"],
        index=["mlx", "ollama", "turboquant-runtime"].index(default_provider),
        key=f"{prefix}_provider",
        help="`mlx` uses the local converted model, `ollama` calls your local Ollama server, and `turboquant-runtime` calls an external server that must actually implement TurboQuant.",
    )
    if provider == "mlx":
        model = st.text_input(
            f"{prefix} target",
            value=str(ROOT / "mlx_model"),
            key=f"{prefix}_model",
            help="For MLX, this exact local model directory will be loaded for inference.",
        )
        base_url = ""
    elif provider == "ollama":
        model = st.text_input(
            f"{prefix} target",
            value="llama3.2:3b",
            key=f"{prefix}_model",
            help="For Ollama, this is the local Ollama model name to query.",
        )
        base_url = "http://127.0.0.1:11434"
    else:
        base_url = st.text_input(
            f"{prefix} TurboQuant runtime URL",
            value="http://127.0.0.1:8000/v1",
            key=f"{prefix}_base_url",
            help="OpenAI-compatible base URL for the runtime that actually uses TurboQuant.",
        )
        model = st.text_input(
            f"{prefix} target",
            value="turboquant-model",
            key=f"{prefix}_model",
            help="Model name exposed by the TurboQuant-backed server.",
        )
    return {"provider": provider, "model": model, "base_url": base_url}


with tab_benchmark:
    st.subheader("2. Benchmark Runtime Targets")
    st.write(
        "This is the important comparison stage. The same prompt is sent to two runtime targets so you can compare latency and output quality directly."
    )
    st.markdown(
        "- Use `mlx` for the local converted baseline.\n"
        "- Use `turboquant-runtime` only if you have a real TurboQuant-backed server.\n"
        "- Use `ollama` if you want a separate local serving baseline."
    )
    bench_prompt = st.text_area(
        "Benchmark prompt",
        value="Explain quantization in simple terms",
        height=120,
        help="Same prompt sent to both benchmark targets.",
    )
    bench_tokens = st.slider(
        "Benchmark max tokens",
        min_value=32,
        max_value=256,
        value=96,
        step=8,
        help="Maximum response length used for the benchmark runs.",
    )
    left, right = st.columns(2)
    with left:
        target_a = provider_editor("Target A", "mlx")
    with right:
        target_b = provider_editor("Target B", "turboquant-runtime")

    if st.button("Run Side-by-Side Benchmark", use_container_width=True):
        rows = []
        outputs = {}
        for label, target in [("Target A", target_a), ("Target B", target_b)]:
            try:
                result = run_provider(
                    provider=target["provider"],
                    prompt=bench_prompt,
                    max_tokens=bench_tokens,
                    model=target.get("model"),
                    base_url=target.get("base_url"),
                )
                rows.append(
                    {
                        "target": label,
                        "provider": result["provider"],
                        "model": result.get("model"),
                        "endpoint": result.get("endpoint", ""),
                        "latency_seconds": round(result["latency_seconds"], 3),
                        "output_chars": len(result["output"]),
                    }
                )
                outputs[label] = result
            except Exception as exc:
                rows.append(
                    {
                        "target": label,
                        "provider": target["provider"],
                        "model": target.get("model"),
                        "endpoint": target.get("base_url", ""),
                        "latency_seconds": None,
                        "output_chars": None,
                        "error": str(exc),
                    }
                )
        st.dataframe(pd.DataFrame(rows), use_container_width=True)
        for label, result in outputs.items():
            with st.expander(f"{label} output"):
                st.text_area(f"{label} response", value=result["output"], height=240)
                st.json({k: v for k, v in result.items() if k not in {"output", "raw"}})
                if "raw" in result:
                    st.json(result["raw"])


with tab_chat:
    st.subheader("3. Manual Chat Test")
    st.write("Use this for one-off prompting after you know which target you want to inspect.")
    st.caption("The selected chat target below is the exact runtime used when you click Send Prompt.")
    chat_target = provider_editor("Chat", "mlx")
    chat_prompt = st.text_area(
        "Chat prompt",
        value="Write a short story about space",
        height=140,
        help="Prompt sent to the chosen runtime target.",
    )
    chat_tokens = st.slider(
        "Chat max tokens",
        min_value=32,
        max_value=256,
        value=120,
        step=8,
        help="Maximum response length for manual testing.",
        key="chat_tokens",
    )
    if st.button("Send Prompt", use_container_width=True):
        try:
            result = run_provider(
                provider=chat_target["provider"],
                prompt=chat_prompt,
                max_tokens=chat_tokens,
                model=chat_target.get("model"),
                base_url=chat_target.get("base_url"),
            )
            st.success(f"{result['provider']} responded in {result['latency_seconds']:.2f}s")
            st.text_area("Response", value=result["output"], height=280)
        except Exception as exc:
            st.error(str(exc))


with tab_logs:
    st.subheader("Logs and Artifacts")
    selected_log = st.selectbox(
        "Log file",
        options=[
            "pipeline.log",
            "phase1_environment.log",
            "phase2_acquire_model.log",
            "quantization.log",
            "phase4_convert_to_mlx.log",
            "phase5_run_inference.log",
            "benchmark.log",
            "phase7_quality_check.log",
        ],
        help="Inspect the latest local MLX build and validation logs.",
    )
    st.code(read_text_file(LOGS_DIR / selected_log), language="text")
    st.code(
        "\n".join(
            [
                f"Workspace: {ROOT}",
                f"Local MLX model: {ROOT / 'mlx_model'}",
                f"Logs: {LOGS_DIR}",
                f"State: {ROOT / 'artifacts' / 'pipeline_state.json'}",
                "TurboQuant runtime note: this app expects a separate server if you want real TurboQuant benchmarking.",
            ]
        ),
        language="text",
    )
