/* =========================================================
   DXF（杭伏図）取り込みの検証

   設計モデルの IFC が無く CAD 図面しか無い前提なので、
   杭伏図から 杭番号・設計座標・杭径 を拾えるかを確かめる。
   実際の図面を模した合成DXF（杭の円＋杭番号の文字に加えて、
   通り芯・寸法・設備といった紛らわしいレイヤを混ぜたもの）を作り、
   取り込み → 杭リスト → IFC書き出し まで通す。

   実行:  npm i playwright-core && node test/dxf-import.test.js
   ========================================================= */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { console.log('スキップ: playwright-core が見つかりません'); process.exit(0); }
const fs = require('fs'), http = require('http'), path = require('path');
const EXEC = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
if (!fs.existsSync(EXEC)) { console.log('スキップ: Chromium が見つかりません'); process.exit(0); }
const ROOT = path.join(__dirname, '..');

/* --- 杭伏図を模した DXF を組み立てる --- */
function makeDXF() {
  const o = [];
  const g = (c, v) => { o.push(String(c)); o.push(String(v)); };
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$INSUNITS'); g(70, 4); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');

  const NX = 4, NY = 3, PITCH = 3600, R = 203.2;
  const piles = [];
  let n = 0;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    n++;
    const x = i * PITCH, y = j * PITCH;
    piles.push({ no: 'No.' + n, x, y });
    g(0, 'CIRCLE'); g(8, '杭'); g(10, x); g(20, y); g(30, 0); g(40, R);
    // 杭番号は円の少し上。1本だけ MTEXT（書式指定つき）にして解釈を試す
    if (n === 5) {
      g(0, 'MTEXT'); g(8, '杭符号'); g(10, x); g(20, y + 700); g(40, 250);
      g(1, '{\\fMS Gothic|b0|i0;No.5}');
    } else {
      g(0, 'TEXT'); g(8, '杭符号'); g(10, x - 200); g(20, y + 600); g(40, 250); g(1, 'No.' + n);
      g(11, x); g(21, y + 700);      // 中央寄せの位置
    }
  }
  // 紛らわしいもの: 通り芯の線、寸法の文字、設備の円
  for (let i = 0; i < NX; i++) {
    g(0, 'LINE'); g(8, '通り芯'); g(10, i * PITCH); g(20, -2000); g(11, i * PITCH); g(21, 9000);
    g(0, 'TEXT'); g(8, '寸法'); g(10, i * PITCH + 1800); g(20, -1200); g(40, 200); g(1, '3600');
  }
  g(0, 'CIRCLE'); g(8, '設備'); g(10, 1800); g(20, 1800); g(40, 75);
  g(0, 'CIRCLE'); g(8, '設備'); g(10, 5400); g(20, 1800); g(40, 75);
  g(0, 'ENDSEC'); g(0, 'EOF');
  return { dxf: o.join('\r\n'), piles, R };
}

const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0].replace(/^\/+/, ''));
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(r);
});

srv.listen(0, '127.0.0.1', async () => {
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { dxf, piles, R } = makeDXF();
  const b = await chromium.launch({ executablePath: EXEC });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/pile.html', { waitUntil: 'networkidle' });

  await p.setInputFiles('#dxf-input', { name: 'kui.dxf', mimeType: 'text/plain', buffer: Buffer.from(dxf, 'utf8') });
  await p.waitForSelector('#dxf-body', { state: 'visible', timeout: 10000 });
  await p.waitForTimeout(200);

  const info = (await p.textContent('#dxf-info')).replace(/\s+/g, ' ').trim();
  const layers = await p.evaluate(() => ({
    circle: DXF.layers.circle, text: DXF.layers.text,
    lp: document.querySelector('#dxf-lp').value, lt: document.querySelector('#dxf-lt').value,
  }));
  console.log('読み込み:', info);
  console.log('円のレイヤ:', layers.circle.map(x => x[0] + '×' + x[1]).join(' / '));
  console.log('文字のレイヤ:', layers.text.map(x => x[0] + '×' + x[1]).join(' / '));
  console.log('既定で選ばれたレイヤ: 円=' + layers.lp + ' 文字=' + layers.lt);
  console.log('照合:', (await p.textContent('#dxf-stat')).replace(/\s+/g, ' ').trim());

  const matched = await p.evaluate(() => DXF.matched.map(m => ({ no: m.no, x: m.x, y: m.y, dia: m.dia })));
  await p.click('#dxf-go');
  await p.waitForTimeout(200);
  const got = await p.evaluate(() => DB.piles.map(x => ({ no: x.no, x: x.x, y: x.y, dia: x.dia })));
  console.log('取り込み後の杭リスト:', got.length + '本  例) ' +
    got.slice(0, 3).map(x => x.no + '(' + x.x + ',' + x.y + ') φ' + x.dia.toFixed(1)).join(' '));

  // 通しで IFC まで出す
  const ifcInfo = await p.evaluate(() => {
    const t = buildIFC();
    return { len: t.length, piles: (t.match(/IFCPILE\(/g) || []).length,
             hasCoord: t.indexOf('10800.') >= 0 || t.indexOf('10800.0') >= 0 };
  });
  console.log('IFC:', ifcInfo.piles + '本  ' + (ifcInfo.len / 1024).toFixed(1) + 'KB');

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
  console.log('');
  ck('杭のレイヤが件数順の先頭になる', layers.lp === '杭');
  ck('杭番号のレイヤが選ばれる', layers.lt === '杭符号');
  ck('紛らわしいレイヤも分けて認識する',
     layers.circle.some(x => x[0] === '設備') && layers.text.some(x => x[0] === '寸法'));
  ck('12本すべてに番号が付く', matched.filter(m => m.no).length === 12);
  ck('円の直径から杭径が出る (φ406.4)', matched.every(m => Math.abs(m.dia - R * 2) < 0.01));
  ck('MTEXTの書式指定を落として読める', matched.some(m => m.no === 'No.5'));
  ck('設計座標が図面のまま入る',
     piles.every(q => got.some(x => x.no === q.no && x.x === q.x && x.y === q.y)));
  ck('寸法の文字を杭番号に拾わない', !got.some(x => x.no === '3600'));
  ck('設備の円を杭に拾わない', got.length === 12);
  ck('そのままIFCに出せる', ifcInfo.piles === 12);
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  await b.close(); srv.close();
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
