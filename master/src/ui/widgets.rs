//! Small reusable widgets: cards, pills, meters, sparklines, nav items.

use chrono::{DateTime, Local};
use eframe::egui::{
    self, pos2, vec2, Align2, Color32, FontId, Margin, Pos2, Rect, Response, RichText, Rounding,
    Sense, Shape, Stroke, Ui, Vec2,
};

use super::theme::{semibold, tint, Palette};

/// A rounded surface with a hairline border. Its content is laid out
/// top-down even when the parent is horizontal (cards side by side).
pub fn card<R>(ui: &mut Ui, pal: &Palette, add: impl FnOnce(&mut Ui) -> R) -> R {
    egui::Frame::none()
        .fill(pal.surface)
        .stroke(Stroke::new(1.0_f32, pal.border))
        .rounding(Rounding::same(8.0))
        .inner_margin(Margin::same(14.0))
        .show(ui, |ui| {
            ui.with_layout(egui::Layout::top_down(egui::Align::LEFT), add)
                .inner
        })
        .inner
}

/// Card title in small caps style.
pub fn card_title(ui: &mut Ui, pal: &Palette, text: &str) {
    ui.label(
        RichText::new(text.to_uppercase())
            .font(semibold(11.0))
            .color(pal.text_faint),
    );
}

pub fn heading(ui: &mut Ui, pal: &Palette, text: &str) {
    ui.label(RichText::new(text).font(semibold(22.0)).color(pal.text));
}

pub fn subtle(ui: &mut Ui, pal: &Palette, text: impl Into<String>) -> Response {
    ui.label(RichText::new(text.into()).color(pal.text_dim))
}

pub fn faint(ui: &mut Ui, pal: &Palette, text: impl Into<String>) -> Response {
    ui.label(RichText::new(text.into()).color(pal.text_faint).size(12.0))
}

/// A rounded tinted label, e.g. "Online".
pub fn pill(ui: &mut Ui, text: &str, color: Color32) -> Response {
    let font = semibold(11.5);
    let galley = ui.painter().layout_no_wrap(text.to_string(), font, color);
    let size = galley.size() + vec2(16.0, 6.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    if ui.is_rect_visible(rect) {
        ui.painter()
            .rect_filled(rect, Rounding::same(size.y / 2.0), tint(color, 34));
        ui.painter()
            .galley(rect.center() - galley.size() / 2.0, galley, color);
    }
    resp
}

/// Pill with a leading dot.
pub fn status_pill(ui: &mut Ui, text: &str, color: Color32) -> Response {
    let font = semibold(11.5);
    let galley = ui.painter().layout_no_wrap(text.to_string(), font, color);
    let size = galley.size() + vec2(28.0, 6.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    if ui.is_rect_visible(rect) {
        let p = ui.painter();
        p.rect_filled(rect, Rounding::same(size.y / 2.0), tint(color, 34));
        p.circle_filled(pos2(rect.left() + 11.0, rect.center().y), 3.5, color);
        p.galley(
            pos2(rect.left() + 19.0, rect.center().y - galley.size().y / 2.0),
            galley,
            color,
        );
    }
    resp
}

pub fn dot(ui: &mut Ui, color: Color32, glow: bool) -> Response {
    let (rect, resp) = ui.allocate_exact_size(vec2(12.0, 12.0), Sense::hover());
    if glow {
        ui.painter()
            .circle_filled(rect.center(), 6.0, tint(color, 50));
    }
    ui.painter().circle_filled(rect.center(), 3.8, color);
    resp
}

/// A thin horizontal bar with an optional label to its right.
pub fn meter(ui: &mut Ui, pal: &Palette, frac: f32, color: Color32, width: f32, label: &str) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let (rect, _) = ui.allocate_exact_size(vec2(width, 6.0), Sense::hover());
        let p = ui.painter();
        p.rect_filled(rect, Rounding::same(3.0), pal.surface2);
        let f = frac.clamp(0.0, 1.0);
        if f > 0.0 {
            let mut fill = rect;
            fill.set_width((rect.width() * f).max(4.0));
            p.rect_filled(fill, Rounding::same(3.0), color);
        }
        if !label.is_empty() {
            ui.label(
                RichText::new(label)
                    .size(12.0)
                    .color(pal.text_dim)
                    .monospace(),
            );
        }
    });
}

/// Bigger bar with text inside, for disks.
pub fn bar(ui: &mut Ui, pal: &Palette, frac: f32, color: Color32, width: f32) {
    let (rect, _) = ui.allocate_exact_size(vec2(width, 8.0), Sense::hover());
    let p = ui.painter();
    p.rect_filled(rect, Rounding::same(4.0), pal.surface2);
    let f = frac.clamp(0.0, 1.0);
    if f > 0.0 {
        let mut fill = rect;
        fill.set_width((rect.width() * f).max(6.0));
        p.rect_filled(fill, Rounding::same(4.0), color);
    }
}

/// Area sparkline of values in 0..=max.
pub fn sparkline(ui: &mut Ui, pal: &Palette, values: &[f32], size: Vec2, color: Color32, max: f32) {
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    if !ui.is_rect_visible(rect) {
        return;
    }
    let p = ui.painter();
    // Grid lines.
    for i in 1..4 {
        let y = rect.top() + rect.height() * i as f32 / 4.0;
        p.line_segment(
            [pos2(rect.left(), y), pos2(rect.right(), y)],
            Stroke::new(1.0_f32, tint(pal.border, 120)),
        );
    }
    if values.len() < 2 {
        p.text(
            rect.center(),
            Align2::CENTER_CENTER,
            "collecting data…",
            FontId::proportional(12.0),
            pal.text_faint,
        );
        return;
    }
    let n = values.len();
    let pt = |i: usize, v: f32| -> Pos2 {
        let x = rect.left() + rect.width() * i as f32 / (n - 1) as f32;
        let y = rect.bottom() - rect.height() * (v / max).clamp(0.0, 1.0);
        pos2(x, y)
    };
    let points: Vec<Pos2> = values.iter().enumerate().map(|(i, v)| pt(i, *v)).collect();
    // Filled area as vertical quads (convex pieces).
    let fill = tint(color, 38);
    let mut mesh = egui::Mesh::default();
    for (i, p0) in points.iter().enumerate() {
        let base = mesh.vertices.len() as u32;
        mesh.colored_vertex(*p0, fill);
        mesh.colored_vertex(pos2(p0.x, rect.bottom()), tint(color, 4));
        if i > 0 {
            mesh.add_triangle(base - 2, base - 1, base);
            mesh.add_triangle(base - 1, base, base + 1);
        }
    }
    p.add(Shape::mesh(mesh));
    p.add(Shape::line(points.clone(), Stroke::new(1.8_f32, color)));
    if let Some(last) = points.last() {
        p.circle_filled(*last, 3.0, color);
    }
    // Hover readout.
    if let Some(pos) = resp.hover_pos() {
        let i = (((pos.x - rect.left()) / rect.width()) * (n - 1) as f32)
            .round()
            .clamp(0.0, (n - 1) as f32) as usize;
        let q = points[i];
        p.line_segment(
            [pos2(q.x, rect.top()), pos2(q.x, rect.bottom())],
            Stroke::new(1.0_f32, tint(pal.text_faint, 120)),
        );
        p.circle_filled(q, 4.0, color);
        p.text(
            pos2(q.x, rect.top() - 2.0),
            if q.x > rect.center().x {
                Align2::RIGHT_BOTTOM
            } else {
                Align2::LEFT_BOTTOM
            },
            format!("{:.0}%", values[i]),
            semibold(12.0),
            pal.text,
        );
    }
}

/// Ring gauge with a big number in the middle.
pub fn ring(ui: &mut Ui, pal: &Palette, frac: f32, color: Color32, diameter: f32, center: &str) {
    let (rect, _) = ui.allocate_exact_size(vec2(diameter, diameter), Sense::hover());
    let p = ui.painter();
    let c = rect.center();
    let r = diameter / 2.0 - 5.0;
    let ring_pts = |from: f32, to: f32| -> Vec<Pos2> {
        let steps = 64;
        (0..=steps)
            .map(|i| {
                let a = from + (to - from) * i as f32 / steps as f32;
                pos2(c.x + r * a.cos(), c.y + r * a.sin())
            })
            .collect()
    };
    let start = -std::f32::consts::FRAC_PI_2;
    p.add(Shape::line(
        ring_pts(0.0, std::f32::consts::TAU),
        Stroke::new(7.0_f32, pal.surface2),
    ));
    let f = frac.clamp(0.0, 1.0);
    if f > 0.0 {
        p.add(Shape::line(
            ring_pts(start, start + std::f32::consts::TAU * f),
            Stroke::new(7.0_f32, color),
        ));
    }
    p.text(
        c,
        Align2::CENTER_CENTER,
        center,
        semibold(diameter * 0.24),
        pal.text,
    );
}

/// A KPI tile: label, big value, caption, accent stripe.
#[allow(clippy::too_many_arguments)]
pub fn stat_tile(
    ui: &mut Ui,
    pal: &Palette,
    width: f32,
    icon: &str,
    label: &str,
    value: &str,
    caption: &str,
    color: Color32,
) -> Response {
    let resp = egui::Frame::none()
        .fill(pal.surface)
        .stroke(Stroke::new(1.0_f32, pal.border))
        .rounding(Rounding::same(8.0))
        .inner_margin(Margin::symmetric(16.0, 14.0))
        .show(ui, |ui| {
            // Parents are often horizontal: lay the tile out top-down.
            ui.vertical(|ui| {
                ui.set_width(width - 32.0);
                ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::hover());
                    ui.painter()
                        .rect_filled(r, Rounding::same(8.0), tint(color, 36));
                    ui.painter().text(
                        r.center(),
                        Align2::CENTER_CENTER,
                        icon,
                        FontId::proportional(15.0),
                        color,
                    );
                    ui.label(RichText::new(label).color(pal.text_dim));
                });
                ui.add_space(4.0);
                ui.label(RichText::new(value).font(semibold(26.0)).color(pal.text));
                ui.add(
                    egui::Label::new(RichText::new(caption).size(12.0).color(pal.text_faint))
                        .truncate(),
                );
            });
        })
        .response;
    resp.interact(Sense::click())
}

/// Sidebar navigation entry.
pub fn nav_item(
    ui: &mut Ui,
    pal: &Palette,
    icon: &str,
    label: &str,
    selected: bool,
    badge: Option<(String, Color32)>,
) -> Response {
    let width = ui.available_width();
    let (rect, resp) = ui.allocate_exact_size(vec2(width, 34.0), Sense::click());
    if ui.is_rect_visible(rect) {
        let p = ui.painter();
        if selected {
            p.rect_filled(rect, Rounding::same(8.0), tint(pal.accent, 40));
            p.rect_filled(
                Rect::from_min_size(
                    pos2(rect.left(), rect.top() + 8.0),
                    vec2(3.0, rect.height() - 16.0),
                ),
                Rounding::same(2.0),
                pal.accent,
            );
        } else if resp.hovered() {
            p.rect_filled(rect, Rounding::same(8.0), pal.surface2);
        }
        let fg = if selected { pal.text } else { pal.text_dim };
        p.text(
            pos2(rect.left() + 22.0, rect.center().y),
            Align2::CENTER_CENTER,
            icon,
            FontId::proportional(15.0),
            if selected { pal.accent } else { pal.text_faint },
        );
        p.text(
            pos2(rect.left() + 40.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            if selected {
                semibold(13.5)
            } else {
                FontId::proportional(13.5)
            },
            fg,
        );
        if let Some((text, color)) = badge {
            let g = p.layout_no_wrap(text, semibold(11.0), color);
            let w = g.size().x + 12.0;
            let br = Rect::from_center_size(
                pos2(rect.right() - 10.0 - w / 2.0, rect.center().y),
                vec2(w, 18.0),
            );
            p.rect_filled(br, Rounding::same(9.0), tint(color, 36));
            p.galley(br.center() - g.size() / 2.0, g, color);
        }
    }
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// Tab strip with an underline on the active tab.
pub fn tabs<T: PartialEq + Copy>(ui: &mut Ui, pal: &Palette, current: &mut T, items: &[(T, &str)]) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        for (value, label) in items {
            let selected = *current == *value;
            let font = if selected {
                semibold(13.5)
            } else {
                FontId::proportional(13.5)
            };
            let g = ui.painter().layout_no_wrap(
                label.to_string(),
                font,
                if selected { pal.text } else { pal.text_dim },
            );
            let (rect, resp) = ui.allocate_exact_size(g.size() + vec2(24.0, 18.0), Sense::click());
            if resp.hovered() && !selected {
                ui.painter().rect_filled(
                    rect.shrink2(vec2(0.0, 3.0)),
                    Rounding::same(6.0),
                    pal.surface2,
                );
            }
            ui.painter()
                .galley(rect.center() - g.size() / 2.0, g, pal.text);
            if selected {
                ui.painter().rect_filled(
                    Rect::from_min_max(
                        pos2(rect.left() + 8.0, rect.bottom() - 2.5),
                        pos2(rect.right() - 8.0, rect.bottom()),
                    ),
                    Rounding::same(2.0),
                    pal.accent,
                );
            }
            if resp
                .on_hover_cursor(egui::CursorIcon::PointingHand)
                .clicked()
            {
                *current = *value;
            }
        }
    });
    let r = ui.min_rect();
    ui.painter().line_segment(
        [
            pos2(r.left(), ui.cursor().top() - 4.0),
            pos2(r.right(), ui.cursor().top() - 4.0),
        ],
        Stroke::new(1.0_f32, pal.border),
    );
}

/// Filter chip (toggle).
pub fn chip(ui: &mut Ui, pal: &Palette, selected: bool, text: &str) -> Response {
    let font = if selected {
        semibold(12.5)
    } else {
        FontId::proportional(12.5)
    };
    let color = if selected { pal.accent } else { pal.text_dim };
    let g = ui.painter().layout_no_wrap(text.to_string(), font, color);
    let size = g.size() + vec2(22.0, 10.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let p = ui.painter();
    let r = Rounding::same(size.y / 2.0);
    if selected {
        p.rect_filled(rect, r, tint(pal.accent, 34));
        p.rect_stroke(rect, r, Stroke::new(1.0_f32, tint(pal.accent, 140)));
    } else {
        p.rect_filled(
            rect,
            r,
            if resp.hovered() {
                pal.surface2
            } else {
                pal.surface
            },
        );
        p.rect_stroke(rect, r, Stroke::new(1.0_f32, pal.border));
    }
    p.galley(rect.center() - g.size() / 2.0, g, color);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand)
}

/// Filled accent button.
pub fn primary(ui: &mut Ui, pal: &Palette, text: &str) -> Response {
    ui.add(
        egui::Button::new(
            RichText::new(text)
                .color(pal.on_accent)
                .font(semibold(13.5)),
        )
        .fill(pal.accent)
        .stroke(Stroke::NONE),
    )
}

pub fn primary_enabled(ui: &mut Ui, pal: &Palette, enabled: bool, text: &str) -> Response {
    ui.add_enabled(
        enabled,
        egui::Button::new(
            RichText::new(text)
                .color(pal.on_accent)
                .font(semibold(13.5)),
        )
        .fill(if enabled { pal.accent } else { pal.surface2 })
        .stroke(Stroke::NONE),
    )
}

pub fn danger(ui: &mut Ui, pal: &Palette, enabled: bool, text: &str) -> Response {
    ui.add_enabled(
        enabled,
        egui::Button::new(
            RichText::new(text)
                .color(Color32::WHITE)
                .font(semibold(13.5)),
        )
        .fill(if enabled { pal.red } else { pal.surface2 })
        .stroke(Stroke::NONE),
    )
}

/// Borderless button for toolbars.
pub fn ghost(ui: &mut Ui, text: &str) -> Response {
    ui.add(egui::Button::new(text).frame(false))
}

/// "label: value" row with copy-on-click for the value.
pub fn kv_row(ui: &mut Ui, pal: &Palette, key: &str, value: &str) {
    ui.label(RichText::new(key).color(pal.text_faint));
    let shown = if value.is_empty() { "—" } else { value };
    let r = ui
        .add(egui::Label::new(RichText::new(shown).color(pal.text)).sense(Sense::click()))
        .on_hover_text("Click to copy");
    if r.clicked() && !value.is_empty() {
        ui.ctx().copy_text(value.to_string());
    }
    ui.end_row();
}

/// Empty-state block.
pub fn empty_state(ui: &mut Ui, pal: &Palette, icon: &str, title: &str, body: &str) {
    ui.vertical_centered(|ui| {
        ui.add_space(30.0);
        ui.label(RichText::new(icon).size(34.0).color(pal.text_faint));
        ui.add_space(6.0);
        ui.label(RichText::new(title).font(semibold(15.0)).color(pal.text));
        ui.label(RichText::new(body).color(pal.text_dim));
        ui.add_space(30.0);
    });
}

/// Search box with a magnifier hint.
pub fn search_box(ui: &mut Ui, text: &mut String, hint: &str, width: f32) -> Response {
    ui.add(
        egui::TextEdit::singleline(text)
            .hint_text(format!("🔍  {hint}"))
            .desired_width(width)
            .margin(vec2(8.0, 5.0)),
    )
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

pub fn fmt_duration(secs: u64) -> String {
    let d = secs / 86_400;
    let h = (secs % 86_400) / 3600;
    let m = (secs % 3600) / 60;
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

pub fn fmt_ago(t: DateTime<Local>) -> String {
    let secs = (Local::now() - t).num_seconds().max(0) as u64;
    if secs < 45 {
        "just now".into()
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86_400 {
        format!("{}h ago", secs / 3600)
    } else if secs < 86_400 * 30 {
        format!("{}d ago", secs / 86_400)
    } else {
        t.format("%Y-%m-%d").to_string()
    }
}

pub fn fmt_mb(mb: u64) -> String {
    if mb >= 1024 {
        format!("{:.1} GB", mb as f64 / 1024.0)
    } else {
        format!("{mb} MB")
    }
}
