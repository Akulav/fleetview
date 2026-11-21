//! One PC: header with actions, and Overview / Software / Terminal / Screen /
//! History tabs.

use eframe::egui::{self, vec2, RichText};
use egui_extras::{Column, TableBuilder};

use fleetview_shared::protocol::{MasterMsg, RunSpec};

use super::{
    split_args, truncate, Action, App, Composer, ComposerKind, DeviceRow, DeviceTab, PowerKind,
    Severity,
};
use crate::agentpkg::UpdateState;
use crate::prefs::{builtin_snippets, Snippet};
use crate::state::TargetStatus;
use crate::ui::theme::{semibold, tint};
use crate::ui::widgets as w;

impl App {
    pub(super) fn page_device(&mut self, ui: &mut egui::Ui, id: &str, rows: &[DeviceRow]) {
        let pal = self.pal;
        let Some(row) = rows.iter().find(|r| r.id == id).cloned() else {
            w::empty_state(
                ui,
                &pal,
                "❓",
                "This PC is no longer in the list",
                "It may have been removed.",
            );
            return;
        };

        // ---- Header ----------------------------------------------------------
        ui.horizontal(|ui| {
            if ui.button("←").on_hover_text("Back (Alt+←)").clicked() {
                self.go_back();
            }
            ui.add_space(4.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.horizontal(|ui| {
                    w::heading(ui, &pal, &row.host);
                    if row.online {
                        w::status_pill(ui, "Online", pal.green);
                    } else {
                        w::status_pill(
                            ui,
                            &format!("Offline · {}", w::fmt_ago(row.last_seen)),
                            pal.text_faint,
                        );
                    }
                    if row.streaming {
                        w::status_pill(ui, "Live view", pal.red);
                    }
                    for t in &row.tags {
                        w::pill(ui, t, pal.violet);
                    }
                });
                let mut facts = Vec::new();
                if !row.user.is_empty() {
                    facts.push(format!("👤 {}", row.user));
                }
                if let Some(ip) = row.ips.iter().find(|i| !i.contains(':')) {
                    facts.push(ip.clone());
                }
                if !row.os.is_empty() {
                    facts.push(row.os.clone());
                }
                if !row.version.is_empty() {
                    facts.push(format!("agent {}", row.version));
                }
                w::subtle(ui, &pal, facts.join("   ·   "));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                self.device_actions(ui, &row);
            });
        });
        if let Some(n) = &row.update_note {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if row.updating {
                    ui.spinner();
                }
                ui.label(RichText::new(format!("Agent update: {n}")).color(pal.text_dim));
            });
        }
        ui.add_space(10.0);

        let sw_count = {
            let s = self.state.lock().unwrap();
            s.agents.get(id).map(|a| a.software.len()).unwrap_or(0)
        };
        let sw_label = format!("Software ({sw_count})");
        w::tabs(
            ui,
            &pal,
            &mut self.device_tab,
            &[
                (DeviceTab::Overview, "Overview"),
                (DeviceTab::Software, &sw_label),
                (DeviceTab::Terminal, "PowerShell"),
                (DeviceTab::Screen, "Screen"),
                (DeviceTab::History, "History"),
            ],
        );
        ui.add_space(12.0);

        match self.device_tab {
            DeviceTab::Overview => self.tab_overview(ui, id, &row),
            DeviceTab::Software => self.tab_software(ui, id, &row),
            DeviceTab::Terminal => self.tab_terminal(ui, id, &row),
            DeviceTab::Screen => self.tab_screen(ui, id, &row),
            DeviceTab::History => self.tab_history(ui, id),
        }
    }

    fn device_actions(&mut self, ui: &mut egui::Ui, row: &DeviceRow) {
        let pal = self.pal;
        let id = row.id.clone();
        let ids = vec![id.clone()];
        ui.menu_button("More…", |ui| {
            if ui.button("📋  Copy agent id").clicked() {
                ui.ctx().copy_text(id.clone());
                ui.close_menu();
            }
            if ui.button("🏷  Edit tags…").clicked() {
                self.tag_input.clear();
                self.composer = Some(Composer {
                    kind: ComposerKind::Tags,
                    ids: ids.clone(),
                });
                ui.close_menu();
            }
            if ui
                .add_enabled(row.online, egui::Button::new("⚙  Remote config…"))
                .clicked()
            {
                self.composer = Some(Composer {
                    kind: ComposerKind::Config,
                    ids: ids.clone(),
                });
                ui.close_menu();
            }
            ui.separator();
            if ui
                .add_enabled(row.online, egui::Button::new("✏  Rename PC…"))
                .clicked()
            {
                self.rename_input = row.host.clone();
                self.composer = Some(Composer {
                    kind: ComposerKind::Rename,
                    ids: ids.clone(),
                });
                ui.close_menu();
            }
            if ui
                .add_enabled(
                    row.online && self.policy.admin_ready(),
                    egui::Button::new("🔑  Set standard admin account"),
                )
                .on_disabled_hover_text("Set it up on the Standards page first")
                .clicked()
            {
                self.confirm = Some(Action::SetAdmin { ids: ids.clone() });
                ui.close_menu();
            }
            if ui
                .add_enabled(
                    row.online && self.policy.wallpaper_ready(),
                    egui::Button::new("🖼  Set standard background"),
                )
                .on_disabled_hover_text("Set it up on the Standards page first")
                .clicked()
            {
                self.confirm = Some(Action::Wallpaper { ids: ids.clone() });
                ui.close_menu();
            }
            if ui
                .add_enabled(
                    row.online && !self.policy.apps.is_empty(),
                    egui::Button::new("📦  Install app package"),
                )
                .on_disabled_hover_text("Set it up on the Standards page first")
                .clicked()
            {
                self.confirm = Some(Action::InstallApps {
                    apps: self.policy.apps.clone(),
                    ids: ids.clone(),
                    package: true,
                });
                ui.close_menu();
            }
            ui.separator();
            if ui
                .add_enabled(
                    !row.online,
                    egui::Button::new(RichText::new("🗑  Remove from list").color(pal.red)),
                )
                .on_disabled_hover_text("Only offline PCs can be removed")
                .clicked()
            {
                self.confirm = Some(Action::Forget { ids: ids.clone() });
                ui.close_menu();
            }
        });
        if let Some(p) = &self.package {
            let pv = p.version;
            let label = match row.update {
                UpdateState::Outdated => format!("⬆  Update to {pv}"),
                _ => format!("Reinstall {pv}"),
            };
            let enabled = row.online && !row.updating && row.update != UpdateState::Newer;
            let btn = if row.update == UpdateState::Outdated {
                w::primary_enabled(ui, &pal, enabled, &label)
            } else {
                ui.add_enabled(enabled, egui::Button::new(label))
            };
            if btn.clicked() {
                self.confirm = Some(Action::Update { ids: ids.clone() });
            }
        }
        ui.menu_button("⚡  Power", |ui| {
            for k in [PowerKind::Restart, PowerKind::Shutdown, PowerKind::Abort] {
                if ui
                    .add_enabled(row.online, egui::Button::new(k.label()))
                    .clicked()
                {
                    self.confirm = Some(Action::Power {
                        kind: k,
                        ids: ids.clone(),
                    });
                    ui.close_menu();
                }
            }
            ui.separator();
            if ui
                .add_enabled(!row.online, egui::Button::new("⏰  Wake-on-LAN"))
                .on_disabled_hover_text("The PC is already online")
                .clicked()
            {
                self.wake(&ids);
                ui.close_menu();
            }
        });
        if ui
            .add_enabled(row.online, egui::Button::new("💬  Message"))
            .clicked()
        {
            self.composer = Some(Composer {
                kind: ComposerKind::Notify,
                ids: ids.clone(),
            });
        }
        if ui
            .add_enabled(row.online, egui::Button::new("↻  Refresh"))
            .on_hover_text("Ask for fresh telemetry and inventory")
            .clicked()
        {
            self.send_to(&id, MasterMsg::RequestTelemetry);
            self.send_to(&id, MasterMsg::RequestSoftware);
            self.toast(format!("Refresh requested from {}", row.host));
        }
    }

    // -----------------------------------------------------------------------
    // Overview
    // -----------------------------------------------------------------------

    fn tab_overview(&mut self, ui: &mut egui::Ui, id: &str, row: &DeviceRow) {
        let pal = self.pal;
        let (t, hist, first_seen, macs, mut notes) = {
            let s = self.state.lock().unwrap();
            let Some(a) = s.agents.get(id) else { return };
            (
                a.telemetry.clone(),
                a.history.iter().copied().collect::<Vec<_>>(),
                a.first_seen,
                a.last_macs.clone(),
                a.notes.clone(),
            )
        };
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                // Alerts
                if !row.alerts.is_empty() {
                    for a in &row.alerts {
                        let c = match a.severity {
                            Severity::Crit => pal.red,
                            Severity::Warn => pal.amber,
                            Severity::Info => pal.blue,
                        };
                        egui::Frame::none()
                            .fill(tint(c, 16))
                            .stroke(egui::Stroke::new(1.0_f32, tint(c, 90)))
                            .rounding(egui::Rounding::same(8.0))
                            .inner_margin(egui::Margin::symmetric(12.0, 7.0))
                            .show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                ui.label(RichText::new(format!("⚠  {}", a.text)).color(c));
                            });
                        ui.add_space(4.0);
                    }
                    ui.add_space(6.0);
                }

                let gap = 12.0;
                let avail = ui.available_width();
                let card_w = (avail - 2.0 * gap) / 3.0;

                // Metric cards
                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    let cpu_hist: Vec<f32> = hist.iter().map(|s| s.cpu).collect();
                    let mem_hist: Vec<f32> = hist.iter().map(|s| s.mem).collect();
                    let span = hist
                        .first()
                        .map(|s| {
                            w::fmt_duration(
                                (chrono::Local::now() - s.at).num_seconds().max(0) as u64
                            )
                        })
                        .unwrap_or_default();
                    self.metric_card(
                        ui,
                        card_w,
                        "CPU",
                        &row.cpu
                            .map(|c| format!("{c:.0}%"))
                            .unwrap_or_else(|| "—".into()),
                        &t.as_ref()
                            .map(|t| {
                                format!("{} · {} cores", truncate(&t.cpu_name, 30), t.cpu_cores)
                            })
                            .unwrap_or_default(),
                        &cpu_hist,
                        pal.accent,
                        &span,
                    );
                    self.metric_card(
                        ui,
                        card_w,
                        "Memory",
                        &row.mem
                            .map(|c| format!("{c:.0}%"))
                            .unwrap_or_else(|| "—".into()),
                        &t.as_ref()
                            .map(|t| {
                                format!(
                                    "{} of {} used",
                                    w::fmt_mb(t.mem_used_mb),
                                    w::fmt_mb(t.mem_total_mb)
                                )
                            })
                            .unwrap_or_default(),
                        &mem_hist,
                        pal.violet,
                        &span,
                    );
                    // Disks
                    w::card(ui, &pal, |ui| {
                        ui.set_width(card_w - 30.0);
                        ui.set_min_height(132.0);
                        w::card_title(ui, &pal, "Disks");
                        ui.add_space(6.0);
                        match &t {
                            Some(t) if !t.disks.is_empty() => {
                                for d in &t.disks {
                                    let used = d.total_gb - d.available_gb;
                                    let pct = if d.total_gb > 0.0 {
                                        (100.0 * used / d.total_gb) as f32
                                    } else {
                                        0.0
                                    };
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(&d.mount)
                                                .font(semibold(13.0))
                                                .color(pal.text),
                                        );
                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                ui.label(
                                                    RichText::new(format!(
                                                        "{:.0} GB free of {:.0}",
                                                        d.available_gb, d.total_gb
                                                    ))
                                                    .size(12.0)
                                                    .color(pal.text_dim),
                                                );
                                            },
                                        );
                                    });
                                    w::bar(
                                        ui,
                                        &pal,
                                        pct / 100.0,
                                        pal.usage(pct, self.prefs.disk_warn_pct),
                                        ui.available_width(),
                                    );
                                    ui.add_space(4.0);
                                }
                            }
                            _ => {
                                w::subtle(ui, &pal, "No data yet.");
                            }
                        }
                    });
                });
                ui.add_space(gap);

                // System + Tags/notes
                let left_w = (avail - gap) * 0.55;
                let right_w = avail - gap - left_w;
                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = gap;
                    ui.allocate_ui_with_layout(
                        vec2(left_w, 0.0),
                        egui::Layout::top_down(egui::Align::LEFT),
                        |ui| {
                            w::card(ui, &pal, |ui| {
                                ui.set_width(left_w - 30.0);
                                w::card_title(ui, &pal, "System");
                                ui.add_space(6.0);
                                egui::Grid::new("sysinfo")
                                    .num_columns(2)
                                    .spacing([18.0, 7.0])
                                    .show(ui, |ui| {
                                        let tt = t.as_ref();
                                        w::kv_row(ui, &pal, "Hostname", &row.host);
                                        w::kv_row(
                                            ui,
                                            &pal,
                                            "Operating system",
                                            &tt.map(|t| t.os_version.clone())
                                                .unwrap_or_else(|| row.os.clone()),
                                        );
                                        w::kv_row(ui, &pal, "Logged-in user", &row.user);
                                        w::kv_row(
                                            ui,
                                            &pal,
                                            "Uptime",
                                            &row.uptime.map(w::fmt_duration).unwrap_or_default(),
                                        );
                                        w::kv_row(ui, &pal, "IP addresses", &row.ips.join(", "));
                                        w::kv_row(ui, &pal, "MAC addresses", &macs.join(", "));
                                        w::kv_row(ui, &pal, "Agent version", &row.version);
                                        w::kv_row(
                                            ui,
                                            &pal,
                                            "First seen",
                                            &first_seen.format("%Y-%m-%d %H:%M").to_string(),
                                        );
                                        w::kv_row(
                                            ui,
                                            &pal,
                                            "Last seen",
                                            &row.last_seen.format("%Y-%m-%d %H:%M:%S").to_string(),
                                        );
                                        w::kv_row(ui, &pal, "Agent id", id);
                                    });
                            });
                        },
                    );
                    ui.allocate_ui_with_layout(
                        vec2(right_w, 0.0),
                        egui::Layout::top_down(egui::Align::LEFT),
                        |ui| {
                            w::card(ui, &pal, |ui| {
                                ui.set_width(right_w - 30.0);
                                w::card_title(ui, &pal, "Tags");
                                ui.add_space(6.0);
                                let mut remove: Option<String> = None;
                                ui.horizontal_wrapped(|ui| {
                                    for t in &row.tags {
                                        let r = w::pill(ui, &format!("{t}  ✖"), pal.violet)
                                            .interact(egui::Sense::click())
                                            .on_hover_text("Remove tag")
                                            .on_hover_cursor(egui::CursorIcon::PointingHand);
                                        if r.clicked() {
                                            remove = Some(t.clone());
                                        }
                                    }
                                    if row.tags.is_empty() {
                                        w::faint(ui, &pal, "No tags yet.");
                                    }
                                });
                                ui.horizontal(|ui| {
                                    let r = ui.add(
                                        egui::TextEdit::singleline(&mut self.tag_input)
                                            .hint_text("Add a tag, e.g. Accounting")
                                            .desired_width(ui.available_width() - 60.0),
                                    );
                                    let enter = r.lost_focus()
                                        && ui.input(|i| i.key_pressed(egui::Key::Enter));
                                    if (ui.button("Add").clicked() || enter)
                                        && !self.tag_input.trim().is_empty()
                                    {
                                        let t = self.tag_input.trim().to_string();
                                        self.set_tags(&[id.to_string()], &[t], &[]);
                                        self.tag_input.clear();
                                    }
                                });
                                if let Some(t) = remove {
                                    self.set_tags(&[id.to_string()], &[], &[t]);
                                }
                                ui.add_space(10.0);
                                w::card_title(ui, &pal, "Notes");
                                ui.add_space(4.0);
                                let r = ui.add(
                                    egui::TextEdit::multiline(&mut notes)
                                        .hint_text("Location, owner, warranty, quirks…")
                                        .desired_rows(5)
                                        .desired_width(f32::INFINITY),
                                );
                                if r.changed() {
                                    let mut s = self.state.lock().unwrap();
                                    if let Some(a) = s.agents.get_mut(id) {
                                        a.notes = notes.clone();
                                    }
                                }
                                if r.lost_focus() {
                                    let s = self.state.lock().unwrap();
                                    crate::state::save_known(&s);
                                }
                                w::faint(ui, &pal, "Saved on this master only.");
                            });
                        },
                    );
                });
            });
    }

    #[allow(clippy::too_many_arguments)]
    fn metric_card(
        &self,
        ui: &mut egui::Ui,
        width: f32,
        title: &str,
        value: &str,
        caption: &str,
        hist: &[f32],
        color: egui::Color32,
        span: &str,
    ) {
        let pal = self.pal;
        w::card(ui, &pal, |ui| {
            ui.set_width(width - 30.0);
            ui.set_min_height(132.0);
            ui.horizontal(|ui| {
                w::card_title(ui, &pal, title);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if !span.is_empty() {
                        w::faint(ui, &pal, format!("last {span}"));
                    }
                });
            });
            ui.horizontal(|ui| {
                ui.label(RichText::new(value).font(semibold(26.0)).color(pal.text));
                ui.label(RichText::new(caption).size(12.0).color(pal.text_faint));
            });
            ui.add_space(4.0);
            w::sparkline(
                ui,
                &pal,
                hist,
                vec2(ui.available_width(), 54.0),
                color,
                100.0,
            );
        });
    }

    // -----------------------------------------------------------------------
    // Software
    // -----------------------------------------------------------------------

    fn tab_software(&mut self, ui: &mut egui::Ui, id: &str, row: &DeviceRow) {
        let pal = self.pal;
        let online = row.online;
        w::card(ui, &pal, |ui| {
            ui.set_width(ui.available_width());
            w::card_title(ui, &pal, "Install software (silently, as SYSTEM)");
            ui.add_space(4.0);
            ui.horizontal_wrapped(|ui| {
                if ui
                    .add_enabled(online, egui::Button::new("📂  Push installer files…"))
                    .on_hover_text(
                        "Pick one or more .exe / .msi; their silent switches are detected",
                    )
                    .clicked()
                {
                    self.install_queue.clear();
                    self.add_installer_files_to_queue();
                    if !self.install_queue.is_empty() {
                        self.composer = Some(Composer {
                            kind: ComposerKind::Install,
                            ids: vec![id.to_string()],
                        });
                    }
                }
                ui.separator();
                ui.label("or URL");
                ui.add(
                    egui::TextEdit::singleline(&mut self.url_input)
                        .hint_text("https://example.com/setup.exe")
                        .desired_width(260.0),
                );
                let url_ok = self.url_input.trim().to_lowercase().starts_with("https://");
                if ui
                    .add_enabled(online && url_ok, egui::Button::new("⬇  Download & run"))
                    .clicked()
                {
                    let url = self.url_input.trim().to_string();
                    let is_msi = self.install_is_msi;
                    let args = split_args(&self.install_args);
                    let name = truncate(url.rsplit('/').next().unwrap_or(&url), 40);
                    self.dispatch(
                        crate::state::JobKind::Install,
                        format!("Install {name}"),
                        url.clone(),
                        &[id.to_string()],
                        |cid| MasterMsg::InstallFromUrl {
                            command_id: cid.clone(),
                            url: url.clone(),
                            run: RunSpec {
                                command_id: cid,
                                args: args.clone(),
                                is_msi,
                            },
                        },
                    );
                }
                if !self.url_input.trim().is_empty() && !url_ok {
                    ui.label(RichText::new("https:// only").color(pal.red));
                }
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.install_is_msi, "MSI package");
                ui.label("Silent arguments");
                ui.add(egui::TextEdit::singleline(&mut self.install_args).desired_width(140.0));
                w::faint(ui, &pal, "e.g. /S (NSIS), /VERYSILENT (Inno), /qn (MSI)");
            });
        });
        ui.add_space(10.0);

        ui.horizontal(|ui| {
            w::search_box(
                ui,
                &mut self.software_filter,
                "Filter programs or publishers",
                280.0,
            );
            if ui
                .add_enabled(online, egui::Button::new("↻  Refresh inventory"))
                .clicked()
            {
                self.send_to(id, MasterMsg::RequestSoftware);
                self.toast("Inventory requested");
            }
        });
        ui.add_space(6.0);

        let filter = self.software_filter.to_lowercase();
        let mut list: Vec<(String, String, String, String)> = {
            let s = self.state.lock().unwrap();
            s.agents
                .get(id)
                .map(|a| {
                    a.software
                        .iter()
                        .filter(|e| {
                            filter.is_empty()
                                || e.name.to_lowercase().contains(&filter)
                                || e.publisher
                                    .as_deref()
                                    .unwrap_or("")
                                    .to_lowercase()
                                    .contains(&filter)
                        })
                        .map(|e| {
                            (
                                e.name.clone(),
                                e.publisher.clone().unwrap_or_default(),
                                e.version.clone().unwrap_or_default(),
                                e.uninstall_string.clone().unwrap_or_default(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        list.sort_by_key(|e| e.0.to_lowercase());
        if list.is_empty() {
            w::card(ui, &pal, |ui| {
                ui.set_width(ui.available_width());
                w::empty_state(
                    ui,
                    &pal,
                    "📦",
                    "No programs",
                    if filter.is_empty() {
                        "The inventory has not arrived yet."
                    } else {
                        "Nothing matches the filter."
                    },
                );
            });
            return;
        }
        w::faint(ui, &pal, format!("{} program(s)", list.len()));
        let mut uninstall: Option<(String, String)> = None;
        egui::Frame::none()
            .fill(pal.surface)
            .stroke(egui::Stroke::new(1.0_f32, pal.border))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::symmetric(6.0, 4.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                TableBuilder::new(ui)
                    .striped(true)
                    .resizable(true)
                    .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                    .column(Column::initial(340.0).at_least(160.0).clip(true))
                    .column(Column::initial(200.0).at_least(80.0).clip(true))
                    .column(Column::initial(130.0).at_least(60.0).clip(true))
                    .column(Column::remainder().at_least(90.0))
                    .header(28.0, |mut h| {
                        for t in ["NAME", "PUBLISHER", "VERSION", ""] {
                            h.col(|ui| {
                                ui.label(
                                    RichText::new(t).font(semibold(12.0)).color(pal.text_faint),
                                );
                            });
                        }
                    })
                    .body(|body| {
                        body.rows(32.0, list.len(), |mut row| {
                            let (name, publisher, ver, un) = &list[row.index()];
                            row.col(|ui| {
                                ui.label(RichText::new(name).color(pal.text));
                            });
                            row.col(|ui| {
                                ui.label(RichText::new(publisher).color(pal.text_dim));
                            });
                            row.col(|ui| {
                                ui.label(RichText::new(ver).monospace().color(pal.text_dim));
                            });
                            row.col(|ui| {
                                if !un.is_empty()
                                    && ui
                                        .add_enabled(online, egui::Button::new("Uninstall").small())
                                        .on_hover_text(un)
                                        .clicked()
                                {
                                    uninstall = Some((name.clone(), un.clone()));
                                }
                            });
                        });
                    });
            });
        if let Some((name, un)) = uninstall {
            self.confirm = Some(Action::Uninstall {
                name,
                targets: vec![(id.to_string(), un)],
            });
        }
    }

    // -----------------------------------------------------------------------
    // Terminal
    // -----------------------------------------------------------------------

    fn tab_terminal(&mut self, ui: &mut egui::Ui, id: &str, row: &DeviceRow) {
        let pal = self.pal;
        let mut run = false;
        ui.horizontal(|ui| {
            ui.label(RichText::new("Runs as SYSTEM (elevated) on").color(pal.text_dim));
            ui.label(
                RichText::new(&row.host)
                    .font(semibold(13.5))
                    .color(pal.text),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                self.snippet_menus(ui);
            });
        });
        ui.add_space(4.0);
        let editor = ui.add(
            egui::TextEdit::multiline(&mut self.ps_input)
                .desired_rows(7)
                .desired_width(f32::INFINITY)
                .code_editor()
                .hint_text("Get-Service | Where-Object Status -eq 'Running'\n\nCtrl+Enter to run · Ctrl+↑/↓ for history"),
        );
        if editor.has_focus() {
            let (enter, up, down) = ui.input_mut(|i| {
                (
                    i.consume_key(egui::Modifiers::COMMAND, egui::Key::Enter),
                    i.consume_key(egui::Modifiers::COMMAND, egui::Key::ArrowUp),
                    i.consume_key(egui::Modifiers::COMMAND, egui::Key::ArrowDown),
                )
            });
            run |= enter;
            if up && !self.ps_history.is_empty() {
                let pos = match self.ps_history_pos {
                    None => self.ps_history.len() - 1,
                    Some(p) => p.saturating_sub(1),
                };
                self.ps_history_pos = Some(pos);
                self.ps_input = self.ps_history[pos].clone();
            }
            if down {
                if let Some(p) = self.ps_history_pos {
                    if p + 1 < self.ps_history.len() {
                        self.ps_history_pos = Some(p + 1);
                        self.ps_input = self.ps_history[p + 1].clone();
                    } else {
                        self.ps_history_pos = None;
                        self.ps_input.clear();
                    }
                }
            }
        }
        ui.horizontal(|ui| {
            run |= w::primary_enabled(
                ui,
                &pal,
                row.online && !self.ps_input.trim().is_empty(),
                "▶  Run",
            )
            .clicked();
            if ui
                .add_enabled(
                    !self.ps_input.trim().is_empty(),
                    egui::Button::new("Run on selection / fleet…"),
                )
                .on_hover_text("Open the bulk runner with this script")
                .clicked()
            {
                let ids = if self.checked.is_empty() {
                    self.online_ids()
                } else {
                    self.only_online(&self.checked.iter().cloned().collect::<Vec<_>>())
                };
                self.composer = Some(Composer {
                    kind: ComposerKind::Script,
                    ids,
                });
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Clear output").clicked() {
                    if let Some(a) = self.state.lock().unwrap().agents.get_mut(id) {
                        a.console_output.clear();
                    }
                }
                if ui.button("Copy output").clicked() {
                    let out = self
                        .state
                        .lock()
                        .unwrap()
                        .agents
                        .get(id)
                        .map(|a| a.console_output.clone())
                        .unwrap_or_default();
                    ui.ctx().copy_text(out);
                    self.toast("Output copied");
                }
            });
        });
        if run && row.online && !self.ps_input.trim().is_empty() {
            let script = self.ps_input.clone();
            self.remember_script(&script);
            self.run_script(script, &[id.to_string()]);
        }
        ui.add_space(6.0);
        let output = {
            let s = self.state.lock().unwrap();
            s.agents
                .get(id)
                .map(|a| a.console_output.clone())
                .unwrap_or_default()
        };
        let pending = {
            let s = self.state.lock().unwrap();
            s.jobs
                .iter()
                .take(20)
                .flat_map(|j| j.targets.iter())
                .any(|t| t.agent_id == id && t.status == TargetStatus::Pending)
        };
        egui::Frame::none()
            .fill(ui.visuals().extreme_bg_color)
            .stroke(egui::Stroke::new(1.0_f32, pal.border))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::same(12.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.set_min_height(ui.available_height() - 8.0);
                if pending {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        w::faint(ui, &pal, "Waiting for the result…");
                    });
                }
                if output.is_empty() && !pending {
                    w::faint(ui, &pal, "Output appears here.");
                }
                egui::ScrollArea::vertical()
                    .id_salt("console")
                    .stick_to_bottom(true)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        for line in output.lines() {
                            let color = if line.starts_with("$ [") {
                                if line.contains("ok=true") {
                                    pal.green
                                } else {
                                    pal.red
                                }
                            } else if line.starts_with("[stderr]") {
                                pal.amber
                            } else {
                                pal.text
                            };
                            ui.label(RichText::new(line).monospace().color(color));
                        }
                    });
            });
    }

    /// Snippet library + save-as-snippet + history menus.
    pub(super) fn snippet_menus(&mut self, ui: &mut egui::Ui) {
        let pal = self.pal;
        ui.menu_button("🕘  History", |ui| {
            if self.ps_history.is_empty() {
                ui.label(RichText::new("Nothing run yet").color(pal.text_faint));
            }
            for h in self.ps_history.clone().iter().rev().take(20) {
                let first = h.lines().next().unwrap_or("");
                if ui.button(truncate(first, 60)).on_hover_text(h).clicked() {
                    self.ps_input = h.clone();
                    ui.close_menu();
                }
            }
        });
        ui.menu_button("💾  Save as snippet", |ui| {
            ui.set_min_width(260.0);
            ui.label("Name");
            ui.text_edit_singleline(&mut self.snippet_name);
            let ok = !self.snippet_name.trim().is_empty() && !self.ps_input.trim().is_empty();
            if ui.add_enabled(ok, egui::Button::new("Save")).clicked() {
                let name = self.snippet_name.trim().to_string();
                self.prefs.snippets.retain(|s| s.name != name);
                self.prefs.snippets.push(Snippet {
                    name: name.clone(),
                    script: self.ps_input.trim().to_string(),
                });
                self.prefs.save();
                self.snippet_name.clear();
                self.toast(format!("Snippet “{name}” saved"));
                ui.close_menu();
            }
        });
        ui.menu_button("📚  Snippets", |ui| {
            ui.set_min_width(240.0);
            ui.label(
                RichText::new("BUILT-IN")
                    .font(semibold(11.0))
                    .color(pal.text_faint),
            );
            for s in builtin_snippets() {
                if ui.button(&s.name).on_hover_text(&s.script).clicked() {
                    self.ps_input = s.script.clone();
                    ui.close_menu();
                }
            }
            if !self.prefs.snippets.is_empty() {
                ui.separator();
                ui.label(
                    RichText::new("SAVED")
                        .font(semibold(11.0))
                        .color(pal.text_faint),
                );
                let mut delete = None;
                for (i, s) in self.prefs.snippets.iter().enumerate() {
                    ui.horizontal(|ui| {
                        if ui.button(&s.name).on_hover_text(&s.script).clicked() {
                            self.ps_input = s.script.clone();
                            ui.close_menu();
                        }
                        if ui
                            .small_button("✖")
                            .on_hover_text("Delete snippet")
                            .clicked()
                        {
                            delete = Some(i);
                        }
                    });
                }
                if let Some(i) = delete {
                    self.prefs.snippets.remove(i);
                    self.prefs.save();
                }
            }
        });
    }

    // -----------------------------------------------------------------------
    // Screen
    // -----------------------------------------------------------------------

    fn tab_screen(&mut self, ui: &mut egui::Ui, id: &str, row: &DeviceRow) {
        let pal = self.pal;
        let (streaming, frame_at) = {
            let s = self.state.lock().unwrap();
            s.agents
                .get(id)
                .map(|a| (a.streaming, a.frame_at))
                .unwrap_or((false, None))
        };
        ui.horizontal(|ui| {
            if ui
                .add_enabled(row.online, egui::Button::new("📷  Capture once"))
                .clicked()
            {
                self.send_to(
                    id,
                    MasterMsg::RequestScreenshot {
                        command_id: Self::new_command_id(),
                    },
                );
            }
            ui.separator();
            if !streaming {
                ui.add(egui::Slider::new(&mut self.stream_fps, 1..=10).text("fps"));
                if w::primary_enabled(ui, &pal, row.online, "▶  Start live view").clicked() {
                    let interval = (1000 / self.stream_fps.max(1)) as u64;
                    self.send_to(
                        id,
                        MasterMsg::StartScreenStream {
                            interval_ms: interval,
                            jpeg_quality: 60,
                        },
                    );
                    // The agent itself notifies the user (localized) when a
                    // live view starts or a screenshot is taken.
                    if let Some(a) = self.state.lock().unwrap().agents.get_mut(id) {
                        a.streaming = true;
                    }
                }
            } else {
                if w::danger(ui, &pal, true, "■  Stop live view").clicked() {
                    self.send_to(id, MasterMsg::StopScreenStream);
                    if let Some(a) = self.state.lock().unwrap().agents.get_mut(id) {
                        a.streaming = false;
                    }
                }
                w::status_pill(ui, "LIVE", pal.red);
            }
            ui.separator();
            ui.checkbox(&mut self.screen_fit, "Fit to window");
            let has = self.textures.contains_key(id);
            if ui
                .add_enabled(has, egui::Button::new("💾  Save image…"))
                .clicked()
            {
                self.save_screenshot(id, &row.host);
            }
            if let Some(at) = frame_at {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    w::faint(ui, &pal, format!("Captured {}", at.format("%H:%M:%S")));
                });
            }
        });
        w::faint(
            ui,
            &pal,
            "The user is notified, and a red frame is shown on their screen while it is captured.",
        );
        ui.add_space(8.0);

        // Update texture if a new frame arrived.
        let frame = {
            let s = self.state.lock().unwrap();
            s.agents
                .get(id)
                .and_then(|a| a.last_frame.as_ref().map(|f| (a.frame_seq, f.jpeg.clone())))
        };
        if let Some((seq, jpeg)) = frame {
            let need_update = self
                .textures
                .get(id)
                .map(|(s, _)| *s != seq)
                .unwrap_or(true);
            if need_update {
                if let Ok(img) = image::load_from_memory(&jpeg) {
                    let rgba = img.to_rgba8();
                    // Use the decoded size, not the agent-reported one: a
                    // mismatch makes `from_rgba_unmultiplied` panic, which
                    // aborts the whole master (panic = "abort" in release).
                    let color = egui::ColorImage::from_rgba_unmultiplied(
                        [rgba.width() as usize, rgba.height() as usize],
                        rgba.as_raw(),
                    );
                    let tex = ui.ctx().load_texture(
                        format!("screen_{id}"),
                        color,
                        egui::TextureOptions::LINEAR,
                    );
                    self.textures.insert(id.to_string(), (seq, tex));
                }
            }
        }
        match self.textures.get(id) {
            Some((_, tex)) => {
                let [w0, h0] = tex.size().map(|v| v.max(1) as f32);
                egui::ScrollArea::both()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let size = if self.screen_fit {
                            let sw = ui.available_width() / w0;
                            let sh = (ui.available_height() - 4.0) / h0;
                            let s = sw.min(sh).clamp(0.05, 1.0);
                            vec2(w0 * s, h0 * s)
                        } else {
                            vec2(w0, h0)
                        };
                        egui::Frame::none()
                            .stroke(egui::Stroke::new(1.0_f32, pal.border))
                            .rounding(egui::Rounding::same(6.0))
                            .show(ui, |ui| {
                                ui.image(egui::load::SizedTexture::new(tex.id(), size));
                            });
                    });
            }
            None => {
                w::card(ui, &pal, |ui| {
                    ui.set_width(ui.available_width());
                    w::empty_state(
                        ui,
                        &pal,
                        "🖵",
                        "No screenshot yet",
                        "Capture once, or start a live view.",
                    );
                });
            }
        }
    }

    fn save_screenshot(&mut self, id: &str, host: &str) {
        let jpeg = {
            let s = self.state.lock().unwrap();
            s.agents
                .get(id)
                .and_then(|a| a.last_frame.as_ref().map(|f| f.jpeg.clone()))
        };
        let Some(jpeg) = jpeg else { return };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!(
                "{host}-{}.png",
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            ))
            .add_filter("PNG image", &["png"])
            .save_file()
        else {
            return;
        };
        let result = image::load_from_memory(&jpeg)
            .map_err(|e| e.to_string())
            .and_then(|img| img.save(&path).map_err(|e| e.to_string()));
        match result {
            Ok(()) => self.toast(format!("Saved {}", path.display())),
            Err(e) => self.toast_err(format!("Cannot save: {e}")),
        }
    }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    fn tab_history(&mut self, ui: &mut egui::Ui, id: &str) {
        let pal = self.pal;
        let items: Vec<(
            u64,
            String,
            chrono::DateTime<chrono::Local>,
            crate::state::JobTarget,
        )> = {
            let s = self.state.lock().unwrap();
            s.jobs
                .iter()
                .filter_map(|j| {
                    j.targets
                        .iter()
                        .find(|t| t.agent_id == id)
                        .map(|t| (j.id, j.title.clone(), j.created, t.clone()))
                })
                .collect()
        };
        if items.is_empty() {
            w::card(ui, &pal, |ui| {
                ui.set_width(ui.available_width());
                w::empty_state(
                    ui,
                    &pal,
                    "🕘",
                    "No jobs for this PC yet",
                    "Scripts, installs and other actions sent from this master appear here.",
                );
            });
            return;
        }
        let mut open_job = None;
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for (job_id, title, created, t) in items {
                    w::card(ui, &pal, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            status_badge(ui, &pal, &t.status, t.exit_code);
                            ui.label(RichText::new(&title).font(semibold(13.5)).color(pal.text));
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    if w::ghost(ui, "Open job →").clicked() {
                                        open_job = Some(job_id);
                                    }
                                    w::faint(
                                        ui,
                                        &pal,
                                        created.format("%Y-%m-%d %H:%M:%S").to_string(),
                                    );
                                },
                            );
                        });
                        if !t.output.trim().is_empty() {
                            egui::CollapsingHeader::new(
                                RichText::new("Output").color(pal.text_dim),
                            )
                            .id_salt(("hist_out", job_id))
                            .show(ui, |ui| {
                                ui.label(
                                    RichText::new(t.output.trim()).monospace().color(pal.text),
                                );
                            });
                        }
                    });
                    ui.add_space(6.0);
                }
            });
        if let Some(j) = open_job {
            self.selected_job = Some(j);
            self.go(super::Page::Jobs);
        }
    }
}

/// Coloured status label for a job target.
pub(super) fn status_badge(
    ui: &mut egui::Ui,
    pal: &crate::ui::theme::Palette,
    s: &TargetStatus,
    exit: Option<i32>,
) {
    match s {
        TargetStatus::Pending => {
            ui.spinner();
            w::pill(ui, "Running", pal.blue);
        }
        TargetStatus::Succeeded => {
            w::pill(ui, "Succeeded", pal.green);
        }
        TargetStatus::Failed => {
            let t = match exit {
                Some(c) => format!("Failed · exit {c}"),
                None => "Failed".into(),
            };
            w::pill(ui, &t, pal.red);
        }
        TargetStatus::Skipped => {
            w::pill(ui, "Skipped", pal.text_faint);
        }
    }
}
