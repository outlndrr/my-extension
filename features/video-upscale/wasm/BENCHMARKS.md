# Browser WebGPU measurements — 2026-11-14

Local RTX 3060 Laptop (6 GiB), headless Chromium for Testing 156.0.8078.4 with the unpacked extension and
hardware WebGPU (`nvidia`, `ampere`, not a fallback adapter). Desktop
applications remained open. These are short playback checks, not a sustained
whole-episode thermal benchmark.

The actual recording is **852 x 480, 25 fps**. The 1280 x 720 workload was
created by resizing that recording; it tests GPU load and dimensions, not
restoration quality on a native-720p recording. Output dimensions are
1704 x 960 and 2560 x 1440 respectively. No input downscaling is used.

## What is measured

After two seconds of warmup, eight seconds of playback are sampled with
`requestAnimationFrame`. Displayed FPS counts distinct enhanced media timestamps
observed on the canvas, rather than inference calls or repeated draws of the
same frame. The original video continues at 25 fps. Processing latency covers
VideoFrame creation, any wait in the single-frame slot, Rust/WASM command submission, waiting for GPU completion
and the content-script completion handler; it is not GPU timestamp-query time.

The pipeline imports a VideoFrame texture, runs the trained CNN and renders
to the GPU canvas. There is no native helper, HTTP frame transfer or per-frame
CPU pixel readback. Numerical tests read back small outputs separately.

## Final FP16 path

Auto precision selected `shader-f16` on this GPU. Feature buffers, weight
matrices and matrix products use float16; accumulation across taps/groups,
bias and the source residual use float32. One GPU render and one latest waiting
VideoFrame are allowed. A new frame replaces and closes an older waiting one;
completion immediately starts the pending frame if it is still current.

| Model | Input | Displayed FPS | Processing median | p95 |
| --- | --- | ---: | ---: | ---: |
| Fast, 8 channels | 852 x 480 | 24.84 | 8.9 ms | 12.5 ms |
| Quality, 16 channels | 852 x 480 | 24.99 | 16.1 ms | 19.6 ms |
| Fast, 8 channels | 1280 x 720 workload | 25.00 | 12.3 ms | 15.5 ms |
| Quality, 16 channels | 1280 x 720 workload | 24.87 | 29.0 ms | 31.7 ms |

Displayed timestamps matched available source timestamps in three runs;
Fast 480p showed one fewer frame over eight seconds. These results support
approximately 25 fps for this short local workload, not a guarantee of zero
drops on other sites, frame rates or during sustained laptop throttling.

Before the waiting slot, FP16 Quality 720p measured 29.7 ms median / 32.7 ms
p95 and 23.71 displayed fps. Occasional 33/50 ms callback intervals meant that
a frame could arrive just before the previous GPU task finished. The one-frame
slot absorbs that scheduling jitter. It does not make sustained processing
slower than the source rate lossless; outdated waiting frames are replaced.

Full final lifecycle checks ran on Fast 480p and Quality 720p. The other two
rows are final performance checks; their full lifecycle checks also passed
before the waiting-slot change. All final runs kept at most two VideoFrames
and one GPU task, with no backward timestamps, canvas disappearances, page/GPU
errors or native-helper requests.

The measured WASM SHA-256 was
`d0107ef0eeff7bbed0658d197a70e5badcde562204267ed8b13b3229e1c00b1c`.

Subsequent diagnostic-only builds are not the measured binary above. They expose
the selected WebGPU adapter, precision, frame sizes and separate capture, queue,
submission, validation and completion waits in the popup. These waits are browser
API timings, not GPU kernel timestamp measurements.

The user's Helium session initially selected Intel Iris Xe and reported Fast at
15/25 fps on 720p. After switching the browser to NVIDIA, the user reported smooth
Quality playback. This is user feedback, not a new controlled benchmark. The
`high-performance` adapter request is a preference and does not guarantee a
discrete GPU. The user also reported that the visual improvement remained subtle;
frame rate alone does not establish useful restoration quality.

## FP32 baseline

| Model | Input | Displayed FPS | Processing median | p95 |
| --- | --- | ---: | ---: | ---: |
| Fast, 8 channels | 852 x 480 | 25.00 | 12.9 ms | 18.7 ms |
| Quality, 16 channels | 852 x 480 | 24.87 | 22.3 ms | 25.1 ms |
| Fast, 8 channels | 1280 x 720 workload | 24.99 | 15.5 ms | 17.9 ms |
| Quality, 16 channels | 1280 x 720 workload | 12.62 | 51.3 ms | 55.2 ms |

At 25 fps a source frame arrives every 40 ms. With one GPU frame in flight,
the FP32 Quality 720p path is still busy at the next callback and skips it;
it therefore presents roughly every other source frame. A buffer alone does
not make that model real time. Earlier Fast 480p checks varied from 9.8 to
14.4 ms median, illustrating background-load variation on this laptop.

A diagnostic texture-import/render-only path, without the CNN, measured
25 displayed fps and 4.4 ms median / 6.2 ms p95 on the same 480p source.
That isolates browser transport overhead; it is not an AI-upscaling result.

## Correctness and player checks

Both networks in automatic FP16 and forced FP32 were compared with independent
PyTorch/NumPy references on 32 x 24 and odd 17 x 13 RGB inputs (eight cases).
Maximum output error was one uint8
level; the FP32 baseline had approximately 63–64 dB PSNR relative to the mathematical reference.
This validates implementation/rounding, not reconstruction quality against
high-resolution ground truth. Alpha was opaque and resize was correct.

**Reference limitation found during the visual-quality investigation:** the
measured revision and its CPU reference both added CNN residuals to a bilinear
source resize. The pinned upstream WebSR `DisplayLayer3C`, used by both bundled
networks, uses Catmull–Rom bicubic instead. Therefore the numerical agreement
above did not establish parity with upstream's final display stage. The
historical performance table and screenshots describe that bilinear revision.

The corrected Catmull–Rom display stage was checked separately in build
`rust-webgpu-bf50d88572e4cee0`, WASM SHA-256
`06471ab67c0486bd933135bc92130951664e380f6b4c159a8d919cf82823dffe`.
All eight small RGB cases (both models, 32x24 / 17x13, automatic FP16 /
forced FP32) matched the regenerated CPU references within one uint8 level.
The CPU reference also checks the resize against independent separable
Catmull–Rom coefficients, including coloured edges and overshoot before final
clamping. Device loss, destroy and recreation passed. These are correctness
checks; full-video performance has not been remeasured after this correction.

Checks covered readable Blob, real MediaSource with 24 appends, seeking,
episode changes, inherited srcdoc frames, native controls/fullscreen, CORS
rejection and original-player state. All four playback runs had no backward
timestamps, canvas disappearances during the measured interval, page errors,
or native-helper requests. Paused frames remain visible. Destroy during work,
device loss and creating a new engine after loss were also checked.

Same-frame 480p visual comparisons at 5 seconds showed more defined hair and
clothing edges with Quality than the browser-scaled original; this is a
subjective single-frame observation. These small CNNs do not establish recovery
of missing texture or temporal consistency across an episode.

Detailed JSON reports and private screenshots remain ignored under
`node_modules/.upscale-integration/`: `wasm-validation-summary.json` records
the detailed report paths; same-frame comparisons are in `wasm-*-5s.png`.
Only the public extension popup screenshot is included in repository assets.

For the bicubic investigation, four new CPU images were generated from the same
decoded frame (index 123, PTS 5.007969 s, 852x480): bilinear, Catmull–Rom, and the
same Quality CNN residual added to each base. All four outputs are 1704x960 and
are stored as `cpu-frame123-*.png`; provenance is in
`cpu-frame123-comparison.json`. They are a consistent comparison with each other,
not an exact timestamp match to the historical browser screenshots. On this
frame, the display correction changes the output by a mean 0.115/255 per colour
component; Quality differs from plain Catmull–Rom by a mean 0.574/255. These
measure change magnitude, not restoration quality. The visual difference remains
modest. `wasm-quality-comparison.html` offers a slider, the old/new display paths,
and a comparison isolating the CNN contribution from interpolation.

The final changes passed 135 Node tests and two Rust engine tests. The WASM
release built successfully and the Bash build script passed its syntax check.
The native TensorRT service was not modified for this path.

## Nomos SRVGG measurements

These separate measurements cover **NomosUni Compact Medium and MultiJPG**,
64 channels and 18 convolutions, on the same RTX 3060 Laptop. Automatic precision
selected FP16. The selected implementation uses the third revision below: shared
input tiles and 2 x 2 output pixels per invocation. The source was 852 x 480;
the 1280 x 720 runs used a resized copy to test the larger workload, **not native
720p footage for evaluating restoration quality**. Both sizes produce ×2 output.

The isolated Medium test repeatedly rendered the same decoded RGB frame
(frame 123, PTS 5.007969 s), with two warmup calls and five measured calls. Times cover the
wall duration of `GpuUpscaler.render`, including command submission and waiting
for completion. They exclude live-video capture, the waiting-frame slot and
browser presentation, and are not GPU timestamp-query timings. With only five
samples, p95 is effectively the slowest measured call, not a reliable estimate
of a long-running tail.

| Hidden-convolution variant at 852 x 480 | Engine build suffix | Isolated render median | p95 |
| --- | --- | ---: | ---: |
| Baseline | `45be86343bf9aed5` | 463.6 ms | 469.5 ms |
| Shared input tile | `ffaba0c99c3dd740` | 368.7 ms | 371.9 ms |
| Shared input, 2 x 2 output pixels per invocation | `875efe92761848be` | 166.8 ms | 168.5 ms |

With the same selected revision and method, Medium at 1280 x 720 measured
**381.1 ms median / 392.5 ms p95** per isolated render. These timings are not live FPS.

The selected revision was also tested separately during real playback: two seconds
of warmup followed by an eight-second observation window. This measures distinct
enhanced timestamps actually observed on the canvas, using the same definition
as the WebSR playback checks above.

| Model and input | Source FPS | Displayed FPS | Total frame latency median | p95 |
| --- | ---: | ---: | ---: | ---: |
| Medium, 852 x 480 | 25.00 | 5.87 | 191.5 ms | 212.5 ms |
| MultiJPG, 852 x 480 | 24.87 | 5.75 | 193.1 ms | 217.7 ms |
| Medium, resized 1280 x 720 | 24.87 | 0 | — | — |
| MultiJPG, resized 1280 x 720 | 25.00 | 0 | — | — |

**Neither model is real-time 25 fps in these tests.** At 480p, the displayed result
was about 6 fps. At 720p, every moving result exceeded the 300 ms freshness limit:
the overlay stayed hidden and the original video continued. Both 720p performance
assertions failed with `No moving frames displayed`; those runs are not recorded
as successful playback. Their live-latency cells are empty because no enhanced
moving frames reached the display. A paused preview did render for both models
at both sizes; the two 720p previews took about 426–429 ms.

Total live latency includes capture and waiting for the current GPU operation,
so it differs from isolated render time. Across these runs, the queue remained
bounded at one active render and one waiting frame; no native requests or
page/GPU errors were recorded. The Medium 480p run additionally passed the full
functional checks: seek, episode changes, Blob/MSE, native controls/fullscreen,
inherited srcdoc and stopping. These checks establish player integration, not
real-time throughput. GPU temperature reached 82–85 °C in the later live runs;
the short observation windows do not establish sustained episode performance.

For quality comparison with a slow model, pause the original video and allow the
still frame to finish. During playback, a waiting-slot replacement counts as a
skipped frame and an expired completed result counts as rejected. Neither a
larger queue nor a functional test pass establishes real-time playback.

The third revision's WASM SHA-256 was
`f8640dfa7b06d4ae24e271dd0cf2bc28bb9c9d8d032594f6e390e65cab764f04`.
Ignored evidence files under `node_modules/.upscale-integration/`:

- `nomos-engine-bench-webgpu-nomos-medium-852x480-baseline-1794667051062.json`
- `nomos-engine-bench-webgpu-nomos-medium-852x480-sharedtile-1794667058692.json`
- `nomos-engine-bench-webgpu-nomos-medium-852x480-shared2x2-1794667290733.json`
- `nomos-browser-webgpu-nomos-medium-480p-lifecycle-1794667339976.json`
- `nomos-engine-bench-webgpu-nomos-medium-1280x720-final-1794667466725.json`
- `nomos-browser-webgpu-nomos-medium-720p-perf-1794667484099.json`
- `nomos-browser-webgpu-nomos-multijpg-480p-perf-1794667502757.json`
- `nomos-browser-webgpu-nomos-multijpg-720p-perf-1794667522400.json`

Any subsequent kernel must be checked numerically and measured again before
these values are attributed to it.
