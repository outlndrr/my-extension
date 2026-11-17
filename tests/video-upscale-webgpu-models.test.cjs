const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const directory = "features/video-upscale/webgpu-models";
const catalogue = JSON.parse(readFileSync(`${directory}/catalogue.json`, "utf8"));
const websr = catalogue.filter((model) => model.id === "webgpu-fast" || model.id === "webgpu-quality");
const nomos = catalogue.filter((model) => model.format === "SRVG");
const commit = "ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("WebGPU bundles the two pinned trained WebSR checkpoints with matching model metadata", () => {
  const expected = [
    { id: "webgpu-fast", file: "websr-cnn-s.bin", bytes: 34865, channels: 8, parameters: 8612,
      sha256: "3292fbd7ab62c862bd44e59b3aa3e69bed51f6d90441f5d8c904c400c7842b00" },
    { id: "webgpu-quality", file: "websr-cnn-m.bin", bytes: 124893, channels: 16, parameters: 31036,
      sha256: "f5d1c334dd486640c562fc6390cb89a6258f1c057d58fd8d56c36d18ac1c3cf1" },
  ];
  assert.equal(websr.length, expected.length);
  for (const pinned of expected) {
    const model = catalogue.find((item) => item.id === pinned.id);
    assert.ok(model, pinned.id);
    for (const [key, value] of Object.entries(pinned)) assert.equal(model[key], value, `${pinned.id}.${key}`);
    assert.equal(model.scale, 2);
    const bytes = readFileSync(`${directory}/${model.file}`);
    assert.equal(bytes.length, pinned.bytes);
    assert.equal(sha256(bytes), pinned.sha256, "weights must remain byte-identical to the trained upstream checkpoint");
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "A4K\0");
    assert.equal(bytes.readUInt32LE(4), 1);
    assert.equal(bytes.readUInt32LE(8), 7 * pinned.channels / 4 + 3);
  }
});

test("bundled WebGPU checkpoints retain their pinned provenance and MIT notice", () => {
  const license = readFileSync(`${directory}/LICENSE-WebSR.txt`, "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2023 Sam Bhattacharyya/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  for (const model of websr) {
    assert.equal(model.license, "MIT");
    assert.equal(model.author, "Sam Bhattacharyya / WebSR");
    assert.equal(model.sourceCommit, commit);
    const source = new URL(model.source);
    assert.equal(source.protocol, "https:");
    assert.equal(source.hostname, "github.com");
    assert.equal(source.pathname, `/sb2702/websr/blob/${commit}/weights/websr/${model.file.replace("websr-", "")}`);
  }
});

test("independent GPU reference vectors cover both widths and odd image edges with intact expected pixels", () => {
  const manifest = JSON.parse(readFileSync(`${directory}/reference/manifest.json`, "utf8"));
  assert.equal(manifest.padding, "clamp-to-edge");
  assert.equal(manifest.fixtures.length, 4);
  for (const model of websr) {
    assert.deepEqual(manifest.fixtures.filter((item) => item.model === model.id).map(({ width, height }) => [width, height]), [[32, 24], [17, 13]]);
  }
  for (const fixture of manifest.fixtures) {
    const pixels = fixture.width * fixture.height;
    const input = readFileSync(`${directory}/reference/${fixture.input}`);
    const expected = readFileSync(`${directory}/reference/${fixture.expected}`);
    const floatRgb = readFileSync(`${directory}/reference/${fixture.floatRgb}`);
    assert.equal(input.length, pixels * 4);
    assert.equal(expected.length, pixels * 16);
    assert.equal(floatRgb.length, pixels * 4 * 3 * 4);
    assert.equal(sha256(expected), fixture.sha256);
    assert.ok(fixture.numpyTorchMaxAbs < 0.000001);
    assert.ok(fixture.stageMaxAbs < 0.00001);
    for (let offset = 3; offset < expected.length; offset += 4) assert.equal(expected[offset], 255);
  }
});

test("Nomos bundles real author FP32 weights in strict SRVG v1 topology", () => {
  const expected = [
    { id: "webgpu-nomos-medium", file: "nomos-medium.bin", sha256: "f8e3adeee2bcbb3c2d120216db9dd80c505c71da059a848655fd2d3e2c07dab9",
      source: "69c5d780acf2fa5814ef6eaa76822ab8c5439641d21f2c80be16c0ff5e9c1992" },
    { id: "webgpu-nomos-multijpg", file: "nomos-multijpg.bin", sha256: "dc51e16d80904c9b609fb392a08c363b6e20612c96927d0bac4860e746d3b8b6",
      source: "cee03eb5411dab817dc7d48e5221813910994af4fd16fd39d3b3ec22b2cf9177" },
  ];
  assert.equal(catalogue.length, 4);
  assert.equal(nomos.length, 2);
  for (const pinned of expected) {
    const model = nomos.find((item) => item.id === pinned.id);
    assert.ok(model);
    assert.equal(model.file, pinned.file);
    assert.equal(model.sha256, pinned.sha256);
    assert.equal(model.sourceOnnx.sha256, pinned.source);
    assert.equal(model.sourceOnnx.bytes, 2412381);
    assert.equal(model.formatVersion, 1);
    assert.equal(model.architecture, "SRVGGNetCompact");
    assert.equal(model.padding, "zero");
    assert.equal(model.sourceResampling, "nearest");
    const bytes = readFileSync(`${directory}/${model.file}`);
    assert.equal(sha256(bytes), pinned.sha256);
    assert.equal(bytes.length, 2402916);
    assert.equal(model.bytes, bytes.length);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "SRVG");
    assert.deepEqual([4, 8, 12, 16].map((offset) => bytes.readUInt32LE(offset)), [1, 2, 64, 18]);
    let offset = 20;
    let parameters = 0;
    let nonzeroSlopes = 0;
    for (let layer = 0; layer < 18; layer++) {
      const input = layer === 0 ? 3 : 64;
      const output = layer === 17 ? 12 : 64;
      const slopes = layer === 17 ? 0 : 64;
      assert.deepEqual([0, 4, 8, 12].map((position) => bytes.readUInt32LE(offset + position)), [input, output, 3, slopes]);
      offset += 16;
      const weights = input * output * 9;
      for (let index = 0; index < weights + output + slopes; index++) {
        const value = bytes.readFloatLE(offset);
        assert.ok(Number.isFinite(value), `finite layer${layer} parameter${index}`);
        if (index >= weights + output && value !== 0 && value !== 1) nonzeroSlopes++;
        offset += 4;
        parameters++;
      }
    }
    assert.equal(offset, bytes.length, "no truncated or trailing parameter records");
    assert.equal(parameters, 600652);
    assert.equal(model.parameters, parameters);
    assert.ok(nonzeroSlopes > 100, "activation must use the trained per-channel slopes");
  }
});

test("Nomos source provenance and CC BY 4.0 attribution accompany both converted checkpoints", () => {
  const sources = JSON.parse(readFileSync(`${directory}/nomos-sources.json`, "utf8"));
  const attribution = readFileSync(`${directory}/ATTRIBUTION-NomosUni.md`, "utf8");
  const license = readFileSync(`${directory}/LICENSE-NomosUni.txt`, "utf8");
  assert.match(license, /Attribution 4\.0 International/);
  assert.match(attribution, /Philip Hofmann/);
  assert.match(attribution, /Local changes:/);
  assert.match(attribution, /creativecommons\.org\/licenses\/by\/4\.0/);
  for (const model of nomos) {
    assert.equal(model.license, "CC-BY-4.0");
    assert.match(model.author, /Philip Hofmann/);
    assert.deepEqual(model.sourceOnnx, sources.find((source) => source.id === model.id).sourceOnnx);
    assert.match(model.sourceOnnx.url, /^https:\/\/github\.com\/Phhofm\/models\/releases\/download\/2xNomosUni_compact_/);
    assert.match(model.sourceOnnx.file, /_fp32_opset17\.onnx$/);
    assert.match(attribution, new RegExp(model.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Nomos CPU references independently match original author ONNX across RGB edges and odd sizes", () => {
  const manifest = JSON.parse(readFileSync(`${directory}/reference/nomos-manifest.json`, "utf8"));
  assert.equal(manifest.provider, "CPUExecutionProvider");
  assert.equal(manifest.padding, "zero");
  assert.equal(manifest.sourceResampling, "nearest/asymmetric/floor");
  assert.equal(manifest.fixtures.length, 4);
  for (const model of nomos) {
    assert.deepEqual(manifest.contractChecks.filter((item) => item.model === model.id).map(({ width, height }) => [width, height]), [[32, 24], [17, 13], [1, 1], [5, 3]]);
    for (const check of manifest.contractChecks.filter((item) => item.model === model.id)) {
      assert.ok(check.onnxTorchMaxAbs < 0.00001);
      assert.ok(check.onnxTorchUint8MaxAbs <= 1);
    }
  }
  for (const fixture of manifest.fixtures) {
    const model = nomos.find((item) => item.id === fixture.model);
    assert.equal(fixture.sourceOnnxSha256, model.sourceOnnx.sha256);
    assert.equal(fixture.modelSha256, model.sha256);
    const input = readFileSync(`${directory}/reference/${fixture.input}`);
    const expected = readFileSync(`${directory}/reference/${fixture.expected}`);
    const floats = readFileSync(`${directory}/reference/${fixture.floatRgb}`);
    assert.equal(input.length, fixture.width * fixture.height * 4);
    assert.equal(expected.length, input.length * 4);
    assert.equal(floats.length, fixture.width * fixture.height * 4 * 3 * 4);
    assert.equal(sha256(input), fixture.inputSha256);
    assert.equal(sha256(expected), fixture.sha256);
    for (let index = 3; index < expected.length; index += 4) assert.equal(expected[index], 255);
    for (let index = 0; index < floats.length; index += 4) {
      const value = floats.readFloatLE(index);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    }
  }
});
