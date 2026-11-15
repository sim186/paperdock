//! Minimal PDF writer that wraps JPEG pages without re-encoding them
//! (DCTDecode passthrough). Enough for multi-page scans; no dependencies.

use crate::error::{Error, Result};

pub struct JpegInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
}

/// Read width/height/components from the first SOF marker.
pub fn jpeg_info(data: &[u8]) -> Result<JpegInfo> {
    let bad = || Error::Protocol("scanner returned an invalid JPEG".into());
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err(bad());
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        // Standalone markers without a length field.
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) || marker == 0xFF {
            i += if marker == 0xFF { 1 } else { 2 };
            continue;
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            if i + 9 >= data.len() {
                return Err(bad());
            }
            let height = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            let width = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
            let components = data[i + 9];
            if width == 0 || height == 0 {
                return Err(bad());
            }
            return Ok(JpegInfo { width, height, components });
        }
        if marker == 0xDA {
            break; // start of scan without a frame header
        }
        i += 2 + len;
    }
    Err(bad())
}

pub struct PdfPage<'a> {
    pub jpeg: &'a [u8],
    /// Maps pixels to physical size.
    pub dpi: u32,
    /// Clockwise degrees, applied with /Rotate (no re-encoding).
    pub rotation: u16,
}

/// Build a PDF with one page per JPEG.
pub fn jpegs_to_pdf(pages: &[PdfPage]) -> Result<Vec<u8>> {
    if pages.is_empty() {
        return Err(Error::invalid("no_pages"));
    }
    let mut out: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    // Object numbering: 1 catalog, 2 pages, then per page: page, content, image.
    let n = pages.len();
    let page_obj = |k: usize| 3 + k * 3;

    let push_obj = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, body: &[u8]| {
        offsets.push(out.len());
        let id = offsets.len();
        out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };

    push_obj(&mut out, &mut offsets, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: Vec<String> = (0..n).map(|k| format!("{} 0 R", page_obj(k))).collect();
    push_obj(
        &mut out,
        &mut offsets,
        format!("<< /Type /Pages /Kids [{}] /Count {n} >>", kids.join(" ")).as_bytes(),
    );

    for (k, page) in pages.iter().enumerate() {
        let jpeg = page.jpeg;
        let info = jpeg_info(jpeg)?;
        let dpi = page.dpi.max(1) as f64;
        let w = info.width as f64 * 72.0 / dpi;
        let h = info.height as f64 * 72.0 / dpi;
        let rotate = match page.rotation % 360 {
            0 => String::new(),
            r => format!(" /Rotate {r}"),
        };
        let (content_id, image_id) = (page_obj(k) + 1, page_obj(k) + 2);
        push_obj(
            &mut out,
            &mut offsets,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.2} {h:.2}]{rotate} \
                 /Resources << /XObject << /Im0 {image_id} 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .as_bytes(),
        );
        let content = format!("q {w:.2} 0 0 {h:.2} 0 0 cm /Im0 Do Q");
        push_obj(
            &mut out,
            &mut offsets,
            format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).as_bytes(),
        );
        let (cs, decode) = match info.components {
            1 => ("/DeviceGray", ""),
            4 => ("/DeviceCMYK", " /Decode [1 0 1 0 1 0 1 0]"),
            _ => ("/DeviceRGB", ""),
        };
        let mut img = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {cs} \
             /BitsPerComponent 8 /Filter /DCTDecode{decode} /Length {} >>\nstream\n",
            info.width,
            info.height,
            jpeg.len()
        )
        .into_bytes();
        img.extend_from_slice(jpeg);
        img.extend_from_slice(b"\nendstream");
        push_obj(&mut out, &mut offsets, &img);
    }

    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes());
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            offsets.len() + 1
        )
        .as_bytes(),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smallest structurally valid JPEG header: SOI, SOF0 (3x2, 3 comps), EOI.
    fn fake_jpeg() -> Vec<u8> {
        vec![
            0xFF, 0xD8, // SOI
            0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, // APP0 with 2 bytes payload
            0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, // SOF0 h=2 w=3
            1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, // components
            0xFF, 0xD9, // EOI
        ]
    }

    #[test]
    fn reads_jpeg_dimensions() {
        let i = jpeg_info(&fake_jpeg()).unwrap();
        assert_eq!((i.width, i.height, i.components), (3, 2, 3));
    }

    #[test]
    fn rejects_non_jpeg() {
        assert!(jpeg_info(b"PNG....").is_err());
    }

    #[test]
    fn builds_multi_page_pdf_with_valid_xref() {
        let j = fake_jpeg();
        let pdf = jpegs_to_pdf(&[
            PdfPage { jpeg: &j, dpi: 72, rotation: 0 },
            PdfPage { jpeg: &j, dpi: 72, rotation: 90 },
        ])
        .unwrap();
        // Map bytes 1:1 to chars so offsets stay byte offsets.
        let s: String = pdf.iter().map(|&b| b as char).collect();
        assert!(s.starts_with("%PDF-1.4"));
        assert!(s.contains("/Count 2"));
        assert!(s.contains("/MediaBox [0 0 3.00 2.00] /Resources"));
        assert!(s.contains("/MediaBox [0 0 3.00 2.00] /Rotate 90"));
        // Every xref offset must point at "N 0 obj".
        let xref_pos: usize = s.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        let table = &pdf[xref_pos..];
        let table: String = table.iter().map(|&b| b as char).collect();
        for (idx, line) in table.lines().skip(3).take(8).enumerate() {
            let off: usize = line[..10].parse().unwrap();
            assert!(pdf[off..].starts_with(format!("{} 0 obj", idx + 1).as_bytes()), "bad offset for obj {}", idx + 1);
        }
    }
}
