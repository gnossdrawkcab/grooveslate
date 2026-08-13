"""Low-memory launcher for the packaged BS-RoFormer inference CLI."""

from __future__ import annotations

from argparse import ArgumentParser
from pathlib import Path
import os
import re


def write_inference_config(source: Path, destination: Path, chunk_size: int) -> None:
    if chunk_size < 131072 or chunk_size % 512:
        raise ValueError("RoFormer chunk size must be at least 131072 and divisible by 512")
    configured, replacements = re.subn(
        r"(?m)^(\s*chunk_size:\s*)\d+[ \t]*$",
        rf"\g<1>{chunk_size}",
        source.read_text(encoding="utf-8"),
        count=1,
    )
    if replacements != 1:
        raise RuntimeError("The RoFormer config does not contain one inference chunk_size")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(configured, encoding="utf-8")


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("--input_folder", type=Path, required=True)
    parser.add_argument("--store_dir", type=Path, required=True)
    parser.add_argument("--models_dir", type=Path, required=True)
    parser.add_argument("--chunk_size", type=int, required=True)
    args = parser.parse_args()

    # Keep the verified checkpoint on the persistent data volume, then derive
    # a config that only changes inference-window memory usage.
    from bs_roformer import DEFAULT_MODEL, ensure_model_assets

    model_path, source_config = ensure_model_assets(
        DEFAULT_MODEL,
        models_dir=args.models_dir,
    )
    tuned_config = args.models_dir / f"BS-Rofo-SW-{args.chunk_size}.yaml"
    write_inference_config(source_config, tuned_config, args.chunk_size)
    os.execvp(
        "bs-roformer-infer",
        [
            "bs-roformer-infer",
            "--model_path",
            str(model_path),
            "--config_path",
            str(tuned_config),
            "--input_folder",
            str(args.input_folder),
            "--store_dir",
            str(args.store_dir),
            "--device",
            "cuda",
        ],
    )


if __name__ == "__main__":
    main()
