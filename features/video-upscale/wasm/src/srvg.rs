use crate::model::{Model, Reader};

/// SRVG v1 keeps the trained OIHW parameters unchanged on disk. This packing
/// transposes them into WGSL column-major vec4 matrix blocks once at load time.
fn pack(weights: &[f32], input: usize, output: usize) -> Vec<f32> {
    let input_groups = input.div_ceil(4);
    let mut packed = Vec::with_capacity(output * input_groups * 4 * 9);
    for out_group in 0..output / 4 {
        for tap in 0..9 {
            for in_group in 0..input_groups {
                for in_lane in 0..4 {
                    let channel = in_group * 4 + in_lane;
                    for out_lane in 0..4 {
                        let out_channel = out_group * 4 + out_lane;
                        packed.push(if channel < input {
                            weights[(out_channel * input + channel) * 9 + tap]
                        } else {
                            0.0
                        });
                    }
                }
            }
        }
    }
    packed
}

pub fn parse(bytes: &[u8]) -> Result<Model, String> {
    if bytes.len() > 3 * 1024 * 1024 {
        return Err("SRVGG model is too large".into());
    }
    let mut reader = Reader { bytes, offset: 0 };
    if reader.bytes(4)? != b"SRVG" || reader.u32()? != 1 {
        return Err("Expected SRVG model version 1".into());
    }
    if reader.u32()? != 2 || reader.u32()? != 64 || reader.u32()? != 18 {
        return Err("Only 2x 64-channel, 18-convolution SRVGG models are supported".into());
    }
    let mut stages = Vec::with_capacity(17);
    let mut final_layer = Vec::new();
    for layer in 0..18 {
        let input = reader.u32()?;
        let output = reader.u32()?;
        let kernel = reader.u32()?;
        let slopes = reader.u32()?;
        let expected_input = if layer == 0 { 3 } else { 64 };
        let expected_output = if layer == 17 { 12 } else { 64 };
        let expected_slopes = if layer == 17 { 0 } else { 64 };
        if input != expected_input
            || output != expected_output
            || kernel != 3
            || slopes != expected_slopes
        {
            return Err(format!("Invalid SRVGG layer {layer} shape or activation"));
        }
        let weights = reader.floats(output * input * 9)?;
        let mut values = pack(&weights, input, output);
        values.extend(reader.floats(output)?);
        values.extend(reader.floats(slopes)?);
        if layer == 17 {
            final_layer = values;
        } else {
            stages.push(values);
        }
    }
    if reader.offset != bytes.len() {
        return Err("Trailing SRVGG model data".into());
    }
    Ok(Model {
        compact: true,
        groups: 16,
        stages,
        final_layer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oihw_packing_preserves_rgb_taps_output_lanes_and_zero_fourth_input() {
        let weights: Vec<f32> = (0..8 * 3 * 9).map(|i| i as f32).collect();
        let packed = pack(&weights, 3, 8);
        for group in 0..2 {
            for tap in 0..9 {
                for input in 0..4 {
                    for lane in 0..4 {
                        let actual = packed[((group * 9 + tap) * 4 + input) * 4 + lane];
                        let expected = if input == 3 {
                            0.0
                        } else {
                            weights[((group * 4 + lane) * 3 + input) * 9 + tap]
                        };
                        assert_eq!(actual, expected);
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_wrong_architecture_before_reading_parameters() {
        let mut bytes = b"SRVG".to_vec();
        for value in [1u32, 2, 64, 18, 4, 64, 3, 64] {
            bytes.extend(value.to_le_bytes());
        }
        assert!(parse(&bytes).err().unwrap().contains("layer 0"));
        bytes[4] = 2;
        assert!(parse(&bytes).err().unwrap().contains("version"));
    }

    #[test]
    fn validates_complete_srvg_payload_and_rejects_nonfinite_weights() {
        let mut bytes = b"SRVG".to_vec();
        for value in [1u32, 2, 64, 18] {
            bytes.extend(value.to_le_bytes());
        }
        for layer in 0..18 {
            let input: u32 = if layer == 0 { 3 } else { 64 };
            let output: u32 = if layer == 17 { 12 } else { 64 };
            let slopes: u32 = if layer == 17 { 0 } else { 64 };
            for value in [input, output, 3, slopes] {
                bytes.extend(value.to_le_bytes());
            }
            bytes.resize(
                bytes.len() + ((input * output * 9 + output + slopes) * 4) as usize,
                0,
            );
        }
        let model = parse(&bytes).unwrap();
        assert!(model.compact);
        assert_eq!(model.stages.len(), 17);
        assert_eq!(model.stages[0].len(), 16 * 9 * 16 + 128);
        assert_eq!(model.stages[1].len(), 16 * 9 * 16 * 16 + 128);
        assert_eq!(model.final_layer.len(), 3 * 9 * 16 * 16 + 12);
        assert!(parse(&bytes[..bytes.len() - 1]).is_err());
        bytes.push(0);
        assert!(parse(&bytes).err().unwrap().contains("Trailing"));
        bytes.pop();
        bytes[36..40].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse(&bytes).err().unwrap().contains("Non-finite"));
    }
}
