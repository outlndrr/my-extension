use std::{env, fs, path::PathBuf};

fn main() {
    // A deterministic diagnostic fingerprint, not a security/integrity hash.
    // It lets the popup distinguish a stale loaded WASM module after reloads.
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let mut fingerprint = 0xcbf29ce484222325u64;
    for name in [
        "Cargo.toml",
        "Cargo.lock",
        "build.rs",
        "src/lib.rs",
        "src/model.rs",
        "src/shaders.rs",
        "src/precision.rs",
        "src/srvg.rs",
        "src/srvg_shaders.rs",
    ] {
        println!("cargo:rerun-if-changed={name}");
        let bytes = fs::read(root.join(name)).expect("WASM source fingerprint input");
        for byte in name.bytes().chain([0]).chain(bytes) {
            fingerprint ^= u64::from(byte);
            fingerprint = fingerprint.wrapping_mul(0x100000001b3);
        }
    }
    println!("cargo:rustc-env=UPSCALE_ENGINE_BUILD=rust-webgpu-{fingerprint:016x}");
}
