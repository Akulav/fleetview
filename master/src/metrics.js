// Performance history per PC, to see whether cleaning a PC helped:
//   * CPU and memory from the agents' telemetry (about once a minute), kept as
//     hourly averages for 14 days and daily averages for 180 days;
//   * performance snapshots (a task: 30 s CPU average, memory, commit,
//     processes, boot time from Windows' own boot diagnostics, top programs);
//   * internet speed tests (a task, and optionally on a schedule).
// Compared before and after the moment a PC was marked "cleaned".
//
// metrics.json: { settings: { speed_every_h }, pcs: { [agentId]: { h: [], d: [], snaps: [], speed: [] } } }

import { join } from "node:path";
import { JsonFile } from "./store.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const KEEP_HOURS = 14 * 24;
const KEEP_DAYS = 180;
const KEEP_SNAPS = 60;
const KEEP_SPEED = 120;
/** Before/after window around the "cleaned" mark. */
const WINDOW_MS = 7 * DAY;

export class Metrics {
  constructor(dataDir) {
    this.file = new JsonFile(join(dataDir, "metrics.json"), { settings: { speed_every_h: 0 }, pcs: {} }, { delayMs: 5000 });
    this.file.value.settings ??= { speed_every_h: 0 };
    this.file.value.pcs ??= {};
  }
  get settings() {
    return this.file.value.settings;
  }
  setSettings(s) {
    const n = Number(s.speed_every_h);
    if (s.speed_every_h !== undefined) {
      if (!Number.isFinite(n) || n < 0 || n > 24 * 30) throw new Error("speed test interval: 0 (off) to 720 hours");
      this.settings.speed_every_h = Math.round(n);
    }
    this.file.touch();
    return this.settings;
  }
  pc(id) {
    return (this.file.value.pcs[id] ??= { h: [], d: [], snaps: [], speed: [] });
  }
  forget(id) {
    delete this.file.value.pcs[id];
    this.file.touch();
  }
  close() {
    this.file.flush();
  }

  /** One telemetry reading: cpu and mem in percent. */
  sample(id, cpu, mem, now = Date.now()) {
    if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return;
    const p = this.pc(id);
    const hour = Math.floor(now / HOUR);
    let b = p.h[p.h.length - 1];
    if (!b || b.t !== hour) {
      b = { t: hour, c: 0, m: 0, n: 0, cx: 0 };
      p.h.push(b);
      this.roll(p, hour);
    }
    b.c += clampPct(cpu);
    b.m += clampPct(mem);
    b.n++;
    b.cx = Math.max(b.cx, Math.round(clampPct(cpu)));
    this.file.touch();
  }

  /** Move hours older than 14 days into daily buckets. */
  roll(p, hour) {
    while (p.h.length && p.h[0].t <= hour - KEEP_HOURS) {
      const x = p.h.shift();
      const day = Math.floor((x.t * HOUR) / DAY);
      let d = p.d[p.d.length - 1];
      if (!d || d.t !== day) p.d.push((d = { t: day, c: 0, m: 0, n: 0, cx: 0 }));
      d.c += x.c;
      d.m += x.m;
      d.n += x.n;
      d.cx = Math.max(d.cx, x.cx);
    }
    const oldest = Math.floor((hour * HOUR) / DAY) - KEEP_DAYS;
    while (p.d.length && p.d[0].t < oldest) p.d.shift();
  }

  addSnapshot(id, snap) {
    const p = this.pc(id);
    p.snaps.push(snap);
    if (p.snaps.length > KEEP_SNAPS) p.snaps.splice(0, p.snaps.length - KEEP_SNAPS);
    this.file.touch();
  }
  addSpeed(id, s) {
    const p = this.pc(id);
    p.speed.push(s);
    if (p.speed.length > KEEP_SPEED) p.speed.splice(0, p.speed.length - KEEP_SPEED);
    this.file.touch();
  }
  lastSpeed(id) {
    const s = this.file.value.pcs[id]?.speed;
    return s?.length ? s[s.length - 1] : null;
  }

  /** Average CPU/memory between two times (ms), from hourly + daily buckets. */
  average(id, from, to) {
    const p = this.file.value.pcs[id];
    if (!p) return null;
    let c = 0, m = 0, n = 0, hours = 0;
    const add = (b, size) => {
      const start = b.t * size;
      if (start + size <= from || start >= to || !b.n) return;
      c += b.c;
      m += b.m;
      n += b.n;
      hours += size === HOUR ? 1 : Math.max(1, Math.round(b.n / 60));
    };
    for (const b of p.d) add(b, DAY);
    for (const b of p.h) add(b, HOUR);
    return n ? { cpu: round1(c / n), mem: round1(m / n), samples: n, hours } : null;
  }

  /** Before/after a "cleaned" mark (ISO time). */
  compare(id, cleanedAt, now = Date.now()) {
    const t = Date.parse(cleanedAt);
    if (!Number.isFinite(t)) return null;
    const p = this.file.value.pcs[id];
    const before = this.average(id, t - WINDOW_MS, t);
    const after = this.average(id, t, Math.min(now, t + WINDOW_MS));
    const snaps = p?.snaps ?? [];
    const sb = [...snaps].reverse().find((s) => Date.parse(s.at) <= t) ?? null;
    const sa = snaps.find((s) => Date.parse(s.at) > t) ?? null;
    return { at: cleanedAt, before, after, snap_before: sb, snap_after: sa };
  }

  /** What a PC page shows. */
  forPc(id, cleanedAt) {
    const p = this.file.value.pcs[id] ?? { h: [], d: [], snaps: [], speed: [] };
    const now = Date.now();
    return {
      hours: p.h.map((b) => ({ t: new Date(b.t * HOUR).toISOString(), cpu: round1(b.c / b.n), mem: round1(b.m / b.n), cpu_max: b.cx })),
      days: p.d.map((b) => ({ t: new Date(b.t * DAY).toISOString(), cpu: round1(b.c / b.n), mem: round1(b.m / b.n), cpu_max: b.cx })),
      week: this.average(id, now - WINDOW_MS, now),
      snaps: p.snaps.slice(-20),
      speed: p.speed.slice(-30),
      compare: cleanedAt ? this.compare(id, cleanedAt, now) : null,
      settings: this.settings,
    };
  }

  /** Fleet view: every cleaned PC's before/after. */
  fleet(agents) {
    const rows = [];
    for (const a of agents) {
      if (!a.cleaned?.at) continue;
      const c = this.compare(a.agent_id, a.cleaned.at);
      rows.push({ id: a.agent_id, hostname: a.hostname, cleaned: a.cleaned, before: c?.before ?? null, after: c?.after ?? null, boot_before: c?.snap_before?.boot_ms ?? null, boot_after: c?.snap_after?.boot_ms ?? null });
    }
    const both = rows.filter((r) => r.before && r.after);
    const avg = (f) => (both.length ? round1(both.reduce((s, r) => s + f(r), 0) / both.length) : null);
    return {
      rows,
      measured: both.length,
      cpu_before: avg((r) => r.before.cpu),
      cpu_after: avg((r) => r.after.cpu),
      mem_before: avg((r) => r.before.mem),
      mem_after: avg((r) => r.after.mem),
    };
  }
}

const clampPct = (x) => Math.max(0, Math.min(100, Number(x)));
const round1 = (x) => Math.round(x * 10) / 10;

// ---- scripts -------------------------------------------------------------
// Both print a machine-readable line (FVPERF / FVSPEED + JSON) that the master
// keeps, then human lines; the last line is the summary shown in Activity.
// CIM performance classes, not Get-Counter: counter names are translated on
// non-English Windows, the class names are not.

export function perfScript() {
  // Every measurement is on its own: a PC where one of them is unavailable
  // (broken performance counters, a WMI hiccup, an unreadable event log)
  // still gets the rest, and the output says what could not be read.
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$missing = New-Object System.Collections.Generic.List[string]
function Try-Get($what, [scriptblock]$sb) {
  try { & $sb } catch { $script:missing.Add($what + ': ' + $_.Exception.Message.Trim()); $null }
}
# CPU over 30 s. The performance class first; Win32_Processor's load as the
# fallback (on PCs whose performance counters are broken or disabled).
$cpu = New-Object System.Collections.Generic.List[double]
$cpuSource = 'counters'
for ($i = 0; $i -lt 15; $i++) {
  $v = Try-Get 'cpu' { [double](Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop).PercentProcessorTime }
  if ($null -eq $v) {
    $cpuSource = 'processor load'
    $v = Try-Get 'cpu load' { [double](@(Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object LoadPercentage -Average)[0].Average) }
  }
  if ($null -ne $v) { $cpu.Add($v) }
  Start-Sleep -Seconds 2
}
$os = Try-Get 'memory' { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$pm = Try-Get 'commit' { Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop }
$totalMb = $null; $usedMb = $null
if ($os) {
  $totalMb = [Math]::Round([double]$os.TotalVisibleMemorySize / 1KB)
  $usedMb = [Math]::Round(([double]$os.TotalVisibleMemorySize - [double]$os.FreePhysicalMemory) / 1KB)
}
$procs = @(Try-Get 'processes' { Get-Process -ErrorAction Stop })
$top = @(Try-Get 'top programs' {
  $procs | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; mb = [Math]::Round([double]($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB) } } |
    Sort-Object mb -Descending | Select-Object -First 6
})
$boot = $null; $bootAt = $null
try {
  $e = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Diagnostics-Performance/Operational'; Id = 100 } -MaxEvents 1 -ErrorAction Stop
  $d = @{}; foreach ($x in ([xml]$e.ToXml()).Event.EventData.Data) { $d[$x.Name] = $x.'#text' }
  $boot = [int]$d['BootTime']; $bootAt = $e.TimeCreated.ToUniversalTime().ToString('o')
} catch {}
$freeGb = Try-Get 'disk' { [Math]::Round([double](Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $env:SystemDrive + "'") -ErrorAction Stop).FreeSpace / 1GB, 1) }
$uptime = $null; if ($os -and $os.LastBootUpTime) { $uptime = [Math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) }
$cpuAvg = $null; $cpuMax = $null
if ($cpu.Count) { $cpuAvg = [Math]::Round(($cpu | Measure-Object -Average).Average, 1); $cpuMax = [Math]::Round(($cpu | Measure-Object -Maximum).Maximum, 1) }
$snap = [ordered]@{
  cpu_avg = $cpuAvg; cpu_max = $cpuMax; cpu_source = $cpuSource
  mem_total_mb = $totalMb; mem_used_mb = $usedMb
  mem_pct = $(if ($totalMb) { [Math]::Round($usedMb / $totalMb * 100, 1) } else { $null })
  commit_mb = $(if ($pm) { [Math]::Round([double]$pm.CommittedBytes / 1MB) } else { $null })
  commit_limit_mb = $(if ($pm) { [Math]::Round([double]$pm.CommitLimit / 1MB) } else { $null })
  processes = $(if ($procs.Count) { $procs.Count } else { $null })
  boot_ms = $boot; boot_at = $bootAt; uptime_h = $uptime; disk_free_gb = $freeGb
  top = $top
}
'FVPERF ' + (ConvertTo-Json -InputObject $snap -Compress -Depth 3)
if ($top.Count) { 'Top programs by memory: ' + (($top | ForEach-Object { $_.name + ' ' + $_.mb + ' MB' }) -join ', ') }
foreach ($m in $missing | Select-Object -Unique) { 'Could not read ' + $m }
if ($null -eq $cpuAvg -and -not $totalMb) { 'No measurement worked on this PC (see above).'; exit 1 }
$(if ($null -ne $cpuAvg) { 'CPU ' + $cpuAvg + '% (30 s average, peak ' + $cpuMax + '%' + $(if ($cpuSource -ne 'counters') { ', from ' + $cpuSource } else { '' }) + ')' } else { 'CPU: not readable' }) +
  $(if ($totalMb) { ', memory ' + $snap.mem_pct + '% (' + [Math]::Round($usedMb / 1KB, 1) + ' of ' + [Math]::Round($totalMb / 1KB, 1) + ' GB)' } else { '' }) +
  $(if ($procs.Count) { ', ' + $procs.Count + ' processes' } else { '' }) +
  $(if ($boot) { ', last boot ' + [Math]::Round($boot / 1000) + ' s' } else { '' })
exit 0`;
}

/** Internet speed against Cloudflare's speed test endpoints (no account, no
 * software): latency, download, upload. Sizes adapt to slow links so a test
 * stays around 10 seconds per direction. */
export function speedScript({ max_down_mb = 25, max_up_mb = 10 } = {}) {
  const down = Math.max(1, Math.min(100, Math.round(Number(max_down_mb) || 25)));
  const up = Math.max(1, Math.min(50, Math.round(Number(max_up_mb) || 10)));
  return String.raw`[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
$h = New-Object System.Net.Http.HttpClient
$h.Timeout = [TimeSpan]::FromSeconds(90)
$base = 'https://speed.cloudflare.com'
function Get-Bytes($n) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = $h.GetAsync($base + '/__down?bytes=' + $n, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  [void]$r.EnsureSuccessStatusCode()
  $s = $r.Content.ReadAsStreamAsync().Result; $buf = New-Object byte[] 65536; $got = 0
  while (($k = $s.Read($buf, 0, $buf.Length)) -gt 0) { $got += $k }
  $sw.Stop(); $s.Dispose(); $r.Dispose()
  @{ bytes = $got; sec = [Math]::Max(0.001, $sw.Elapsed.TotalSeconds) }
}
function Send-Bytes($n) {
  $c = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,(New-Object byte[] $n))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = $h.PostAsync($base + '/__up', $c).Result
  $sw.Stop(); [void]$r.EnsureSuccessStatusCode(); $r.Dispose()
  @{ bytes = $n; sec = [Math]::Max(0.001, $sw.Elapsed.TotalSeconds) }
}
try {
  $meta = $null; try { $meta = $h.GetStringAsync($base + '/meta').Result | ConvertFrom-Json } catch {}
  # Latency: small requests over the open connection (the first one pays for TLS).
  [void](Get-Bytes 0)
  $lat = @(for ($i = 0; $i -lt 6; $i++) { [Math]::Round((Get-Bytes 0).sec * 1000, 1) }) | Sort-Object
  $ping = $lat[[int][Math]::Floor($lat.Count / 2)]
  $jitter = [Math]::Round(($lat[-1] - $lat[0]) / 2, 1)
  # Download: a 1 MB probe sizes the real test to about 8 seconds.
  $probe = Get-Bytes 1000000
  $bps = $probe.bytes / $probe.sec
  $n = [long][Math]::Min(${down}000000, [Math]::Max(2000000, $bps * 8))
  $d = Get-Bytes $n
  $downMbps = [Math]::Round($d.bytes * 8 / $d.sec / 1e6, 1)
  $probe = Send-Bytes 500000
  $n = [int][Math]::Min(${up}000000, [Math]::Max(1000000, ($probe.bytes / $probe.sec) * 6))
  $u = Send-Bytes $n
  $upMbps = [Math]::Round($u.bytes * 8 / $u.sec / 1e6, 1)
} catch {
  $m = $_.Exception; while ($m.InnerException) { $m = $m.InnerException }
  'Speed test failed: ' + $m.Message.Trim()
  exit 1
}
$res = [ordered]@{ down_mbps = $downMbps; up_mbps = $upMbps; ping_ms = $ping; jitter_ms = $jitter; down_mb = [Math]::Round($d.bytes / 1e6, 1); up_mb = [Math]::Round($u.bytes / 1e6, 1);
  isp = $(if ($meta) { $meta.asOrganization } else { $null }); colo = $(if ($meta) { $meta.colo } else { $null }); ip = $(if ($meta) { $meta.clientIp } else { $null }) }
'FVSPEED ' + (ConvertTo-Json -InputObject $res -Compress)
'Down ' + $downMbps + ' Mbps, up ' + $upMbps + ' Mbps, latency ' + $ping + ' ms' + $(if ($meta -and $meta.asOrganization) { ' (' + $meta.asOrganization + ')' } else { '' })`;
}

/** Pull the FVPERF / FVSPEED record out of a script's output. */
export function parseRecord(stdout, tag) {
  const line = String(stdout ?? "").split(/\r?\n/).find((l) => l.startsWith(`${tag} `));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(tag.length + 1));
  } catch {
    return null;
  }
}

export function cleanSnapshot(r, at = new Date().toISOString()) {
  if (!r || typeof r !== "object") return null;
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
  return {
    at,
    cpu_avg: num(r.cpu_avg),
    cpu_max: num(r.cpu_max),
    mem_pct: num(r.mem_pct),
    mem_used_mb: num(r.mem_used_mb),
    mem_total_mb: num(r.mem_total_mb),
    commit_mb: num(r.commit_mb),
    processes: num(r.processes),
    boot_ms: num(r.boot_ms),
    boot_at: typeof r.boot_at === "string" ? r.boot_at : null,
    uptime_h: num(r.uptime_h),
    disk_free_gb: num(r.disk_free_gb),
    top: (Array.isArray(r.top) ? r.top : r.top ? [r.top] : []).slice(0, 8).map((t) => ({ name: String(t?.name ?? "").slice(0, 80), mb: num(t?.mb) })),
  };
}

export function cleanSpeed(r, at = new Date().toISOString()) {
  if (!r || typeof r !== "object") return null;
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
  const str = (x) => (typeof x === "string" ? x.slice(0, 120) : null);
  if (num(r.down_mbps) === null) return null;
  return { at, down: num(r.down_mbps), up: num(r.up_mbps), ping: num(r.ping_ms), jitter: num(r.jitter_ms), isp: str(r.isp), colo: str(r.colo), ip: str(r.ip) };
}

/**
 * Scheduled speed tests: one PC at a time (tests on the same office line
 * would slow each other down), each PC every `speed_every_h` hours. Runs
 * quietly — results go to the PC's history, not to Activity.
 */
export function startSpeedSchedule({ metrics, hub, jobs, log, tickMs = 120_000 }) {
  let busy = false;
  const tick = async () => {
    const every = metrics.settings.speed_every_h;
    if (busy || !every) return;
    const due = hub
      .list()
      .filter((a) => a.conn)
      .map((a) => ({ a, last: Date.parse(metrics.lastSpeed(a.agent_id)?.at ?? 0) || 0 }))
      .filter((x) => Date.now() - x.last >= every * HOUR)
      .sort((x, y) => x.last - y.last)[0];
    if (!due) return;
    busy = true;
    try {
      const r = await jobs.quiet(due.a.agent_id, `# FleetView: scheduled speed test\n${speedScript()}`, 5 * 60_000);
      const s = cleanSpeed(parseRecord(r.stdout, "FVSPEED"));
      if (s) metrics.addSpeed(due.a.agent_id, { ...s, scheduled: true });
      else metrics.addSpeed(due.a.agent_id, { at: new Date().toISOString(), down: null, error: firstOut(r), scheduled: true });
      hub.changed(due.a);
    } catch (e) {
      log(`${due.a.hostname}: scheduled speed test: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => tick().catch(() => {}), tickMs);
  timer.unref?.();
  return { tick, close: () => clearInterval(timer) };
}

function firstOut(r) {
  const l = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return (l[l.length - 1] ?? "failed").slice(0, 200);
}
