// A stand-in installer for the end-to-end test (compiled with rustc by the
// test). Behaves like a real silent-capable installer:
//   * without /S it would show a wizard — here it exits 1639 ("invalid
//     command-line arguments") instead of hanging;
//   * with /S it "installs": writes the file given by /MARKER=<path> and
//     exits 0 (or the code given by /EXIT=<n>).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|a| a.eq_ignore_ascii_case("/S")) {
        std::process::exit(1639);
    }
    if let Some(m) = args.iter().find_map(|a| a.strip_prefix("/MARKER=")) {
        std::fs::write(m, format!("installed silently with {args:?}\n")).expect("write marker");
    }
    let code = args
        .iter()
        .find_map(|a| a.strip_prefix("/EXIT="))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    std::process::exit(code);
}
