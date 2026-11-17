# Video upscale assets

Neural inference runs in the browser's Rust/WASM WebGPU engine. The extension
does not ship ONNX Runtime Web. The browser model catalogue pins the WebSR and
NomosUni weights; Node tests verify their sizes and SHA-256 hashes.

## Browser WebGPU models and Rust/WASM

The trained **WebSR CNN S** (8 channels) and **CNN M** (16 channels) are bundled
unchanged from Sam Bhattacharyya's WebSR repository at commit
`ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd`, under its MIT license. The
[browser model catalogue](webgpu-models/catalogue.json) records source URLs,
hashes and dimensions; [model documentation](webgpu-models/README.md) describes
the seven-stage CReLU graph and numerical checks. They are different trained
networks from NomosUni. No training-dataset or live-action
quality claim is inferred from the network architecture.

The Rust implementation generates WGSL passes from the same weight layout,
with explicit clamp-to-edge reads. It does not bundle the WebSR JavaScript
runtime. Runtime dependencies are wasm-bindgen, wasm-bindgen-futures and
js-sys, pinned in [Cargo.lock](wasm/Cargo.lock); their MIT notices and those of
transitive runtime dependencies are under [wasm/licenses](wasm/licenses/).
Generated WASM/JavaScript bindings are bundled under `wasm/pkg/`. See
[engine and rebuild instructions](wasm/README.md).

The browser also bundles **2xNomosUni Compact OTF Medium** and
**2xNomosUni Compact MultiJPG**, by Philip Hofmann (Helaman / Phhofm / Phips),
under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

- [OTF Medium author release](https://github.com/Phhofm/models/releases/tag/2xNomosUni_compact_otf_medium)
- [MultiJPG author model card](https://huggingface.co/Phips/2xNomosUni_compact_multijpg)

Local modifications extract the trained FP32 parameters into an SRVG binary
container and implement the SRVGGNetCompact graph in Rust/WGSL. Weights are not
retrained; the optional FP16 path packs them at initialization. These models use
zero-padded convolutions, learned channel-wise PReLU, 2x pixel shuffle and a
nearest-neighbour source residual. The browser catalogue records the source and
converted hashes; reproduction and reference checks are documented alongside
the model files. Their licences require attribution when redistributing them.
