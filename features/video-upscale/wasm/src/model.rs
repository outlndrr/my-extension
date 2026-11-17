use std::collections::BTreeMap;

const STAGES: usize = 7;
const MAX_BYTES: usize = 256 * 1024;

pub struct Model {
    pub compact: bool,
    pub groups: usize,
    pub stages: Vec<Vec<f32>>,
    pub final_layer: Vec<f32>,
}

struct Layer {
    weights: Vec<f32>,
    bias: Vec<f32>,
}

pub(crate) struct Reader<'a> {
    pub bytes: &'a [u8],
    pub offset: usize,
}

impl<'a> Reader<'a> {
    pub fn bytes(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or("Invalid weight length")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("Truncated model weights")?;
        self.offset = end;
        Ok(value)
    }

    pub fn u32(&mut self) -> Result<usize, String> {
        let bytes: [u8; 4] = self.bytes(4)?.try_into().map_err(|_| "Invalid integer")?;
        Ok(u32::from_le_bytes(bytes) as usize)
    }

    pub fn floats(&mut self, count: usize) -> Result<Vec<f32>, String> {
        let bytes = self.bytes(count.checked_mul(4).ok_or("Invalid tensor size")?)?;
        bytes
            .chunks_exact(4)
            .map(|chunk| {
                let value = f32::from_le_bytes(chunk.try_into().map_err(|_| "Invalid float")?);
                if value.is_finite() {
                    Ok(value)
                } else {
                    Err("Non-finite model weight".to_owned())
                }
            })
            .collect()
    }
}

fn name(stage: usize, group: usize) -> String {
    let base = if stage == 0 {
        "conv2d_tf".to_owned()
    } else {
        format!("conv2d_{stage}_tf")
    };
    if group == 0 {
        base
    } else {
        format!("{base}{group}")
    }
}

impl Model {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.starts_with(b"SRVG") {
            return crate::srvg::parse(bytes);
        }
        if bytes.len() > MAX_BYTES {
            return Err("Model is too large".into());
        }
        let mut reader = Reader { bytes, offset: 0 };
        if reader.bytes(4)? != b"A4K\0" {
            return Err("Expected A4K model weights".into());
        }
        if reader.u32()? != 1 {
            return Err("Unsupported model weight version".into());
        }
        let count = reader.u32()?;
        if count != 17 && count != 31 {
            return Err("Only trained 8- or 16-channel models are supported".into());
        }
        let groups = (count - 3) / STAGES;
        let mut layers = BTreeMap::new();
        for _ in 0..count {
            let length = reader.u32()?;
            if length == 0 || length > 64 {
                return Err("Invalid model layer name".into());
            }
            let key = std::str::from_utf8(reader.bytes(length)?)
                .map_err(|_| "Invalid model layer name")?
                .to_owned();
            let weights_len = reader.u32()?;
            let bias_len = reader.u32()?;
            if weights_len > 4096 || bias_len != 4 {
                return Err("Invalid model layer shape".into());
            }
            let layer = Layer {
                weights: reader.floats(weights_len)?,
                bias: reader.floats(bias_len)?,
            };
            if layers.insert(key, layer).is_some() {
                return Err("Duplicate model layer".into());
            }
        }
        if reader.offset != bytes.len() {
            return Err("Trailing model weight data".into());
        }
        let mut stages = Vec::with_capacity(STAGES);
        for stage in 0..STAGES {
            let mut weights = Vec::new();
            let mut bias = Vec::new();
            for group in 0..groups {
                let layer = layers
                    .remove(&name(stage, group))
                    .ok_or("Missing convolution layer")?;
                let expected = if stage == 0 {
                    9 * 16
                } else {
                    9 * 2 * groups * 16
                };
                if layer.weights.len() != expected {
                    return Err("Invalid convolution weight shape".into());
                }
                weights.extend(layer.weights);
                bias.extend(layer.bias);
            }
            weights.extend(bias);
            stages.push(weights);
        }
        let mut final_layer = Vec::new();
        let mut final_bias = Vec::new();
        for plane in 0..3 {
            let key = if plane == 0 {
                "conv2d_last_tf".into()
            } else {
                format!("conv2d_last_tf{plane}")
            };
            let layer = layers.remove(&key).ok_or("Missing output layer")?;
            if layer.weights.len() != STAGES * 2 * groups * 16 {
                return Err("Invalid output weight shape".into());
            }
            final_layer.extend(layer.weights);
            final_bias.extend(layer.bias);
        }
        final_layer.extend(final_bias);
        if !layers.is_empty() {
            return Err("Unexpected model layers".into());
        }
        Ok(Self {
            compact: false,
            groups,
            stages,
            final_layer,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        let mut bytes = b"A4K\0".to_vec();
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(17u32.to_le_bytes());
        let mut layer = |name: String, count: usize| {
            bytes.extend((name.len() as u32).to_le_bytes());
            bytes.extend(name.as_bytes());
            bytes.extend((count as u32).to_le_bytes());
            bytes.extend(4u32.to_le_bytes());
            bytes.extend(std::iter::repeat_n(0u8, (count + 4) * 4));
        };
        for stage in 0..7 {
            for group in 0..2 {
                layer(name(stage, group), if stage == 0 { 144 } else { 576 });
            }
        }
        for plane in 0..3 {
            layer(
                if plane == 0 {
                    "conv2d_last_tf".into()
                } else {
                    format!("conv2d_last_tf{plane}")
                },
                448,
            );
        }
        bytes
    }

    #[test]
    fn checks_format_shapes_and_complete_payload() {
        let bytes = fixture();
        let model = Model::parse(&bytes).unwrap();
        assert_eq!(model.groups, 2);
        assert_eq!(model.stages.len(), 7);
        assert_eq!(model.stages[0].len(), 2 * 144 + 8);
        for n in [0, 4, 8, 12, bytes.len() - 1] {
            assert!(Model::parse(&bytes[..n]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(Model::parse(&trailing).is_err());
        let mut invalid = bytes;
        invalid[4] = 2;
        assert!(Model::parse(&invalid).is_err());
    }
}
