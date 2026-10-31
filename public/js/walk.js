// Walking routes inside Disneyland Park, computed on the phone (no external service).
//
// A hand-made network of the main GUEST walkways (Main Street, the hub, each land's main path,
// Big Thunder Trail, the Galaxy's Edge entrances…). Public OpenStreetMap routers were tried but
// sent guests through backstage cast alleys and even out onto Disneyland Drive, so they are not
// used. Coordinates are approximate (±15 m); the line shows which way to go, not every bend.
import { distanceM } from './engine.js';

// id: [lat, lon, area name shown in directions]
export const NODES = {
  ent: [33.80985, -117.91899, '入口'],
  ts: [33.8103, -117.9190, 'タウンスクエア'],
  ms1: [33.8110, -117.9190, 'メインストリート'],
  ms2: [33.8117, -117.9190, 'メインストリート'],
  hub: [33.8123, -117.9190, 'お城前'],
  castle: [33.8131, -117.9190, 'お城'],
  fcourt: [33.8136, -117.9188, 'ファンタジーランド'],
  fwest: [33.8139, -117.9197, 'ファンタジーランド西側'],
  feast: [33.8136, -117.9179, 'ファンタジーランド東側'],
  fnorth: [33.8142, -117.9182, 'ファンタジーランド北側'],
  swmall: [33.8147, -117.9176, 'スモールワールド前'],
  toonent: [33.8155, -117.9180, 'トゥーンタウン入口'],
  toon: [33.8160, -117.9182, 'トゥーンタウン'],
  mattf: [33.8131, -117.9183, 'マッターホーン前'],
  tmatt: [33.8126, -117.9178, 'トゥモローランド北側'],
  tent: [33.8121, -117.9183, 'トゥモローランド入口'],
  tland: [33.8118, -117.9177, 'トゥモローランド'],
  tspace: [33.8114, -117.9172, 'スペース・マウンテン前'],
  tauto: [33.8124, -117.9169, 'オートピア前'],
  advent: [33.8119, -117.9196, 'アドベンチャーランド入口'],
  adv1: [33.8116, -117.9203, 'アドベンチャーランド'],
  adv2: [33.8117, -117.9213, 'インディ前'],
  nos: [33.8114, -117.9221, 'ニューオーリンズ・スクエア'],
  nos2: [33.8117, -117.9229, 'ホーンテッドマンション前'],
  river: [33.8121, -117.9219, 'アメリカ河沿い'],
  frent: [33.8125, -117.9197, 'フロンティアランド入口'],
  fr1: [33.8124, -117.9206, 'フロンティアランド'],
  btt: [33.8133, -117.9207, 'ビッグサンダー・トレイル'],
  btt2: [33.8140, -117.9209, 'ビッグサンダー・トレイル北側'],
  bayou: [33.8126, -117.9236, 'バイユー・カントリー'],
  bayou2: [33.8135, -117.9240, 'バイユー・カントリー北側'],
  gew: [33.8143, -117.9238, 'ギャラクシーズ・エッジ西口'],
  gee: [33.8145, -117.9214, 'ギャラクシーズ・エッジ東口'],
  ge: [33.8148, -117.9227, 'ギャラクシーズ・エッジ'],
  rise: [33.8153, -117.9234, 'レジスタンスの台頭前'],
};
export const EDGES = [
  ['ent', 'ts'], ['ts', 'ms1'], ['ms1', 'ms2'], ['ms2', 'hub'],
  ['hub', 'castle'], ['castle', 'fcourt'], ['fcourt', 'fwest'], ['fcourt', 'feast'], ['fcourt', 'fnorth'],
  ['feast', 'fnorth'], ['fnorth', 'swmall'], ['swmall', 'toonent'], ['toonent', 'toon'],
  ['feast', 'mattf'], ['mattf', 'tmatt'], ['hub', 'tent'], ['tent', 'tland'], ['tent', 'tmatt'],
  ['tland', 'tspace'], ['tland', 'tauto'], ['tmatt', 'tauto'],
  ['hub', 'advent'], ['hub', 'frent'], ['advent', 'frent'], ['advent', 'adv1'], ['adv1', 'adv2'], ['adv2', 'nos'],
  ['nos', 'nos2'], ['nos', 'river'], ['river', 'nos2'], ['nos2', 'bayou'], ['bayou', 'bayou2'], ['bayou2', 'gew'],
  ['frent', 'fr1'], ['fr1', 'river'], ['fr1', 'btt'], ['btt', 'btt2'], ['btt2', 'gee'], ['btt2', 'fwest'],
  ['gew', 'ge'], ['gew', 'rise'], ['ge', 'rise'], ['ge', 'gee'],
];

const P = (id) => ({ lat: NODES[id][0], lon: NODES[id][1] });
const ADJ = {};
for (const [a, b] of EDGES) {
  const d = distanceM(P(a), P(b));
  (ADJ[a] ||= []).push([b, d]);
  (ADJ[b] ||= []).push([a, d]);
}
// The walkway nodes closest to a point (we join the network at one of them).
function nearest(p, k = 3) {
  return Object.keys(NODES).map((id) => [id, distanceM(p, P(id))]).sort((x, y) => x[1] - y[1]).slice(0, k);
}
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function turnOf(delta) {
  const a = Math.abs(delta);
  if (a < 30) return null;
  const side = delta > 0 ? 'right' : 'left';
  return a < 60 ? `slight ${side}` : a > 140 ? `sharp ${side}` : side;
}

/**
 * Route from `from` to `to` (each {lat, lon}) over the guest walkways.
 * Returns { coords:[[lat,lon]...], distance (m), steps:[{type, modifier, name, distance, at:[lat,lon]}] }
 * in the same shape the guidance UI uses; null if no route.
 */
export function walkRoute(from, to) {
  const direct = distanceM(from, to);
  // Very close: just walk straight there.
  if (direct < 60) return { coords: [[from.lat, from.lon], [to.lat, to.lon]], distance: Math.round(direct), steps: [{ type: 'arrive', modifier: '', name: '', distance: 0, at: [to.lat, to.lon] }] };
  const starts = nearest(from), ends = new Map(nearest(to).map(([id, d]) => [id, d]));
  // Dijkstra from a virtual start node connected to the 3 nearest walkway points.
  const dist = new Map(), prev = new Map(), done = new Set();
  for (const [id, d] of starts) { dist.set(id, d); prev.set(id, null); }
  let best = null;
  while (true) {
    let u = null, du = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < du) { u = id; du = d; }
    if (u == null) break;
    done.add(u);
    if (ends.has(u)) {
      const total = du + ends.get(u);
      if (!best || total < best.total) best = { id: u, total };
    }
    if (best && du > best.total) break;
    for (const [v, w] of ADJ[u] || []) {
      if (done.has(v)) continue;
      const nd = du + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  if (!best) return null;
  const path = [];
  for (let id = best.id; id != null; id = prev.get(id)) path.unshift(id);
  const pts = [from, ...path.map(P), to];
  const coords = pts.map((p) => [p.lat, p.lon]);
  const steps = [{ type: 'depart', modifier: '', name: NODES[path[0]][2], distance: 0, at: coords[0] }];
  let acc = 0, lastAt = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    acc += distanceM(pts[i - 1], pts[i]);
    let delta = bearing(pts[i], pts[i + 1]) - bearing(pts[i - 1], pts[i]);
    delta = ((delta + 540) % 360) - 180;
    const m = turnOf(delta);
    if (!m) continue;
    const name = i + 1 < pts.length - 1 ? NODES[path[i]][2] : '';
    steps.push({ type: 'turn', modifier: m, name, distance: Math.round(acc - lastAt), at: coords[i] });
    lastAt = acc;
  }
  acc += distanceM(pts[pts.length - 2], pts[pts.length - 1]);
  steps.push({ type: 'arrive', modifier: '', name: '', distance: 0, at: coords[coords.length - 1] });
  return { coords, distance: Math.round(acc), steps };
}
