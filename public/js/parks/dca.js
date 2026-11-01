// ---------------------------------------------------------------------------
// Static catalog for Disney California Adventure Park (Anaheim) — Nov 1, 2026
//
// Same honesty rules as parks/dl.js:
//  * `pos` coordinates are APPROXIMATE hand-placed fallbacks. At runtime they are
//    replaced by ThemeParks.wiki coordinates whenever that API is reachable.
//  * `peak` / wait curves are PLANNING ESTIMATES, never shown as live values.
//  * Restaurants, prices and show times are pre-trip research (事前情報) and must be
//    re-checked in the official app. Show times are "要確認" until the API confirms them.
// ---------------------------------------------------------------------------

export const PARK = {
  id: 'dca', ja: 'ディズニー・カリフォルニア・アドベンチャー', short: 'カリフォルニア', en: 'Disney California Adventure Park',
  storeKey: 'dlnavi-dca-v1',
  officialUrl: 'https://disneyland.disney.go.com/entertainment/disney-california-adventure/',
  tpwId: '832fcd51-ea19-4e77-85c7-75d5843b127c', tpwName: 'California Adventure', qtId: 17,
  bounds: [[33.8030, -117.9245], [33.8098, -117.9152]],
  center: { lat: 33.8066, lon: -117.9198 },
  box: { lat: [33.801, 33.812], lon: [-117.927, -117.913] },
  limitedTab: null,
};

export const TRIP = {
  date: '2026-11-01',
  tz: 'America/Los_Angeles',
  // しおり: 8:00 開園 / 21:00 閉園（予定）。API の公式スケジュールが取れればそちらを使う。
  openMin: 8 * 60,
  closeMin: 21 * 60,
  hotel: { name: 'Clarion Hotel Anaheim Resort', pos: { lat: 33.80345, lon: -117.91508 } },
  entrance: { lat: 33.8089, lon: -117.9190 },
};

export const PARK_ID_TPW = PARK.tpwId;
export const PARK_ID_QT = PARK.qtId;
export const DEFAULT_MUST = { rsr: true };

export const LANDS = [
  { id: 'bvs', ja: 'ブエナビスタ・ストリート', en: 'Buena Vista Street', pos: { lat: 33.8080, lon: -117.9190 }, color: '#c8423a' },
  { id: 'hollywood', ja: 'ハリウッドランド', en: 'Hollywood Land', pos: { lat: 33.8083, lon: -117.9173 }, color: '#5b3f78' },
  { id: 'avengers', ja: 'アベンジャーズ・キャンパス', en: 'Avengers Campus', pos: { lat: 33.8070, lon: -117.9167 }, color: '#3c4a5c' },
  { id: 'cars', ja: 'カーズランド', en: 'Cars Land', pos: { lat: 33.8052, lon: -117.9178 }, color: '#d9852b' },
  { id: 'wharf', ja: 'サンフランソウキョウ・スクエア', en: 'San Fransokyo Square', pos: { lat: 33.8061, lon: -117.9195 }, color: '#2d6fa3' },
  { id: 'pixar', ja: 'ピクサー・ピア', en: 'Pixar Pier', pos: { lat: 33.8049, lon: -117.9218 }, color: '#b0518a' },
  { id: 'gardens', ja: 'パラダイス・ガーデンズ・パーク', en: 'Paradise Gardens Park', pos: { lat: 33.8059, lon: -117.9228 }, color: '#2f6b5a' },
  { id: 'grizzly', ja: 'グリズリー・ピーク', en: 'Grizzly Peak', pos: { lat: 33.8068, lon: -117.9212 }, color: '#4f7a3a' },
  { id: 'dtd', ja: 'ダウンタウン・ディズニー', en: 'Downtown Disney District', pos: { lat: 33.8094, lon: -117.9228 }, color: '#a8642a' },
];
export const landById = Object.fromEntries(LANDS.map((l) => [l.id, l]));

// thrill 1-5, pop 1-5, dur = ride + load/unload minutes, peak = typical busy-day wait (planning only).
// extra: listed everywhere but only planned when the user adds it / marks it must.
export const ATTRACTIONS = [
  {
    id: 'rsr', ja: 'ラジエーター・スプリングス・レーサーズ', short: 'ラジエーター・スプリングス',
    en: 'Radiator Springs Racers', land: 'cars', must: true,
    match: ['radiatorspringsracers'], thrill: 3, pop: 5, dur: 8, peak: 90,
    pos: { lat: 33.8045, lon: -117.9181 }, wiki: 'Radiator_Springs_Racers',
    desc: '『カーズ』の町ラジエーター・スプリングスをドライブし、最後は2台並んでオーナメント・バレーを駆け抜けるレース。夕暮れ〜夜のネオンも美しい。',
    japan: '日本未上陸。カリフォルニア・アドベンチャーで一番人気の看板ライド。',
    tip: '朝イチか閉園間際が狙い目。シングルライダーあり（2人別々でよければ大幅に時短）。休止もよくある。',
  },
  {
    id: 'guardians', ja: 'ガーディアンズ・オブ・ギャラクシー：ミッション・ブレイクアウト！', short: 'ガーディアンズ・オブ・ギャラクシー',
    en: 'Guardians of the Galaxy – Mission: BREAKOUT!', land: 'avengers',
    match: ['missionbreakout'], thrill: 4, pop: 5, dur: 8, peak: 70,
    pos: { lat: 33.8077, lon: -117.9165 }, wiki: 'Guardians_of_the_Galaxy_–_Mission:_Breakout!',
    desc: 'コレクターの要塞に捕らわれたガーディアンズを救い出す落下系アトラクション。音楽に合わせて上下に何度も落ちる。',
    japan: '日本未上陸。旧タワー・オブ・テラーを改装したもの（東京のタワー・オブ・テラーとは物語も曲も別物）。',
    tip: '落下が苦手なら要注意。音楽は数パターンあり、乗るたびに違う。',
  },
  {
    id: 'webslingers', ja: 'ウェブ・スリンガーズ：スパイダーマン・アドベンチャー', short: 'ウェブ・スリンガーズ',
    en: 'WEB SLINGERS: A Spider-Man Adventure', land: 'avengers',
    match: ['webslingers'], thrill: 2, pop: 4, dur: 8, peak: 55,
    pos: { lat: 33.8066, lon: -117.9168 }, wiki: 'Web_Slingers:_A_Spider-Man_Adventure',
    desc: '手を振るとクモの糸が出る、体の動きで遊ぶシューティング。暴走するスパイダーボットを捕まえてスコアを競う。',
    japan: '日本未上陸。2人でスコア勝負が盛り上がる。',
    tip: '手首を素早く振るのがコツ。待ち時間は比較的読みやすい。',
  },
  {
    id: 'incredicoaster', ja: 'インクレディコースター', short: 'インクレディコースター',
    en: 'Incredicoaster', land: 'pixar',
    match: ['incredicoaster'], thrill: 4, pop: 4, dur: 5, peak: 45,
    pos: { lat: 33.8044, lon: -117.9226 }, wiki: 'Incredicoaster',
    desc: '『Mr.インクレディブル』のジャック・ジャックを追いかける、ラグーンを一周する大型ローラーコースター。ループあり。',
    japan: '日本未上陸。ディズニーの中でもかなり本格的なコースター。',
    tip: '夜はライトアップされて景色も良い。荷物はロッカー不要だが小物は落とさないよう注意。',
  },
  {
    id: 'soarin', ja: 'ソアリン・アラウンド・ザ・ワールド', short: 'ソアリン',
    en: "Soarin' Around the World", land: 'grizzly',
    match: ['soarin'], thrill: 2, pop: 4, dur: 12, peak: 50,
    pos: { lat: 33.8076, lon: -117.9207 }, wiki: "Soarin'",
    desc: 'ハンググライダーに乗って世界の名所の上空を飛ぶ、大スクリーンの体感型シアター。風や香りの演出あり。',
    japan: '東京ディズニーシーの「ソアリン：ファンタスティック・フライト」とは映像が違う。上映内容は時期で変わるので当日確認。',
    tip: '真ん中の列（B）が一番見やすい。午後は比較的空くことが多い。',
  },
  {
    id: 'tsmm', ja: 'トイ・ストーリー・マニア！', short: 'トイ・ストーリー・マニア',
    en: 'Toy Story Midway Mania!', land: 'pixar',
    match: ['toystorymidwaymania'], thrill: 1, pop: 4, dur: 10, peak: 50,
    pos: { lat: 33.8053, lon: -117.9212 }, wiki: 'Toy_Story_Midway_Mania!',
    desc: '3Dメガネをかけて的当てゲームを回るシューティング。2人並んで得点を競える。',
    japan: '東京ディズニーシーにもあるが、こちらが元祖。',
    tip: '的の数字が大きいもの・動くものほど高得点。',
  },
  {
    id: 'grizzly', ja: 'グリズリー・リバー・ラン', short: 'グリズリー・リバー・ラン',
    en: 'Grizzly River Run', land: 'grizzly',
    match: ['grizzlyriverrun'], thrill: 3, pop: 3, dur: 8, peak: 35,
    pos: { lat: 33.8063, lon: -117.9214 }, wiki: 'Grizzly_River_Run',
    desc: '円形ボートで急流を下るラフティング。かなり濡れる。',
    japan: '日本未上陸。',
    tip: '11月の夜は寒いので乗るなら昼間に。ポンチョ推奨。冬季は休止することもある。',
  },
  {
    id: 'monsters', ja: 'モンスターズ・インク：マイク＆サリーのレスキュー！', short: 'モンスターズ・インク',
    en: 'Monsters, Inc. Mike & Sulley to the Rescue!', land: 'hollywood',
    match: ['monstersinc', 'mikesulley'], thrill: 1, pop: 3, dur: 6, peak: 25,
    pos: { lat: 33.8087, lon: -117.9171 }, wiki: 'Monsters,_Inc._Mike_%26_Sulley_to_the_Rescue!',
    desc: 'タクシーに乗ってブーを探しながらモンスターシティを巡るダークライド。',
    japan: '東京の「ライド＆ゴーシーク」とは別物（懐中電灯はなし）。',
    tip: '待ちは短め。合間の休憩がわりに。',
  },
  {
    id: 'luigi', ja: 'ルイジのローリッキン・ロードスター', short: 'ルイジのロードスター',
    en: "Luigi's Rollickin' Roadsters", land: 'cars',
    match: ['luigis'], thrill: 1, pop: 3, dur: 5, peak: 25,
    pos: { lat: 33.8055, lon: -117.9177 }, wiki: "Luigi's_Rollickin'_Roadsters",
    desc: 'イタリア音楽に合わせて車が踊るように動き回る、のんびり系ライド。',
    japan: '日本未上陸。',
    tip: 'カーズランドの合間に。',
  },
  {
    id: 'mater', ja: 'メーターのジャンクヤード・ジャンボリー', short: 'メーターのジャンボリー',
    en: "Mater's Graveyard JamBOree", land: 'cars',
    match: ['mater'], thrill: 2, pop: 2, dur: 4, peak: 20,
    pos: { lat: 33.8057, lon: -117.9185 }, wiki: "Mater's_Junkyard_Jamboree",
    desc: 'メーターの歌に合わせて小さなトラクターに引かれて振り回されるライド。',
    japan: '日本未上陸。',
    tip: '短時間で終わる。待ちが10分以下なら。',
  },
  {
    id: 'mermaid', ja: 'リトル・マーメイド：アリエルのアンダーシー・アドベンチャー', short: 'リトル・マーメイド',
    en: "The Little Mermaid – Ariel's Undersea Adventure", land: 'gardens',
    match: ['littlemermaid', 'arielsundersea'], thrill: 1, pop: 3, dur: 7, peak: 20,
    pos: { lat: 33.8064, lon: -117.9222 }, wiki: "The_Little_Mermaid:_Ariel's_Undersea_Adventure",
    desc: '貝殻の乗り物で映画の名曲シーンを巡るダークライド。',
    japan: '日本未上陸（東京のマーメイドラグーンとは別物）。',
    tip: '待ちが短く、休憩代わりに座れる。',
  },
  {
    id: 'goofy', ja: 'グーフィーのスカイ・スクール', short: 'グーフィーのスカイ・スクール',
    en: "Goofy's Sky School", land: 'gardens',
    match: ['goofysskyschool'], thrill: 3, pop: 2, dur: 4, peak: 25,
    pos: { lat: 33.8055, lon: -117.9231 }, wiki: "Goofy's_Sky_School",
    desc: 'グーフィーの操縦練習という設定の、急カーブの多い小型コースター。',
    japan: '日本未上陸。',
    tip: '見た目より揺れる。',
  },
  {
    id: 'swings', ja: 'シリー・シンフォニー・スウィング', short: 'シリー・シンフォニー・スウィング',
    en: 'Silly Symphony Swings', land: 'gardens',
    match: ['sillysymphonyswings'], thrill: 2, pop: 2, dur: 4, peak: 15,
    pos: { lat: 33.8058, lon: -117.9227 }, wiki: 'Silly_Symphony_Swings',
    desc: '空中ブランコ。ラグーンを見渡せて夜景がきれい。',
    japan: '日本未上陸。',
    tip: '2人乗りの席もある。',
  },
  {
    id: 'palaround', ja: 'ピクサー・パル・ア・ラウンド', short: 'パル・ア・ラウンド',
    en: 'Pixar Pal-A-Round', land: 'pixar',
    match: ['palaround'], thrill: 2, pop: 2, dur: 12, peak: 20,
    pos: { lat: 33.8049, lon: -117.9221 }, wiki: 'Pixar_Pal-A-Round',
    desc: 'ラグーンにそびえる大観覧車。揺れるゴンドラと揺れないゴンドラを選べる。',
    japan: '日本未上陸。',
    tip: '夕方〜夜の景色が最高。揺れるゴンドラはかなりスリルあり。',
  },
  {
    id: 'insideout', ja: 'インサイド・ヘッド：エモーショナル・ワールウィンド', short: 'インサイド・ヘッド',
    en: 'Inside Out Emotional Whirlwind', land: 'pixar',
    match: ['insideout'], thrill: 1, pop: 2, dur: 4, peak: 20,
    pos: { lat: 33.8052, lon: -117.9217 }, wiki: 'Inside_Out_Emotional_Whirlwind',
    desc: '『インサイド・ヘッド』の記憶ボールの中を回るファミリーライド。',
    japan: '日本未上陸。',
    tip: '短時間。待ち10分以下なら。',
  },
  {
    id: 'turtle', ja: 'タートル・トーク・ウィズ・クラッシュ', short: 'タートル・トーク',
    en: 'Turtle Talk with Crush', land: 'hollywood',
    match: ['turtletalk'], thrill: 1, pop: 2, dur: 17, peak: 15,
    pos: { lat: 33.8081, lon: -117.9178 }, wiki: 'Turtle_Talk_with_Crush',
    desc: 'ウミガメのクラッシュと会話できるシアター。',
    japan: '東京ディズニーシーにもあるが、こちらは英語。',
    tip: '座って休めるので疲れたときに。',
  },
  {
    id: 'zephyr', ja: 'ゴールデン・ゼファー', short: 'ゴールデン・ゼファー',
    en: 'Golden Zephyr', land: 'gardens', extra: true,
    match: ['goldenzephyr'], thrill: 1, pop: 1, dur: 4, peak: 10,
    pos: { lat: 33.8061, lon: -117.9230 }, wiki: 'Golden_Zephyr',
    desc: 'ロケット型ゴンドラがゆったり回るクラシックなライド。風が強い日は休止。',
    japan: '日本未上陸。',
    tip: 'ほぼ待たずに乗れることが多い。',
  },
  {
    id: 'jessie', ja: 'ジェシーのクリッター・カルーセル', short: 'ジェシーのカルーセル',
    en: "Jessie's Critter Carousel", land: 'pixar', extra: true,
    match: ['jessiescrittercarousel', 'critterc'], thrill: 1, pop: 1, dur: 5, peak: 10,
    pos: { lat: 33.8050, lon: -117.9214 }, wiki: "Jessie's_Critter_Carousel",
    desc: '『トイ・ストーリー』の動物たちのメリーゴーラウンド。',
    japan: '日本未上陸。',
    tip: '写真スポットとしても。',
  },
];
export const attractionById = Object.fromEntries(ATTRACTIONS.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// Dining (pre-trip research, may have changed — always confirm in the official app).
// kind 'meal' entries are dinner/lunch candidates. Downtown Disney entries are
// outside the park (re-entry with ticket scan).
// ---------------------------------------------------------------------------
const menuUrl = (slug) => `https://disneyland.disney.go.com/dining/disney-california-adventure/${slug}/menus/`;
export const RESTAURANTS = [
  {
    id: 'lamplight', ja: 'ランプライト・ラウンジ', en: 'Lamplight Lounge', land: 'pixar', kind: 'meal', style: 'テーブルサービス（予約推奨）',
    match: ['lamplightlounge'], pos: { lat: 33.8047, lon: -117.9208 }, mobile: 'no',
    hours: '昼〜夜（予約・空き状況はアプリで確認）', emoji: '🍽️',
    menu: [{ name: 'ロブスター・ナチョス（名物）', en: 'Lobster Nachos', price: '要確認' }],
    halloween: [],
    desc: 'ピクサーのアニメーターが集うという設定のガストロパブ。ラグーンを見渡すテラス席もあり、ご褒美ディナーの第一候補。',
    menuUrl: menuUrl('lamplight-lounge'),
  },
  {
    id: 'carthay', ja: 'カーセイ・サークル・レストラン', en: 'Carthay Circle Restaurant', land: 'bvs', kind: 'meal', style: 'テーブルサービス（予約推奨）',
    match: ['carthaycircle'], pos: { lat: 33.8074, lon: -117.9196 }, mobile: 'no',
    hours: '昼〜夜（営業日・予約はアプリで確認）', emoji: '🍷',
    menu: [{ name: 'コース・アラカルト（ステーキ等）', en: 'Fine dining', price: '要確認（高め）' }],
    halloween: [],
    desc: 'パークの中心に建つ映画館風の建物のレストラン。落ち着いた雰囲気で記念日向き。',
    menuUrl: menuUrl('carthay-circle-restaurant'),
  },
  {
    id: 'flos', ja: 'フローズ・V8・カフェ', en: "Flo's V8 Cafe", land: 'cars', kind: 'meal', style: 'クイックサービス',
    match: ['flosv8'], pos: { lat: 33.8051, lon: -117.9186 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🍔',
    menu: [{ name: 'ロティサリーチキン・アメリカン料理', en: 'American comfort food', price: '要確認' }],
    halloween: [],
    desc: 'カーズランドのダイナー。ラジエーター・スプリングスの景色を眺めながら食べられる。',
    menuUrl: menuUrl('flos-v8-cafe'),
  },
  {
    id: 'smokejumpers', ja: 'スモークジャンパーズ・グリル', en: 'Smokejumpers Grill', land: 'grizzly', kind: 'meal', style: 'クイックサービス',
    match: ['smokejumpers'], pos: { lat: 33.8073, lon: -117.9199 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🍔',
    menu: [{ name: 'バーガー', en: 'Burgers', price: '要確認' }],
    halloween: [],
    desc: '森林消防隊の基地がテーマのバーガー店。ソアリンの近く。',
    menuUrl: menuUrl('smokejumpers-grill'),
  },
  {
    id: 'luckyfortune', ja: 'ラッキー・フォーチュン・クッカリー', en: 'Lucky Fortune Cookery', land: 'wharf', kind: 'meal', style: 'クイックサービス',
    match: ['luckyfortune'], pos: { lat: 33.8061, lon: -117.9197 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🍜',
    menu: [{ name: 'アジアン・ボウル（ご飯＋おかず）', en: 'Asian rice bowls', price: '要確認' }],
    halloween: [],
    desc: 'サンフランソウキョウのアジア料理。ご飯ものが恋しくなったら。',
    menuUrl: menuUrl('lucky-fortune-cookery'),
  },
  {
    id: 'pacificwharf', ja: 'パシフィック・ワーフ・カフェ', en: 'Pacific Wharf Cafe', land: 'wharf', kind: 'meal', style: 'クイックサービス',
    match: ['pacificwharfcafe'], pos: { lat: 33.8063, lon: -117.9192 }, mobile: 'yes',
    hours: '朝〜夜', emoji: '🥣',
    menu: [{ name: 'クラムチャウダー（ブレッドボウル）', en: 'Clam Chowder Bread Bowl', price: '要確認' }],
    halloween: [],
    desc: 'サワードウのブレッドボウルに入ったクラムチャウダーが名物。',
    menuUrl: menuUrl('pacific-wharf-cafe'),
  },
  {
    id: 'pym', ja: 'ピム・テスト・キッチン', en: 'Pym Test Kitchen', land: 'avengers', kind: 'meal', style: 'クイックサービス',
    match: ['pymtestkitchen'], pos: { lat: 33.8068, lon: -117.9161 }, mobile: 'yes',
    hours: '昼〜夜（営業状況は要確認）', emoji: '🥨',
    menu: [{ name: '巨大プレッツェル・小さいサンドなど', en: 'Quantum-sized food', price: '要確認' }],
    halloween: [],
    desc: 'アントマンの研究所で、料理が巨大化・縮小化した「量子サイズ」メニュー。',
    menuUrl: menuUrl('pym-test-kitchen'),
  },
  {
    id: 'paradisegrill', ja: 'パラダイス・ガーデン・グリル', en: 'Paradise Garden Grill', land: 'gardens', kind: 'meal', style: 'クイックサービス',
    match: ['paradisegardengrill'], pos: { lat: 33.8056, lon: -117.9224 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🥙',
    menu: [{ name: 'グリル料理', en: 'Grill', price: '要確認' }],
    halloween: [],
    desc: 'ラグーン沿いのカウンター。ワールド・オブ・カラーの前に便利。',
    menuUrl: menuUrl('paradise-garden-grill'),
  },
  {
    id: 'clarabelle', ja: 'クララベルズ・ハンドスクープ・アイスクリーム', en: "Clarabelle's Hand Scooped Ice Cream", land: 'bvs', kind: 'cafe', style: 'カウンター',
    match: ['clarabelle'], pos: { lat: 33.8082, lon: -117.9192 }, mobile: 'unknown',
    hours: '朝〜夜', emoji: '🍨',
    menu: [{ name: 'アイスクリーム・サンドイッチ', en: 'Ice cream & sandwiches', price: '要確認' }],
    halloween: [],
    desc: 'ブエナビスタ・ストリートのアイスクリーム＆軽食店。',
    menuUrl: menuUrl('clarabelles'),
  },
  {
    id: 'ghirardelli', ja: 'ギラデリ・ソーダファウンテン', en: 'Ghirardelli Soda Fountain and Chocolate Shop', land: 'pixar', kind: 'sweets', style: 'カウンター',
    match: ['ghirardelli'], pos: { lat: 33.8055, lon: -117.9206 }, mobile: 'unknown',
    hours: '昼〜閉園', emoji: '🍫',
    menu: [{ name: 'ホットファッジ・サンデー', en: 'Hot Fudge Sundae', price: '要確認' }],
    halloween: [],
    desc: 'サンフランシスコの老舗チョコレート店のサンデー。2人でシェアできる大きさ。',
    menuUrl: menuUrl('ghirardelli-soda-fountain-and-chocolate-shop'),
  },
  {
    id: 'cozycone', ja: 'コージー・コーン・モーテル', en: 'Cozy Cone Motel', land: 'cars', kind: 'snack', style: '軽食スタンド',
    match: ['cozycone'], pos: { lat: 33.8056, lon: -117.9174 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🍦',
    menu: [{ name: 'ソフトクリーム・チュロス・ポップコーン', en: 'Cone snacks', price: '要確認' }],
    halloween: [],
    desc: '三角コーン型のモーテルで、コーンに入ったスナックを売るスタンド。',
    menuUrl: menuUrl('cozy-cone-motel'),
  },
  {
    id: 'jackjack', ja: 'ジャック・ジャック・クッキー・ナム・ナム', en: 'Jack-Jack Cookie Num Nums', land: 'pixar', kind: 'sweets', style: '軽食スタンド',
    match: ['jackjack'], pos: { lat: 33.8048, lon: -117.9214 }, mobile: 'yes',
    hours: '昼〜夜', emoji: '🍪',
    menu: [{ name: '巨大クッキー＆ミルク', en: 'Cookie & milk', price: '要確認' }],
    halloween: [],
    desc: '焼きたての巨大チョコチップクッキー。',
    menuUrl: menuUrl('jack-jack-cookie-num-nums'),
  },
  // --- Downtown Disney (park outside; re-entry needed) ---
  {
    id: 'catal', ja: 'カタル・レストラン（ダウンタウン）', en: 'Catal Restaurant', land: 'dtd', kind: 'meal', style: 'テーブルサービス（パーク外）',
    match: ['catal'], pos: { lat: 33.8093, lon: -117.9236 }, mobile: 'no',
    hours: '夜まで（予約推奨・営業は要確認）', emoji: '🥘',
    menu: [{ name: '地中海料理・パエリア', en: 'Mediterranean', price: '要確認' }],
    halloween: [],
    desc: 'ダウンタウン・ディズニーの地中海料理レストラン。2階のバルコニー席が気持ちいい。パークを出て再入園が必要。',
    menuUrl: 'https://disneyland.disney.go.com/dining/downtown-disney-district/catal-restaurant/',
  },
  {
    id: 'naples', ja: 'ナポリ・リストランテ（ダウンタウン）', en: 'Naples Ristorante e Bar', land: 'dtd', kind: 'meal', style: 'テーブルサービス（パーク外）',
    match: ['naples'], pos: { lat: 33.8095, lon: -117.9226 }, mobile: 'no',
    hours: '夜まで（予約推奨・営業は要確認）', emoji: '🍕',
    menu: [{ name: 'ナポリピッツァ・パスタ', en: 'Pizza & pasta', price: '要確認' }],
    halloween: [],
    desc: 'ダウンタウン・ディズニーのイタリアン。大きなピザを2人でシェア。パークを出て再入園が必要。',
    menuUrl: 'https://disneyland.disney.go.com/dining/downtown-disney-district/naples-ristorante-e-bar/',
  },
];
export const restaurantById = Object.fromEntries(RESTAURANTS.map((r) => [r.id, r]));

export const POPCORN = [];

// ---------------------------------------------------------------------------
// Shows. times = placeholder for planning, labelled 要確認 until confirmed.
// ---------------------------------------------------------------------------
export const SHOWS = [
  {
    id: 'worldofcolor', ja: 'ワールド・オブ・カラー', short: 'ワールド・オブ・カラー',
    en: 'World of Color', match: ['worldofcolor'],
    times: ['20:30'], dur: 25, claim: 30,
    venue: 'パラダイス・ベイ（ラグーン）沿い', venuePos: { lat: 33.8058, lon: -117.9221 },
    viewing: '正面のビューイングエリアはスタンバイパス（公式アプリ）が必要なことが多い。パラダイス・ガーデンズ側の手すり沿いや、ピクサー・ピア側からも見られる。前方は水しぶきあり。',
    desc: '噴水・光・炎・映像でディズニー／ピクサーの名場面を描く、ラグーンの水上ナイトショー。上演内容と時刻は当日アプリで確認。',
    emoji: '🌈', defaultPick: '20:30',
  },
];
export const showById = Object.fromEntries(SHOWS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Plans (minutes from midnight). しおり：12:00 お昼 / 18:30 ご褒美ディナー / 21:00 閉園
// ---------------------------------------------------------------------------
export const PLANS = {
  relax: {
    id: 'relax', label: 'A', ja: 'ゆったり満喫', tagline: '食事・景色をじっくり',
    targetRides: 5, maxWait: 50, waitWeight: 0.55, walkWeight: 1.2,
    meals: [
      { id: 'lunch', ja: 'ランチ', at: 12 * 60, dur: 70, restaurant: 'flos' },
      { id: 'snack', ja: 'おやつ休憩', at: 15 * 60 + 15, dur: 40, restaurant: 'ghirardelli' },
      { id: 'dinner', ja: 'ご褒美ディナー', at: 18 * 60 + 30, dur: 90, restaurant: 'lamplight' },
    ],
    shows: { worldofcolor: true },
    note: 'ラジエーター・スプリングス＋人気施設を厳選。ディナーはゆっくり。',
  },
  balance: {
    id: 'balance', label: 'B', ja: 'バランス型', tagline: '人気施設もご褒美ディナーも',
    targetRides: 8, maxWait: 70, waitWeight: 0.45, walkWeight: 0.9,
    meals: [
      { id: 'lunch', ja: 'ランチ', at: 12 * 60, dur: 60, restaurant: 'flos' },
      { id: 'snack', ja: 'おやつ休憩', at: 15 * 60 + 30, dur: 25, restaurant: 'cozycone' },
      { id: 'dinner', ja: 'ご褒美ディナー', at: 18 * 60 + 30, dur: 90, restaurant: 'lamplight' },
    ],
    shows: { worldofcolor: true },
    note: 'おすすめ。ラジエーター・スプリングス＋人気施設を効率よく。18:30のご褒美ディナーは固定。',
  },
  rides: {
    id: 'rides', label: 'C', ja: 'アトラクション重視', tagline: '乗れるだけ乗る（ディナーは死守）',
    targetRides: 12, maxWait: 90, waitWeight: 0.35, walkWeight: 0.7,
    meals: [
      { id: 'lunch', ja: 'ランチ', at: 11 * 60 + 30, dur: 40, restaurant: 'smokejumpers' },
      { id: 'snack', ja: 'おやつ休憩', at: 15 * 60 + 30, dur: 15, restaurant: 'cozycone' },
      { id: 'dinner', ja: 'ご褒美ディナー', at: 18 * 60 + 30, dur: 80, restaurant: 'lamplight' },
    ],
    shows: { worldofcolor: true },
    note: '待ち時間の短い施設を柔軟に追加。ディナーとショーは削りません。',
  },
};

export const PRIORITY = {
  rsr: 30, guardians: 22, soarin: 16, incredicoaster: 15, webslingers: 15, tsmm: 14, grizzly: 7,
  monsters: 7, luigi: 6, mermaid: 5, goofy: 4, swings: 3, palaround: 4, insideout: 2, mater: 2,
  turtle: 3, zephyr: 1, jessie: 1,
};

// Planning-only crowd curve (fraction of `peak` by hour). Sunday after Halloween, 21:00 close.
export const WAIT_CURVE = [
  [8, 0.35], [9, 0.55], [10, 0.75], [11, 0.9], [12, 0.97], [13, 1.0], [14, 1.0], [15, 0.95],
  [16, 0.9], [17, 0.85], [18, 0.8], [19, 0.72], [20, 0.6], [21, 0.45],
];
