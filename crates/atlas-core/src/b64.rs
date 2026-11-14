//! Standard base64 (RFC 4648) for binary file transfer over the JSON API.

const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        Ok(match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63,
            _ => return Err("invalid base64".into()) } as u32)
    }
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    if b.len() % 4 != 0 { return Err("invalid base64 length".into()); }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for q in b.chunks(4) {
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 { return Err("invalid padding".into()); }
        let mut n = 0u32;
        for (i, &c) in q.iter().enumerate() { n |= if i >= 4 - pad { 0 } else { val(c)? } << (18 - 6 * i); }
        out.push((n >> 16) as u8);
        if pad < 2 { out.push((n >> 8) as u8); }
        if pad < 1 { out.push(n as u8); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn roundtrip() {
        for s in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", &[0u8, 255, 128, 7, 9]] {
            assert_eq!(super::decode(&super::encode(s)).unwrap(), s);
        }
        assert_eq!(super::encode(b"foobar"), "Zm9vYmFy");
        assert!(super::decode("Zm9v!mFy").is_err());
    }
}
