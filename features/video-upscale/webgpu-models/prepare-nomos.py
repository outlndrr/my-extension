"""Reproduce SRVG v1 weights from pinned author ONNX protobuf, never pickle.

Requires numpy and onnx for export. Source downloads remain in the chosen cache.
"""
import argparse
import hashlib
import json
import struct
import urllib.request
from pathlib import Path

import numpy as np

DIRECTORY = Path(__file__).resolve().parent


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_bytes(spec, cache):
    source = spec["sourceOnnx"]
    target = cache / source["file"]
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(source["url"], timeout=60) as response:
            data = response.read(source["bytes"] + 1)
    require(len(data) == source["bytes"] and digest(data) == source["sha256"],
            f"Source length/checksum mismatch: {target.name}")
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return data


def extract_onnx(data):
    import onnx
    from onnx import helper, numpy_helper

    model = onnx.load_model_from_string(data)
    require(model.ir_version == 8 and [(op.domain, op.version) for op in model.opset_import] == [("", 17)], "Unexpected ONNX version")
    require(not model.functions and not model.training_info, "Custom functions/training graphs are unsupported")
    graph = model.graph
    require(len(graph.input) == len(graph.output) == 1 and not graph.initializer and not graph.sparse_initializer, "Unexpected ONNX inputs/weights")
    for value in (graph.input[0], graph.output[0]):
        tensor = value.type.tensor_type
        require(tensor.elem_type == onnx.TensorProto.FLOAT and len(tensor.shape.dim) == 4 and tensor.shape.dim[1].dim_value == 3, "Expected FP32 NCHW RGB graph")
    onnx.checker.check_model(model)
    constants, nodes, used = {}, [], set()
    for node in graph.node:
        require(node.domain == "" and len(node.output) == 1, "Unsupported domain or multiple outputs")
        if node.op_type != "Constant":
            nodes.append(node)
            continue
        require(not node.input and len(node.attribute) == 1 and node.attribute[0].name == "value", "Unsupported Constant")
        tensor = node.attribute[0].t
        require(tensor.data_type == onnx.TensorProto.FLOAT and not tensor.external_data and tensor.data_location == 0, "Expected embedded FP32 weights")
        array = numpy_helper.to_array(tensor).astype("<f4", copy=True)
        require(array.size <= 64 * 64 * 9 and np.isfinite(array).all(), "Invalid constant size or nonfinite parameter")
        require(node.output[0] not in constants, "Duplicate constant")
        constants[node.output[0]] = array

    def attributes(node):
        return {attribute.name: helper.get_attribute_value(attribute) for attribute in node.attribute}

    def constant(name, shape):
        require(name in constants and constants[name].shape == shape, f"Unexpected constant shape: {name}")
        used.add(name)
        return constants[name]

    layers, position, previous = [], 0, graph.input[0].name
    for index in range(18):
        node = nodes[position]
        position += 1
        channels_in, channels_out = (3 if index == 0 else 64), (12 if index == 17 else 64)
        require(node.op_type == "Conv" and len(node.input) == 3 and node.input[0] == previous, "Broken sequential convolution graph")
        require(attributes(node) == {"dilations": [1, 1], "group": 1, "kernel_shape": [3, 3], "pads": [1, 1, 1, 1], "strides": [1, 1]}, "Unsupported convolution/padding")
        weights = constant(node.input[1], (channels_out, channels_in, 3, 3))
        bias = constant(node.input[2], (channels_out,))
        previous = node.output[0]
        slopes = np.empty(0, dtype="<f4")
        if index < 17:
            activation = nodes[position]
            position += 1
            require(activation.op_type == "PRelu" and len(activation.input) == 2 and activation.input[0] == previous and not activation.attribute, "Expected channel PReLU")
            slopes = constant(activation.input[1], (64, 1, 1)).reshape(64)
            previous = activation.output[0]
        layers.append((weights, bias, slopes))
    require(len(nodes) == position + 4, "Unexpected graph nodes")
    shuffle, resize, add, clip = nodes[position:]
    require(shuffle.op_type == "DepthToSpace" and list(shuffle.input) == [previous] and attributes(shuffle) == {"blocksize": 2, "mode": b"CRD"}, "Expected pixel shuffle x2")
    require(resize.op_type == "Resize" and len(resize.input) == 3 and list(resize.input[:2]) == [graph.input[0].name, ""], "Expected original RGB residual")
    require(attributes(resize) == {"coordinate_transformation_mode": b"asymmetric", "cubic_coeff_a": -.75, "mode": b"nearest", "nearest_mode": b"floor"}, "Expected nearest residual resampling")
    require(np.array_equal(constant(resize.input[2], (4,)), [1, 1, 2, 2]), "Expected residual scale x2")
    require(add.op_type == "Add" and list(add.input) == [shuffle.output[0], resize.output[0]] and not add.attribute, "Expected source plus CNN residual")
    require(clip.op_type == "Clip" and len(clip.input) == 3 and clip.input[0] == add.output[0] and not clip.attribute and clip.output[0] == graph.output[0].name, "Expected final output clamp")
    require(constant(clip.input[1], ()).item() == 0 and constant(clip.input[2], ()).item() == 1, "Expected clamp [0,1]")
    require(used == set(constants), "Unused or unexpected constants")
    return layers


def encode(layers):
    parts = [b"SRVG", struct.pack("<4I", 1, 2, 64, len(layers))]
    for weights, bias, slopes in layers:
        parts.append(struct.pack("<4I", weights.shape[1], weights.shape[0], 3, slopes.size))
        parts.extend(array.astype("<f4", copy=False).tobytes() for array in (weights, bias, slopes))
    return b"".join(parts)


def read_srvg(data):
    require(20 <= len(data) <= 3 * 1024 * 1024 and data[:4] == b"SRVG", "Invalid SRVG length/magic")
    require(struct.unpack_from("<4I", data, 4) == (1, 2, 64, 18), "Unsupported SRVG version/topology")
    position, layers = 20, []
    for index in range(18):
        require(position + 16 <= len(data), "Truncated layer header")
        channels_in, channels_out, kernel, slope_count = struct.unpack_from("<4I", data, position)
        position += 16
        require((channels_in, channels_out, kernel, slope_count) == (3 if index == 0 else 64, 12 if index == 17 else 64, 3, 0 if index == 17 else 64), "Invalid SRVG layer shape")
        weight_count = channels_in * channels_out * 9
        count = weight_count + channels_out + slope_count
        require(position + count * 4 <= len(data), "Truncated parameters")
        values = np.frombuffer(data, dtype="<f4", count=count, offset=position).copy()
        require(np.isfinite(values).all(), "Nonfinite SRVG parameter")
        position += count * 4
        layers.append((values[:weight_count].reshape(channels_out, channels_in, 3, 3), values[weight_count:weight_count + channels_out], values[weight_count + channels_out:]))
    require(position == len(data), "Trailing SRVG bytes")
    return layers


def prepare(cache, write_catalogue=False):
    entries = []
    for spec in json.loads((DIRECTORY / "nomos-sources.json").read_text(encoding="utf-8")):
        layers = extract_onnx(source_bytes(spec, cache))
        data = encode(layers)
        decoded = read_srvg(data)
        require(all(original.astype("<f4", copy=False).tobytes() == restored.astype("<f4", copy=False).tobytes()
                    for first, second in zip(layers, decoded) for original, restored in zip(first, second)), "Serialization changed FP32 parameter bits")
        target = DIRECTORY / spec["file"]
        if target.exists():
            require(target.read_bytes() == data, f"Existing container differs from author weights: {target.name}")
        else:
            target.write_bytes(data)
        entry = {**spec, "format": "SRVG", "formatVersion": 1, "bytes": len(data), "sha256": digest(data), "channels": 64,
                 "convolutions": 18, "parameters": sum(array.size for layer in layers for array in layer), "scale": 2,
                 "architecture": "SRVGGNetCompact", "padding": "zero", "sourceResampling": "nearest"}
        entries.append(entry)
        print(f"Verified {spec['id']}: {len(data)} bytes, {entry['parameters']} unchanged FP32 parameters, sha256={entry['sha256']}")
    if write_catalogue:
        target = DIRECTORY / "catalogue.json"
        old = json.loads(target.read_text(encoding="utf-8"))
        combined = [entry for entry in old if entry["id"] not in {item["id"] for item in entries}] + entries
        target.write_text(json.dumps(combined, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        catalogue = json.loads((DIRECTORY / "catalogue.json").read_text(encoding="utf-8"))
        require(all(entry == next((item for item in catalogue if item["id"] == entry["id"]), None) for entry in entries), "Catalogue differs; inspect export then explicitly use --write-catalogue")
    return entries


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True, help="Cache for hash-pinned original ONNX files")
    parser.add_argument("--write-catalogue", action="store_true", help="Explicitly update derived metadata after verified export")
    arguments = parser.parse_args()
    prepare(arguments.source_dir, arguments.write_catalogue)
