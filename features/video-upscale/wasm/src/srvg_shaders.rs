fn types(half: bool) -> &'static str {
    if half {
        "enable f16;\nalias Value = vec4<f16>;\nalias Matrix = mat4x4<f16>;"
    } else {
        "alias Value = vec4f;\nalias Matrix = mat4x4f;"
    }
}

pub fn convolution(first: bool, last: bool, half: bool) -> String {
    if !first && !last {
        return hidden_tiled(half);
    }
    let input_groups = if first { 1 } else { 16 };
    let output_groups = if last { 3 } else { 16 };
    let source = if first {
        "@group(0) @binding(0) var source: texture_external;"
    } else {
        "@group(0) @binding(0) var<storage, read> source: array<Value>;"
    };
    let size = if first {
        "let size = textureDimensions(source);"
    } else {
        "let size = vec2u(dimensions.width, dimensions.height);"
    };
    let dimensions = if first {
        ""
    } else {
        "struct Dimensions { width: u32, height: u32, pad0: u32, pad1: u32 }\n@group(0) @binding(3) var<uniform> dimensions: Dimensions;"
    };
    let pixel = if first {
        "Value(vec4f(textureLoad(source, coord).rgb, 0.0))".to_owned()
    } else {
        "source[group * size.x * size.y + u32(coord.y) * size.x + u32(coord.x)]".to_owned()
    };
    let slopes = if last {
        String::new()
    } else {
        format!(", slopes: array<vec4f, {output_groups}>")
    };
    let activation = if last {
        ""
    } else {
        "value = max(value, vec4f(0.0)) + parameters.slopes[id.z] * min(value, vec4f(0.0));"
    };
    format!(
        r#"
{types}
{source}
struct Parameters {{ kernels: array<Matrix, {matrices}>, bias: array<vec4f, {output_groups}>{slopes} }}
@group(0) @binding(1) var<storage, read> parameters: Parameters;
@group(0) @binding(2) var<storage, read_write> output: array<Value>;
{dimensions}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {{
  {size}
  if (id.x >= size.x || id.y >= size.y || id.z >= {output_groups}u) {{ return; }}
  var value = parameters.bias[id.z];
  for (var tap = 0u; tap < 9u; tap++) {{
    let coord = vec2i(id.xy) + vec2i(i32(tap % 3u) - 1, i32(tap / 3u) - 1);
    // The trained SRVGG models use zero padding, including the first layer.
    if (coord.x < 0 || coord.y < 0 || coord.x >= i32(size.x) || coord.y >= i32(size.y)) {{ continue; }}
    for (var group = 0u; group < {input_groups}u; group++) {{
      let pixel = {pixel};
      let weight = (id.z * 9u + tap) * {input_groups}u + group;
      value += vec4f(parameters.kernels[weight] * pixel);
    }}
  }}
  {activation}
  // Channel planes keep adjacent pixel threads coalesced at 64 channels.
  output[id.z * size.x * size.y + id.y * size.x + id.x] = Value(value);
}}
"#,
        types = types(half),
        matrices = output_groups * input_groups * 9
    )
}

fn hidden_tiled(half: bool) -> String {
    let rows = if half { 4 } else { 2 };
    let output_height = rows * 2;
    let tile_pixels = 10 * (output_height + 2);
    let tile_values = tile_pixels * 16;
    let lanes = 4 * rows * 4;
    format!(
        r#"
{types}
struct Parameters {{ kernels: array<Matrix, 2304>, bias: array<vec4f, 16>, slopes: array<vec4f, 16> }}
struct Dimensions {{ width: u32, height: u32, pad0: u32, pad1: u32 }}
@group(0) @binding(0) var<storage, read> source: array<Value>;
@group(0) @binding(1) var<storage, read> parameters: Parameters;
@group(0) @binding(2) var<storage, read_write> output: array<Value>;
@group(0) @binding(3) var<uniform> dimensions: Dimensions;
// Each invocation accumulates 2x2 pixels, reusing every weight matrix four times.
// Shared input tiles use 12.5 KiB (float16) or 15 KiB (float32).
var<workgroup> inputTile: array<Value, {tile_values}>;
@compute @workgroup_size(4, {rows}, 4)
fn main(@builtin(workgroup_id) workgroup: vec3u,
        @builtin(local_invocation_id) local: vec3u,
        @builtin(local_invocation_index) lane: u32) {{
  let size = vec2u(dimensions.width, dimensions.height);
  let origin = vec2i(workgroup.xy * vec2u(8u, {output_height}u)) - vec2i(1);
  let plane = size.x * size.y;
  for (var index = lane; index < {tile_values}u; index += {lanes}u) {{
    let group = index / {tile_pixels}u;
    let pixel = index % {tile_pixels}u;
    let coord = origin + vec2i(i32(pixel % 10u), i32(pixel / 10u));
    var value = Value(0.0);
    if (coord.x >= 0 && coord.y >= 0 && coord.x < i32(size.x) && coord.y < i32(size.y)) {{
      value = source[group * plane + u32(coord.y) * size.x + u32(coord.x)];
    }}
    inputTile[index] = value;
  }}
  workgroupBarrier();
  // Every lane participates in loading/barrier, including padded dispatch edges.
  let coord = workgroup.xy * vec2u(8u, {output_height}u) + local.xy * 2u;
  let outputGroup = workgroup.z * 4u + local.z;
  if (coord.x >= size.x || coord.y >= size.y) {{ return; }}
  var v00 = parameters.bias[outputGroup];
  var v10 = v00;
  var v01 = v00;
  var v11 = v00;
  for (var tap = 0u; tap < 9u; tap++) {{
    let tilePixel = (local.y * 2u + tap / 3u) * 10u + local.x * 2u + tap % 3u;
    for (var group = 0u; group < 16u; group++) {{
      let weight = (outputGroup * 9u + tap) * 16u + group;
      let matrix = parameters.kernels[weight];
      let pixel = group * {tile_pixels}u + tilePixel;
      v00 += vec4f(matrix * inputTile[pixel]);
      v10 += vec4f(matrix * inputTile[pixel + 1u]);
      v01 += vec4f(matrix * inputTile[pixel + 10u]);
      v11 += vec4f(matrix * inputTile[pixel + 11u]);
    }}
  }}
  let slope = parameters.slopes[outputGroup];
  v00 = max(v00, vec4f(0.0)) + slope * min(v00, vec4f(0.0));
  v10 = max(v10, vec4f(0.0)) + slope * min(v10, vec4f(0.0));
  v01 = max(v01, vec4f(0.0)) + slope * min(v01, vec4f(0.0));
  v11 = max(v11, vec4f(0.0)) + slope * min(v11, vec4f(0.0));
  let index = outputGroup * plane + coord.y * size.x + coord.x;
  output[index] = Value(v00);
  if (coord.x + 1u < size.x) {{ output[index + 1u] = Value(v10); }}
  if (coord.y + 1u < size.y) {{
    output[index + size.x] = Value(v01);
    if (coord.x + 1u < size.x) {{ output[index + size.x + 1u] = Value(v11); }}
  }}
}}
"#,
        types = types(half)
    )
}

pub fn display(half: bool) -> String {
    format!(
        r#"
{types}
@group(0) @binding(0) var<storage, read> predicted: array<Value>;
@group(0) @binding(1) var source: texture_external;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {{
  let vertices = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(vertices[index], 0.0, 1.0);
}}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {{
  let size = textureDimensions(source);
  let outputCoord = vec2u(position.xy);
  let coord = outputCoord / 2u;
  let pixel = coord.y * size.x + coord.x;
  let plane = size.x * size.y;
  let subpixel = (outputCoord.x % 2u) + 2u * (outputCoord.y % 2u);
  let residual = vec3f(f32(predicted[pixel][subpixel]), f32(predicted[plane + pixel][subpixel]), f32(predicted[plane * 2u + pixel][subpixel]));
  let original = textureLoad(source, vec2i(coord)).rgb;
  return vec4f(clamp(original + residual, vec3f(0.0), vec3f(1.0)), 1.0);
}}
"#,
        types = types(half)
    )
}
