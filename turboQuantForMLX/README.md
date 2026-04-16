# turboQuantForMLX

Phased MLX-compatible quantized LLM pipeline for Apple Silicon.

## Quick start

```bash
python3 scripts/pipeline.py
```

## UI

```bash
.venv/bin/streamlit run app.py
```

The UI lets you:

- toggle TurboQuant on or off before running the pipeline
- switch providers between MLX and Ollama
- swap the Hugging Face model used for conversion
- test prompts and inspect logs in one place

## Default model

The pipeline defaults to `TinyLlama/TinyLlama-1.1B-Chat-v1.0` so the end-to-end flow is practical on local Apple Silicon. Override it with:

```bash
MODEL_ID=mistralai/Mistral-7B-v0.1 python3 scripts/pipeline.py
```

## Direct phase execution

```bash
python3 scripts/phase1_environment.py
python3 scripts/phase2_acquire_model.py
python3 scripts/phase3_quantize.py
python3 scripts/phase4_convert_to_mlx.py
python3 scripts/phase5_run_inference.py
python3 scripts/benchmark.py
python3 scripts/phase7_quality_check.py
```

## Output locations

- `mlx_model/`
- `logs/quantization.log`
- `scripts/run_inference.py`
- `scripts/benchmark.py`
