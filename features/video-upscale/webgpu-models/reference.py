"""Independent CPU reference for the Rust/WGSL model port.

Uses PyTorch NCHW conv2d, CReLU and pixel_shuffle, rather than the engine's
WGSL matrix loops. A second NumPy implementation checks conversion/layout.
Requires numpy and torch only when regenerating the small reference vectors.
"""

import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional


DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare_models", DIRECTORY / "prepare-models.py")
prepare_models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_models)
torch.set_num_threads(2)


def catmull_rom_torch(rgb):
    """Separable exact quarter-phase Catmull-Rom coefficients for 2x resize.

    This is independent of the upstream shader's 4x4 polynomial loops.
    torch.interpolate(mode='bicubic') uses a different cubic parameter.
    Values are not clipped: the CNN residual is added before output clamping.
    """
    result = rgb
    for dimension in (3, 2):
        length = result.shape[dimension]
        positions = torch.arange(length * 2, device=result.device)
        starts = positions // 2 - (positions % 2 == 0).to(torch.int64)
        phases = torch.tensor([[-3, 29, 111, -9], [-9, 111, 29, -3]],
                              dtype=result.dtype, device=result.device)[positions % 2] / 128
        shape = [1, 1, 1, 1]
        shape[dimension] = length * 2
        parts = [torch.index_select(result, dimension, (starts + tap - 1).clamp(0, length - 1))
                 * phases[:, tap].reshape(shape) for tap in range(4)]
        result = parts[0] + parts[1] + parts[2] + parts[3]
    return result


def catmull_rom_numpy(rgb):
    """Literal pinned WebSR DisplayLayer3C kernel, nearest taps, clamped edges."""
    def weight(t):
        distance = np.abs(t)
        squared = t * t
        cubed = distance * squared
        return np.where(distance >= 2, np.float32(0),
                        np.where(distance <= 1, 1.5 * cubed - 2.5 * squared + 1,
                                 -.5 * cubed + 2.5 * squared - 4 * distance + 2)).astype(np.float32)

    height, width = rgb.shape[:2]
    ys = (np.arange(height * 2, dtype=np.float32) + .5) * .5 - .5
    xs = (np.arange(width * 2, dtype=np.float32) + .5) * .5 - .5
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    fy, fx = (ys - y0).astype(np.float32), (xs - x0).astype(np.float32)
    result = np.zeros((height * 2, width * 2, 3), dtype=np.float32)
    weight_sum = np.zeros((height * 2, width * 2), dtype=np.float32)
    for y in range(-1, 3):
        for x in range(-1, 3):
            pixel = rgb[np.clip(y0 + y, 0, height - 1)[:, None], np.clip(x0 + x, 0, width - 1)[None, :]]
            contribution = weight(fy - y)[:, None] * weight(fx - x)[None, :]
            result += pixel * contribution[:, :, None]
            weight_sum += contribution
    return result / weight_sum[:, :, None]


def verify_resampling():
    # Closed-form 2-pixel edge weights at positions -.25, .25, .75, 1.25.
    # Saturated independent RGB channels catch channel swaps and early clamp.
    colors = np.asarray([[[1, 0, 0], [0, 0, 1]], [[0, 1, 0], [1, 1, 1]]], dtype=np.float32)
    edge = np.asarray([[137, -9], [102, 26], [26, 102], [-9, 137]], dtype=np.float32) / 128
    expected = np.einsum("yi,ijc,xj->yxc", edge, colors, edge)
    torch_result = catmull_rom_torch(torch.from_numpy(colors.transpose(2, 0, 1).copy())[None])[0].permute(1, 2, 0).numpy()
    np.testing.assert_allclose(catmull_rom_numpy(colors), expected, atol=2e-7, rtol=0)
    np.testing.assert_allclose(torch_result, expected, atol=2e-7, rtol=0)
    assert expected.min() < 0 and expected.max() > 1, "Bicubic must not clamp before adding the residual"
    for height, width in ((1, 1), (3, 5)):
        constant = np.broadcast_to(np.array([.125, .5, .875], dtype=np.float32), (height, width, 3)).copy()
        np.testing.assert_allclose(catmull_rom_numpy(constant), np.tile(constant, (2, 2, 1)), atol=2e-7, rtol=0)


def convert_conv(layer, input_channels, kernel_size):
    packed, bias = layer
    groups = input_channels // 4
    # Source matrices are WGSL/GLSL column-major: [input channel, output channel].
    matrices = np.asarray(packed, dtype=np.float32).reshape(groups, kernel_size, kernel_size, 4, 4)
    kernel = matrices.transpose(4, 0, 3, 2, 1).reshape(4, input_channels, kernel_size, kernel_size)
    return torch.from_numpy(kernel.copy()), torch.tensor(bias, dtype=torch.float32)


def run_torch(pixels, groups, layers):
    rgb = torch.from_numpy(pixels[:, :, :3].astype(np.float32).transpose(2, 0, 1).copy())[None] / 255
    initial = torch.cat((rgb, torch.ones_like(rgb[:, :1])), 1)
    stages = []
    for stage in range(7):
        source = initial if stage == 0 else torch.cat((functional.relu(stages[-1]), functional.relu(-stages[-1])), 1)
        channels = source.shape[1]
        kernels = [convert_conv(layers[prepare_models.layer_name(stage, group)], channels, 3) for group in range(groups)]
        weights = torch.cat([item[0] for item in kernels], 0)
        biases = torch.cat([item[1] for item in kernels], 0)
        output = functional.conv2d(functional.pad(source, (1, 1, 1, 1), mode="replicate"), weights, biases)
        stages.append(output)
    source = torch.cat([part for stage in stages for part in (functional.relu(stage), functional.relu(-stage))], 1)
    kernels = [convert_conv(layers["conv2d_last_tf" + (str(plane) if plane else "")], source.shape[1], 1) for plane in range(3)]
    residual = functional.conv2d(source, torch.cat([item[0] for item in kernels]), torch.cat([item[1] for item in kernels]))
    residual = functional.pixel_shuffle(residual, 2)
    base = catmull_rom_torch(rgb)
    output = (base + residual).clamp(0, 1)[0].permute(1, 2, 0).numpy()
    return output, [stage[0].permute(1, 2, 0).numpy() for stage in stages]


def run_numpy(pixels, groups, layers):
    source = pixels.astype(np.float32) / np.float32(255)
    height, width = source.shape[:2]
    stages = []
    for stage in range(7):
        previous = source if stage == 0 else np.concatenate((np.maximum(stages[-1], 0), np.maximum(-stages[-1], 0)), axis=2)
        padded = np.pad(previous, ((1, 1), (1, 1), (0, 0)), mode="edge")
        outputs = []
        for group in range(groups):
            packed, bias = layers[prepare_models.layer_name(stage, group)]
            matrices = np.asarray(packed, dtype=np.float32).reshape(-1, 9, 4, 4)
            result = np.broadcast_to(np.asarray(bias, dtype=np.float32), (height, width, 4)).copy()
            for input_group in range(matrices.shape[0]):
                for tap in range(9):
                    dx, dy = tap // 3, tap % 3
                    window = padded[dy:dy + height, dx:dx + width, input_group * 4:input_group * 4 + 4]
                    result += window @ matrices[input_group, tap]
            outputs.append(result)
        stages.append(np.concatenate(outputs, axis=2))
    concatenated = np.concatenate([part for stage in stages for part in (np.maximum(stage, 0), np.maximum(-stage, 0))], axis=2)
    planes = []
    for plane in range(3):
        packed, bias = layers["conv2d_last_tf" + (str(plane) if plane else "")]
        matrix = np.asarray(packed, dtype=np.float32).reshape(-1, 4)
        planes.append(concatenated @ matrix + np.asarray(bias, dtype=np.float32))
    residual = np.stack(planes, axis=2).reshape(height, width, 3, 2, 2).transpose(0, 3, 1, 4, 2).reshape(height * 2, width * 2, 3)
    return np.clip(catmull_rom_numpy(source[:, :, :3]) + residual, 0, 1), stages


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


def main():
    verify_resampling()
    destination = DIRECTORY / "reference"
    destination.mkdir(exist_ok=True)
    catalogue = json.loads((DIRECTORY / "catalogue.json").read_text(encoding="utf-8"))
    report = {"torch": torch.__version__, "numpy": np.__version__, "padding": "clamp-to-edge",
              "sourceResampling": "Catmull-Rom bicubic (a=-0.5), pinned WebSR DisplayLayer3C",
              "resamplingTest": "independent separable quarter coefficients vs upstream 4x4 polynomial; RGB edges, overshoot, constants",
              "fixtures": []}
    for width, height in ((32, 24), (17, 13)):
        pixels = fixture(width, height)
        input_name = f"input-{width}x{height}.rgba"
        (destination / input_name).write_bytes(pixels.tobytes())
        for model in catalogue:
            if model.get("format", "A4K") != "A4K":
                continue
            data = (DIRECTORY / model["file"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != model["sha256"]:
                raise ValueError("Unverified model weights")
            groups, layers = prepare_models.read_weights(data)
            with torch.inference_mode():
                result, torch_stages = run_torch(pixels, groups, layers)
            numpy_result, numpy_stages = run_numpy(pixels, groups, layers)
            error = float(np.max(np.abs(result - numpy_result)))
            stage_error = max(float(np.max(np.abs(a - b))) for a, b in zip(torch_stages, numpy_stages))
            if error > 0.00002 or stage_error > 0.0001:
                raise AssertionError(f"Independent reference mismatch: output={error}, stages={stage_error}")
            output = np.empty((height * 2, width * 2, 4), dtype=np.uint8)
            output[:, :, :3] = np.floor(result * 255 + .5).astype(np.uint8)
            output[:, :, 3] = 255
            output_name = f"{model['id']}-{width}x{height}.rgba"
            (destination / output_name).write_bytes(output.tobytes())
            float_name = f"{model['id']}-{width}x{height}.f32"
            (destination / float_name).write_bytes(result.astype("<f4").tobytes())
            report["fixtures"].append({"model": model["id"], "width": width, "height": height,
                                       "input": input_name, "expected": output_name, "floatRgb": float_name,
                                       "sha256": hashlib.sha256(output.tobytes()).hexdigest(),
                                       "numpyTorchMaxAbs": error, "stageMaxAbs": stage_error,
                                       "gpuToleranceUint8": 2})
            print(model["id"], f"{width}x{height}", "independent max error", error)
    (destination / "manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
