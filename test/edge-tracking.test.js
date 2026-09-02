/* =========================================================
   pile.html の連続計測（エッジ追跡）の検証

   既知の傾きを持つ「杭」の合成画像（ぼけ・ノイズ入り）を作り、
   サブピクセルのエッジ検出と直線フィットが元の傾きを
   復元できるかを確認する。

   実行:  node test/edge-tracking.test.js
   ========================================================= */
const fs = require('fs'), path = require('path'), vm = require('vm');

function loadTracker() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pile.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');
  const cut = (a, b) => js.slice(js.indexOf(a), js.indexOf(b));
  const src =
    'const DB={settings:{tiltN:100,eccMax:100,pitchTol:1,hfov:65}};\n' +
    cut('const D2R', '/* ---------------- ステップ定義') +
    cut('/* 画像内の線分', '/* 4点（左エッジ2点') +
    cut('const SCAN_TOP', '/* ---------------- 実行 ----------------') +
    '\nmodule.exports={findEdge,fitLineX,trackFrame,calibratePolarity,angleFromTrueVertical,' +
    'verticalSlope,Guides,Cont,SCAN_TOP,SCAN_BOT};';
  const ctx = { module: { exports: {} }, document: { createElement: () => ({ getContext: () => null }) },
                $: () => null, $$: () => [], window: {}, performance: { now: () => 0 } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.module.exports;
}
const T = loadTracker();
const R2D = 180 / Math.PI;
let fails = 0;
const ok = (name, got, want, tol) => {
  const bad = !(Math.abs(got - want) <= tol);
  if (bad) fails++;
  console.log((bad ? 'FAIL ' : 'ok   ') + name + '  got=' + got.toFixed(4) + ' want=' + want.toFixed(4) + ' (±' + tol + ')');
};

/* ---- 合成画像 ---- */
const W = 1440, H = 1080;
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makePile({ xc, slope, hw, inside, outside, noise, blur }) {
  const px = new Float32Array(W * H);
  const ym = H / 2;
  const S = t => 1 / (1 + Math.exp(-t / blur));
  for (let y = 0; y < H; y++) {
    const c = xc + slope * (y - ym);
    for (let x = 0; x < W; x++) {
      const a = S(x - (c - hw)) * (1 - S(x - (c + hw)));
      px[y * W + x] = outside + (inside - outside) * a + (rnd() - 0.5) * 2 * noise;
    }
  }
  return px;
}
function makeCtx(px) {
  return {
    canvas: { width: W, height: H },
    getImageData(x, y, w, h) {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const v = px[(y + j) * W + (x + i)], o = (j * w + i) * 4;
        d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
      }
      return { data: d };
    },
  };
}
/* 理論値: 理想直線を同じ式に通した角度 */
function expected(slope, grav) {
  const ym = H / 2, yA = H * T.SCAN_TOP, yB = H * T.SCAN_BOT;
  return T.angleFromTrueVertical({ x: slope * (yA - ym), y: yA }, { x: slope * (yB - ym), y: yB }, grav);
}
function run(opts, grav, guideErr) {
  const px = makePile(opts);
  const ctx = makeCtx(px);
  T.Guides.L = opts.xc - opts.hw + (guideErr || 0);
  T.Guides.R = opts.xc + opts.hw - (guideErr || 0);
  T.calibratePolarity(ctx);
  return T.trackFrame(ctx, grav, null);
}

const upright = { gx: 0, gy: -1, gz: 0 };
const base = { xc: 720, hw: 70, inside: 62, outside: 205, noise: 3, blur: 0.9 };

console.log('--- 1. 暗い杭 / 明るい背景（鋼管を空バックで撮った状況）---');
[-0.4, 0, 0.25, 0.9].forEach(deg => {
  const slope = -Math.tan(deg / R2D);
  const f = run({ ...base, slope }, upright, 0);
  if (!f) { fails++; console.log('FAIL ' + deg + '° 追跡失敗'); return; }
  ok(deg + '° の復元', f.angle, expected(slope, upright), 0.01);
});

console.log('\n--- 2. 明るい杭 / 暗い背景（極性の自動判定）---');
{
  const slope = -Math.tan(0.5 / R2D);
  const f = run({ ...base, slope, inside: 210, outside: 55 }, upright, 0);
  if (!f) { fails++; console.log('FAIL 追跡失敗'); }
  else ok('0.5° の復元', f.angle, expected(slope, upright), 0.01);
}

/* 重力が傾いているときは、杭も画像内で同じだけ傾いて写る。
   目標の傾斜角になる画像内の傾きを二分法で逆算して合成する。 */
function slopeFor(targetDeg, grav) {
  let lo = -0.6, hi = 0.6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (expected(mid, grav) > targetDeg) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

console.log('\n--- 3. カメラを傾け持ちした場合（重力基準で補正されるか）---');
[10, -22].forEach(rollDeg => {
  const p = rollDeg / R2D;
  const grav = { gx: -Math.sin(p), gy: -Math.cos(p), gz: 0 };
  const slope = slopeFor(0.3, grav);
  const f = run({ ...base, slope }, grav, 0);
  if (!f) { fails++; console.log('FAIL ロール' + rollDeg + '° 追跡失敗'); return; }
  ok('ロール' + rollDeg + '°', f.angle, 0.3, 0.01);
});

console.log('\n--- 3b. 許容を大きく超えた杭でも追跡できるか（最悪の失敗を防ぐ）---');
[1.5, 3, 5, 8].forEach(deg => {
  const slope = -Math.tan(deg / R2D);
  const f = run({ ...base, slope }, upright, 0);
  if (!f) { fails++; console.log('FAIL ' + deg + '°（1/' + (1 / Math.tan(deg / R2D)).toFixed(0) + '）追跡失敗 — 許容超過を検出できない'); return; }
  ok(deg + '° (1/' + (1 / Math.tan(deg / R2D)).toFixed(0) + ')', f.angle, expected(slope, upright), 0.02);
});

console.log('\n--- 4. ガイド線が縁からずれている場合 ---');
[10, 25, 40].forEach(err => {
  const slope = -Math.tan(0.35 / R2D);
  const f = run({ ...base, slope }, upright, err);
  if (!f) { fails++; console.log('FAIL ずれ' + err + 'px 追跡失敗'); return; }
  ok('ガイドが ' + err + 'px 内側', f.angle, expected(slope, upright), 0.015);
});

console.log('\n--- 5. ノイズ耐性（単発の誤差がランダムか偏りかを切り分ける）---');
[3, 10, 20, 35].forEach(noise => {
  const slope = -Math.tan(0.45 / R2D);
  const want = expected(slope, upright);
  const a = [];
  for (let i = 0; i < 40; i++) { const f = run({ ...base, slope, noise }, upright, 0); if (f) a.push(f.angle); }
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / (a.length - 1));
  console.log('     ノイズ ±' + noise + '階調 → 採用 ' + a.length + '/40、単発1σ=' + sd.toFixed(3) +
              '°、40枚平均の偏り=' + (mean - want).toFixed(4) + '°');
  // 偏りが無い = 連続計測で平均すれば消える、が成立するか
  ok('  ノイズ ±' + noise + ' の系統誤差', mean, want, 0.01);
});

console.log('\n--- 6. コントラスト不足は「誤答」ではなく「棄却」されるか ---');
[60, 25, 8, 3].forEach(contrast => {
  const f = run({ ...base, slope: 0, inside: 205 - contrast, noise: 12 }, upright, 0);
  const angErr = f ? Math.abs(f.angle - expected(0, upright)) : null;
  const verdict = f ? (angErr < 0.05 ? '採用（正しい）' : '★採用したが誤差 ' + angErr.toFixed(3) + '°') : '棄却';
  if (f && angErr >= 0.05) fails++;
  console.log('     コントラスト ' + contrast + '階調 → ' + verdict);
});

/* 実映像で追跡が全滅した条件の再現。
   杭には製品表示の白文字が縁のすぐ内側にあり、円筒の陰影が輪郭と平行に
   もう1本の線を作る。走査線ごとに独立して最も強い勾配を選ぶ方式では
   これらを掴んで直線に乗らなかった。 */
function makeConfusingPile({ slope, hw, textRows, shadeOffset }) {
  const px = new Float32Array(W * H);
  const ym = H / 2;
  const S = t => 1 / (1 + Math.exp(-t / 0.9));
  for (let y = 0; y < H; y++) {
    const c = 720 + slope * (y - ym);
    for (let x = 0; x < W; x++) {
      const a = S(x - (c - hw)) * (1 - S(x - (c + hw)));
      let v = 205 + (62 - 205) * a;
      // 円筒の陰影: 右の縁より内側に、輪郭と平行な段差をもう1本作る
      if (x > c + hw - shadeOffset && x < c + hw) v -= 45;
      px[y * W + x] = v + (rnd() - 0.5) * 6;
    }
  }
  // 製品表示の白文字（左の縁のすぐ内側に、飛び飛びの行で入る）
  for (const ty of textRows) {
    for (let y = ty; y < ty + 26; y++) {
      if (y < 0 || y >= H) continue;
      const c = 720 + slope * (y - ym);
      for (let x = Math.round(c - hw + 8); x < Math.round(c - hw + 30); x++) px[y * W + x] = 245;
    }
  }
  return px;
}

console.log('\n--- 7b. 縁のすぐ内側に白文字と陰影の線がある場合（実映像で全滅した条件）---');
[0.35, -0.5].forEach(deg => {
  const slope = -Math.tan(deg / R2D);
  const px = makeConfusingPile({ slope, hw: 70, shadeOffset: 20,
    textRows: [200, 340, 480, 620, 760, 900] });
  const ctx = makeCtx(px);
  T.Guides.L = 720 - 70; T.Guides.R = 720 + 70;
  T.calibratePolarity(ctx);
  const f = T.trackFrame(ctx, upright, null);
  if (!f) { fails++; console.log('FAIL ' + deg + '° 追跡失敗'); return; }
  ok(deg + '° を紛らわしい線に惑わされず復元', f.angle, expected(slope, upright), 0.03);
});

console.log('\n--- 7c. 走査範囲が指定した範囲に従うか（杭が画面の一部にしか無い場合）---');
{
  // 杭は上半分にしか無く、下半分は地面のテクスチャ
  const slope = -Math.tan(0.4 / R2D), hw = 70, ym = H / 2;
  const px = new Float32Array(W * H);
  const S = t => 1 / (1 + Math.exp(-t / 0.9));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (y < H * 0.55) {
      const c = 720 + slope * (y - ym);
      const a = S(x - (c - hw)) * (1 - S(x - (c + hw)));
      px[y * W + x] = 205 + (62 - 205) * a + (rnd() - 0.5) * 6;
    } else {
      px[y * W + x] = 150 + 55 * Math.sin(x / 7) * Math.cos(y / 11) + (rnd() - 0.5) * 30;
    }
  }
  const ctx = makeCtx(px);
  T.Guides.L = 720 - hw; T.Guides.R = 720 + hw;
  T.calibratePolarity(ctx);

  T.Guides.yTop = 0.15; T.Guides.yBot = 0.85;      // 画面比で固定（従来）
  const bad = T.trackFrame(ctx, upright, null);
  console.log('     範囲を画面比で固定 (15〜85%) → ' + (bad ? '誤って採用: ' + bad.angle.toFixed(3) + '°' : '追跡失敗'));
  if (bad && Math.abs(bad.angle - expected(slope, upright)) > 0.05) fails++;

  T.Guides.yTop = 0.05; T.Guides.yBot = 0.50;      // 杭が写っている範囲だけ
  const good = T.trackFrame(ctx, upright, null);
  if (!good) { fails++; console.log('FAIL 指定範囲でも追跡失敗'); }
  else {
    const yA = H * 0.05, yB = H * 0.50;
    const want = T.angleFromTrueVertical({ x: slope * (yA - ym), y: yA }, { x: slope * (yB - ym), y: yB }, upright);
    ok('杭が写っている範囲 (5〜50%) を走査', good.angle, want, 0.02);
  }
  T.Guides.yTop = T.SCAN_TOP; T.Guides.yBot = T.SCAN_BOT;
}

console.log('\n--- 7. 連続フレームの平均で精度が上がるか（首振りのシミュレーション）---');
{
  const trueDeg = 0.30, ampDeg = 0.25;      // 真の傾斜 0.30°、首振り振幅 ±0.25°
  const samples = [];
  for (let i = 0; i < 60; i++) {
    const wob = ampDeg * Math.sin(2 * Math.PI * i / 20);   // 20フレームで1回転
    const slope = -Math.tan((trueDeg + wob) / R2D);
    const f = run({ ...base, slope, xc: 720 + 3 * Math.sin(i / 3) }, upright, 0);
    if (f) samples.push(f.angle);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1));
  console.log('     採用 ' + samples.length + '/60 フレーム、1σ=' + sd.toFixed(3) + '°');
  console.log('     静止画1枚なら最悪 ' + (trueDeg + ampDeg).toFixed(2) + '° を掴む（誤差 ' + ampDeg.toFixed(2) + '°）');
  ok('60フレーム平均', mean, trueDeg, 0.02);
}

console.log(fails ? '\n===== ' + fails + ' 件 失敗 =====' : '\n===== 全て合格 =====');
process.exit(fails ? 1 : 0);
