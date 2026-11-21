//! Colors, fonts and egui style for the master app: Windows 11's dark and light themes (flat layers, hairline
//! borders, the Windows accent blue, 4 px controls and 8 px cards, Segoe UI), like Akulav's other apps.

use eframe::egui::{
    self, Color32, FontData, FontDefinitions, FontFamily, FontId, Margin, Rounding, Shadow, Stroke,
    TextStyle, Vec2,
};

/// Semantic colors used throughout the UI.
#[derive(Clone, Copy)]
pub struct Palette {
    pub dark: bool,
    /// Window background (central area).
    pub bg: Color32,
    /// Sidebar / top bar.
    pub panel: Color32,
    /// Cards.
    pub surface: Color32,
    /// Inputs, hovered rows, subtle fills.
    pub surface2: Color32,
    pub border: Color32,
    pub text: Color32,
    pub text_dim: Color32,
    pub text_faint: Color32,
    pub accent: Color32,
    pub on_accent: Color32,
    pub green: Color32,
    pub amber: Color32,
    pub red: Color32,
    pub blue: Color32,
    pub violet: Color32,
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        let c = Color32::from_rgb;
        if dark {
            Self {
                dark,
                bg: c(32, 32, 32),
                panel: c(28, 28, 28),
                surface: c(43, 43, 43),
                surface2: c(50, 50, 50),
                border: c(58, 58, 58),
                text: c(255, 255, 255),
                text_dim: c(207, 207, 207),
                text_faint: c(157, 157, 157),
                accent: c(96, 205, 255),
                on_accent: Color32::BLACK,
                green: c(108, 203, 95),
                amber: c(252, 225, 0),
                red: c(255, 153, 164),
                blue: c(96, 205, 255),
                violet: c(176, 160, 255),
            }
        } else {
            Self {
                dark,
                bg: c(243, 243, 243),
                panel: c(238, 238, 238),
                surface: c(251, 251, 251),
                surface2: c(246, 246, 246),
                border: c(229, 229, 229),
                text: c(26, 26, 26),
                text_dim: c(93, 93, 93),
                text_faint: c(138, 138, 138),
                accent: c(0, 95, 184),
                on_accent: Color32::WHITE,
                green: c(15, 123, 15),
                amber: c(157, 93, 0),
                red: c(196, 43, 28),
                blue: c(0, 95, 184),
                violet: c(124, 77, 230),
            }
        }
    }

    /// Color for a usage percentage given its warning threshold.
    pub fn usage(&self, pct: f32, warn: f32) -> Color32 {
        if pct >= warn {
            self.red
        } else if pct >= warn - 15.0 {
            self.amber
        } else {
            self.green
        }
    }
}

/// `color` at `alpha` (0..=255), for tinted backgrounds.
pub fn tint(color: Color32, alpha: u8) -> Color32 {
    // Premultiply in gamma space: `from_rgba_unmultiplied` converts through
    // linear space, which makes low alphas look far more opaque.
    let f = alpha as f32 / 255.0;
    let m = |c: u8| (c as f32 * f).round() as u8;
    Color32::from_rgba_premultiplied(m(color.r()), m(color.g()), m(color.b()), alpha)
}

pub const SEMIBOLD: &str = "semibold";

pub fn semibold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name(SEMIBOLD.into()))
}

/// Use Segoe UI / Cascadia (or Consolas) when present, keeping egui's built-in
/// fonts as fallbacks for symbols and emoji.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let dir = std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into())
        .join("Fonts");
    let load = |names: &[&str]| -> Option<Vec<u8>> {
        names.iter().find_map(|n| std::fs::read(dir.join(n)).ok())
    };

    let mut semibold_chain = Vec::new();
    if let Some(bytes) = load(&["segoeui.ttf"]) {
        fonts
            .font_data
            .insert("ui".into(), FontData::from_owned(bytes));
        fonts
            .families
            .entry(FontFamily::Proportional)
            .or_default()
            .insert(0, "ui".into());
    }
    if let Some(bytes) = load(&["seguisb.ttf", "segoeuib.ttf"]) {
        fonts
            .font_data
            .insert("ui-semibold".into(), FontData::from_owned(bytes));
        semibold_chain.push("ui-semibold".to_string());
    }
    if let Some(bytes) = load(&["CascadiaMono.ttf", "consola.ttf"]) {
        fonts
            .font_data
            .insert("mono".into(), FontData::from_owned(bytes));
        fonts
            .families
            .entry(FontFamily::Monospace)
            .or_default()
            .insert(0, "mono".into());
    }
    // Semibold falls back to the regular chain (incl. emoji).
    let regular = fonts
        .families
        .get(&FontFamily::Proportional)
        .cloned()
        .unwrap_or_default();
    semibold_chain.extend(regular);
    fonts
        .families
        .insert(FontFamily::Name(SEMIBOLD.into()), semibold_chain);
    ctx.set_fonts(fonts);
}

pub fn apply(ctx: &egui::Context, pal: &Palette) {
    let mut style = (*ctx.style()).clone();
    let mut v = if pal.dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    let r6 = Rounding::same(4.0);
    v.panel_fill = pal.bg;
    v.window_fill = pal.surface;
    v.window_stroke = Stroke::new(1.0_f32, pal.border);
    v.window_rounding = Rounding::same(8.0);
    v.menu_rounding = Rounding::same(4.0);
    v.window_shadow = Shadow {
        offset: Vec2::new(0.0, 8.0),
        blur: 28.0,
        spread: 0.0,
        color: Color32::from_black_alpha(if pal.dark { 110 } else { 40 }),
    };
    v.popup_shadow = Shadow {
        offset: Vec2::new(0.0, 4.0),
        blur: 14.0,
        spread: 0.0,
        color: Color32::from_black_alpha(if pal.dark { 90 } else { 30 }),
    };
    v.extreme_bg_color = if pal.dark {
        Color32::from_rgb(28, 28, 28)
    } else {
        Color32::WHITE
    };
    v.faint_bg_color = if pal.dark {
        Color32::from_rgb(39, 39, 39)
    } else {
        Color32::from_rgb(247, 247, 247)
    };
    v.code_bg_color = pal.surface2;
    v.hyperlink_color = pal.accent;
    // Also the selected-row fill in tables: keep it subtle so text and tags
    // on selected rows stay readable.
    v.selection.bg_fill = tint(pal.accent, if pal.dark { 48 } else { 40 });
    v.selection.stroke = Stroke::new(1.0_f32, pal.accent);
    v.override_text_color = None;
    v.slider_trailing_fill = true;
    v.warn_fg_color = pal.amber;
    v.error_fg_color = pal.red;

    let w = &mut v.widgets;
    w.noninteractive.bg_fill = pal.surface;
    w.noninteractive.weak_bg_fill = pal.surface;
    w.noninteractive.bg_stroke = Stroke::new(1.0_f32, pal.border);
    w.noninteractive.fg_stroke = Stroke::new(1.0_f32, pal.text_dim);
    w.noninteractive.rounding = r6;

    w.inactive.bg_fill = pal.surface2;
    w.inactive.weak_bg_fill = pal.surface2;
    w.inactive.bg_stroke = Stroke::new(1.0_f32, pal.border);
    w.inactive.fg_stroke = Stroke::new(1.0_f32, pal.text);
    w.inactive.rounding = r6;

    let hover = if pal.dark {
        Color32::from_rgb(56, 56, 56)
    } else {
        Color32::from_rgb(240, 240, 240)
    };
    w.hovered.bg_fill = hover;
    w.hovered.weak_bg_fill = hover;
    w.hovered.bg_stroke = Stroke::new(1.0_f32, pal.border);
    w.hovered.fg_stroke = Stroke::new(1.5_f32, pal.text);
    w.hovered.rounding = r6;
    w.hovered.expansion = 0.0;

    w.active.bg_fill = pal.surface2;
    w.active.weak_bg_fill = pal.surface2;
    w.active.bg_stroke = Stroke::new(1.0_f32, pal.border);
    w.active.fg_stroke = Stroke::new(1.5_f32, pal.text);
    w.active.rounding = r6;
    w.active.expansion = 0.0;

    w.open.bg_fill = pal.surface2;
    w.open.weak_bg_fill = pal.surface2;
    w.open.bg_stroke = Stroke::new(1.0_f32, pal.accent);
    w.open.rounding = r6;

    style.visuals = v;
    style.spacing.item_spacing = Vec2::new(8.0, 7.0);
    style.spacing.button_padding = Vec2::new(11.0, 5.0);
    style.spacing.interact_size.y = 26.0;
    style.spacing.window_margin = Margin::same(18.0);
    style.spacing.menu_margin = Margin::same(6.0);
    style.spacing.scroll.bar_width = 8.0;
    style.spacing.scroll.floating = true;
    style.spacing.combo_width = 140.0;

    style.text_styles = [
        (TextStyle::Heading, semibold(21.0)),
        (TextStyle::Body, FontId::proportional(13.5)),
        (TextStyle::Button, FontId::proportional(13.5)),
        (TextStyle::Small, FontId::proportional(11.5)),
        (TextStyle::Monospace, FontId::monospace(12.5)),
    ]
    .into();
    ctx.set_style(style);
}
