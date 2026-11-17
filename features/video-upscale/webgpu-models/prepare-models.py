"""Fetch pinned upstream trained weights. No Python packages are required."""

import hashlib
import json
import math
import struct
import urllib.request
from pathlib import Path


DIRECTORY = Path(__file__).resolve().parent
COMMIT = "ab5c08c06b9ac912b64838ba1ae8bfb592d0b7dd"
BASE = f"https://raw.githubusercontent.com/sb2702/websr/{COMMIT}"


def read_weights(data):
    """Read the original A4K v1 container without changing floating-point bits."""
    if len(data) < 12 or data[:4] != b"A4K\0":
        raise ValueError("Not an A4K weight container")
    version, count = struct.unpack_from("<II", data, 4)
    if version != 1 or count not in (17, 31):
        raise ValueError("Unsupported model version or topology")
    offset = 12
    layers = {}
    for _ in range(count):
        if offset + 4 > len(data):
            raise ValueError("Truncated layer name length")
        length, = struct.unpack_from("<I", data, offset)
        offset += 4
        if not 1 <= length <= 64 or offset + length + 8 > len(data):
            raise ValueError("Invalid layer name")
        name = data[offset:offset + length].decode("ascii")
        offset += length
        weights, bias = struct.unpack_from("<II", data, offset)
        offset += 8
        size = (weights + bias) * 4
        if bias != 4 or weights > 1152 or offset + size > len(data):
            raise ValueError("Invalid or truncated layer weights")
        values = struct.unpack_from(f"<{weights + bias}f", data, offset)
        offset += size
        if name in layers or not all(math.isfinite(value) for value in values):
            raise ValueError("Duplicate layer or non-finite weights")
        layers[name] = (values[:weights], values[weights:])
    if offset != len(data):
        raise ValueError("Unexpected trailing bytes")
    groups = (count - 3) // 7
    expected = {}
    for stage in range(7):
        for group in range(groups):
            name = layer_name(stage, group)
            expected[name] = 144 if stage == 0 else 288 * groups
    for plane in range(3):
        expected["conv2d_last_tf" + (str(plane) if plane else "")] = 224 * groups
    if set(layers) != set(expected):
        raise ValueError("Unexpected layer names")
    for name, count in expected.items():
        if len(layers[name][0]) != count:
            raise ValueError(f"Unexpected shape for {name}")
    return groups, layers


def layer_name(stage, group):
    return ("conv2d_tf" if stage == 0 else f"conv2d_{stage}_tf") + (str(group) if group else "")


def prepare():
    specs = json.loads((DIRECTORY / "catalogue.json").read_text(encoding="utf-8"))
    for spec in specs:
        if spec.get("format", "A4K") != "A4K":
            continue
        target = DIRECTORY / spec["file"]
        if target.is_file():
            data = target.read_bytes()
        else:
            upstream = spec["file"].removeprefix("websr-")
            with urllib.request.urlopen(f"{BASE}/weights/websr/{upstream}", timeout=60) as response:
                data = response.read(spec["bytes"] + 1)
        if len(data) != spec["bytes"] or hashlib.sha256(data).hexdigest() != spec["sha256"]:
            raise ValueError(f"Checksum or length mismatch: {target.name}")
        groups, layers = read_weights(data)
        if groups * 4 != spec["channels"]:
            raise ValueError("Channel metadata mismatch")
        parameters = sum(len(w) + len(b) for w, b in layers.values())
        if parameters != spec["parameters"]:
            raise ValueError("Parameter metadata mismatch")
        if not target.exists():
            target.write_bytes(data)
        print(f"Verified {spec['id']}: {groups * 4} channels, {parameters} parameters, {len(data)} bytes")


if __name__ == "__main__":
    prepare()
