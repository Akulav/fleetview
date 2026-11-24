//! Tray strings. Per requirement, the tray defaults to **Romanian**; the master
//! desktop app is English-only. English strings are kept here as a fallback and
//! in case the tray language is made configurable later.
#![allow(dead_code)] // English fallback + splash strings are kept for future use.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ro,
    En,
}

/// The agent tray defaults to Romanian.
pub const TRAY_LANG: Lang = Lang::Ro;

pub struct Strings {
    pub tooltip_connected: &'static str, // takes a {master} via format
    pub tooltip_searching: &'static str,
    pub menu_status_connected: &'static str,
    pub menu_status_searching: &'static str,
    pub menu_about: &'static str,
    pub menu_open_logs: &'static str,
    pub splash_title: &'static str,
    pub splash_body: &'static str,
    pub running_title: &'static str,
    pub running_body: &'static str,
    pub about_text: &'static str,
    pub view_title: &'static str,
    pub live_view_started: &'static str,
    pub live_view_stopped: &'static str,
    pub screenshot_taken: &'static str,
    pub tooltip_viewing: &'static str,
    /// Tooltip / menu status while a pushed installer is running.
    pub tooltip_installing: &'static str,
    pub menu_status_installing: &'static str,
    /// Watermark shown across the screen while it is being viewed/captured.
    pub overlay_watermark: &'static str,
}

pub fn strings(lang: Lang) -> Strings {
    match lang {
        Lang::Ro => Strings {
            tooltip_connected: "FleetView — conectat la",
            tooltip_searching: "FleetView — se caută serverul…",
            menu_status_connected: "Stare: conectat",
            menu_status_searching: "Stare: se caută serverul…",
            menu_about: "Despre FleetView",
            menu_open_logs: "Deschide jurnalele",
            splash_title: "FleetView",
            splash_body: "Agentul de administrare rulează pe acest computer.",
            running_title: "FleetView",
            running_body: "Agentul rulează pe acest computer.",
            about_text: "FleetView Agent\nAdministrare la distanță a stației.\nRealizat de Akulav.",
            view_title: "FleetView — asistență la distanță",
            live_view_started: "Un administrator a început vizualizarea acestui ecran.",
            live_view_stopped: "Vizualizarea ecranului de către administrator s-a încheiat.",
            screenshot_taken: "Un administrator a făcut o captură a acestui ecran.",
            tooltip_viewing: "FleetView — ecranul este vizualizat de un administrator",
            tooltip_installing: "FleetView — se instalează un program…",
            menu_status_installing: "Stare: se instalează un program…",
            overlay_watermark: "Acest ecran este vizualizat de un administrator — FleetView",
        },
        Lang::En => Strings {
            tooltip_connected: "FleetView — connected to",
            tooltip_searching: "FleetView — searching for server…",
            menu_status_connected: "Status: connected",
            menu_status_searching: "Status: searching…",
            menu_about: "About FleetView",
            menu_open_logs: "Open logs",
            splash_title: "FleetView",
            splash_body: "The management agent is running on this computer.",
            running_title: "FleetView",
            running_body: "The agent is running on this computer.",
            about_text: "FleetView Agent\nRemote workstation management.\nMade by Akulav.",
            view_title: "FleetView — remote support",
            live_view_started: "An administrator has started viewing this screen.",
            live_view_stopped: "The administrator has stopped viewing this screen.",
            screenshot_taken: "An administrator took a screenshot of this screen.",
            tooltip_viewing: "FleetView — screen is being viewed by an administrator",
            tooltip_installing: "FleetView — installing software…",
            menu_status_installing: "Status: installing software…",
            overlay_watermark: "This screen is being viewed by an administrator — FleetView",
        },
    }
}
