#!/usr/bin/env node
// Generates the FleetView icon set (no dependencies):
//
//   installer/assets/agent.ico           app icon (exe), 16–256 px
//   installer/assets/tray-<state>.ico    tray icons: connected, offline, busy, viewing
//   installer/assets/logo.png            256 px, for the README
//   installer/assets/tray.png            48 px, inside the agent's toast notifications
//   installer/assets/preview.png         every state at every size, for review
//   master/public/favicon.png            32 px favicon for the web console
//
// Every size is drawn on its own pixel grid (geometry snapped per size) and
// supersampled, so 16/20/24/32 px stay crisp instead of being a blurry
// downscale of a big image.
//
//   node tools/make-icons.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "installer", "assets");

// Palette ------------------------------------------------------------------
const C = {
  tileTop: [44, 98, 246],      // #2C62F6
  tileBottom: [26, 64, 196],   // #1A40C4
  offTop: [120, 132, 150],     // slate
  offBottom: [84, 96, 114],
  mark: [255, 255, 255],
  green: [34, 197, 94],
  amber: [245, 158, 11],
  red: [239, 68, 68],
};

// Shapes (all coordinates in pixels of the target size) --------------------
const roundRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
const poly = (pts) => (px, py) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const minus = (a, b) => (px, py) => a(px, py) && !b(px, py);

// Canvas with supersampled coverage ----------------------------------------
class Canvas {
  constructor(size) {
    this.size = size;
    this.px = new Float64Array(size * size * 4); // premultiplied RGBA 0..1
  }
  // Paint `shape` with color (fn of y or fixed) at opacity.
  fill(shape, color, opacity = 1) {
    const n = this.size, ss = 8;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let hit = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++)
            if (shape(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hit++;
        if (!hit) continue;
        const a = (hit / (ss * ss)) * opacity;
        const col = typeof color === "function" ? color(y / n) : color;
        const i = (y * n + x) * 4;
        for (let k = 0; k < 3; k++) this.px[i + k] = (col[k] / 255) * a + this.px[i + k] * (1 - a);
        this.px[i + 3] = a + this.px[i + 3] * (1 - a);
      }
    }
  }
  // Erase (knock out) `shape` — used to cut a gap around the status badge.
  erase(shape) {
    const n = this.size, ss = 8;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let hit = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++)
            if (shape(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hit++;
        if (!hit) continue;
        const keep = 1 - hit / (ss * ss);
        const i = (y * n + x) * 4;
        for (let k = 0; k < 4; k++) this.px[i + k] *= keep;
      }
  }
  rgba() {
    const out = Buffer.alloc(this.size * this.size * 4);
    for (let i = 0; i < this.size * this.size; i++) {
      const a = this.px[i * 4 + 3];
      for (let k = 0; k < 3; k++) out[i * 4 + k] = a > 0 ? Math.round(Math.min(1, this.px[i * 4 + k] / a) * 255) : 0;
      out[i * 4 + 3] = Math.round(a * 255);
    }
    return out;
  }
}

const lerp = (a, b) => (t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// The mark: a monitor (one PC of the fleet) with a "pulse" across its screen,
// on a rounded tile. A status badge sits in the bottom-right corner.
function draw(size, state) {
  const c = new Canvas(size);
  const u = size / 16; // design grid is 16 units
  const s = (v) => Math.round(v * u); // snap to whole pixels
  const offline = state === "offline";

  // Tile
  const pad = size >= 32 ? s(0.5) : 0;
  const tile = roundRect(pad, pad, size - 2 * pad, size - 2 * pad, Math.max(2, 3.2 * u));
  c.fill(tile, lerp(offline ? C.offTop : C.tileTop, offline ? C.offBottom : C.tileBottom));

  // Monitor
  const stroke = Math.max(1, s(1.25));
  const mx = s(3), my = s(3.5), mw = size - 2 * s(3), mh = s(7.5);
  const outer = roundRect(mx, my, mw, mh, Math.max(1, 1.2 * u));
  const inner = roundRect(mx + stroke, my + stroke, mw - 2 * stroke, mh - 2 * stroke, Math.max(0.5, 0.6 * u));
  c.fill(inner, C.mark, 0.18);
  c.fill(minus(outer, inner), C.mark);
  // Stand: neck + base
  const neckW = Math.max(2, s(2)), baseW = s(6);
  const neckX = Math.round((size - neckW) / 2), baseX = Math.round((size - baseW) / 2);
  const baseY = my + mh + Math.max(1, s(1.25));
  c.fill(roundRect(neckX, my + mh, neckW, baseY - (my + mh), 0), C.mark);
  c.fill(roundRect(baseX, baseY, baseW, Math.max(1, s(1.1)), Math.min(0.5 * u, 1)), C.mark);

  // Pulse line inside the screen (only where there's room for it).
  if (size >= 24) {
    const lw = Math.max(1, 0.9 * u);
    const y0 = my + mh / 2 + 0.5 * u;
    const x0 = mx + stroke + 0.6 * u, x1 = mx + mw - stroke - 0.6 * u;
    const pts = [
      [x0, y0], [x0 + 2.2 * u, y0], [x0 + 3.2 * u, y0 - 2.2 * u],
      [x0 + 4.6 * u, y0 + 1.6 * u], [x0 + 5.6 * u, y0], [x1, y0],
    ];
    c.fill(polyline(pts, lw), C.mark);
  }

  // Status badge
  const badge = { connected: C.green, busy: C.amber, viewing: C.red }[state];
  if (badge) {
    const r = Math.max(2.5, (size <= 20 ? 3.1 : 2.6) * u);
    const cx = size - r - (size >= 32 ? s(0.25) : 0), cy = cx;
    c.erase(circle(cx, cy, r + Math.max(1, 0.9 * u)));
    c.fill(circle(cx, cy, r), badge);
    if (size >= 24 && state === "busy") {
      // down arrow: "installing"
      const w = r * 0.55;
      c.fill(roundRect(cx - w * 0.28, cy - r * 0.55, w * 0.56, r * 0.6, 0), C.mark);
      c.fill(poly([[cx - w, cy - r * 0.05], [cx + w, cy - r * 0.05], [cx, cy + r * 0.62]]), C.mark);
    } else if (size >= 24 && state === "viewing") {
      // eye
      c.fill(minus(eye(cx, cy, r * 0.72, r * 0.45), circle(cx, cy, r * 0.18)), C.mark);
    } else if (size >= 24 && state === "connected") {
      // check mark
      c.fill(polyline([[cx - r * 0.45, cy + r * 0.02], [cx - r * 0.1, cy + r * 0.38], [cx + r * 0.5, cy - r * 0.35]], Math.max(1.2, r * 0.26)), C.mark);
    }
  } else if (offline && size >= 20) {
    // small hollow ring: "not connected"
    const r = Math.max(2.5, (size <= 20 ? 3.1 : 2.6) * u);
    const cx = size - r - (size >= 32 ? s(0.25) : 0), cy = cx;
    c.erase(circle(cx, cy, r + Math.max(1, 0.9 * u)));
    c.fill(minus(circle(cx, cy, r), circle(cx, cy, r - Math.max(1.5, 1.1 * u))), [226, 232, 240]);
  }
  return c.rgba();
}

function eye(cx, cy, rx, ry) {
  return (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
}

// Thick polyline as a union of segment capsules.
function polyline(pts, width) {
  const h = width / 2;
  return (px, py) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      if ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= h * h) return true;
    }
    return false;
  };
}

// Encoders -------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(rgba, w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}
// 32-bit BMP entry (classic, read by every Windows API) for small sizes.
function dib(rgba, n) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(n, 4); header.writeInt32LE(n * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(n * n * 4, 20);
  const pixels = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const s = (y * n + x) * 4, d = ((n - 1 - y) * n + x) * 4; // bottom-up, BGRA
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  const maskRow = Math.ceil(n / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * n)]); // AND mask unused (alpha wins)
}
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  const bodies = images.map(({ size, rgba }, i) => {
    const body = size >= 64 ? png(rgba, size, size) : dib(rgba, size);
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(body.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += body.length;
    return body;
  });
  return Buffer.concat([head, ...bodies]);
}

// Output ---------------------------------------------------------------------
mkdirSync(assets, { recursive: true });
const traySizes = [16, 20, 24, 32, 40, 48, 64];
const states = ["connected", "offline", "busy", "viewing"];
for (const st of states) {
  writeFileSync(join(assets, `tray-${st}.ico`), ico(traySizes.map((size) => ({ size, rgba: draw(size, st) }))));
}
const appSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
writeFileSync(join(assets, "agent.ico"), ico(appSizes.map((size) => ({ size, rgba: draw(size, "app") }))));
writeFileSync(join(assets, "logo.png"), png(draw(256, "app"), 256, 256));
// Shown inside the agent's own toast notifications (agent/src/notify.rs).
writeFileSync(join(assets, "tray.png"), png(draw(48, "app"), 48, 48));
mkdirSync(join(root, "master", "public"), { recursive: true });
writeFileSync(join(root, "master", "public", "favicon.png"), png(draw(32, "app"), 32, 32));

// Preview sheet: rows = states, columns = sizes, each shown at 1x and 4x.
{
  const sizes = [16, 20, 24, 32, 48];
  const rows = ["app", ...states];
  const cell = 48 * 4 + 16;
  const W = sizes.length * cell + 16, H = rows.length * (cell + 56) + 16;
  const sheet = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) sheet.set([246, 247, 250, 255], i * 4);
  rows.forEach((st, r) => sizes.forEach((sz, col) => {
    const img = draw(sz, st);
    const ox = 16 + col * cell, oy = 16 + r * (cell + 56);
    const blit = (scale, bx, by) => {
      for (let y = 0; y < sz * scale; y++)
        for (let x = 0; x < sz * scale; x++) {
          const s = (Math.floor(y / scale) * sz + Math.floor(x / scale)) * 4, a = img[s + 3] / 255;
          const d = ((by + y) * W + bx + x) * 4;
          for (let k = 0; k < 3; k++) sheet[d + k] = Math.round(img[s + k] * a + sheet[d + k] * (1 - a));
        }
    };
    blit(1, ox, oy);
    blit(4, ox, oy + sz + 8);
  }));
  writeFileSync(join(assets, "icon-preview.png"), png(sheet, W, H));
}
console.log("icons written to", assets);
