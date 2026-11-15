//! A scan session collects pages across several feeder batches so a long
//! document can be scanned in loads of N sheets, optionally with manual
//! duplex (scan fronts, flip the stack, scan backs), then saved once.

use std::io::Cursor;

use base64::Engine;
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::pdf::{self, PdfPage};

pub struct Page {
    pub id: u64,
    pub jpeg: Vec<u8>,
    /// Clockwise degrees: 0, 90, 180, 270.
    pub rotation: u16,
    pub dpi: u32,
    pub thumb: String,
    pub blank: bool,
}

#[derive(Default)]
pub struct Session {
    pages: Vec<Page>,
    next_id: u64,
    /// Ids of the most recent front-side batch, awaiting its backs.
    pending_fronts: Option<Vec<u64>>,
    saved_snapshot: Option<SessionSnapshot>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pages: Vec<(u64, u16)>,
    pending_fronts: Option<Vec<u64>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageView {
    pub id: u64,
    pub rotation: u16,
    pub thumb: String,
    pub blank: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub pages: Vec<PageView>,
    /// Number of front pages waiting for their backs (manual duplex).
    pub awaiting_backs: Option<usize>,
    /// Blank pages the last scan left out (only set on a scan's answer).
    pub skipped_blank: usize,
}

/// Analysed page, computed off the session lock.
pub struct Prepared {
    jpeg: Vec<u8>,
    thumb: String,
    blank: bool,
}

const THUMB_WIDTH: u32 = 220;

/// Share of "ink" pixels below which a page counts as blank.
const BLANK_INK_RATIO: f64 = 0.004;

/// Decode a scanned page (JPEG or PNG), build its thumbnail and blank flag.
/// Non-JPEG pages are re-encoded as JPEG so the PDF can embed them as-is.
pub fn prepare(data: Vec<u8>) -> Result<Prepared> {
    let is_jpeg = data.starts_with(&[0xFF, 0xD8]);
    let img = image::load_from_memory(&data)?;
    let jpeg = if is_jpeg {
        data
    } else {
        let mut buf = Cursor::new(Vec::new());
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 88);
        // Grayscale stays single-channel (smaller files).
        match &img {
            DynamicImage::ImageLuma8(_) | DynamicImage::ImageLuma16(_) | DynamicImage::ImageLumaA8(_) => {
                enc.encode_image(&img.to_luma8())?
            }
            _ => enc.encode_image(&img.to_rgb8())?,
        }
        buf.into_inner()
    };
    let thumb_img = img.resize(THUMB_WIDTH, THUMB_WIDTH * 2, FilterType::Triangle);
    let blank = is_blank(&thumb_img);
    let mut buf = Cursor::new(Vec::new());
    thumb_img.to_rgb8().write_to(&mut buf, ImageFormat::Jpeg)?;
    let thumb = format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    );
    Ok(Prepared { jpeg, thumb, blank })
}

/// A page is blank when almost no pixel is much darker than the paper.
/// Margins are ignored: feeders often leave shadows at the edges.
pub fn is_blank(img: &DynamicImage) -> bool {
    let gray = img.to_luma8();
    let (w, h) = img.dimensions();
    let (mx, my) = (w / 20, h / 20);
    let mut values: Vec<u8> = Vec::with_capacity((w * h) as usize);
    for y in my..h.saturating_sub(my) {
        for x in mx..w.saturating_sub(mx) {
            values.push(gray.get_pixel(x, y)[0]);
        }
    }
    if values.is_empty() {
        return true;
    }
    // Paper brightness = 90th percentile, robust to content.
    let mut sorted = values.clone();
    sorted.sort_unstable();
    let paper = sorted[sorted.len() * 9 / 10] as i32;
    let ink = values.iter().filter(|&&v| (v as i32) < paper - 60).count();
    (ink as f64 / values.len() as f64) < BLANK_INK_RATIO
}

impl Session {
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            pages: self.pages.iter().map(|p| (p.id, p.rotation)).collect(),
            pending_fronts: self.pending_fronts.clone(),
        }
    }

    pub fn mark_saved(&mut self, snapshot: SessionSnapshot) {
        self.saved_snapshot = Some(snapshot);
    }

    pub fn has_unsaved_pages(&self) -> bool {
        !self.pages.is_empty() && self.saved_snapshot.as_ref() != Some(&self.snapshot())
    }

    fn push(&mut self, p: Prepared, dpi: u32) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.pages.push(Page {
            id,
            jpeg: p.jpeg,
            rotation: 0,
            dpi,
            thumb: p.thumb,
            blank: p.blank,
        });
        id
    }

    pub fn view(&self) -> SessionView {
        SessionView {
            pages: self
                .pages
                .iter()
                .map(|p| PageView {
                    id: p.id,
                    rotation: p.rotation,
                    thumb: p.thumb.clone(),
                    blank: p.blank,
                })
                .collect(),
            awaiting_backs: self.pending_fronts.as_ref().map(Vec::len),
            skipped_blank: 0,
        }
    }

    /// Append a batch. With `expect_backs` the batch is remembered as fronts.
    pub fn add_batch(&mut self, pages: Vec<Prepared>, dpi: u32, expect_backs: bool, skip_blank: bool) {
        let mut ids = Vec::new();
        for p in pages {
            // In manual duplex keep blanks for now so the interleave lines up.
            if skip_blank && p.blank && !expect_backs {
                continue;
            }
            ids.push(self.push(p, dpi));
        }
        self.pending_fronts = expect_backs.then_some(ids);
    }

    /// Interleave a batch of backs with the pending fronts. A flipped stack
    /// comes out last-sheet-first, so backs are reversed by default.
    pub fn add_backs(&mut self, backs: Vec<Prepared>, dpi: u32, reversed: bool, skip_blank: bool) -> Result<()> {
        let fronts = self
            .pending_fronts
            .clone()
            .ok_or_else(|| Error::invalid("no_pending_fronts"))?;
        if backs.len() != fronts.len() {
            return Err(Error::invalid_with(
                "backs_mismatch",
                &[("fronts", fronts.len().to_string()), ("backs", backs.len().to_string())],
            ));
        }
        let mut backs = backs;
        if reversed {
            backs.reverse();
        }
        // Rebuild page order: each front followed by its back.
        let mut back_pages: Vec<Page> = backs
            .into_iter()
            .map(|b| {
                self.next_id += 1;
                Page {
                    id: self.next_id,
                    jpeg: b.jpeg,
                    rotation: 0,
                    dpi,
                    thumb: b.thumb,
                    blank: b.blank,
                }
            })
            .collect();
        let mut ordered = Vec::with_capacity(self.pages.len() + back_pages.len());
        let mut back_iter = back_pages.drain(..);
        for page in std::mem::take(&mut self.pages) {
            let is_front = fronts.contains(&page.id);
            ordered.push(page);
            if is_front {
                if let Some(b) = back_iter.next() {
                    ordered.push(b);
                }
            }
        }
        self.pages = ordered;
        self.pending_fronts = None;
        if skip_blank {
            self.pages.retain(|p| !p.blank);
        }
        Ok(())
    }

    /// Fronts only: give up waiting for backs.
    pub fn finish_without_backs(&mut self, skip_blank: bool) {
        self.pending_fronts = None;
        if skip_blank {
            self.pages.retain(|p| !p.blank);
        }
    }

    fn index(&self, id: u64) -> Result<usize> {
        self.pages
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| Error::invalid("page_not_found"))
    }

    pub fn rotate(&mut self, id: u64) -> Result<()> {
        let i = self.index(id)?;
        self.pages[i].rotation = (self.pages[i].rotation + 90) % 360;
        Ok(())
    }

    pub fn delete(&mut self, id: u64) -> Result<()> {
        let i = self.index(id)?;
        self.pages.remove(i);
        if let Some(f) = &mut self.pending_fronts {
            f.retain(|x| *x != id);
        }
        Ok(())
    }

    pub fn delete_blank(&mut self) {
        let blanks: Vec<u64> = self.pages.iter().filter(|p| p.blank).map(|p| p.id).collect();
        for id in blanks {
            let _ = self.delete(id);
        }
    }

    pub fn move_to(&mut self, id: u64, to: usize) -> Result<()> {
        let i = self.index(id)?;
        let page = self.pages.remove(i);
        self.pages.insert(to.min(self.pages.len()), page);
        Ok(())
    }

    pub fn clear(&mut self) {
        self.pages.clear();
        self.pending_fronts = None;
    }

    /// Append a page from a file (not a scan): kept even when blank.
    pub fn add_imported(&mut self, page: Prepared, dpi: u32) -> Result<()> {
        if self.pending_fronts.is_some() {
            return Err(Error::invalid("awaiting_backs"));
        }
        self.push(page, dpi);
        Ok(())
    }

    /// Full-size JPEG of one page (rotation not applied).
    pub fn page_jpeg(&self, id: u64) -> Result<Vec<u8>> {
        Ok(self.pages[self.index(id)?].jpeg.clone())
    }

    pub fn len(&self) -> usize {
        self.pages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    pub fn to_pdf(&self) -> Result<Vec<u8>> {
        let pages: Vec<PdfPage> = self
            .pages
            .iter()
            .map(|p| PdfPage { jpeg: &p.jpeg, dpi: p.dpi, rotation: p.rotation })
            .collect();
        pdf::jpegs_to_pdf(&pages)
    }

    /// JPEG bytes per page with rotation applied (re-encodes rotated pages).
    pub fn to_jpegs(&self) -> Result<Vec<Vec<u8>>> {
        self.pages
            .iter()
            .map(|p| {
                if p.rotation == 0 {
                    return Ok(p.jpeg.clone());
                }
                let img = image::load_from_memory_with_format(&p.jpeg, ImageFormat::Jpeg)?;
                let img = match p.rotation {
                    90 => img.rotate90(),
                    180 => img.rotate180(),
                    _ => img.rotate270(),
                };
                let mut buf = Cursor::new(Vec::new());
                let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90);
                enc.encode_image(&img)?;
                Ok(buf.into_inner())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn page(dark_pixels: u32) -> Prepared {
        let mut img = RgbImage::from_pixel(200, 280, Rgb([250, 250, 250]));
        for i in 0..dark_pixels {
            img.put_pixel(20 + (i % 160), 20 + (i / 160) % 240, Rgb([10, 10, 10]));
        }
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img).write_to(&mut buf, ImageFormat::Jpeg).unwrap();
        prepare(buf.into_inner()).unwrap()
    }

    #[test]
    fn png_pages_become_jpeg() {
        let img = RgbImage::from_pixel(50, 70, Rgb([250, 250, 250]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img).write_to(&mut buf, ImageFormat::Png).unwrap();
        let p = prepare(buf.into_inner()).unwrap();
        assert!(p.jpeg.starts_with(&[0xFF, 0xD8]));
        assert!(p.blank);
    }

    #[test]
    fn detects_blank_and_text_pages() {
        assert!(page(0).blank);
        assert!(page(20).blank, "a few specks are still blank");
        assert!(!page(3000).blank);
    }

    #[test]
    fn manual_duplex_interleaves_reversed_backs() {
        let mut s = Session::default();
        s.add_batch(vec![page(3000), page(3000), page(3000)], 300, true, false);
        let fronts: Vec<u64> = s.view().pages.iter().map(|p| p.id).collect();
        assert_eq!(s.view().awaiting_backs, Some(3));
        // Flipped stack: backs arrive as sheet 3, 2, 1.
        let (b3, b2, b1) = (page(1000), page(2000), page(3000));
        let thumbs = [b1.thumb.clone(), b2.thumb.clone(), b3.thumb.clone()];
        s.add_backs(vec![b3, b2, b1], 300, true, false).unwrap();
        let v = s.view();
        assert_eq!(v.pages.len(), 6);
        for sheet in 0..3 {
            assert_eq!(v.pages[sheet * 2].id, fronts[sheet]);
            assert_eq!(v.pages[sheet * 2 + 1].thumb, thumbs[sheet], "back of sheet {}", sheet + 1);
        }
        assert_eq!(v.awaiting_backs, None);
    }

    #[test]
    fn duplex_with_blank_backs_removed() {
        let mut s = Session::default();
        s.add_batch(vec![page(3000), page(3000)], 300, true, true);
        s.add_backs(vec![page(0), page(3000)], 300, true, true).unwrap();
        assert_eq!(s.view().pages.len(), 3);
    }

    #[test]
    fn unsaved_state_tracks_saved_snapshot_and_later_edits() {
        let mut s = Session::default();
        assert!(!s.has_unsaved_pages());
        s.add_batch(vec![page(3000)], 300, false, false);
        assert!(s.has_unsaved_pages());
        let snapshot = s.snapshot();
        s.mark_saved(snapshot.clone());
        assert!(!s.has_unsaved_pages());
        let id = s.view().pages[0].id;
        s.rotate(id).unwrap();
        assert!(s.has_unsaved_pages());
        // Completion of an older save must not mark a newer edit as saved.
        s.mark_saved(snapshot);
        assert!(s.has_unsaved_pages());
        s.mark_saved(s.snapshot());
        assert!(!s.has_unsaved_pages());
        s.clear();
        assert!(!s.has_unsaved_pages());
    }

    #[test]
    fn rejects_mismatched_back_count() {
        let mut s = Session::default();
        s.add_batch(vec![page(3000), page(3000)], 300, true, false);
        let before: Vec<u64> = s.view().pages.iter().map(|p| p.id).collect();
        assert!(s.add_backs(vec![page(3000)], 300, true, false).is_err());
        let after = s.view();
        assert_eq!(after.awaiting_backs, Some(2), "still waiting after error");
        assert_eq!(after.pages.iter().map(|p| p.id).collect::<Vec<_>>(), before, "front pages stay in order");
        s.add_backs(vec![page(3000), page(3000)], 300, true, false).unwrap();
        assert_eq!(s.view().pages.len(), 4, "retry adds the backs");
    }

    #[test]
    fn batches_append_and_pages_can_be_edited() {
        let mut s = Session::default();
        s.add_batch(vec![page(3000), page(0)], 300, false, true);
        assert_eq!(s.view().pages.len(), 1, "blank skipped");
        s.add_batch(vec![page(3000), page(3000)], 300, false, false);
        let ids: Vec<u64> = s.view().pages.iter().map(|p| p.id).collect();
        s.rotate(ids[1]).unwrap();
        s.move_to(ids[2], 0).unwrap();
        s.delete(ids[0]).unwrap();
        let v = s.view();
        assert_eq!(v.pages.iter().map(|p| p.id).collect::<Vec<_>>(), vec![ids[2], ids[1]]);
        assert_eq!(v.pages[1].rotation, 90);
        assert!(s.to_pdf().unwrap().starts_with(b"%PDF"));
        assert_eq!(s.to_jpegs().unwrap().len(), 2);
    }
}

#[cfg(test)]
mod live_convert {
    /// `PAPERDOCK_RAW` in, `PAPERDOCK_OUT` (JPEG) out, through `prepare`.
    #[test]
    #[ignore]
    fn convert_raw_file() {
        let raw = std::fs::read(std::env::var("PAPERDOCK_RAW").unwrap()).unwrap();
        let p = super::prepare(raw).unwrap();
        std::fs::write(std::env::var("PAPERDOCK_OUT").unwrap(), &p.jpeg).unwrap();
        println!("blank={}", p.blank);
    }
}
