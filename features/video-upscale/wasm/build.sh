#!/usr/bin/env bash
set -euo pipefail
crate_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$crate_dir"
if [[ "${1:-}" == "--test" ]]; then
  cargo test --locked
  shift
fi
if [[ "$#" -ne 0 ]]; then
  printf 'Usage: %s [--test]\n' "$0" >&2
  exit 2
fi
cargo build --locked --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg --out-name upscale_wasm target/wasm32-unknown-unknown/release/upscale_wasm.wasm
