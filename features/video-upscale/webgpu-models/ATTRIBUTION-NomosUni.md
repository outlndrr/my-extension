# NomosUni model attribution

The following trained models are by **Philip Hofmann (Helaman / Phhofm)**,
licensed by the author under **Creative Commons Attribution 4.0 International**
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). The complete license
text is included in `LICENSE-NomosUni.txt`.

- **2xNomosUni compact OTF Medium** — [author release](https://github.com/Phhofm/models/releases/tag/2xNomosUni_compact_otf_medium),
  released 11 January 2024 according to its model card. The author describes
  JPEG compression, some noise and some blur as its intended degradations.
- **2xNomosUni compact MultiJPG** — [author release](https://github.com/Phhofm/models/releases/tag/2xNomosUni_compact_multijpg)
  and [author model card](https://huggingface.co/Phips/2xNomosUni_compact_multijpg),
  released 13 December 2023 according to its model card. The author describes
  paired training with JPEG degradation down to quality 40 and several resize
  methods.

`nomos-sources.json` pins the author's FP32 opset-17 ONNX files by byte length
and SHA-256. The release tag/commit identifies the publication; the SHA-256
additionally pins each separately uploaded release asset.

Local changes: the FP32 convolution weights, biases and channel PReLU slopes
are extracted from ONNX protobuf and repackaged in the documented SRVG v1
container for the Rust/WASM WebGPU renderer. No training or modification of
the learned FP32 values is performed. The renderer may use FP16 arithmetic;
that runtime choice is separate from the distributed FP32 weights. The renderer
normalizes captured RGB uint8 values to the graph's `[0,1]` input range. Its zero
padding, pixel shuffle, nearest-neighbour source residual and final clamp match
the author's ONNX. The ONNX files themselves
are downloaded only during reproducible preparation, not by the extension.

No author endorsement is implied. These are spatial image models;
no claim is made that they restore ground-truth details or provide temporal
consistency in video. Names and source descriptions identify the checkpoints,
not measured quality or real-time guarantees.
