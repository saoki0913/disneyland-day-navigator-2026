// A designed one-day record as a PDF, made entirely on the phone (no server, no library).
// Each A4 page is drawn on a canvas with the app's own font and artwork, then embedded as a
// JPEG in a minimal PDF file. The file can be shared (iOS share sheet → ファイルに保存 / LINE)
// or downloaded.
const W = 1240, H = 1754;               // A4 at 150 dpi
const PT_W = 595.28, PT_H = 841.89;     // A4 in PDF points
const FONT = "'M PLUS Rounded 1c', 'Hiragino Maru Gothic ProN', 'Hiragino Sans', 'Noto Sans JP', sans-serif";
const C = {
  bg: '#f3f7ff', navy: '#0b2552', ink: '#13284b', muted: '#64779a', line: '#dbe6f6', blue: '#1565d8', blueL: '#e7f0ff',
  ride: '#1565d8', meal: '#e0891a', show: '#7a5bd6', gold: '#ffc83d',
};
const KIND = { ride: ['乗り物', C.ride], meal: ['ごはん', C.meal], show: ['ショー', C.show] };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const clock = (m) => `${Math.floor(m / 60) % 24}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${y}年${m}月${d}日（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`; };

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function sparkle(g, x, y, s, color) {
  g.save(); g.fillStyle = color; g.beginPath();
  g.moveTo(x, y - s); g.quadraticCurveTo(x + s * 0.12, y - s * 0.12, x + s, y); g.quadraticCurveTo(x + s * 0.12, y + s * 0.12, x, y + s);
  g.quadraticCurveTo(x - s * 0.12, y + s * 0.12, x - s, y); g.quadraticCurveTo(x - s * 0.12, y - s * 0.12, x, y - s);
  g.fill(); g.restore();
}
const font = (w, px) => `${w} ${px}px ${FONT}`;
function fit(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function newPage() {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  g.textBaseline = 'alphabetic';
  return { cv, g };
}

function drawHero(g, rec, o, art, stats) {
  const hh = 470;
  const grad = g.createLinearGradient(0, 0, 0, hh);
  grad.addColorStop(0, '#0a4fc2'); grad.addColorStop(1, '#3a8ff2');
  g.fillStyle = grad; g.fillRect(0, 0, W, hh);
  if (art) {
    // the park skyline artwork across the bottom of the header
    const s = W / art.width, ah = art.height * s;
    g.save(); g.globalAlpha = 0.9; g.drawImage(art, 0, hh - ah, W, ah); g.restore();
    const fade = g.createLinearGradient(0, 0, 0, hh);
    fade.addColorStop(0, 'rgba(10,79,194,.97)'); fade.addColorStop(0.42, 'rgba(10,79,194,.8)'); fade.addColorStop(0.62, 'rgba(10,79,194,.2)'); fade.addColorStop(1, 'rgba(10,79,194,0)');
    g.fillStyle = fade; g.fillRect(0, 0, W, hh);
  }
  sparkle(g, 1110, 92, 26, 'rgba(255,255,255,.95)'); sparkle(g, 1162, 150, 13, 'rgba(255,255,255,.8)'); sparkle(g, 1060, 160, 9, C.gold);
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = font(800, 24);
  g.fillText('PARK NAVI  ·  MY DAY', 80, 108);
  g.fillStyle = '#fff'; g.font = font(800, 64);
  g.fillText(fit(g, o.parkName, W - 160), 80, 196);
  g.font = font(700, 40);
  g.fillText(longDate(rec.date), 80, 258);
  // stats card overlapping the header
  const y = hh - 90, x = 60, w = W - 120, h = 190;
  g.save(); g.shadowColor = 'rgba(18,72,160,.18)'; g.shadowBlur = 40; g.shadowOffsetY = 12;
  rr(g, x, y, w, h, 36); g.fillStyle = '#fff'; g.fill(); g.restore();
  const cells = [['乗り物', stats.ride, C.ride], ['ごはん', stats.meal, C.meal], ['ショー', stats.show, C.show],
    ['時間', stats.first != null ? `${clock(stats.first)}–${clock(stats.last)}` : '—', C.navy]];
  const cw = w / cells.length;
  cells.forEach(([k, v, col], i) => {
    const cx = x + cw * i + cw / 2;
    if (i) { g.fillStyle = C.line; g.fillRect(x + cw * i, y + 40, 2, h - 80); }
    g.textAlign = 'center';
    g.fillStyle = col; g.font = font(800, i === 3 ? 38 : 72);
    g.fillText(String(v), cx, y + (i === 3 ? 108 : 118));
    g.fillStyle = C.muted; g.font = font(700, 24);
    g.fillText(k, cx, y + 160);
    g.textAlign = 'left';
  });
  return y + h + 70;
}

function drawFooter(g, page, pages) {
  g.fillStyle = C.muted; g.font = font(500, 20); g.textAlign = 'center';
  g.fillText(`Park Navi（非公式の個人用ナビ）で作成  ·  ${page} / ${pages}`, W / 2, H - 48);
  g.textAlign = 'left';
}

export async function recordPdf(rec, o = {}) {
  try {
    await Promise.all([document.fonts.load(font(800, 40), 'あ乗'), document.fonts.load(font(700, 40), 'あ乗'), document.fonts.load(font(500, 40), 'あ乗')]);
  } catch { /* system font */ }
  const art = await loadImage(o.art);
  const stats = { ride: 0, meal: 0, show: 0, first: null, last: null };
  for (const i of rec.items) {
    stats[i.kind]++;
    if (i.min != null) { stats.first = stats.first == null ? i.min : Math.min(stats.first, i.min); stats.last = stats.last == null ? i.min : Math.max(stats.last, i.min); }
  }
  const ROW = 88, BOTTOM = H - 120;
  const pages = [];
  let p = newPage();
  let y = drawHero(p.g, rec, o, art, stats);
  const title = (g, yy, cont) => {
    sparkle(g, 92, yy - 14, 16, C.gold);
    g.fillStyle = C.navy; g.font = font(800, 38); g.fillText(cont ? '1日のあゆみ（つづき）' : '1日のあゆみ', 122, yy);
    return yy + 40;
  };
  y = title(p.g, y, false);
  if (rec.partial) {
    p.g.fillStyle = C.muted; p.g.font = font(500, 22);
    p.g.fillText('一部の時刻は不明です（共有プランに残っていた記録から復元）', 80, y + 8); y += 36;
  }
  y += 12;
  const X_TIME = 80, X_DOT = 250, X_NAME = 290, X_END = W - 80;
  rec.items.forEach((it, idx) => {
    if (y + ROW > BOTTOM) { pages.push(p); p = newPage(); y = title(p.g, 120, true) + 24; }
    const g = p.g;
    const [kj, col] = KIND[it.kind] || KIND.ride;
    const last = idx === rec.items.length - 1;
    // timeline spine
    if (!last) { g.fillStyle = '#c9daf3'; g.fillRect(X_DOT - 2, y + ROW / 2, 4, ROW); }
    g.beginPath(); g.arc(X_DOT, y + ROW / 2, 14, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.lineWidth = 6; g.strokeStyle = col; g.stroke();
    g.fillStyle = it.min != null ? C.blue : C.muted; g.font = font(800, 34);
    g.fillText(it.min != null ? clock(it.min) : '—', X_TIME, y + ROW / 2 + 12);
    // card
    rr(g, X_NAME, y + 8, X_END - X_NAME, ROW - 16, 22); g.fillStyle = '#fff'; g.fill();
    g.font = font(700, 22);
    const chipW = g.measureText(kj).width + 36;
    rr(g, X_END - chipW - 20, y + ROW / 2 - 21, chipW, 42, 21); g.fillStyle = col + '1f'; g.fill();
    g.fillStyle = col; g.fillText(kj, X_END - chipW - 2, y + ROW / 2 + 8);
    g.fillStyle = C.ink; g.font = font(800, 31);
    g.fillText(fit(g, it.name, X_END - X_NAME - chipW - 70), X_NAME + 26, y + ROW / 2 + 11);
    y += ROW;
  });
  pages.push(p);
  pages.forEach((pg, i) => drawFooter(pg.g, i + 1, pages.length));
  const jpegs = await Promise.all(pages.map((pg) => new Promise((resolve, reject) => pg.cv.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('画像を作れませんでした'))), 'image/jpeg', 0.9))));
  return pdfFromJpegs(jpegs, W, H);
}

// Minimal PDF 1.4: one full-page JPEG per page.
export function pdfFromJpegs(jpegs, w, h) {
  const enc = new TextEncoder();
  const chunks = [];
  const offs = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const obj = (n, parts) => { offs[n] = len; push(`${n} 0 obj\n`); parts.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n%');
  push(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = jpegs.length;
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Kids [${jpegs.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${n} >>`]);
  jpegs.forEach((jpeg, i) => {
    const pn = 3 + 3 * i;
    obj(pn, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] /Resources << /XObject << /Im0 ${pn + 2} 0 R >> >> /Contents ${pn + 1} 0 R >>`]);
    const cs = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`;
    obj(pn + 1, [`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`]);
    obj(pn + 2, [`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
  });
  const xref = len;
  const total = 3 + 3 * n;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) push(`${String(offs[k]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
