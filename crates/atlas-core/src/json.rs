//! Minimal JSON value, parser and serializer (RFC 8259 subset sufficient for the core API).
//! Replace with serde_json once the build environment has crates.io access.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

impl Value {
    pub fn obj() -> Self { Value::Obj(BTreeMap::new()) }
    pub fn with(mut self, k: &str, v: impl Into<Value>) -> Self {
        if let Value::Obj(m) = &mut self { m.insert(k.to_string(), v.into()); }
        self
    }
    pub fn get(&self, k: &str) -> Option<&Value> {
        match self { Value::Obj(m) => m.get(k), _ => None }
    }
    pub fn as_str(&self) -> Option<&str> { if let Value::Str(s) = self { Some(s) } else { None } }
    pub fn as_bool(&self) -> Option<bool> { if let Value::Bool(b) = self { Some(*b) } else { None } }
    pub fn as_f64(&self) -> Option<f64> { if let Value::Num(n) = self { Some(*n) } else { None } }
    pub fn as_arr(&self) -> Option<&Vec<Value>> { if let Value::Arr(a) = self { Some(a) } else { None } }
    pub fn str_field(&self, k: &str) -> Option<&str> { self.get(k).and_then(|v| v.as_str()) }

    pub fn to_json(&self) -> String { let mut s = String::new(); write_value(self, &mut s); s }
}

impl From<&str> for Value { fn from(s: &str) -> Self { Value::Str(s.to_string()) } }
impl From<String> for Value { fn from(s: String) -> Self { Value::Str(s) } }
impl From<bool> for Value { fn from(b: bool) -> Self { Value::Bool(b) } }
impl From<f64> for Value { fn from(n: f64) -> Self { Value::Num(n) } }
impl From<u64> for Value { fn from(n: u64) -> Self { Value::Num(n as f64) } }
impl From<i64> for Value { fn from(n: i64) -> Self { Value::Num(n as f64) } }
impl From<usize> for Value { fn from(n: usize) -> Self { Value::Num(n as f64) } }
impl From<Vec<Value>> for Value { fn from(v: Vec<Value>) -> Self { Value::Arr(v) } }
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(o: Option<T>) -> Self { o.map(Into::into).unwrap_or(Value::Null) }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => { let _ = write!(out, "\\u{:04x}", c as u32); }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 { let _ = write!(out, "{}", *n as i64); }
            else if n.is_finite() { let _ = write!(out, "{}", n); }
            else { out.push_str("null"); }
        }
        Value::Str(s) => write_str(s, out),
        Value::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() { if i > 0 { out.push(','); } write_value(x, out); }
            out.push(']');
        }
        Value::Obj(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 { out.push(','); }
                write_str(k, out); out.push(':'); write_value(x, out);
            }
            out.push('}');
        }
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let mut p = Parser { b: input.as_bytes(), i: 0, depth: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() { return Err(format!("trailing characters at {}", p.i)); }
    Ok(v)
}

struct Parser<'a> { b: &'a [u8], i: usize, depth: usize }

impl<'a> Parser<'a> {
    fn ws(&mut self) { while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') { self.i += 1; } }
    fn peek(&self) -> Option<u8> { self.b.get(self.i).copied() }
    fn expect(&mut self, lit: &str) -> Result<(), String> {
        if self.b[self.i..].starts_with(lit.as_bytes()) { self.i += lit.len(); Ok(()) } else { Err(format!("expected {} at {}", lit, self.i)) }
    }
    fn value(&mut self) -> Result<Value, String> {
        self.depth += 1;
        if self.depth > 64 { return Err("nesting too deep".into()); }
        let r = match self.peek() {
            Some(b'n') => self.expect("null").map(|_| Value::Null),
            Some(b't') => self.expect("true").map(|_| Value::Bool(true)),
            Some(b'f') => self.expect("false").map(|_| Value::Bool(false)),
            Some(b'"') => self.string().map(Value::Str),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number(),
            _ => Err(format!("unexpected input at {}", self.i)),
        };
        self.depth -= 1;
        r
    }
    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') { self.i += 1; }
        std::str::from_utf8(&self.b[start..self.i]).unwrap().parse::<f64>().map(Value::Num).map_err(|e| e.to_string())
    }
    fn hex4(&mut self) -> Result<u32, String> {
        if self.i + 4 > self.b.len() { return Err("bad unicode escape".into()); }
        let h = std::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|e| e.to_string())?;
        self.i += 4;
        u32::from_str_radix(h, 16).map_err(|e| e.to_string())
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or("unterminated string")?;
            match c {
                b'"' => { self.i += 1; return Ok(out); }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek().ok_or("bad escape")?; self.i += 1;
                    match e {
                        b'"' => out.push('"'), b'\\' => out.push('\\'), b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'), b'f' => out.push('\u{c}'), b'n' => out.push('\n'),
                        b'r' => out.push('\r'), b't' => out.push('\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) {
                                self.expect("\\u")?;
                                let lo = self.hex4()?;
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                            }
                            out.push(char::from_u32(cp).ok_or("invalid code point")?);
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                _ => {
                    // Copy the whole run up to the next quote or backslash at once. Re-validating the rest of the
                    // input for every character made large bodies (e.g. documents with pictures) quadratic.
                    // The input came from a &str and the run ends at an ASCII byte, so the slice is valid UTF-8.
                    let start = self.i;
                    while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' { self.i += 1; }
                    out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?);
                }
            }
        }
    }
    fn array(&mut self) -> Result<Value, String> {
        self.i += 1; let mut v = Vec::new(); self.ws();
        if self.peek() == Some(b']') { self.i += 1; return Ok(Value::Arr(v)); }
        loop {
            self.ws(); v.push(self.value()?); self.ws();
            match self.peek() { Some(b',') => self.i += 1, Some(b']') => { self.i += 1; return Ok(Value::Arr(v)); } _ => return Err(format!("expected , or ] at {}", self.i)) }
        }
    }
    fn object(&mut self) -> Result<Value, String> {
        self.i += 1; let mut m = BTreeMap::new(); self.ws();
        if self.peek() == Some(b'}') { self.i += 1; return Ok(Value::Obj(m)); }
        loop {
            self.ws();
            if self.peek() != Some(b'"') { return Err(format!("expected key at {}", self.i)); }
            let k = self.string()?; self.ws(); self.expect(":")?; self.ws();
            let v = self.value()?; m.insert(k, v); self.ws();
            match self.peek() { Some(b',') => self.i += 1, Some(b'}') => { self.i += 1; return Ok(Value::Obj(m)); } _ => return Err(format!("expected , or }} at {}", self.i)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let src = r#"{"a":[1,2.5,true,null],"b":"x\"y\né😀","c":{}}"#;
        let v = parse(src).unwrap();
        assert_eq!(v.get("b").unwrap().as_str().unwrap(), "x\"y\né😀");
        let again = parse(&v.to_json()).unwrap();
        assert_eq!(v, again);
    }
    #[test]
    fn large_strings_parse_in_linear_time() {
        let big = "é".repeat(2_000_000);
        let src = format!(r#"{{"content":"{}","n":1}}"#, big);
        let t = std::time::Instant::now();
        let v = parse(&src).unwrap();
        assert_eq!(v.get("content").unwrap().as_str().unwrap().len(), big.len());
        assert!(t.elapsed() < std::time::Duration::from_secs(2), "parsing 4 MB took {:?}", t.elapsed());
    }
    #[test]
    fn rejects_garbage() {
        assert!(parse("{\"a\":}").is_err());
        assert!(parse("[1,2").is_err());
        assert!(parse("1 2").is_err());
        assert!(parse(&"[".repeat(100)).is_err());
    }
}
