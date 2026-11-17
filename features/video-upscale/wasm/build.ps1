param([switch]$Test)
$ErrorActionPreference = "Stop"
$crateRoot = $PSScriptRoot
Push-Location -LiteralPath $crateRoot
try {
  if ($Test) {
    cargo test --locked
    if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
  }
  cargo build --locked --release --target wasm32-unknown-unknown
  if ($LASTEXITCODE -ne 0) { throw "Rust/WASM build failed." }
  wasm-bindgen --target web --out-dir pkg --out-name upscale_wasm target/wasm32-unknown-unknown/release/upscale_wasm.wasm
  if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen generation failed. Install wasm-bindgen-cli 0.2.118." }
} finally {
  Pop-Location
}
