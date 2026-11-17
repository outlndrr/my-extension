"""Compare original author ONNX on ORT CPU with independent PyTorch SRVG execution.

Both runtimes use two CPU threads. No CUDA or browser GPU is requested.
Optional --image writes same-source full-frame ONNX CPU comparison images.
"""
import argparse
import hashlib
import importlib.util
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as functional

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare_nomos", DIRECTORY / "prepare-nomos.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
torch.set_num_threads(2)
torch.set_num_interop_threads(1)


def run_torch(pixels, layers):
    rgb = torch.from_numpy(pixels[:, :, :3].astype(np.float32).transpose(2, 0, 1).copy())[None] / 255
    current = rgb
    with torch.inference_mode():
        for weights, bias, slopes in layers:
            current = functional.conv2d(current, torch.from_numpy(weights), torch.from_numpy(bias), padding=1)
            if slopes.size:
                current = functional.prelu(current, torch.from_numpy(slopes))
        output = functional.pixel_shuffle(current, 2) + functional.interpolate(rgb, scale_factor=2, mode="nearest")
        return output.clamp(0, 1)[0].permute(1, 2, 0).numpy()


def session(source):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    result = ort.InferenceSession(source, sess_options=options, providers=["CPUExecutionProvider"])
    if result.get_providers() != ["CPUExecutionProvider"]:
        raise ValueError("Reference must use CPUExecutionProvider only")
    return result


def run_ort(executor, pixels):
    rgb = pixels[:, :, :3].astype(np.float32).transpose(2, 0, 1).copy()[None] / np.float32(255)
    result = executor.run(None, {executor.get_inputs()[0].name: rgb})[0]
    if not np.isfinite(result).all() or result.min() < 0 or result.max() > 1:
        raise ValueError("Original ONNX produced invalid output")
    return result[0].transpose(1, 2, 0).copy()


def rgba(result):
    output = np.empty((*result.shape[:2], 4), dtype=np.uint8)
    output[:, :, :3] = np.floor(result * 255 + .5).astype(np.uint8)
    output[:, :, 3] = 255
    return output


def fixture(width, height):
    y, x = np.indices((height, width), dtype=np.uint32)
    pixels = np.empty((height, width, 4), dtype=np.uint8)
    pixels[:, :, 0] = (x * 17 + y * 3) % 256
    pixels[:, :, 1] = (y * 23 + (x >= width // 2) * 97) % 256
    pixels[:, :, 2] = ((x // 3 + y // 2) % 2) * 191 + 32
    pixels[:, :, 3] = 255
    pixels[0, 0, :3] = (255, 0, 0)
    pixels[-1, -1, :3] = (0, 0, 255)
    return pixels


def main(arguments):
    models = [model for model in json.loads((DIRECTORY / "catalogue.json").read_text(encoding="utf-8")) if model.get("format") == "SRVG"]
    destination = DIRECTORY / "reference"
    report = {"torch": torch.__version__, "onnxruntime": ort.__version__, "numpy": np.__version__, "provider": "CPUExecutionProvider",
              "threads": 2, "padding": "zero", "activation": "learned channel PReLU after first 17 convolutions",
              "shuffle": "DepthToSpace CRD x2 / torch.pixel_shuffle", "sourceResampling": "nearest/asymmetric/floor",
              "expectedSource": "original hash-pinned author ONNX, unmodified; FP32 CPU",
              "fixtures": [], "contractChecks": []}
    image_report = {"scope": "Original author ONNX CPU inference on the same saved RGB source frame; not a browser screenshot or temporal quality test", "threads": 2, "models": []}
    for model in models:
        data = (DIRECTORY / model["file"]).read_bytes()
        prepare.require(prepare.digest(data) == model["sha256"], "Unverified SRVG weights")
        layers = prepare.read_srvg(data)
        original = prepare.source_bytes(model, arguments.source_dir)
        executor = session(original)
        for width, height in ((32, 24), (17, 13), (1, 1), (5, 3)):
            pixels = fixture(width, height)
            expected = run_ort(executor, pixels)
            actual = run_torch(pixels, layers)
            error = float(np.max(np.abs(actual - expected)))
            uint8_error = int(np.abs(rgba(actual).astype(np.int16) - rgba(expected).astype(np.int16)).max())
            prepare.require(error <= .0001 and uint8_error <= 1, f"Original ONNX/SRVG mismatch: {model['id']} {width}x{height}: {error}, {uint8_error}")
            check = {"model": model["id"], "width": width, "height": height, "onnxTorchMaxAbs": error, "onnxTorchUint8MaxAbs": uint8_error}
            report["contractChecks"].append(check)
            if width > 5:
                input_name = f"input-{width}x{height}.rgba"
                output_name = f"{model['id']}-{width}x{height}.rgba"
                float_name = f"{model['id']}-{width}x{height}.f32"
                # Shared WebSR fixture inputs must be byte-identical.
                existing = destination / input_name
                prepare.require(not existing.exists() or existing.read_bytes() == pixels.tobytes(), "Input fixture differs")
                existing.write_bytes(pixels.tobytes())
                output = rgba(expected)
                (destination / output_name).write_bytes(output.tobytes())
                (destination / float_name).write_bytes(expected.astype("<f4").tobytes())
                report["fixtures"].append({**check, "input": input_name, "expected": output_name, "floatRgb": float_name,
                    "sha256": prepare.digest(output.tobytes()), "inputSha256": prepare.digest(pixels.tobytes()),
                    "sourceOnnxSha256": model["sourceOnnx"]["sha256"], "modelSha256": model["sha256"], "gpuToleranceUint8": 2})
            print(model["id"], f"{width}x{height}", "original ONNX vs SRVG/Torch", error, "uint8", uint8_error, flush=True)
        if arguments.image:
            from PIL import Image
            source = np.asarray(Image.open(arguments.image).convert("RGB"))
            started = time.perf_counter()
            output = rgba(run_ort(executor, source))
            elapsed = time.perf_counter() - started
            target = arguments.output_dir / ("cpu-frame123-" + model["id"].removeprefix("webgpu-") + ".png")
            target.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(output[:, :, :3]).save(target)
            image_report["sourceFileSha256"] = prepare.digest(arguments.image.read_bytes())
            image_report["inputWidth"], image_report["inputHeight"] = int(source.shape[1]), int(source.shape[0])
            image_report["models"].append({"model": model["id"], "file": target.name, "sourceOnnxSha256": model["sourceOnnx"]["sha256"],
                "sha256": prepare.digest(target.read_bytes()), "width": int(output.shape[1]), "height": int(output.shape[0]), "cpuSeconds": elapsed})
            print("Saved", target.name, "CPU seconds", round(elapsed, 3), flush=True)
    (destination / "nomos-manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if arguments.image:
        (arguments.output_dir / "cpu-frame123-nomos-comparison.json").write_text(json.dumps(image_report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--output-dir", type=Path)
    arguments = parser.parse_args()
    if arguments.image and not arguments.output_dir:
        parser.error("--image requires --output-dir")
    main(arguments)
