/// IEEE-754 binary32 to binary16, round to nearest, ties to even. Models are
/// validated as finite before packing; overflow is checked by `weight_bytes`.
fn binary16(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let fraction = bits & 0x7f_ffff;
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    if exponent <= 0 {
        if exponent < -10 {
            return sign;
        }
        let significand = fraction | 0x80_0000;
        let shift = (14 - exponent) as u32;
        let rounding = (1 << (shift - 1)) - 1 + ((significand >> shift) & 1);
        return sign | ((significand + rounding) >> shift) as u16;
    }
    let rounded = fraction + 0xfff + ((fraction >> 13) & 1);
    sign | (((exponent as u32) << 10) + (rounded >> 13)) as u16
}

/// Matrices use half precision when supported. Bias stays float32, matching
/// WGSL's uniform-array alignment and the shader's float32 accumulator.
pub fn weight_bytes(values: &[f32], bias_count: usize, half: bool) -> Result<Vec<u8>, String> {
    if !half {
        return Ok(values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect());
    }
    let split = values
        .len()
        .checked_sub(bias_count)
        .ok_or("Invalid bias count")?;
    let mut bytes = Vec::with_capacity(split * 2 + bias_count * 4);
    for &value in &values[..split] {
        let packed = binary16(value);
        if packed & 0x7c00 == 0x7c00 {
            return Err("Model weight exceeds finite float16 range".into());
        }
        bytes.extend(packed.to_le_bytes());
    }
    for value in &values[split..] {
        bytes.extend(value.to_le_bytes());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_packing_handles_normal_subnormal_and_tie_boundaries() {
        for (value, expected) in [
            (0.0, 0x0000),
            (-0.0, 0x8000),
            (1.0, 0x3c00),
            (-2.0, 0xc000),
            (65504.0, 0x7bff),
            (2f32.powi(-14), 0x0400),
            (2f32.powi(-24), 0x0001),
            (2f32.powi(-25), 0x0000),
            (3.0 * 2f32.powi(-25), 0x0002),
            (1.0 + 2f32.powi(-11), 0x3c00),
            (1.0 + 3.0 * 2f32.powi(-11), 0x3c02),
        ] {
            assert_eq!(binary16(value), expected, "{value}");
        }
        assert!(weight_bytes(&[65536.0, 0.0], 1, true).is_err());
        assert_eq!(
            weight_bytes(&[1.0, 0.25], 1, true).unwrap(),
            [0, 0x3c, 0, 0, 0x80, 0x3e]
        );
    }
}
