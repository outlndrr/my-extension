# Rust/WASM WebGPU engine

The extension ships the generated `pkg/upscale_wasm.js` and
`pkg/upscale_wasm_bg.wasm`, so loading the unpacked extension does not require
Rust. The module parses the pinned trained WebSR and NomosUni CNN weights, creates WGSL
pipelines and GPU buffers, imports video textures and submits every model pass
from Rust. JavaScript handles video lifecycle and supplies a `VideoFrame`.

The browser API is called directly through `wasm-bindgen` bindings. The stable
wgpu release inspected during implementation did not yet expose the browser
`VideoFrame` external-texture import provided on its development branch. Direct
WebGPU bindings preserve that import without an unreleased Git dependency or
copying source pixels into WASM memory.

```js
import init, { GpuUpscaler } from "./pkg/upscale_wasm.js";
await init();
const engine = await GpuUpscaler.create(canvas, weightsUint8Array, width, height);
const frame = new VideoFrame(video);
try {
  const { elapsedMs } = await engine.render(frame);
} finally {
  frame.close();
}
console.log(engine.info);
engine.destroy();
engine.free();
```

`render` waits for GPU completion, rejects concurrent frames, and resizes its
resources when the source dimensions change. It accepts an HTMLVideoElement as
well, but a VideoFrame gives the caller an explicit frame lifetime. `destroy`
is idempotent and safe while rendering; a pending render then rejects. Device
loss and uncaptured GPU errors reject subsequent renders. The caller owns the
source frame and closes it after the render promise settles. Source frames
never pass through `getImageData`, HTTP, or WASM linear memory.

The optional fifth `create` argument is `"auto"` (default), `"float32"` or
`"float16"`. Auto selects float16 only when the adapter exposes `shader-f16`
and requests that feature when creating the device. Otherwise it uses float32.
Explicit float16 rejects an unsupported GPU. The selected path is reported in
`engine.info.precision`; force float32 for a controlled A/B comparison.

`engine.info` also reports the adapter's disclosed vendor/architecture/device,
the requested power preference and precision, shader-f16 support, and a
deterministic engine build fingerprint. `high-performance` is a browser hint;
it does not guarantee selection of a particular GPU. An unavailable fallback
adapter flag is `null`, rather than an assumed hardware adapter.

Each successful `render` reports `submitMs` (wall time for synchronous frame
setup, command encoding and submission), `validationWaitMs` (awaiting the
validation scope), and `completionWaitMs` (subsequent wait for
`onSubmittedWorkDone`). These consecutive intervals sum to `elapsedMs`.
Waiting includes browser/GPU scheduling and callback delivery; it is **not a
GPU kernel measurement**. No timestamp-query or pixel readback is added by
these diagnostics. The JavaScript caller measures capture, queuing and
continuation delay outside this Rust method separately.

The trained 8/16-channel networks run seven 3x3 stages, CReLU, a final 1x1
projection, 2x pixel shuffle and a Catmull–Rom bicubic source residual
(`a = -0.5`). The source uses the pinned upstream DisplayLayer3C's 4x4 nearest
taps and remains unclipped until the CNN residual is added. The float16 path
packs weight matrices and feature buffers as binary16 and uses half matrix
products; sums across taps/groups, biases and the final source residual remain
float32. The fallback uses float32 throughout. Model conversion happens once
at initialization, with round-to-nearest/ties-to-even and overflow checks.
Every convolution explicitly clamps edge taps and agrees with the independent
CPU references. This differs from the pinned upstream hidden convolutions,
which skip out-of-bounds taps (zero padding); border parity is not claimed. Weight
provenance and checksums live in `../webgpu-models/`.

The separate SRVGGNetCompact path accepts the two trained NomosUni models.
It runs 18 zero-padded 3x3 convolutions: RGB to 64 channels, sixteen 64-channel
hidden layers, then 12 output channels. The first 17 layers use their learned
per-channel PReLU slopes. Pixel shuffle produces 2x RGB, then adds the original
nearest-neighbor RGB sample before final clamping. This path does not use the
WebSR model's CReLU, source bicubic interpolation or replicate padding.

SRVG v1 model files contain little-endian `SRVG`, u32 version/scale/channels/
convolution-count, then each layer's u32 input/output/kernel/PReLU counts and
float32 OIHW weights, biases and slopes. Rust validates topology, finite values
and the complete payload, then packs matrix blocks once. Weights use storage
buffers because the 64-channel kernels exceed the uniform binding limit.
Two feature buffers alternate between hidden layers; a third, smaller buffer
holds the 12-channel prediction. Shapes, pipelines and bind groups are reused.
Hidden convolutions share an input tile across output-channel groups; each
thread computes 2x2 pixels and reuses each weight matrix four times. Feature
buffers store vec4 channel planes for adjacent pixel access. Shared workgroup
memory stays within 16 KiB in both precision modes; border lanes participate
in the load barrier before masking out-of-frame output stores.
At 1280x720 this uses about 246 MiB of feature/prediction storage in float16
(492 MiB in float32). This is memory accounting, not a throughput estimate.
The device requests the required storage/buffer limits supported by its
adapter; oversized initial frames or resizes fail explicitly without changing
the source resolution. `engine.info.architecture` distinguishes the pipelines.

Input is limited to 1920x1080 pixels and output is always 2x; one frame may be
in flight. WebSR keeps seven feature buffers bounded by source size. At
1280x720, these occupy about 98 MiB for the 8-channel network and 197 MiB for the
16-channel network in float16 (197/394 MiB in float32). This is not a claim of real-time speed: measure complete
frame processing and actual displayed FPS on the target GPU.

## Rebuild

Install Rust with `wasm32-unknown-unknown` and
`cargo install wasm-bindgen-cli --version 0.2.118 --locked`. Then run either:

```powershell
./build.ps1 -Test
```

```bash
bash ./build.sh --test
```

Cargo.lock and the wasm-bindgen version pin the generated loader/toolchain
interface. The runtime dependencies are wasm-bindgen, wasm-bindgen-futures
and js-sys; there is no JavaScript inference library or native helper.
The selected MIT notices for the runtime dependencies are retained in
[`licenses/`](licenses/). The wasm-bindgen notice also covers its js-sys and
wasm-bindgen-futures workspace crates; the futures notice covers futures-core,
futures-task and futures-util. Model notices are separate in `../webgpu-models/`.
