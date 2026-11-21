//! Jobs page: every action sent from this master, with per-PC results.

use eframe::egui::{self, vec2, RichText};

use super::device::status_badge;
use super::{truncate, Action, App, Composer, ComposerKind, Page};
use crate::state::{Job, JobKind, TargetStatus};
use crate::ui::theme::semibold;
use crate::ui::widgets as w;

impl App {
    pub(super) fn page_jobs(&mut self, ui: &mut egui::Ui) {
        let pal = self.pal;
        let jobs: Vec<Job> = self.state.lock().unwrap().jobs.iter().cloned().collect();
        let running = jobs.iter().filter(|j| j.is_running()).count();
        self.page_header(
            ui,
            "Jobs",
            &format!("{} job(s) this session · {running} running", jobs.len()),
            |app, ui| {
                if ui.button("▶  New script job…").clicked() {
                    let ids = if app.checked.is_empty() {
                        app.online_ids()
                    } else {
                        app.only_online(&app.checked.iter().cloned().collect::<Vec<_>>())
                    };
                    app.composer = Some(Composer {
                        kind: ComposerKind::Script,
                        ids,
                    });
                }
            },
        );
        if jobs.is_empty() {
            w::card(ui, &pal, |ui| {
                ui.set_width(ui.available_width());
                w::empty_state(
                    ui,
                    &pal,
                    "⚡",
                    "No jobs yet",
                    "Scripts, installs, messages, updates and power actions you send show up here with a result per PC.",
                );
            });
            return;
        }
        if self.selected_job.is_none() || !jobs.iter().any(|j| Some(j.id) == self.selected_job) {
            self.selected_job = jobs.first().map(|j| j.id);
        }

        let avail = ui.available_width();
        let list_w = (avail * 0.36).clamp(280.0, 420.0);
        let detail_w = avail - list_w - 12.0;
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 12.0;
            // ---- Job list -----------------------------------------------------
            ui.allocate_ui_with_layout(
                vec2(list_w, ui.available_height()),
                egui::Layout::top_down(egui::Align::LEFT),
                |ui| {
                    egui::ScrollArea::vertical()
                        .id_salt("job_list")
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            for j in &jobs {
                                let sel = self.selected_job == Some(j.id);
                                let (pending, ok, failed, skipped) = j.counts();
                                let resp = egui::Frame::none()
                                    .fill(if sel {
                                        crate::ui::theme::tint(pal.accent, 30)
                                    } else {
                                        pal.surface
                                    })
                                    .stroke(egui::Stroke::new(
                                        1.0_f32,
                                        if sel { pal.accent } else { pal.border },
                                    ))
                                    .rounding(egui::Rounding::same(8.0))
                                    .inner_margin(egui::Margin::symmetric(12.0, 10.0))
                                    .show(ui, |ui| {
                                        ui.set_width(list_w - 40.0);
                                        ui.horizontal(|ui| {
                                            w::pill(ui, j.kind.label(), kind_color(&pal, j.kind));
                                            ui.with_layout(
                                                egui::Layout::right_to_left(egui::Align::Center),
                                                |ui| {
                                                    w::faint(
                                                        ui,
                                                        &pal,
                                                        j.created.format("%H:%M:%S").to_string(),
                                                    );
                                                },
                                            );
                                        });
                                        ui.label(
                                            RichText::new(truncate(&j.title, 46))
                                                .font(semibold(13.5))
                                                .color(pal.text),
                                        );
                                        let n = (j.targets.len() - skipped).max(1);
                                        let done = ok + failed;
                                        ui.horizontal(|ui| {
                                            let color = if failed > 0 {
                                                pal.red
                                            } else if pending > 0 {
                                                pal.blue
                                            } else {
                                                pal.green
                                            };
                                            w::meter(
                                                ui,
                                                &pal,
                                                done as f32 / n as f32,
                                                color,
                                                90.0,
                                                "",
                                            );
                                            let mut s = format!("{ok} ok");
                                            if failed > 0 {
                                                s.push_str(&format!(" · {failed} failed"));
                                            }
                                            if pending > 0 {
                                                s.push_str(&format!(" · {pending} running"));
                                            }
                                            if skipped > 0 {
                                                s.push_str(&format!(" · {skipped} skipped"));
                                            }
                                            ui.label(
                                                RichText::new(s).size(12.0).color(pal.text_dim),
                                            );
                                        });
                                    })
                                    .response
                                    .interact(egui::Sense::click())
                                    .on_hover_cursor(egui::CursorIcon::PointingHand);
                                if resp.clicked() {
                                    self.selected_job = Some(j.id);
                                }
                                ui.add_space(6.0);
                            }
                        });
                },
            );
            // ---- Detail -----------------------------------------------------
            ui.allocate_ui_with_layout(
                vec2(detail_w, ui.available_height()),
                egui::Layout::top_down(egui::Align::LEFT),
                |ui| {
                    if let Some(j) = jobs.iter().find(|j| Some(j.id) == self.selected_job) {
                        self.job_detail(ui, j, detail_w);
                    }
                },
            );
        });
    }

    fn job_detail(&mut self, ui: &mut egui::Ui, j: &Job, width: f32) {
        let pal = self.pal;
        let (pending, ok, failed, skipped) = j.counts();
        let mut rerun: Option<Vec<String>> = None;
        let mut open_dev: Option<String> = None;
        w::card(ui, &pal, |ui| {
            ui.set_width(width - 30.0);
            ui.horizontal(|ui| {
                w::pill(ui, j.kind.label(), kind_color(&pal, j.kind));
                ui.label(RichText::new(&j.title).font(semibold(16.0)).color(pal.text));
            });
            w::faint(
                ui,
                &pal,
                format!(
                    "Started {} · {} target(s)",
                    j.created.format("%Y-%m-%d %H:%M:%S"),
                    j.targets.len()
                ),
            );
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                w::pill(ui, &format!("{ok} succeeded"), pal.green);
                if failed > 0 {
                    w::pill(ui, &format!("{failed} failed"), pal.red);
                }
                if pending > 0 {
                    w::pill(ui, &format!("{pending} running"), pal.blue);
                }
                if skipped > 0 {
                    w::pill(ui, &format!("{skipped} skipped"), pal.text_faint);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let failed_ids: Vec<String> = j
                        .targets
                        .iter()
                        .filter(|t| {
                            matches!(t.status, TargetStatus::Failed | TargetStatus::Skipped)
                        })
                        .map(|t| t.agent_id.clone())
                        .collect();
                    if j.kind == JobKind::Script
                        && ui
                            .add_enabled(
                                !failed_ids.is_empty(),
                                egui::Button::new("↻  Re-run failed/skipped"),
                            )
                            .clicked()
                    {
                        rerun = Some(failed_ids);
                    }
                    if j.kind == JobKind::Script && ui.button("Copy script").clicked() {
                        ui.ctx().copy_text(j.detail.clone());
                        self.toast("Script copied");
                    }
                });
            });
            if j.kind == JobKind::Script {
                ui.add_space(6.0);
                egui::CollapsingHeader::new(RichText::new("Script").color(pal.text_dim))
                    .id_salt(("job_script", j.id))
                    .show(ui, |ui| {
                        ui.label(RichText::new(&j.detail).monospace().color(pal.text));
                    });
            } else if !j.detail.is_empty() {
                w::faint(ui, &pal, truncate(&j.detail, 120));
            }
        });
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.checkbox(&mut self.job_filter_failed, "Only show problems");
            if ui.button("Copy all output").clicked() {
                let mut s = String::new();
                for t in &j.targets {
                    s.push_str(&format!(
                        "===== {} ({:?}, exit {:?})\n{}\n\n",
                        t.hostname,
                        t.status,
                        t.exit_code,
                        t.output.trim()
                    ));
                }
                ui.ctx().copy_text(s);
                self.toast("Output copied");
            }
        });
        ui.add_space(4.0);
        egui::ScrollArea::vertical()
            .id_salt(("job_targets", j.id))
            .auto_shrink([false, false])
            .show(ui, |ui| {
                let mut targets: Vec<&crate::state::JobTarget> = j
                    .targets
                    .iter()
                    .filter(|t| {
                        !self.job_filter_failed
                            || matches!(t.status, TargetStatus::Failed | TargetStatus::Skipped)
                    })
                    .collect();
                // Problems first, then running, then the rest.
                targets.sort_by_key(|t| {
                    (
                        match t.status {
                            TargetStatus::Failed => 0,
                            TargetStatus::Pending => 1,
                            TargetStatus::Skipped => 2,
                            TargetStatus::Succeeded => 3,
                        },
                        t.hostname.to_lowercase(),
                    )
                });
                for t in targets {
                    egui::Frame::none()
                        .fill(pal.surface)
                        .stroke(egui::Stroke::new(1.0_f32, pal.border))
                        .rounding(egui::Rounding::same(8.0))
                        .inner_margin(egui::Margin::symmetric(12.0, 8.0))
                        .show(ui, |ui| {
                            ui.set_width(width - 26.0);
                            ui.horizontal(|ui| {
                                if ui
                                    .link(
                                        RichText::new(&t.hostname)
                                            .font(semibold(13.5))
                                            .color(pal.text),
                                    )
                                    .clicked()
                                {
                                    open_dev = Some(t.agent_id.clone());
                                }
                                status_badge(ui, &pal, &t.status, t.exit_code);
                                ui.with_layout(
                                    egui::Layout::right_to_left(egui::Align::Center),
                                    |ui| {
                                        if let Some(f) = t.finished {
                                            let secs = (f - j.created).num_milliseconds().max(0)
                                                as f64
                                                / 1000.0;
                                            w::faint(ui, &pal, format!("{secs:.1}s"));
                                        }
                                    },
                                );
                            });
                            let out = t.output.trim();
                            if !out.is_empty() {
                                let lines = out.lines().count();
                                if lines <= 6 {
                                    ui.label(RichText::new(out).monospace().color(pal.text_dim));
                                } else {
                                    egui::CollapsingHeader::new(
                                        RichText::new(format!("Output ({lines} lines)"))
                                            .color(pal.text_dim),
                                    )
                                    .id_salt(("t_out", j.id, &t.agent_id))
                                    .show(ui, |ui| {
                                        ui.label(
                                            RichText::new(out).monospace().color(pal.text_dim),
                                        );
                                    });
                                }
                            }
                        });
                    ui.add_space(4.0);
                }
            });
        if let Some(ids) = rerun {
            let online = self.only_online(&ids);
            if !online.is_empty() {
                self.confirm = Some(Action::RunScript {
                    script: j.detail.clone(),
                    ids: online,
                });
            } else {
                self.toast_err("None of those PCs are online");
            }
        }
        if let Some(id) = open_dev {
            self.device_tab = super::DeviceTab::History;
            self.go(Page::Device(id));
        }
    }
}

fn kind_color(pal: &crate::ui::theme::Palette, k: JobKind) -> egui::Color32 {
    match k {
        JobKind::Script => pal.accent,
        JobKind::Install => pal.green,
        JobKind::Uninstall => pal.red,
        JobKind::Update => pal.violet,
        JobKind::Config => pal.blue,
        JobKind::Notify => pal.amber,
        JobKind::Power => pal.red,
        JobKind::Standard => pal.violet,
    }
}
