mod model;
mod precision;
mod shaders;
mod srvg;
mod srvg_shaders;

use js_sys::{Array, Function, Object, Promise, Reflect, Uint8Array};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
use wasm_bindgen::{JsCast, prelude::*};
use wasm_bindgen_futures::{JsFuture, spawn_local};

const MAX_PIXELS: u64 = 1920 * 1080;
const UNIFORM_COPY_DST: u32 = 64 | 8;
const STORAGE: u32 = 128;

fn error(message: impl AsRef<str>) -> JsValue {
    js_sys::Error::new(message.as_ref()).into()
}
fn get(object: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(object, &key.into())
}
fn set(object: &JsValue, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &key.into(), value)?;
    Ok(())
}
fn object(entries: &[(&str, JsValue)]) -> Result<JsValue, JsValue> {
    let value: JsValue = Object::new().into();
    for (key, item) in entries {
        set(&value, key, item)?;
    }
    Ok(value)
}
fn array(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    values.into_iter().collect::<Array>().into()
}
fn call(target: &JsValue, key: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let method: Function = get(target, key)?
        .dyn_into()
        .map_err(|_| error(format!("WebGPU method {key} is unavailable")))?;
    method.apply(target, &array(args.iter().cloned()).unchecked_into())
}
async fn promise(value: JsValue) -> Result<JsValue, JsValue> {
    JsFuture::from(
        value
            .dyn_into::<Promise>()
            .map_err(|_| error("Expected a WebGPU promise"))?,
    )
    .await
}
fn now() -> f64 {
    get(&js_sys::global(), "performance")
        .and_then(|performance| call(&performance, "now", &[]))
        .ok()
        .and_then(|value| value.as_f64())
        .unwrap_or_else(js_sys::Date::now)
}
fn dimensions(width: u32, height: u32) -> Result<(), JsValue> {
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_PIXELS
        || width > 4096
        || height > 4096
    {
        return Err(error(
            "WebGPU input must be nonempty and at most 1920x1080 pixels",
        ));
    }
    Ok(())
}
fn uniform(
    device: &JsValue,
    queue: &JsValue,
    bytes: &[u8],
    label: &str,
) -> Result<JsValue, JsValue> {
    parameter_buffer(device, queue, bytes, label, UNIFORM_COPY_DST)
}
fn parameter_buffer(
    device: &JsValue,
    queue: &JsValue,
    bytes: &[u8],
    label: &str,
    usage: u32,
) -> Result<JsValue, JsValue> {
    let buffer = call(
        device,
        "createBuffer",
        &[object(&[
            ("label", label.into()),
            ("size", (bytes.len() as f64).into()),
            ("usage", usage.into()),
        ])?],
    )?;
    let data: JsValue = Uint8Array::from(bytes).into();
    if let Err(failure) = call(queue, "writeBuffer", &[buffer.clone(), 0.into(), data]) {
        let _ = call(&buffer, "destroy", &[]);
        return Err(failure);
    }
    Ok(buffer)
}
fn buffer_binding(binding: u32, buffer: &JsValue) -> Result<JsValue, JsValue> {
    object(&[
        ("binding", binding.into()),
        ("resource", object(&[("buffer", buffer.clone())])?),
    ])
}
fn texture_binding(binding: u32, texture: &JsValue) -> Result<JsValue, JsValue> {
    object(&[("binding", binding.into()), ("resource", texture.clone())])
}
fn bind(device: &JsValue, pipeline: &JsValue, entries: Vec<JsValue>) -> Result<JsValue, JsValue> {
    call(
        device,
        "createBindGroup",
        &[object(&[
            ("layout", call(pipeline, "getBindGroupLayout", &[0.into()])?),
            ("entries", array(entries)),
        ])?],
    )
}
async fn compute(device: &JsValue, source: &str, label: &str) -> Result<JsValue, JsValue> {
    let module = call(
        device,
        "createShaderModule",
        &[object(&[("code", source.into()), ("label", label.into())])?],
    )?;
    promise(call(
        device,
        "createComputePipelineAsync",
        &[object(&[
            ("label", label.into()),
            ("layout", "auto".into()),
            (
                "compute",
                object(&[("module", module), ("entryPoint", "main".into())])?,
            ),
        ])?],
    )?)
    .await
}

struct Resources {
    width: u32,
    height: u32,
    size: JsValue,
    stages: Vec<JsValue>,
    hidden_bindings: Vec<JsValue>,
    final_binding: Option<JsValue>,
}

impl Drop for Resources {
    fn drop(&mut self) {
        for buffer in &self.stages {
            let _ = call(buffer, "destroy", &[]);
        }
        let _ = call(&self.size, "destroy", &[]);
    }
}

struct BusyGuard<'a>(&'a Cell<bool>);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

/// The model graph and every GPU command are owned by Rust. JavaScript loads
/// this module and supplies VideoFrames; image pixels never enter WASM memory.
#[wasm_bindgen]
pub struct GpuUpscaler {
    canvas: JsValue,
    context: JsValue,
    device: JsValue,
    queue: JsValue,
    first: JsValue,
    hidden: JsValue,
    final_compute: Option<JsValue>,
    display: JsValue,
    sampler: JsValue,
    weights: Vec<JsValue>,
    final_weights: JsValue,
    groups: usize,
    half: bool,
    compact: bool,
    resources: RefCell<Option<Resources>>,
    busy: Cell<bool>,
    destroyed: Cell<bool>,
    fault: Rc<RefCell<Option<String>>>,
    info: JsValue,
    error_handler: Closure<dyn FnMut(JsValue)>,
}

#[wasm_bindgen]
impl GpuUpscaler {
    /// `weights` is a pinned A4K or SRVG container. Only model data is copied to WASM.
    pub async fn create(
        canvas: JsValue,
        weights: Vec<u8>,
        width: u32,
        height: u32,
        precision: Option<String>,
    ) -> Result<GpuUpscaler, JsValue> {
        dimensions(width, height)?;
        let model = model::Model::parse(&weights).map_err(error)?;
        let navigator = get(&js_sys::global(), "navigator")?;
        let gpu = get(&navigator, "gpu")?;
        if gpu.is_null() || gpu.is_undefined() {
            return Err(error("WebGPU is unavailable in this browser or context"));
        }
        let adapter = promise(call(
            &gpu,
            "requestAdapter",
            &[object(&[("powerPreference", "high-performance".into())])?],
        )?)
        .await?;
        if adapter.is_null() {
            return Err(error("No WebGPU adapter is available"));
        }
        let supports_half = call(&get(&adapter, "features")?, "has", &["shader-f16".into()])?
            .as_bool()
            .unwrap_or(false);
        let half = match precision.as_deref().unwrap_or("auto") {
            "auto" => supports_half,
            "float32" => false,
            "float16" if supports_half => true,
            "float16" => return Err(error("This GPU does not support shader-f16")),
            _ => return Err(error("Precision must be auto, float16, or float32")),
        };
        let required_limits = if model.compact {
            let limits = get(&adapter, "limits")?;
            let requested = (MAX_PIXELS * 64 * if half { 2 } else { 4 }) as f64;
            let binding = get(&limits, "maxStorageBufferBindingSize")?
                .as_f64()
                .unwrap_or(0.0);
            let buffer = get(&limits, "maxBufferSize")?.as_f64().unwrap_or(0.0);
            let supported = requested.min(binding).min(buffer);
            let needed =
                (u64::from(width) * u64::from(height) * 64 * if half { 2 } else { 4 }) as f64;
            if supported < needed {
                return Err(error(format!(
                    "SRVGG {}x{} requires a {:.0} MiB feature buffer; this GPU permits {:.0} MiB",
                    width,
                    height,
                    needed / 1048576.0,
                    supported / 1048576.0
                )));
            }
            object(&[
                ("maxStorageBufferBindingSize", supported.into()),
                ("maxBufferSize", supported.into()),
            ])?
        } else {
            object(&[])?
        };
        let device = promise(call(
            &adapter,
            "requestDevice",
            &[object(&[
                ("label", "Outlndrr Rust/WASM upscaler".into()),
                ("requiredLimits", required_limits),
                (
                    "requiredFeatures",
                    array(if half {
                        vec!["shader-f16".into()]
                    } else {
                        vec![]
                    }),
                ),
            ])?],
        )?)
        .await?;
        let result = Self::setup(
            canvas.clone(),
            &gpu,
            &adapter,
            &device,
            model,
            half,
            supports_half,
            precision.as_deref().unwrap_or("auto"),
            width,
            height,
        )
        .await;
        if result.is_err() {
            if let Ok(context) = call(&canvas, "getContext", &["webgpu".into()]) {
                let _ = call(&context, "unconfigure", &[]);
            }
            let _ = call(&device, "destroy", &[]);
        }
        result
    }

    #[wasm_bindgen(getter)]
    pub fn info(&self) -> JsValue {
        self.info.clone()
    }

    /// The promise resolves after GPU completion. A second simultaneous call
    /// fails instead of accumulating an unbounded queue of video frames.
    pub async fn render(&self, source: JsValue) -> Result<JsValue, JsValue> {
        self.check()?;
        if self.busy.replace(true) {
            return Err(error("A WebGPU frame is already in flight"));
        }
        let _busy = BusyGuard(&self.busy);
        let started = now();
        let width = source_dimension(&source, "displayWidth", "videoWidth")?;
        let height = source_dimension(&source, "displayHeight", "videoHeight")?;
        dimensions(width, height)?;
        self.resize(width, height)?;
        call(&self.device, "pushErrorScope", &["validation".into()])?;
        let encoded = self.encode(&source);
        let submitted = now();
        // Consume the scope even when importing a frame throws synchronously.
        let validation = promise(call(&self.device, "popErrorScope", &[])?).await;
        let validated = now();
        encoded?;
        promise(call(&self.queue, "onSubmittedWorkDone", &[])?).await?;
        let completed = now();
        let validation = validation?;
        if !validation.is_null() && !validation.is_undefined() {
            return Err(error(
                get(&validation, "message")?
                    .as_string()
                    .unwrap_or_else(|| "WebGPU validation failed".into()),
            ));
        }
        self.check()?;
        object(&[
            ("elapsedMs", (completed - started).into()),
            ("submitMs", (submitted - started).into()),
            ("validationWaitMs", (validated - submitted).into()),
            ("completionWaitMs", (completed - validated).into()),
            ("width", (width * 2).into()),
            ("height", (height * 2).into()),
        ])
    }

    /// Safe while a render promise is pending; that promise then rejects.
    pub fn destroy(&self) {
        if self.destroyed.replace(true) {
            return;
        }
        let _ = call(
            &self.device,
            "removeEventListener",
            &[
                "uncapturederror".into(),
                self.error_handler.as_ref().clone(),
            ],
        );
        let _ = call(&self.context, "unconfigure", &[]);
        self.resources.borrow_mut().take();
        for buffer in &self.weights {
            let _ = call(buffer, "destroy", &[]);
        }
        let _ = call(&self.final_weights, "destroy", &[]);
        let _ = call(&self.device, "destroy", &[]);
    }
}

fn source_dimension(source: &JsValue, frame_key: &str, video_key: &str) -> Result<u32, JsValue> {
    let frame = get(source, frame_key)?.as_f64();
    let value = frame
        .or_else(|| get(source, video_key).ok()?.as_f64())
        .ok_or_else(|| error("Expected a readable VideoFrame or HTMLVideoElement"))?;
    if !value.is_finite() || value <= 0.0 || value.fract() != 0.0 || value > 4096.0 {
        return Err(error("Invalid source frame size"));
    }
    Ok(value as u32)
}

impl GpuUpscaler {
    async fn setup(
        canvas: JsValue,
        gpu: &JsValue,
        adapter: &JsValue,
        device: &JsValue,
        model: model::Model,
        half: bool,
        supports_half: bool,
        requested_precision: &str,
        width: u32,
        height: u32,
    ) -> Result<Self, JsValue> {
        let context = call(&canvas, "getContext", &["webgpu".into()])?;
        if context.is_null() {
            return Err(error("A WebGPU canvas context could not be created"));
        }
        let format = call(gpu, "getPreferredCanvasFormat", &[])?;
        call(
            &context,
            "configure",
            &[object(&[
                ("device", device.clone()),
                ("format", format.clone()),
                ("alphaMode", "opaque".into()),
            ])?],
        )?;
        let queue = get(device, "queue")?;
        let first = compute(
            device,
            &if model.compact {
                srvg_shaders::convolution(true, false, half)
            } else {
                shaders::first(model.groups, half)
            },
            "Trained CNN input convolution",
        )
        .await?;
        let hidden = compute(
            device,
            &if model.compact {
                srvg_shaders::convolution(false, false, half)
            } else {
                shaders::hidden(model.groups, half)
            },
            "Trained CNN CReLU convolution",
        )
        .await?;
        let final_compute = if model.compact {
            Some(
                compute(
                    device,
                    &srvg_shaders::convolution(false, true, half),
                    "SRVGG final RGB subpixel convolution",
                )
                .await?,
            )
        } else {
            None
        };
        let module = call(
            device,
            "createShaderModule",
            &[object(&[
                (
                    "code",
                    if model.compact {
                        srvg_shaders::display(half)
                    } else {
                        shaders::display(model.groups, half)
                    }
                    .into(),
                ),
                ("label", "Trained CNN subpixel output".into()),
            ])?],
        )?;
        let display = promise(call(
            device,
            "createRenderPipelineAsync",
            &[object(&[
                ("label", "Trained CNN subpixel output".into()),
                ("layout", "auto".into()),
                (
                    "vertex",
                    object(&[("module", module.clone()), ("entryPoint", "vertex".into())])?,
                ),
                (
                    "fragment",
                    object(&[
                        ("module", module),
                        ("entryPoint", "fragment".into()),
                        ("targets", array([object(&[("format", format)])?])),
                    ])?,
                ),
                (
                    "primitive",
                    object(&[("topology", "triangle-list".into())])?,
                ),
            ])?],
        )?)
        .await?;
        let sampler = call(
            device,
            "createSampler",
            &[object(&[
                ("magFilter", "nearest".into()),
                ("minFilter", "nearest".into()),
            ])?],
        )?;
        let mut weights = Vec::with_capacity(model.stages.len());
        let parameter_usage = if model.compact {
            STORAGE | 8
        } else {
            UNIFORM_COPY_DST
        };
        for (i, values) in model.stages.iter().enumerate() {
            weights.push(parameter_buffer(
                device,
                &queue,
                &precision::weight_bytes(
                    values,
                    model.groups * if model.compact { 8 } else { 4 },
                    half,
                )
                .map_err(error)?,
                &format!("CNN stage {i} trained weights"),
                parameter_usage,
            )?);
        }
        let final_weights = parameter_buffer(
            device,
            &queue,
            &precision::weight_bytes(&model.final_layer, 12, half).map_err(error)?,
            "CNN trained output weights",
            parameter_usage,
        )?;
        let fault = Rc::new(RefCell::new(None));
        let lost_fault = fault.clone();
        let lost = get(device, "lost")?;
        spawn_local(async move {
            if let Ok(info) = promise(lost).await {
                let message = get(&info, "message")
                    .ok()
                    .and_then(|value| value.as_string())
                    .unwrap_or_else(|| "device unavailable".into());
                *lost_fault.borrow_mut() = Some(format!("WebGPU device lost: {message}"));
            }
        });
        let error_fault = fault.clone();
        let error_handler = Closure::<dyn FnMut(JsValue)>::new(move |event: JsValue| {
            let message = get(&event, "error")
                .and_then(|value| get(&value, "message"))
                .ok()
                .and_then(|value| value.as_string())
                .unwrap_or_else(|| "WebGPU operation failed".into());
            *error_fault.borrow_mut() = Some(message);
        });
        let adapter_info = get(adapter, "info").unwrap_or(JsValue::NULL);
        let info = object(&[
            ("backend", "webgpu".into()),
            ("runtime", "rust-wasm".into()),
            ("engineVersion", env!("CARGO_PKG_VERSION").into()),
            ("engineBuild", env!("UPSCALE_ENGINE_BUILD").into()),
            ("powerPreference", "high-performance".into()),
            ("precisionRequested", requested_precision.into()),
            ("shaderF16Supported", supports_half.into()),
            ("precision", if half { "float16" } else { "float32" }.into()),
            ("accumulation", "float32".into()),
            ("channels", ((model.groups * 4) as u32).into()),
            (
                "stages",
                (model.stages.len() as u32 + u32::from(model.compact)).into(),
            ),
            (
                "architecture",
                if model.compact {
                    "SRVGGNetCompact"
                } else {
                    "WebSR-CReLU"
                }
                .into(),
            ),
            (
                "adapter",
                object(&[
                    (
                        "vendor",
                        get(&adapter_info, "vendor").unwrap_or(JsValue::NULL),
                    ),
                    (
                        "architecture",
                        get(&adapter_info, "architecture").unwrap_or(JsValue::NULL),
                    ),
                    (
                        "device",
                        get(&adapter_info, "device").unwrap_or(JsValue::NULL),
                    ),
                    (
                        "description",
                        get(&adapter_info, "description").unwrap_or(JsValue::NULL),
                    ),
                    (
                        "isFallbackAdapter",
                        get(&adapter_info, "isFallbackAdapter")
                            .ok()
                            .and_then(|value| value.as_bool())
                            .map(JsValue::from)
                            .unwrap_or(JsValue::NULL),
                    ),
                ])?,
            ),
        ])?;
        let engine = Self {
            canvas,
            context,
            device: device.clone(),
            queue,
            first,
            hidden,
            final_compute,
            display,
            sampler,
            weights,
            final_weights,
            groups: model.groups,
            half,
            compact: model.compact,
            resources: RefCell::new(None),
            busy: Cell::new(false),
            destroyed: Cell::new(false),
            fault,
            info,
            error_handler,
        };
        call(
            &engine.device,
            "addEventListener",
            &[
                "uncapturederror".into(),
                engine.error_handler.as_ref().clone(),
            ],
        )?;
        engine.resize(width, height)?;
        Ok(engine)
    }

    fn check(&self) -> Result<(), JsValue> {
        if self.destroyed.get() {
            return Err(error("WebGPU upscaler has been destroyed"));
        }
        if let Some(message) = self.fault.borrow().as_ref() {
            return Err(error(message));
        }
        Ok(())
    }

    fn resize(&self, width: u32, height: u32) -> Result<(), JsValue> {
        let mut slot = self.resources.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|value| value.width == width && value.height == height)
        {
            return Ok(());
        }
        // No pending frame may use these buffers: render has one explicit lease.
        let feature_bytes = u64::from(width)
            * u64::from(height)
            * self.groups as u64
            * if self.half { 8 } else { 16 };
        let limits = get(&self.device, "limits")?;
        let binding_limit = get(&limits, "maxStorageBufferBindingSize")?
            .as_f64()
            .unwrap_or(0.0);
        let buffer_limit = get(&limits, "maxBufferSize")?.as_f64().unwrap_or(0.0);
        if feature_bytes as f64 > binding_limit.min(buffer_limit) {
            return Err(error(format!(
                "{}x{} requires a {:.0} MiB feature buffer; WebGPU device limit is {:.0} MiB",
                width,
                height,
                feature_bytes as f64 / 1048576.0,
                binding_limit.min(buffer_limit) / 1048576.0
            )));
        }
        slot.take();
        set(&self.canvas, "width", &(width * 2).into())?;
        set(&self.canvas, "height", &(height * 2).into())?;
        let size_bytes: Vec<u8> = [width, height, 0, 0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let size = uniform(
            &self.device,
            &self.queue,
            &size_bytes,
            "Video frame dimensions",
        )?;
        let mut resources = Resources {
            width,
            height,
            size,
            stages: Vec::with_capacity(if self.compact { 3 } else { 7 }),
            hidden_bindings: Vec::with_capacity(self.weights.len() - 1),
            final_binding: None,
        };
        for stage in 0..if self.compact { 3 } else { 7 } {
            let groups = if self.compact && stage == 2 {
                3
            } else {
                self.groups
            };
            resources.stages.push(call(
                &self.device,
                "createBuffer",
                &[object(&[
                    ("label", format!("CNN feature stage {stage}").into()),
                    (
                        "size",
                        ((u64::from(width)
                            * u64::from(height)
                            * groups as u64
                            * if self.half { 8 } else { 16 }) as f64)
                            .into(),
                    ),
                    ("usage", STORAGE.into()),
                ])?],
            )?);
        }
        for stage in 1..self.weights.len() {
            let input = if self.compact {
                (stage - 1) % 2
            } else {
                stage - 1
            };
            let output = if self.compact { stage % 2 } else { stage };
            resources.hidden_bindings.push(bind(
                &self.device,
                &self.hidden,
                vec![
                    buffer_binding(0, &resources.stages[input])?,
                    buffer_binding(1, &self.weights[stage])?,
                    buffer_binding(2, &resources.stages[output])?,
                    buffer_binding(3, &resources.size)?,
                ],
            )?);
        }
        if let Some(pipeline) = &self.final_compute {
            resources.final_binding = Some(bind(
                &self.device,
                pipeline,
                vec![
                    buffer_binding(0, &resources.stages[0])?,
                    buffer_binding(1, &self.final_weights)?,
                    buffer_binding(2, &resources.stages[2])?,
                    buffer_binding(3, &resources.size)?,
                ],
            )?);
        }
        *slot = Some(resources);
        Ok(())
    }

    fn encode(&self, source: &JsValue) -> Result<(), JsValue> {
        let slot = self.resources.borrow();
        let resources = slot
            .as_ref()
            .ok_or_else(|| error("Frame buffers are unavailable"))?;
        let input = call(
            &self.device,
            "importExternalTexture",
            &[object(&[("source", source.clone())])?],
        )?;
        let first_group = bind(
            &self.device,
            &self.first,
            vec![
                texture_binding(0, &input)?,
                buffer_binding(1, &self.weights[0])?,
                buffer_binding(2, &resources.stages[0])?,
            ],
        )?;
        let mut display_entries = Vec::with_capacity(10);
        if self.compact {
            display_entries.extend([
                buffer_binding(0, &resources.stages[2])?,
                texture_binding(1, &input)?,
            ]);
        } else {
            for (binding, buffer) in resources.stages.iter().enumerate() {
                display_entries.push(buffer_binding(binding as u32, buffer)?);
            }
            display_entries.extend([
                buffer_binding(7, &self.final_weights)?,
                texture_binding(8, &input)?,
                texture_binding(9, &self.sampler)?,
            ]);
        }
        let display_group = bind(&self.device, &self.display, display_entries)?;
        let encoder = call(
            &self.device,
            "createCommandEncoder",
            &[object(&[(
                "label",
                "Rust/WASM video upscale frame".into(),
            )])?],
        )?;
        let pass = call(&encoder, "beginComputePass", &[])?;
        call(&pass, "setPipeline", &[self.first.clone()])?;
        call(&pass, "setBindGroup", &[0.into(), first_group])?;
        let dispatch = [
            resources.width.div_ceil(8).into(),
            resources.height.div_ceil(8).into(),
            (self.groups as u32).into(),
        ];
        call(&pass, "dispatchWorkgroups", &dispatch)?;
        call(&pass, "setPipeline", &[self.hidden.clone()])?;
        let hidden_dispatch = if self.compact {
            [
                resources.width.div_ceil(8).into(),
                resources
                    .height
                    .div_ceil(if self.half { 8 } else { 4 })
                    .into(),
                4.into(),
            ]
        } else {
            dispatch
        };
        for binding in &resources.hidden_bindings {
            call(&pass, "setBindGroup", &[0.into(), binding.clone()])?;
            call(&pass, "dispatchWorkgroups", &hidden_dispatch)?;
        }
        if let (Some(pipeline), Some(binding)) = (&self.final_compute, &resources.final_binding) {
            call(&pass, "setPipeline", &[pipeline.clone()])?;
            call(&pass, "setBindGroup", &[0.into(), binding.clone()])?;
            call(
                &pass,
                "dispatchWorkgroups",
                &[
                    resources.width.div_ceil(8).into(),
                    resources.height.div_ceil(8).into(),
                    3.into(),
                ],
            )?;
        }
        call(&pass, "end", &[])?;
        let target = call(&self.context, "getCurrentTexture", &[])?;
        let view = call(&target, "createView", &[])?;
        let render = call(
            &encoder,
            "beginRenderPass",
            &[object(&[(
                "colorAttachments",
                array([object(&[
                    ("view", view),
                    ("loadOp", "clear".into()),
                    ("storeOp", "store".into()),
                    (
                        "clearValue",
                        object(&[
                            ("r", 0.into()),
                            ("g", 0.into()),
                            ("b", 0.into()),
                            ("a", 1.into()),
                        ])?,
                    ),
                ])?]),
            )])?],
        )?;
        call(&render, "setPipeline", &[self.display.clone()])?;
        call(&render, "setBindGroup", &[0.into(), display_group])?;
        call(&render, "draw", &[3.into()])?;
        call(&render, "end", &[])?;
        let commands = call(&encoder, "finish", &[])?;
        call(&self.queue, "submit", &[array([commands])])?;
        Ok(())
    }
}

impl Drop for GpuUpscaler {
    fn drop(&mut self) {
        self.destroy();
    }
}
