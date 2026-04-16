from __future__ import annotations

import argparse

from common import MLX_MODEL_DIR, build_generation_prompt


def main() -> None:
    parser = argparse.ArgumentParser(description="Run MLX inference on the converted model.")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-tokens", type=int, default=100)
    args = parser.parse_args()

    from mlx_lm import generate, load

    model, tokenizer = load(str(MLX_MODEL_DIR))
    prompt = build_generation_prompt(tokenizer, args.prompt)
    output = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens, verbose=False)
    print(output)


if __name__ == "__main__":
    main()
