/* =========================================================
   動画解析モードの端から端までの検証

   合成した「杭」の映像をブラウザ内で canvas → MediaRecorder で作り
   （VP8圧縮を通すので、実際のネットワークカメラ映像に近い劣化が入る）、
   ファイル選択 → 鉛直基準 → エッジ指定 → 解析 → 保存 という
   実際の操作経路をそのまま辿って、既知の傾斜が復元できるかを見る。

   実行:  npm i playwright-core && node test/video-e2e.test.js
   Chromium が無い環境では自動でスキップする。
   ========================================================= */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) {
  console.log('スキップ: playwright-core が見つかりません（npm i playwright-core）');
  process.exit(0);
}
const fs = require('fs'), path = require('path'), http = require('http');

const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
if (!fs.existsSync(EXEC)) {
  console.log('スキップ: Chromium が見つかりません（CHROMIUM_PATH で指定できます）');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
function serve() {
  return new Promise(res => {
    const s = http.createServer((req, rep) => {
      const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rep.writeHead(404); rep.end(); return; }
      rep.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rep);
    });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

const TRUE_DEG = 0.42;   // 真の傾斜（画像の鉛直から）
const WOBBLE   = 0.30;   // 首振り振幅
const CAM_DRIFT_PX = 25; // 三脚のドリフト（軟弱地盤を想定）
const PILE_MOVE_PX = 16; // 杭そのものの横移動

(async () => {
  const server = await serve();
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ executablePath: EXEC,
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errs.push('console: ' + m.text()); });

  await p.goto(BASE + '/pile.html', { waitUntil: 'networkidle' });

  // 杭を1本用意して計測タブへ
  // 杭径 340mm、映像内の見かけ 68px → 5.00 mm/px になるようにしておく
  await p.fill('#p-no', 'V-1'); await p.fill('#p-dia', '340'); await p.fill('#p-head', '1.2');
  await p.click('#p-add');
  await p.click('.pile-item [data-act="sel"]');

  // --- 合成動画を生成して #vf-input に流し込む ---
  const gen = await p.evaluate(async ({ TRUE_DEG, WOBBLE, CAM_DRIFT_PX, PILE_MOVE_PX }) => {
    const W = 640, H = 480, FPS = 30, SEC = 3;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const stream = cv.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => rec.onstop = r);

    const hw = 34, xc = W / 2, refX0 = 120, refHw = 11;
    let frame = 0;
    const total = FPS * SEC;
    const draw = () => {
      const prog = frame / total;
      const cam = CAM_DRIFT_PX * prog;                            // 三脚が少しずつ動く
      // 杭は途中で横に動く（0 → PILE_MOVE_PX）
      const mv = PILE_MOVE_PX * Math.min(1, Math.max(0, (prog - 0.3) / 0.4));
      const wob = WOBBLE * Math.sin(2 * Math.PI * frame / 25);
      const slope = -Math.tan((TRUE_DEG + wob) * Math.PI / 180);
      g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#b0b0b0';
      for (let i = 0; i < 6; i++) g.fillRect(i * 110 + 20 + cam, 0, 26, H);
      // 動かない基準（逃げ棒）— カメラのドリフトだけを受ける
      g.fillStyle = '#2a2a2a';
      g.fillRect(refX0 + cam - refHw, 0, refHw * 2, H);
      // 杭 — カメラのドリフト＋実際の移動
      const ym = H / 2, c0 = xc + cam + mv;
      g.beginPath();
      g.moveTo(c0 + slope * (0 - ym) - hw, 0);
      g.lineTo(c0 + slope * (H - ym) - hw, H);
      g.lineTo(c0 + slope * (H - ym) + hw, H);
      g.lineTo(c0 + slope * (0 - ym) + hw, 0);
      g.closePath();
      g.fillStyle = '#3a3a3a'; g.fill();
      frame++;
    };
    rec.start();
    await new Promise(res => {
      const tick = () => { draw(); if (frame >= total) { rec.stop(); res(); } else setTimeout(tick, 1000 / FPS); };
      tick();
    });
    await done;

    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return { b64: btoa(bin), bytes: blob.size, frames: total };
  }, { TRUE_DEG, WOBBLE, CAM_DRIFT_PX, PILE_MOVE_PX });
  console.log('合成動画: ' + gen.frames + 'フレーム / ' + (gen.bytes / 1024).toFixed(0) + ' KB (VP8圧縮)');

  // 実際の操作と同じく「動画」ボタン → ファイル選択 の経路を通す
  p.on('filechooser', fc => fc.setFiles({
    name: 'synthetic.webm', mimeType: 'video/webm', buffer: Buffer.from(gen.b64, 'base64'),
  }));
  await p.locator('.viewslot [data-act="vid"]').first().click();

  await p.waitForSelector('#vfile.on', { timeout: 10000 });
  await p.waitForFunction(() => typeof VF !== 'undefined' && VF.seed, null, { timeout: 10000 });
  console.log('先頭フレーム取得:', await p.evaluate(() => VF.seed.width + 'x' + VF.seed.height));

  // --- ① 動かない基準（逃げ棒に相当）を2点で指定する ---
  const tap = async q => {
    const d = await p.evaluate(pt => { const r = toDisp(pt); return { x: r.x, y: r.y }; }, q);
    const st = await p.locator('#mark-stage').boundingBox();
    await p.mouse.move(st.x + d.x, st.y + d.y);
    await p.mouse.down(); await p.mouse.move(st.x + d.x, st.y + d.y); await p.mouse.up();
  };
  await p.click('#vf-vert');
  await p.waitForSelector('#mark.on');
  await tap({ x: 120 - 11, y: 480 * 0.2 });
  await tap({ x: 120 - 11, y: 480 * 0.8 });
  await p.click('#mark-ok');
  console.log('鉛直基準:', (await p.textContent('#vf-msg')).replace(/\s+/g, ' ').trim());

  // --- ② 杭のエッジを実際にタップして指定する ---
  await p.click('#vf-edges');
  await p.waitForSelector('#mark.on');
  const W = 640, H = 480, hw = 34, xc = W / 2;
  const pts = [                                   // 左上, 左下, 右上, 右下（真の縁から少しずらす）
    { x: xc - hw + 6, y: H * 0.2 }, { x: xc - hw + 6, y: H * 0.8 },
    { x: xc + hw - 6, y: H * 0.2 }, { x: xc + hw - 6, y: H * 0.8 },
  ];
  const stage = await p.locator('#mark-stage').boundingBox();
  for (const q of pts) {
    const d = await p.evaluate(pt => { const r = toDisp(pt); return { x: r.x, y: r.y }; }, q);
    await p.mouse.move(stage.x + d.x, stage.y + d.y);
    await p.mouse.down(); await p.mouse.move(stage.x + d.x, stage.y + d.y); await p.mouse.up();
  }
  console.log('エッジ指定後の表示:', (await p.textContent('#mark-msg')).replace(/\s+/g, ' ').trim());
  await p.click('#mark-ok');
  console.log('ガイド位置:', await p.evaluate(() => 'L=' + Guides.L.toFixed(1) + ' R=' + Guides.R.toFixed(1)));
  console.log('状態:', (await p.textContent('#vf-msg')).replace(/\s+/g, ' ').trim());

  // 設計芯は指定しない → 基準からの移動量で監視するモードになる
  const MMPX = 340 / (2 * hw);
  const EXPECT_MOVE_MM = PILE_MOVE_PX * MMPX;   // 杭の実際の移動
  const DRIFT_MM = CAM_DRIFT_PX * MMPX;         // 三脚のドリフト（打ち消されるべき量）
  console.log('\n杭の移動 ' + EXPECT_MOVE_MM.toFixed(0) + 'mm / 三脚のドリフト ' +
              DRIFT_MM.toFixed(0) + 'mm 相当を仕込んである');

  // --- ③ 解析。等速と早送りの両方を通し、フレーム落ちが結果を歪めないか見る ---
  const analyse = async rate => {
    await p.evaluate(r => { VF.rate = r; document.querySelector('#vf-rate').textContent = r + '倍'; }, rate);
    await p.click('#vf-run');
    await p.waitForSelector('#vf-result', { state: 'visible', timeout: 120000 });
    const out = await p.evaluate(() => ({
      angle: VF.result.angle, sd: VF.result.sd, sem: VF.result.sem,
      n: VF.result.n, rej: VF.result.rejected, edgeDiff: VF.result.edgeDiff,
      widthPx: VF.result.widthPx, mmPerPx: VF.result.mmPerPx,
      eccMm: VF.result.eccMm, mon: VF.result.mon || null, camRoll: VF.result.camRoll,
    }));
    console.log('\n' + rate + '倍速で解析:');
    console.log('  採用 ' + out.n + ' フレーム / 追跡失敗 ' + out.rej);
    console.log('  平均 ' + out.angle.toFixed(4) + '°  (真値 ' + TRUE_DEG + '°、誤差 ' + (out.angle - TRUE_DEG).toFixed(4) + '°)');
    console.log('  1σ ' + out.sd.toFixed(3) + '°（首振り振幅 ±' + WOBBLE + '° を反映）');
    console.log('  平均の標準誤差 ±' + out.sem.toFixed(4) + '°');
    console.log('  左右エッジ差 ' + out.edgeDiff.toFixed(4) + '°');
    if (out.mon)
      console.log('  偏芯（基準からの移動）' + out.mon.end.toFixed(1) + 'mm （真値 ' +
                  EXPECT_MOVE_MM.toFixed(1) + 'mm、振れ幅 ' + out.mon.range.toFixed(1) +
                  'mm、見かけの幅 ' + out.widthPx.toFixed(1) + 'px = ' + out.mmPerPx.toFixed(3) + ' mm/px）');
    return out;
  };
  const r = await analyse(1);
  await p.click('#vf-retry');
  const r4 = await analyse(4);
  await p.click('#vf-retry');
  await analyse(1);   // 保存用にもう一度（等速の結果を確定させる）

  // --- 保存して記録に反映されるか ---
  await p.click('#vf-save');
  await p.waitForTimeout(300);
  console.log('\n保存後の視点A:', (await p.textContent('.viewslot')).replace(/\s+/g, ' ').trim());

  let fail = 0;
  const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fail++; };
  console.log('');
  check('真値との誤差 < 0.05°', Math.abs(r.angle - TRUE_DEG) < 0.05);
  check('等速なら十分なフレーム数を拾う (>70)', r.n > 70);
  check('早送りでもフレーム落ちが結果を歪めない (<0.05°)', Math.abs(r4.angle - r.angle) < 0.05);
  // 統計的に整合しているか（平均が真値から標準誤差の3倍以内 = 系統的な偏りが無い）
  check('平均が真値と統計的に整合 (|誤差| < 3×標準誤差)', Math.abs(r.angle - TRUE_DEG) < 3 * r.sem);
  check('首振りがばらつきとして現れる (1σ > 0.1°)', r.sd > 0.1);
  check('左右エッジが平行 (<0.1°)', r.edgeDiff < 0.1);
  check('基準からの相対で偏芯が測れている', r.mon !== null);
  check('杭の移動を復元 (' + EXPECT_MOVE_MM.toFixed(0) + 'mm ±8mm)',
        r.mon && Math.abs(r.mon.end - EXPECT_MOVE_MM) < 8);
  check('三脚のドリフト ' + DRIFT_MM.toFixed(0) + 'mm が打ち消されている',
        r.mon && Math.abs(r.mon.end - EXPECT_MOVE_MM) < DRIFT_MM * 0.15);
  check('スケールが杭径から正しく出る (±2%)',
        r.mmPerPx !== undefined && Math.abs(r.mmPerPx - MMPX) / MMPX < 0.02);
  check('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  await b.close();
  server.close();
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
})();
