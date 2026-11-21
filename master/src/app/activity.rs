//! Activity log: searchable event list with export.

use eframe::egui::{self, RichText};

use super::dashboard::event_color;
use super::App;
use crate::ui::widgets as w;

impl App {
    pub(super) fn page_activity(&mut self, ui: &mut egui::Ui) {
        let pal = self.pal;
        let events: Vec<(chrono::DateTime<chrono::Local>, String)> =
            self.state.lock().unwrap().events.iter().cloned().collect();
        let q = self.activity_filter.to_lowercase();
        let shown: Vec<&(chrono::DateTime<chrono::Local>, String)> = events
            .iter()
            .filter(|(_, m)| q.is_empty() || m.to_lowercase().contains(&q))
            .collect();
        let as_text = shown
            .iter()
            .map(|(t, m)| format!("{}  {m}", t.format("%Y-%m-%d %H:%M:%S")))
            .collect::<Vec<_>>()
            .join("\n");
        self.page_header(
            ui,
            "Activity",
            &format!(
                "{} event(s) since the master started (also in the master log files)",
                events.len()
            ),
            |app, ui| {
                if ui.button("🗑  Clear").clicked() {
                    app.state.lock().unwrap().events.clear();
                }
                if ui.button("💾  Save…").clicked() {
                    if let Some(path) = rfd::FileDialog::new()
                        .set_file_name(format!(
                            "fleetview-activity-{}.txt",
                            chrono::Local::now().format("%Y%m%d-%H%M")
                        ))
                        .save_file()
                    {
                        match std::fs::write(&path, &as_text) {
                            Ok(()) => app.toast("Activity saved"),
                            Err(e) => app.toast_err(format!("Cannot save: {e}")),
                        }
                    }
                }
                if ui.button("📋  Copy").clicked() {
                    ui.ctx().copy_text(as_text.clone());
                    app.toast("Copied");
                }
                if ui.button("📂  Open log folder").clicked() {
                    let dir = crate::paths::data_dir().join("logs");
                    let _ = std::process::Command::new("explorer").arg(dir).spawn();
                }
            },
        );
        let r = w::search_box(
            ui,
            &mut self.activity_filter,
            "Filter events  (Ctrl+F)",
            340.0,
        );
        if self.focus_search {
            r.request_focus();
            self.focus_search = false;
        }
        ui.add_space(8.0);
        egui::Frame::none()
            .fill(pal.surface)
            .stroke(egui::Stroke::new(1.0_f32, pal.border))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::same(12.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.set_min_height(ui.available_height() - 6.0);
                if shown.is_empty() {
                    w::empty_state(ui, &pal, "📜", "No events", "Nothing matches.");
                    return;
                }
                let row_h = 20.0;
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show_rows(ui, row_h, shown.len(), |ui, range| {
                        for (t, m) in &shown[range] {
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new(t.format("%m-%d %H:%M:%S").to_string())
                                        .monospace()
                                        .color(pal.text_faint),
                                );
                                ui.label(RichText::new(m).color(event_color(&pal, m)));
                            });
                        }
                    });
            });
    }
}
