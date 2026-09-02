/* 傾斜センサー入力 + 杭芯セットを原点にした偏芯 の一連の流れを検証する
   （現場の実データに合わせて φ406.4 / N-ECS 想定）*/
/* =========================================================
   傾斜センサー入力 → 杭芯セットを原点にした偏芯 → 判定
   までの一連の流れを、実際の操作経路で検証する。

   現場の実データに合わせた設定:
     N-ECS工法 / φ406.4 / 羽根厚55mm / 杭長5.0m / STK490
     杭芯セットで逃げ杭から実測して 0.0 に合わせる運用

   実行:  npm i playwright-core && node test/sensor-flow.test.js
   ========================================================= */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { console.log('スキップ: playwright-core が見つかりません'); process.exit(0); }
const fs = require('fs'), http = require('http'), path = require('path');
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
if (!fs.existsSync(EXEC)) { console.log('スキップ: Chromium が見つかりません'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0].replace(/^\/+/, ''));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(r);
});
srv.listen(0, '127.0.0.1', async () => {
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch({ executablePath: EXEC });
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + '/pile.html', { waitUntil: 'networkidle' });

  await p.fill('#p-no', 'No.12'); await p.fill('#p-dia', '406.4'); await p.fill('#p-head', '1.0');
  await p.click('#p-add');
  await p.click('.pile-item [data-act="sel"]');
  console.log('杭:', (await p.textContent('#m-pilemeta')).trim());
  console.log('ステップ:', await p.locator('#m-steps .step-btn').count(), '個');

  const step = async i => { await p.locator('#m-steps .step-btn').nth(i).click(); await p.waitForTimeout(120); };

  // --- ① 杭芯セット: 傾斜をセンサーで、残差を 0.0 で記録 ---
  await step(0);
  console.log('\n[杭芯セット]');
  await p.fill('#sn-x', '0.10'); await p.fill('#sn-y', '-0.05');
  await p.fill('#sn-name', 'WT901'); await p.click('#sn-save');
  await step(0);
  await p.fill('#e-a', '0'); await p.fill('#e-b', '0'); await p.click('#e-save');
  await p.waitForTimeout(120);
  console.log('  傾斜:', (await p.textContent('#sn-out')).replace(/\s+/g, ' ').trim());
  console.log('  残差:', (await p.textContent('#e-out')).replace(/\s+/g, ' ').trim().slice(0, 70));

  // --- ② 最終: 傾斜をセンサーで、偏芯を「杭芯セットからの移動量」で ---
  await step(5);
  console.log('\n[最終]');
  await p.fill('#sn-x', '0.45'); await p.fill('#sn-y', '0.30');
  await p.fill('#sn-name', 'WT901'); await p.click('#sn-save');
  await step(5);
  await p.selectOption('#e-basis', 'move');
  await p.fill('#e-a', '35'); await p.fill('#e-b', '-20'); await p.fill('#e-h', '0.5');
  await p.click('#e-save'); await p.waitForTimeout(150);
  const out = (await p.textContent('#e-out')).replace(/\s+/g, ' ').trim();
  console.log('  ' + out.slice(0, 340));

  const got = await p.evaluate(() => {
    const s = pileSummary(DB.selPile);
    return { mag: s.head.mag, allow: s.allow, absA: s.absEcc.eA, absB: s.absEcc.eB,
             tilt: s.byStep.final.tilt.ratio, mode: s.byStep.final.meas.A.mode };
  });
  // 手検算
  const t = d => Math.tan(d * Math.PI / 180);
  const dh = 1500, wantA = 35 - t(0.45) * dh, wantB = -20 - t(0.30) * dh;
  const wantMag = Math.hypot(wantA, wantB);
  console.log('\n手検算: 杭頭 ' + wantA.toFixed(1) + ' / ' + wantB.toFixed(1) + ' → 合成 ' + wantMag.toFixed(1) + 'mm');
  console.log('アプリ: 合成 ' + got.mag.toFixed(1) + 'mm  許容 ' + got.allow + 'mm  傾斜 1/' + got.tilt.toFixed(0));

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
  console.log('');
  ck('センサー入力が記録される', got.mode === 'sensor');
  ck('許容が min(D/4,100)=100mm', Math.abs(got.allow - 100) < 0.01);
  ck('杭芯セット残差が原点として足される', Math.abs(got.absA - 35) < 0.01 && Math.abs(got.absB - (-20)) < 0.01);
  ck('外挿が手検算と一致 (<0.5mm)', Math.abs(got.mag - wantMag) < 0.5);
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  // CSV に出るか
  await p.click('nav.tabs button[data-tab="records"]');
  console.log('\n記録:', (await p.textContent('#r-body')).replace(/\s+/g, ' ').trim().slice(0, 160));

  await b.close(); srv.close();
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
