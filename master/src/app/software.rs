//! Fleet-wide software inventory: which programs are installed where, in
//! which versions, and bulk uninstall.

use std::collections::BTreeMap;

use eframe::egui::{self, vec2, RichText};
use egui_extras::{Column, TableBuilder};

use super::{truncate, Action, App, DeviceRow};
use crate::ui::theme::semibold;
use crate::ui::widgets as w;

struct Install {
    agent_id: String,
    host: String,
    online: bool,
    version: String,
    uninstall: String,
}

struct Program {
    name: String,
    publisher: String,
    installs: Vec<Install>,
}

impl Program {
    fn versions(&self) -> Vec<(String, usize)> {
        let mut m: BTreeMap<String, usize> = BTreeMap::new();
        for i in &self.installs {
            *m.entry(if i.version.is_empty() {
                "?".into()
            } else {
                i.version.clone()
            })
            .or_default() += 1;
        }
        let mut v: Vec<(String, usize)> = m.into_iter().collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1));
        v
    }
}

impl App {
    fn fleet_programs(&self) -> Vec<Program> {
        let s = self.state.lock().unwrap();
        let mut map: BTreeMap<String, Program> = BTreeMap::new();
        for a in s.agents.values() {
            for e in &a.software {
                let key = e.name.trim().to_lowercase();
                let p = map.entry(key).or_insert_with(|| Program {
                    name: e.name.trim().to_string(),
                    publisher: e.publisher.clone().unwrap_or_default(),
                    installs: Vec::new(),
                });
                if p.installs.iter().any(|i| i.agent_id == a.agent_id) {
                    continue;
                }
                p.installs.push(Install {
                    agent_id: a.agent_id.clone(),
                    host: a.hostname.clone(),
                    online: a.online,
                    version: e.version.clone().unwrap_or_default(),
                    uninstall: e.uninstall_string.clone().unwrap_or_default(),
                });
            }
        }
        map.into_values().collect()
    }

    pub(super) fn page_software(&mut self, ui: &mut egui::Ui, rows: &[DeviceRow]) {
        let pal = self.pal;
        let programs = self.fleet_programs();
        let with_inventory = {
            let s = self.state.lock().unwrap();
            s.agents.values().filter(|a| !a.software.is_empty()).count()
        };
        self.page_header(
            ui,
            "Software",
            &format!(
                "{} distinct programs across {with_inventory} PCs with an inventory",
                programs.len()
            ),
            |app, ui| {
                if ui.button("📦  Install on PCs…").clicked() {
                    let ids = app.online_ids();
                    app.composer = Some(super::Composer {
                        kind: super::ComposerKind::Install,
                        ids,
                    });
                }
            },
        );
        let r = w::search_box(
            ui,
            &mut self.fleet_sw_filter,
            "Search programs or publishers  (Ctrl+F)",
            340.0,
        );
        if self.focus_search {
            r.request_focus();
            self.focus_search = false;
        }
        ui.add_space(8.0);

        let q = self.fleet_sw_filter.to_lowercase();
        let mut list: Vec<&Program> = programs
            .iter()
            .filter(|p| {
                q.is_empty()
                    || p.name.to_lowercase().contains(&q)
                    || p.publisher.to_lowercase().contains(&q)
            })
            .collect();
        list.sort_by(|a, b| {
            b.installs
                .len()
                .cmp(&a.installs.len())
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        if programs.is_empty() {
            w::card(ui, &pal, |ui| {
                ui.set_width(ui.available_width());
                w::empty_state(
                    ui,
                    &pal,
                    "📦",
                    "No inventory yet",
                    "Programs appear once PCs report their installed software.",
                );
            });
            return;
        }

        let open_key = self.fleet_sw_open.clone();
        let selected = open_key
            .as_ref()
            .and_then(|k| programs.iter().find(|p| p.name.to_lowercase() == *k));
        let avail = ui.available_width();
        let detail_w = if selected.is_some() {
            (avail * 0.42).max(320.0)
        } else {
            0.0
        };
        let table_w = avail - detail_w - if selected.is_some() { 12.0 } else { 0.0 };
        let mut open: Option<Option<String>> = None;

        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 12.0;
            ui.allocate_ui_with_layout(
                vec2(table_w, ui.available_height()),
                egui::Layout::top_down(egui::Align::LEFT),
                |ui| {
                    egui::Frame::none()
                        .fill(pal.surface)
                        .stroke(egui::Stroke::new(1.0_f32, pal.border))
                        .rounding(egui::Rounding::same(8.0))
                        .inner_margin(egui::Margin::symmetric(6.0, 4.0))
                        .show(ui, |ui| {
                            ui.set_width(table_w - 14.0);
                            let total = rows.len().max(1);
                            let cw = (table_w - 50.0).max(360.0);
                            TableBuilder::new(ui)
                                .striped(true)
                                .resizable(true)
                                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                                .column(Column::initial(cw * 0.40).at_least(120.0).clip(true))
                                .column(Column::initial(cw * 0.24).at_least(60.0).clip(true))
                                .column(Column::initial(cw * 0.16).at_least(90.0).clip(true))
                                .column(Column::remainder().at_least(60.0).clip(true))
                                .header(28.0, |mut h| {
                                    for t in ["PROGRAM", "PUBLISHER", "INSTALLED ON", "VERSIONS"] {
                                        h.col(|ui| {
                                            ui.label(
                                                RichText::new(t)
                                                    .font(semibold(12.0))
                                                    .color(pal.text_faint),
                                            );
                                        });
                                    }
                                })
                                .body(|body| {
                                    body.rows(32.0, list.len(), |mut row| {
                                        let p = list[row.index()];
                                        let is_sel = open_key.as_deref()
                                            == Some(p.name.to_lowercase().as_str());
                                        row.set_selected(is_sel);
                                        row.col(|ui| {
                                            let r = ui.add(
                                                egui::Label::new(
                                                    RichText::new(&p.name).color(pal.text),
                                                )
                                                .sense(egui::Sense::click()),
                                            );
                                            if r.on_hover_cursor(egui::CursorIcon::PointingHand)
                                                .clicked()
                                            {
                                                open = Some(if is_sel {
                                                    None
                                                } else {
                                                    Some(p.name.to_lowercase())
                                                });
                                            }
                                        });
                                        row.col(|ui| {
                                            ui.label(
                                                RichText::new(&p.publisher).color(pal.text_dim),
                                            );
                                        });
                                        row.col(|ui| {
                                            let n = p.installs.len();
                                            w::meter(
                                                ui,
                                                &pal,
                                                n as f32 / total as f32,
                                                pal.accent,
                                                40.0,
                                                &n.to_string(),
                                            );
                                        });
                                        row.col(|ui| {
                                            let v = p.versions();
                                            let text = if v.len() == 1 {
                                                v[0].0.clone()
                                            } else {
                                                format!("{} versions", v.len())
                                            };
                                            ui.label(RichText::new(text).monospace().color(
                                                if v.len() > 1 { pal.amber } else { pal.text_dim },
                                            ))
                                            .on_hover_text(
                                                v.iter()
                                                    .map(|(v, n)| format!("{v}  ×{n}"))
                                                    .collect::<Vec<_>>()
                                                    .join("\n"),
                                            );
                                        });
                                    });
                                });
                        });
                },
            );
            if let Some(p) = selected {
                ui.allocate_ui_with_layout(
                    vec2(detail_w, ui.available_height()),
                    egui::Layout::top_down(egui::Align::LEFT),
                    |ui| {
                        if self.program_detail(ui, p, rows, detail_w) {
                            open = Some(None);
                        }
                    },
                );
            }
        });
        if let Some(o) = open {
            self.fleet_sw_open = o;
        }
    }

    /// Returns true when closed.
    fn program_detail(
        &mut self,
        ui: &mut egui::Ui,
        p: &Program,
        rows: &[DeviceRow],
        width: f32,
    ) -> bool {
        let pal = self.pal;
        let mut close = false;
        let mut action: Option<Action> = None;
        let mut open_dev: Option<String> = None;
        w::card(ui, &pal, |ui| {
            ui.set_width(width - 30.0);
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new(truncate(&p.name, 46))
                            .font(semibold(16.0))
                            .color(pal.text),
                    );
                    if !p.publisher.is_empty() {
                        w::faint(ui, &pal, &p.publisher);
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::TOP), |ui| {
                    if w::ghost(ui, "✖").clicked() {
                        close = true;
                    }
                });
            });
            ui.add_space(6.0);
            ui.horizontal_wrapped(|ui| {
                for (v, n) in p.versions().iter().take(6) {
                    w::pill(ui, &format!("{v} ×{n}"), pal.blue);
                }
            });
            ui.add_space(8.0);
            let targets: Vec<(String, String)> = p
                .installs
                .iter()
                .filter(|i| i.online && !i.uninstall.is_empty())
                .map(|i| (i.agent_id.clone(), i.uninstall.clone()))
                .collect();
            ui.horizontal(|ui| {
                if w::danger(
                    ui,
                    &pal,
                    !targets.is_empty(),
                    &format!("Uninstall from {} online PC(s)", targets.len()),
                )
                .clicked()
                {
                    action = Some(Action::Uninstall {
                        name: p.name.clone(),
                        targets: targets.clone(),
                    });
                }
                if ui
                    .button("Select these PCs")
                    .on_hover_text("Check them in Devices for other bulk actions")
                    .clicked()
                {
                    self.checked = p.installs.iter().map(|i| i.agent_id.clone()).collect();
                    self.go(super::Page::Devices);
                }
            });
            ui.add_space(8.0);
            w::card_title(ui, &pal, &format!("Installed on {}", p.installs.len()));
            egui::ScrollArea::vertical()
                .id_salt("sw_hosts")
                .max_height(300.0)
                .show(ui, |ui| {
                    let mut inst: Vec<&Install> = p.installs.iter().collect();
                    inst.sort_by_key(|i| i.host.to_lowercase());
                    for i in inst {
                        ui.horizontal(|ui| {
                            w::dot(ui, if i.online { pal.green } else { pal.text_faint }, false);
                            if ui.link(RichText::new(&i.host).color(pal.text)).clicked() {
                                open_dev = Some(i.agent_id.clone());
                            }
                            ui.label(RichText::new(&i.version).monospace().color(pal.text_dim));
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    if !i.uninstall.is_empty()
                                        && ui
                                            .add_enabled(
                                                i.online,
                                                egui::Button::new("Uninstall").small(),
                                            )
                                            .clicked()
                                    {
                                        action = Some(Action::Uninstall {
                                            name: p.name.clone(),
                                            targets: vec![(
                                                i.agent_id.clone(),
                                                i.uninstall.clone(),
                                            )],
                                        });
                                    }
                                },
                            );
                        });
                    }
                });
            let missing: Vec<&DeviceRow> = rows
                .iter()
                .filter(|r| !p.installs.iter().any(|i| i.agent_id == r.id))
                .collect();
            if !missing.is_empty() {
                ui.add_space(8.0);
                egui::CollapsingHeader::new(
                    RichText::new(format!("Not installed on {}", missing.len()))
                        .color(pal.text_dim),
                )
                .id_salt("sw_missing")
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        for r in missing {
                            if ui.link(&r.host).clicked() {
                                open_dev = Some(r.id.clone());
                            }
                        }
                    });
                });
            }
        });
        if action.is_some() {
            self.confirm = action;
        }
        if let Some(id) = open_dev {
            self.device_tab = super::DeviceTab::Software;
            self.open_device(&id);
        }
        close
    }
}
