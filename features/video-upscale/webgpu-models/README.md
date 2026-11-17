# Trained models for the Rust/WASM WebGPU renderer

These are **trained super-resolution CNN weights**, bundled locally and used
without runtime downloads.

| Popup ID | Upstream model | Channels | Parameters | Scale | Bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| `webgpu-fast` | WebSR CNN S | 8 | 8,612 | 2x | 34,865 |
| `webgpu-quality` | WebSR CNN M | 16 | 31,036 | 2x | 124,893 |
| `webgpu-nomos-medium` | NomosUni Compact OTF Medium | 64 | 600,652 | 2x | 2,402,916 |
| `webgpu-nomos-multijpg` | NomosUni Compact MultiJPG | 64 | 600,652 | 2x | 2,402,916 |

The wider model costs more GPU work; its name is not a measured quality
guarantee. The two WebSR models are separate from the two NomosUni checkpoints.
NomosUni has 18 convolution layers and substantially more GPU work.
Live-action restoration,
temporal stability and face/detail preservation must be assessed on actual
footage. The upstream documentation does not specify a training dataset for
the WebSR binary checkpoints; no CC0-training claim is made here.

## NomosUni provenance and reproduction

The two NomosUni models are trained **SRVGGNetCompact** checkpoints by
**Philip Hofmann (Helaman / Phhofm)**, distributed under **CC BY 4.0**. See
`ATTRIBUTION-NomosUni.md` for author links, source descriptions and local changes;
`LICENSE-NomosUni.txt` contains the complete license. The author's descriptions
associate Medium with JPEG compression, some noise and blur, and MultiJPG with
paired JPEG/multiscale degradation. These descriptions are not quality promises.

`nomos-sources.json` pins the author's FP32 opset-17 ONNX release files:

- Medium SHA-256: `69c5d780acf2fa5814ef6eaa76822ab8c5439641d21f2c80be16c0ff5e9c1992`.
- MultiJPG SHA-256: `cee03eb5411dab817dc7d48e5221813910994af4fd16fd39d3b3ec22b2cf9177`.

`prepare-nomos.py` downloads only those ONNX protobuf assets into an explicit
cache, verifies hashes before parsing, and validates the entire connected graph.
It rejects external tensors, custom functions, unexpected constants, topology,
padding, resampling or nonfinite weights. It never loads a PyTorch pickle.
All 600,652 FP32 weights/biases/PReLU slopes are preserved without training or
quantization. Existing binary mismatches fail instead of being overwritten.

```sh
# Preparation dependencies only; the extension uses the bundled binary files.
python -m pip install numpy onnx==1.20.1
python features/video-upscale/webgpu-models/prepare-nomos.py --source-dir node_modules/.upscale-integration/nomos-source
```

`--write-catalogue` explicitly refreshes derived metadata during a reviewed
export; ordinary reproduction verifies it. `prepare-models.py` below remains
the dependency-free preparer for the two WebSR files.

### SRVG v1 container and numerical contract

All integers and floats are little-endian, with no alignment padding:

1. `SRVG` magic, then `u32 version=1`, `scale=2`, `channels=64`, `convCount=18`.
2. For each convolution: `u32 inputChannels`, `outputChannels`, `kernel=3`,
   `preluLength`, then FP32 OIHW convolution weights (`out,in,ky,kx`), output
   biases and PReLU slopes. Tap order is Y-major, unlike WebSR's packed matrices.
3. Layer channels are `3→64`, sixteen `64→64`, and `64→12`. The first 17 layers
   have 64 learned channel slopes; the last has none. No trailing bytes exist.

Input is RGB normalized to `[0,1]`. Every convolution uses **zero padding**
of one pixel, stride/dilation one. PReLU multiplies negative values by its
learned channel slope. The 12 final channels use PyTorch `pixel_shuffle(2)` /
ONNX DepthToSpace `CRD`: channel `rgb*4 + dy*2 + dx`. This CNN residual is added
to nearest-neighbour RGB (`asymmetric`, `floor`, scale 2), then clamped to
`[0,1]`, with opaque alpha. No bicubic residual or replicate padding is used.

### NomosUni independent CPU reference

`reference-nomos.py` executes the **unmodified author ONNX** with only
`CPUExecutionProvider`, then independently executes the deserialized SRVG weights
through PyTorch `conv2d`, `prelu` and `pixel_shuffle`. Both use two CPU threads.
Checks cover colour corners/hard edges at 32x24, odd 17x13, 1x1 and 5x3 sizes.
The measured maximum final difference was below `4.8e-6`, at most one uint8 level.
`reference/nomos-manifest.json` records provenance, errors and hashes; its expected
RGBA8 and float HWC outputs come from original ONNX, not the custom renderer.

```sh
python -m pip install onnxruntime==1.23.2 torch
python features/video-upscale/webgpu-models/reference-nomos.py --source-dir node_modules/.upscale-integration/nomos-source
# Optional same-source CPU comparison; Pillow is required for PNG I/O.
python features/video-upscale/webgpu-models/reference-nomos.py --source-dir node_modules/.upscale-integration/nomos-source --image node_modules/.upscale-integration/cpu-source-frame123.png --output-dir node_modules/.upscale-integration
```

The browser numerical check uses tolerance two uint8 levels. Both models at
32x24 and 17x13, FP16 and forced FP32, matched within **one** level on NVIDIA
Ampere (`rust-webgpu-45be86343bf9aed5`); this checks implementation correctness,
not throughput, temporal consistency or restoration against a high-resolution
ground truth. GPU speed on full video must be measured separately.

## Provenance and reproduction

Files are byte-identical to WebSR commit
`ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd`:

- [CNN S](https://github.com/sb2702/websr/blob/ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd/weights/websr/cnn-s.bin)
- [CNN M](https://github.com/sb2702/websr/blob/ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd/weights/websr/cnn-m.bin)
- [Upstream model description and checksums](https://github.com/sb2702/websr/blob/ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd/WEIGHTS.md)
- [Upstream MIT license](https://github.com/sb2702/websr/blob/ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd/LICENSE), copied in `LICENSE-WebSR.txt`.

`catalogue.json` pins the byte lengths, SHA-256 digests, author and source.
`prepare-models.py` fetches a missing file from that exact commit and verifies
its hash, complete container, finite parameters and layer shapes. Existing
files with mismatched hashes are rejected, not silently overwritten.

```sh
python features/video-upscale/webgpu-models/prepare-models.py
```

The preparation step uses Python's standard library. It performs no weight
conversion, quantization or retraining. SeeB4's similarly named assets are not
the source used here: its README and license have conflicting statements about
weight redistribution, while WebSR publishes these files with its MIT source.

## Model and numerical contract

The original **A4K v1** little-endian container is preserved: four-byte magic
`A4K\0`, version, layer count, followed by named weight and bias arrays. Records
are not aligned. Each record stores `u32 nameLength`, UTF-8 name,
`u32 weightCount`, `u32 biasCount`, then float32 weights and biases. Width is
inferred from the number of `conv2d_tf*` first-stage groups; each group has four
channels.

There are seven 3x3 convolution stages. The first reads normalized RGB plus
an alpha channel with zero weights. Each subsequent stage reads the positive
and negative halves of the previous stage (CReLU), retaining signed outputs.
Three final 1x1 convolutions read CReLU features from all seven stages and
produce four subpixels for each of R, G and B. Their residual is added to a
Catmull–Rom bicubic 2x sample of the original (`a = -0.5`), matching the pinned
[DisplayLayer3C](https://github.com/sb2702/websr/blob/ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd/src/layers/anime4k/display_3c.ts)
used by both upstream networks. The source interpolation is not clipped before
adding the CNN residual. The result is clamped to `[0,1]`; output
alpha is opaque.

- All spatial reads use explicit **clamp-to-edge** padding. This is a deliberate
  boundary contract: the pinned upstream hidden convolution shaders skip
  out-of-bounds taps (zero padding), while the first layer reads its external
  texture directly. Our replicate padding differs near image borders; matching
  the display interpolation does not establish complete upstream border parity.
- 3x3 taps are ordered by X first: `(-1,-1), (-1,0), (-1,1), (0,-1), ...`.
- Each packed 4x4 matrix is column-major (`inputChannel * 4 + outputChannel`).
- Hidden-stage blocks are positive channel groups, then negative groups; each
  block contains nine matrices.
- Output blocks are stage-major, with positive then negative groups per stage.
- Subpixel index is `(outputX % 2) + 2 * (outputY % 2)`.
- Source coordinates are `(outputCoordinate + 0.5) / 2 - 0.5`. The bicubic
  sampler uses 4x4 nearest taps, clamped image edges, and no input downscaling.

## Independent CPU reference

`reference.py` reconstructs the CNN using PyTorch NCHW `conv2d`, replicate
padding and `pixel_shuffle`. It independently compares every stage and final
output against NumPy matrix loops before writing reference vectors. The
Catmull–Rom reference separately checks exact quarter-phase coefficients
against the upstream 4x4 polynomial, including saturated RGB corners,
clamp-edge coefficients, overshoot and constant images. It does not use
PyTorch's bicubic resize, which has a different cubic parameter. On both
models and both inputs, the output difference was below `3e-7` in `[0,1]`.
That validates the conversion/layout, not subjective restoration quality.

```sh
# Only needed to regenerate the reference vectors, not to use the extension.
python -m pip install numpy torch
python features/video-upscale/webgpu-models/reference.py
```

The checked-in `reference/manifest.json` describes opaque RGBA8 inputs at
32x24 and odd 17x13 dimensions, 2x RGBA8 expected outputs, and
float32 RGB output files (`.f32`, little-endian, interleaved HWC). Fixtures mix
colour gradients, hard edges, checkerboard detail and corner pixels. The
browser test can compare GPU canvas output against these references with an
absolute tolerance of two uint8 levels for GPU arithmetic/rounding. A video
conversion through YUV should be measured separately from this raw-RGB check.
