fn types(half: bool) -> &'static str {
    if half {
        "enable f16;\nalias Value = vec4<f16>;\nalias Matrix = mat4x4<f16>;"
    } else {
        "alias Value = vec4f;\nalias Matrix = mat4x4f;"
    }
}

pub fn first(groups: usize, half: bool) -> String {
    format!(
        r#"
{types}
struct Parameters {{ kernels: array<Matrix, {matrices}>, bias: array<vec4f, {groups}> }}
@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var<uniform> parameters: Parameters;
@group(0) @binding(2) var<storage, read_write> output: array<Value>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {{
  let size = textureDimensions(source);
  if (id.x >= size.x || id.y >= size.y || id.z >= {groups}u) {{ return; }}
  var value = parameters.bias[id.z];
  for (var tap = 0u; tap < 9u; tap++) {{
    let offset = vec2i(i32(tap / 3u) - 1, i32(tap % 3u) - 1);
    let coord = clamp(vec2i(id.xy) + offset, vec2i(0), vec2i(size) - vec2i(1));
    let pixel = textureLoad(source, coord);
    value += vec4f(parameters.kernels[id.z * 9u + tap] * Value(vec4f(pixel.rgb, 1.0)));
  }}
  output[(id.y * size.x + id.x) * {groups}u + id.z] = Value(value);
}}
"#,
        matrices = groups * 9,
        types = types(half),
    )
}

pub fn hidden(groups: usize, half: bool) -> String {
    format!(
        r#"
{types}
struct Parameters {{ kernels: array<Matrix, {matrices}>, bias: array<vec4f, {groups}> }}
struct Size {{ width: u32, height: u32, pad0: u32, pad1: u32 }}
@group(0) @binding(0) var<storage, read> input: array<Value>;
@group(0) @binding(1) var<uniform> parameters: Parameters;
@group(0) @binding(2) var<storage, read_write> output: array<Value>;
@group(0) @binding(3) var<uniform> size: Size;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {{
  if (id.x >= size.width || id.y >= size.height || id.z >= {groups}u) {{ return; }}
  var value = parameters.bias[id.z];
  for (var tap = 0u; tap < 9u; tap++) {{
    let offset = vec2i(i32(tap / 3u) - 1, i32(tap % 3u) - 1);
    let coord = clamp(vec2i(id.xy) + offset, vec2i(0), vec2i(i32(size.width) - 1, i32(size.height) - 1));
    let pixel = (u32(coord.y) * size.width + u32(coord.x)) * {groups}u;
    for (var group = 0u; group < {groups}u; group++) {{
      let v = input[pixel + group];
      let base = id.z * {per_group}u + group * 9u + tap;
      value += vec4f(parameters.kernels[base] * max(v, Value(0.0)));
      value += vec4f(parameters.kernels[base + {negative}u] * max(-v, Value(0.0)));
    }}
  }}
  output[(id.y * size.width + id.x) * {groups}u + id.z] = Value(value);
}}
"#,
        matrices = groups * groups * 18,
        per_group = groups * 18,
        negative = groups * 9,
        types = types(half),
    )
}

pub fn display(groups: usize, half: bool) -> String {
    let mut bindings = String::new();
    let mut accumulate = String::new();
    for stage in 0..7 {
        bindings.push_str(&format!(
            "@group(0) @binding({stage}) var<storage, read> stage{stage}: array<Value>;\n"
        ));
        accumulate.push_str(&format!(
            r#"
    for (var group = 0u; group < {groups}u; group++) {{
      let v = stage{stage}[pixel + group];
      let positive = plane * {plane_matrices}u + {stage_offset}u + group;
      value += vec4f(parameters.kernels[positive] * max(v, Value(0.0)));
      value += vec4f(parameters.kernels[positive + {groups}u] * max(-v, Value(0.0)));
    }}
"#,
            plane_matrices = 7 * 2 * groups,
            stage_offset = stage * 2 * groups
        ));
    }
    format!(
        r#"
{types}
{bindings}
struct Parameters {{ kernels: array<Matrix, {matrices}>, bias: array<vec4f, 3> }}
@group(0) @binding(7) var<uniform> parameters: Parameters;
@group(0) @binding(8) var source: texture_external;
@group(0) @binding(9) var sourceSampler: sampler;
// Match pinned WebSR DisplayLayer3C: Catmull-Rom (a = -0.5), not the
// a = -0.75 bicubic kernel used by some image-resize libraries.
fn cubicWeight(t: f32) -> f32 {{
  let distance = abs(t);
  if (distance >= 2.0) {{ return 0.0; }}
  let squared = t * t;
  let cubed = distance * squared;
  if (distance <= 1.0) {{ return 1.5 * cubed - 2.5 * squared + 1.0; }}
  return -0.5 * cubed + 2.5 * squared - 4.0 * distance + 2.0;
}}
fn sourceBicubic(uv: vec2f) -> vec3f {{
  let size = vec2f(textureDimensions(source));
  let pixel = uv * size - 0.5;
  let base = floor(pixel);
  let fraction = pixel - base;
  var color = vec3f(0.0);
  var weightSum = 0.0;
  for (var y = -1; y <= 2; y++) {{
    for (var x = -1; x <= 2; x++) {{
      let tapUv = (base + vec2f(f32(x), f32(y)) + 0.5) / size;
      let sample = textureSampleBaseClampToEdge(source, sourceSampler, tapUv).rgb;
      let weight = cubicWeight(fraction.x - f32(x)) * cubicWeight(fraction.y - f32(y));
      color += sample * weight;
      weightSum += weight;
    }}
  }}
  return color / weightSum;
}}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {{
  let vertices = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(vertices[index], 0.0, 1.0);
}}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {{
  let size = textureDimensions(source);
  let outputCoord = vec2u(position.xy);
  let coord = outputCoord / 2u;
  let pixel = (coord.y * size.x + coord.x) * {groups}u;
  let subpixel = (outputCoord.x % 2u) + 2u * (outputCoord.y % 2u);
  var predicted = vec3f(0.0);
  for (var plane = 0u; plane < 3u; plane++) {{
    var value = parameters.bias[plane];
    {accumulate}
    predicted[plane] = value[subpixel];
  }}
  let original = sourceBicubic(position.xy / vec2f(size * 2u));
  return vec4f(clamp(original + predicted, vec3f(0.0), vec3f(1.0)), 1.0);
}}
"#,
        matrices = 7 * 2 * groups * 3,
        types = types(half),
    )
}
