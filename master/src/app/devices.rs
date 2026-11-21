//! Devices page: filterable, sortable table with multi-select bulk actions.

use eframe::egui::{self, RichText};
use egui_extras::{Column, TableBuilder};

use super::{
    csv_field, row_matches, Action, App, Composer, ComposerKind, DeviceRow, PowerKind, Severity,
    SortKey, StatusFilter,
};
use crate::agentpkg::UpdateState;
use crate::ui::theme::{semibold, tint};
use crate::ui::widgets as w;

impl App {
    fn filtered_rows<'a>(&self, rows: &'a [DeviceRow]) -> Vec<&'a DeviceRow> {
        let q = self.search.to_lowercase();
        let mut list: Vec<&DeviceRow> = rows
            .iter()
            .filter(|r| q.is_empty() || row_matches(r, &q))
            .filter(|r| match self.status_filter {
                StatusFilter::All => true,
                StatusFilter::Online => r.online,
                StatusFilter::Offline => !r.online,
                StatusFilter::Attention => r.worst().is_some_and(|s| s >= Severity::Warn),
                StatusFilter::Outdated => r.update == UpdateState::Outdated,
            })
            .filter(|r| {
                self.tag_filter
                    .as_ref()
                    .is_none_or(|t| r.tags.iter().any(|x| x == t))
            })
            .collect();
        let (key, asc) = self.sort;
        let f = |o: Option<f32>| o.unwrap_or(-1.0);
        list.sort_by(|a, b| {
            let ord = match key {
                SortKey::Host => a.host.to_lowercase().cmp(&b.host.to_lowercase()),
                SortKey::User => a.user.to_lowercase().cmp(&b.user.to_lowercase()),
                SortKey::Cpu => f(a.cpu).total_cmp(&f(b.cpu)),
                SortKey::Mem => f(a.mem).total_cmp(&f(b.mem)),
                SortKey::Disk => {
                    f(a.disk.as_ref().map(|d| d.1)).total_cmp(&f(b.disk.as_ref().map(|d| d.1)))
                }
                SortKey::Uptime => a.uptime.unwrap_or(0).cmp(&b.uptime.unwrap_or(0)),
                SortKey::LastSeen => a.last_seen.cmp(&b.last_seen),
                SortKey::Version => a.version.cmp(&b.version),
            };
            let ord = if asc { ord } else { ord.reverse() };
            // Online first within equal keys keeps the list stable.
            ord.then_with(|| b.online.cmp(&a.online))
        });
        list
    }

    pub(super) fn page_devices(&mut self, ui: &mut egui::Ui, rows: &[DeviceRow]) {
        let pal = self.pal;
        let online = rows.iter().filter(|r| r.online).count();
        let list = self.filtered_rows(rows);
        let shown: Vec<DeviceRow> = list.iter().map(|r| (*r).clone()).collect();
        self.page_header(
            ui,
            "Devices",
            &format!("{} PCs known · {online} online", rows.len()),
            |app, ui| {
                if ui
                    .button("⬇  Export CSV")
                    .on_hover_text("Save the rows shown below as a CSV file")
                    .clicked()
                {
                    app.export_csv(&shown);
                }
            },
        );

        // ---- Toolbar ---------------------------------------------------------
        ui.horizontal_wrapped(|ui| {
            let r = w::search_box(
                ui,
                &mut self.search,
                "Search host, user, IP, OS or tag  (Ctrl+F)",
                300.0,
            );
            if self.focus_search {
                r.request_focus();
                self.focus_search = false;
            }
            ui.add_space(6.0);
            let count = |f: StatusFilter| -> usize {
                rows.iter()
                    .filter(|r| match f {
                        StatusFilter::All => true,
                        StatusFilter::Online => r.online,
                        StatusFilter::Offline => !r.online,
                        StatusFilter::Attention => r.worst().is_some_and(|s| s >= Severity::Warn),
                        StatusFilter::Outdated => r.update == UpdateState::Outdated,
                    })
                    .count()
            };
            for (f, label) in [
                (StatusFilter::All, "All"),
                (StatusFilter::Online, "Online"),
                (StatusFilter::Offline, "Offline"),
                (StatusFilter::Attention, "Needs attention"),
                (StatusFilter::Outdated, "Outdated"),
            ] {
                if w::chip(
                    ui,
                    &pal,
                    self.status_filter == f,
                    &format!("{label}  {}", count(f)),
                )
                .clicked()
                {
                    self.status_filter = f;
                }
            }
            let tags = App::all_tags(rows);
            if !tags.is_empty() {
                ui.add_space(6.0);
                let label = self.tag_filter.clone().unwrap_or_else(|| "Any tag".into());
                egui::ComboBox::from_id_salt("tag_filter")
                    .selected_text(format!("🏷  {label}"))
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.tag_filter, None, "Any tag");
                        for t in tags {
                            ui.selectable_value(&mut self.tag_filter, Some(t.clone()), t);
                        }
                    });
            }
        });
        ui.add_space(8.0);

        // ---- Selection bar ---------------------------------------------------
        self.checked.retain(|id| rows.iter().any(|r| &r.id == id));
        if !self.checked.is_empty() {
            self.selection_bar(ui, rows);
            ui.add_space(8.0);
        }

        // ---- Table -----------------------------------------------------------
        if list.is_empty() {
            w::card(ui, &pal, |ui| {
                ui.set_width(ui.available_width());
                if rows.is_empty() {
                    w::empty_state(
                        ui,
                        &pal,
                        "🖥",
                        "No PCs have connected yet",
                        "Build an agent setup in Deploy & settings and run it on each PC.",
                    );
                } else {
                    w::empty_state(
                        ui,
                        &pal,
                        "🔍",
                        "No matches",
                        "Try another search or filter.",
                    );
                }
            });
            return;
        }
        egui::Frame::none()
            .fill(pal.surface)
            .stroke(egui::Stroke::new(1.0_f32, pal.border))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::symmetric(6.0, 4.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                self.devices_table(ui, &list);
            });
    }

    fn sort_header(&mut self, ui: &mut egui::Ui, label: &str, key: SortKey) {
        let pal = self.pal;
        let active = self.sort.0 == key;
        let arrow = if active {
            if self.sort.1 {
                " ▲"
            } else {
                " ▼"
            }
        } else {
            ""
        };
        let r = ui.add(
            egui::Label::new(
                RichText::new(format!("{label}{arrow}"))
                    .font(semibold(12.0))
                    .color(if active { pal.text } else { pal.text_faint }),
            )
            .sense(egui::Sense::click()),
        );
        if r.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
            if active {
                self.sort.1 = !self.sort.1;
            } else {
                // Numbers read best biggest-first.
                let asc = matches!(key, SortKey::Host | SortKey::User | SortKey::Version);
                self.sort = (key, asc);
            }
        }
    }

    fn devices_table(&mut self, ui: &mut egui::Ui, list: &[&DeviceRow]) {
        let pal = self.pal;
        let warn = (
            self.prefs.cpu_warn_pct,
            self.prefs.mem_warn_pct,
            self.prefs.disk_warn_pct,
        );
        let mut open: Option<String> = None;
        let all_checked = list.iter().all(|r| self.checked.contains(&r.id));
        let mut toggle_all = false;

        // Size columns from the space we have so the table never overflows.
        let rest = (ui.available_width() - 28.0 - 10.0 * ui.spacing().item_spacing.x).max(700.0);
        let col = |f: f32| (rest * f).floor();
        let meter_w = (col(0.095) - 48.0).clamp(22.0, 64.0);

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::exact(28.0))
            .column(Column::initial(col(0.20)).at_least(120.0).clip(true))
            .column(Column::initial(col(0.10)).at_least(50.0).clip(true))
            .column(Column::initial(col(0.11)).at_least(60.0).clip(true))
            .column(Column::initial(col(0.12)).at_least(50.0).clip(true))
            .column(Column::initial(col(0.095)).at_least(60.0).clip(true))
            .column(Column::initial(col(0.095)).at_least(60.0).clip(true))
            .column(Column::initial(col(0.095)).at_least(60.0).clip(true))
            .column(Column::initial(col(0.065)).at_least(44.0).clip(true))
            .column(Column::initial(col(0.07)).at_least(44.0).clip(true))
            .column(Column::remainder().at_least(50.0).clip(true))
            .header(30.0, |mut h| {
                h.col(|ui| {
                    let mut c = all_checked;
                    if ui
                        .checkbox(&mut c, "")
                        .on_hover_text("Select all shown")
                        .changed()
                    {
                        toggle_all = true;
                    }
                });
                h.col(|ui| self.sort_header(ui, "HOST", SortKey::Host));
                h.col(|ui| self.sort_header(ui, "USER", SortKey::User));
                h.col(|ui| {
                    ui.label(
                        RichText::new("IP ADDRESS")
                            .font(semibold(12.0))
                            .color(pal.text_faint),
                    );
                });
                h.col(|ui| {
                    ui.label(
                        RichText::new("OS")
                            .font(semibold(12.0))
                            .color(pal.text_faint),
                    );
                });
                h.col(|ui| self.sort_header(ui, "CPU", SortKey::Cpu));
                h.col(|ui| self.sort_header(ui, "MEMORY", SortKey::Mem));
                h.col(|ui| self.sort_header(ui, "DISK", SortKey::Disk));
                h.col(|ui| self.sort_header(ui, "UPTIME", SortKey::Uptime));
                h.col(|ui| self.sort_header(ui, "LAST SEEN", SortKey::LastSeen));
                h.col(|ui| self.sort_header(ui, "AGENT", SortKey::Version));
            })
            .body(|body| {
                body.rows(38.0, list.len(), |mut row| {
                    let r = list[row.index()];
                    let checked = self.checked.contains(&r.id);
                    row.set_selected(checked);
                    row.col(|ui| {
                        let mut c = checked;
                        if ui.checkbox(&mut c, "").changed() {
                            if c {
                                self.checked.insert(r.id.clone());
                            } else {
                                self.checked.remove(&r.id);
                            }
                        }
                    });
                    row.col(|ui| {
                        let color = if r.online { pal.green } else { pal.text_faint };
                        w::dot(ui, color, r.online);
                        let resp = ui.add(
                            egui::Label::new(
                                RichText::new(&r.host)
                                    .font(semibold(13.5))
                                    .color(if r.online { pal.text } else { pal.text_dim }),
                            )
                            .sense(egui::Sense::click()),
                        );
                        if resp
                            .on_hover_cursor(egui::CursorIcon::PointingHand)
                            .clicked()
                        {
                            open = Some(r.id.clone());
                        }
                        if let Some(sev) = r.worst() {
                            let c = match sev {
                                Severity::Crit => pal.red,
                                Severity::Warn => pal.amber,
                                Severity::Info => pal.blue,
                            };
                            let tip = r
                                .alerts
                                .iter()
                                .map(|a| a.text.clone())
                                .collect::<Vec<_>>()
                                .join("\n");
                            ui.label(
                                RichText::new(if sev == Severity::Info { "ℹ" } else { "⚠" })
                                    .color(c),
                            )
                            .on_hover_text(tip);
                        }
                        if r.streaming {
                            w::pill(ui, "LIVE", pal.red);
                        }
                        for t in r.tags.iter().take(2) {
                            w::pill(ui, t, pal.violet);
                        }
                    });
                    row.col(|ui| {
                        ui.label(
                            RichText::new(if r.user.is_empty() { "—" } else { &r.user })
                                .color(pal.text_dim),
                        );
                    });
                    row.col(|ui| {
                        let ip = r.ips.iter().find(|i| !i.contains(':')).or(r.ips.first());
                        ui.label(
                            RichText::new(ip.map(|s| s.as_str()).unwrap_or("—"))
                                .monospace()
                                .color(pal.text_dim),
                        )
                        .on_hover_text(r.ips.join("\n"));
                    });
                    row.col(|ui| {
                        ui.label(
                            RichText::new(if r.os.is_empty() { "—" } else { &r.os })
                                .color(pal.text_dim),
                        );
                    });
                    row.col(|ui| match r.cpu {
                        Some(c) => w::meter(
                            ui,
                            &pal,
                            c / 100.0,
                            pal.usage(c, warn.0),
                            meter_w,
                            &format!("{c:>3.0}%"),
                        ),
                        None => {
                            ui.label(RichText::new("—").color(pal.text_faint));
                        }
                    });
                    row.col(|ui| match r.mem {
                        Some(m) => w::meter(
                            ui,
                            &pal,
                            m / 100.0,
                            pal.usage(m, warn.1),
                            meter_w,
                            &format!("{m:>3.0}%"),
                        ),
                        None => {
                            ui.label(RichText::new("—").color(pal.text_faint));
                        }
                    });
                    row.col(|ui| match &r.disk {
                        Some((mount, d)) => {
                            w::meter(
                                ui,
                                &pal,
                                d / 100.0,
                                pal.usage(*d, warn.2),
                                meter_w,
                                &format!("{d:>3.0}%"),
                            );
                            ui.label("").on_hover_text(format!("Fullest: {mount}"));
                        }
                        None => {
                            ui.label(RichText::new("—").color(pal.text_faint));
                        }
                    });
                    row.col(|ui| {
                        let t = r.uptime.map(w::fmt_duration).unwrap_or_else(|| "—".into());
                        ui.label(RichText::new(t).color(pal.text_dim));
                    });
                    row.col(|ui| {
                        let t = if r.online {
                            "now".to_string()
                        } else {
                            w::fmt_ago(r.last_seen)
                        };
                        ui.label(RichText::new(t).color(if r.online {
                            pal.green
                        } else {
                            pal.text_dim
                        }))
                        .on_hover_text(r.last_seen.format("%Y-%m-%d %H:%M:%S").to_string());
                    });
                    row.col(|ui| {
                        ui.label(self.version_text(&r.version, r.update));
                        if r.updating {
                            ui.spinner();
                        }
                    });
                });
            });

        if toggle_all {
            if all_checked {
                for r in list {
                    self.checked.remove(&r.id);
                }
            } else {
                for r in list {
                    self.checked.insert(r.id.clone());
                }
            }
        }
        if let Some(id) = open {
            self.open_device(&id);
        }
    }

    /// Actions for the checked PCs.
    fn selection_bar(&mut self, ui: &mut egui::Ui, rows: &[DeviceRow]) {
        let pal = self.pal;
        let ids: Vec<String> = self.checked.iter().cloned().collect();
        let online = self.only_online(&ids);
        let offline: Vec<String> = ids
            .iter()
            .filter(|i| !online.contains(i))
            .cloned()
            .collect();
        let updatable: Vec<String> = rows
            .iter()
            .filter(|r| {
                self.checked.contains(&r.id)
                    && r.online
                    && !r.updating
                    && r.update != UpdateState::Newer
            })
            .map(|r| r.id.clone())
            .collect();
        egui::Frame::none()
            .fill(tint(pal.accent, 24))
            .stroke(egui::Stroke::new(1.0_f32, tint(pal.accent, 110)))
            .rounding(egui::Rounding::same(8.0))
            .inner_margin(egui::Margin::symmetric(12.0, 8.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal_wrapped(|ui| {
                    ui.label(
                        RichText::new(format!("{} selected", ids.len()))
                            .font(semibold(13.5))
                            .color(pal.text),
                    );
                    w::faint(ui, &pal, format!("({} online)", online.len()));
                    if w::ghost(ui, "✖")
                        .on_hover_text("Clear the selection")
                        .clicked()
                    {
                        self.checked.clear();
                    }
                    ui.separator();
                    let any = !online.is_empty();
                    if ui.add_enabled(any, egui::Button::new("▶  Run script")).clicked() {
                        self.composer = Some(Composer { kind: ComposerKind::Script, ids: online.clone() });
                    }
                    if ui.add_enabled(any, egui::Button::new("📦  Install")).clicked() {
                        self.composer = Some(Composer { kind: ComposerKind::Install, ids: online.clone() });
                    }
                    if ui.add_enabled(any, egui::Button::new("💬  Message")).clicked() {
                        self.composer = Some(Composer { kind: ComposerKind::Notify, ids: online.clone() });
                    }
                    if ui
                        .add_enabled(self.package.is_some() && !updatable.is_empty(), egui::Button::new("⬆  Update agent"))
                        .clicked()
                    {
                        self.confirm = Some(Action::Update { ids: updatable.clone() });
                    }
                    ui.add_enabled_ui(any, |ui| {
                        ui.menu_button("⚡  Power", |ui| {
                            for k in [PowerKind::Restart, PowerKind::Shutdown, PowerKind::Abort] {
                                if ui.button(k.label()).clicked() {
                                    self.confirm = Some(Action::Power { kind: k, ids: online.clone() });
                                    ui.close_menu();
                                }
                            }
                        });
                    });
                    if ui
                        .add_enabled(!offline.is_empty(), egui::Button::new("⏰  Wake"))
                        .on_hover_text("Send a Wake-on-LAN packet to the offline ones")
                        .clicked()
                    {
                        self.wake(&offline);
                    }
                    if ui.button("🏷  Tags").clicked() {
                        self.tag_input.clear();
                        self.composer = Some(Composer { kind: ComposerKind::Tags, ids: ids.clone() });
                    }
                    if ui.add_enabled(any, egui::Button::new("⚙  Config")).clicked() {
                        self.composer = Some(Composer { kind: ComposerKind::Config, ids: online.clone() });
                    }
                    if ui.add_enabled(any, egui::Button::new("✏  Rename")).clicked() {
                        self.rename_input.clear();
                        self.composer = Some(Composer { kind: ComposerKind::Rename, ids: online.clone() });
                    }
                    ui.add_enabled_ui(any, |ui| {
                        ui.menu_button("📐  Standards", |ui| {
                            if ui
                                .add_enabled(self.policy.admin_ready(), egui::Button::new("🔑  Set admin account"))
                                .on_disabled_hover_text("Set it up on the Standards page first")
                                .clicked()
                            {
                                self.confirm = Some(Action::SetAdmin { ids: online.clone() });
                                ui.close_menu();
                            }
                            if ui
                                .add_enabled(self.policy.wallpaper_ready(), egui::Button::new("🖼  Set background"))
                                .on_disabled_hover_text("Set it up on the Standards page first")
                                .clicked()
                            {
                                self.confirm = Some(Action::Wallpaper { ids: online.clone() });
                                ui.close_menu();
                            }
                            if ui
                                .add_enabled(!self.policy.apps.is_empty(), egui::Button::new("📦  Install app package"))
                                .on_disabled_hover_text("Set it up on the Standards page first")
                                .clicked()
                            {
                                self.confirm = Some(Action::InstallApps {
                                    apps: self.policy.apps.clone(),
                                    ids: online.clone(),
                                    package: true,
                                });
                                ui.close_menu();
                            }
                        });
                    });
                    if ui
                        .add_enabled(!offline.is_empty(), egui::Button::new("🗑  Remove"))
                        .on_hover_text("Forget the selected offline PCs (they re-appear if they connect again)")
                        .clicked()
                    {
                        self.confirm = Some(Action::Forget { ids: offline.clone() });
                    }
                });
            });
    }

    fn export_csv(&mut self, rows: &[DeviceRow]) {
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!(
                "fleet-{}.csv",
                chrono::Local::now().format("%Y%m%d-%H%M")
            ))
            .add_filter("CSV", &["csv"])
            .save_file()
        else {
            return;
        };
        let mut out = String::from(
            "Host,Status,User,IP addresses,OS,CPU %,Memory %,Fullest disk,Disk %,Uptime,Last seen,Agent version,Tags,Alerts\n",
        );
        for r in rows {
            let fields = [
                r.host.clone(),
                if r.online {
                    "online".into()
                } else {
                    "offline".into()
                },
                r.user.clone(),
                r.ips.join(" "),
                r.os.clone(),
                r.cpu.map(|v| format!("{v:.0}")).unwrap_or_default(),
                r.mem.map(|v| format!("{v:.0}")).unwrap_or_default(),
                r.disk.as_ref().map(|d| d.0.clone()).unwrap_or_default(),
                r.disk
                    .as_ref()
                    .map(|d| format!("{:.0}", d.1))
                    .unwrap_or_default(),
                r.uptime.map(w::fmt_duration).unwrap_or_default(),
                r.last_seen.format("%Y-%m-%d %H:%M").to_string(),
                r.version.clone(),
                r.tags.join("; "),
                r.alerts
                    .iter()
                    .map(|a| a.text.clone())
                    .collect::<Vec<_>>()
                    .join("; "),
            ];
            let line: Vec<String> = fields.iter().map(|f| csv_field(f)).collect();
            out.push_str(&line.join(","));
            out.push('\n');
        }
        match std::fs::write(&path, out) {
            Ok(()) => self.toast(format!("Exported {} row(s)", rows.len())),
            Err(e) => self.toast_err(format!("Cannot write {}: {e}", path.display())),
        }
    }
}
