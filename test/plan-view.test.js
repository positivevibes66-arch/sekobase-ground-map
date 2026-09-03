/* =========================================================
   配置図（出来形図）の検証

   数値の一覧だけでは「どこがどれだけずれたか」が伝わらない。
   基礎伏図と同じ配置で設計位置から実測位置へ矢印を引き、判定で色を分ける。
   ここでは、色分け・誇張倍率・座標の向き・文字の重なり回避が
   意図どおりに出ているかをSVGの中身で確かめる。

   実行:  npm i playwright-core && node test/plan-view.test.js
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
  const b = await chromium.launch({ executablePath: EXEC });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:' + srv.address().port + '/pile.html', { waitUntil: 'networkidle' });

  const r = await p.evaluate(() => {
    DB.settings.rod1 = 'X通り'; DB.settings.rod2 = 'Y通り'; DB.settings.tiltN = 200;
    // 4本: 合格 / 要協議 / 未計測 / 座標なし
    addPile('P1', 406.4, 1.0, false, { x: 0, y: 0, len: 5, thick: 12.7 });
    addPile('P2', 406.4, 1.0, false, { x: 6000, y: 0, len: 5, thick: 12.7 });
    addPile('P3', 406.4, 1.0, false, { x: 0, y: 6000, len: 5, thick: 12.7 });
    addPile('P4', 406.4, 1.0, false, { len: 5, thick: 12.7 });          // 座標なし
    const sensor = (m, x, y) => {
      const mk = v => ({ mode: 'sensor', angle: v, tan: Math.tan(v * Math.PI / 180),
        edgeDiff: 0, offset: 0, perspErr: 0, pitch: 0, roll: 0, stab: null,
        n: 1, sd: null, sem: null, sensor: 'test', at: Date.now(), pts: [] });
      m.A = mk(x); m.B = mk(y);
    };
    // P1: X通りへ +40mm（傾斜ゼロなので杭頭も +40）　P2: +200mm で許容超過
    [['P1', 1540, 1200], ['P2', 1700, 1200]].forEach(([no, f1, f2]) => {
      const pl = DB.piles.find(q => q.no === no);
      const so = ensureMeas(pl.id, 'setout');
      sensor(so, 0, 0); so.ecc = { mode: 'rods', r1: 1500, r2: 1200, measH: 0, at: Date.now() };
      commitMeas(so);
      const fi = ensureMeas(pl.id, 'final');
      sensor(fi, 0, 0); fi.ecc = { mode: 'rods', r1: f1, r2: f2, measH: 0, at: Date.now() };
      commitMeas(fi);
    });
    document.querySelector('#pl-mag').value = '20';
    document.querySelector('#pl-title').value = 'テスト現場';
    renderPlan();
    const svg = buildPlanSVG();
    const D = planData();
    return { svg, n: D.length,
             mags: D.map(d => d.ecc ? +d.ecc.mag.toFixed(1) : null),
             ngs: D.map(d => d.ng),
             sum: document.querySelector('#pl-sum').textContent.replace(/\s+/g, ' ').trim() };
  });
  await b.close(); srv.close();

  const svg = r.svg;
  const green = (svg.match(/#1a7f37/g) || []).length;
  const red = (svg.match(/#b42318/g) || []).length;
  const grey = (svg.match(/#9aa0a6/g) || []).length;
  console.log('配置図: ' + (svg.length / 1024).toFixed(1) + 'KB　杭 ' + r.n + '本（座標なしは除外）');
  console.log('偏芯:', r.mags, ' 判定:', r.ngs);
  console.log('色の出現数: 緑' + green + ' 赤' + red + ' 灰' + grey);
  console.log('集計:', r.sum);

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
  console.log('');
  ck('座標のない杭は図に出さない', r.n === 3);
  ck('偏芯が正しく出る (40mm / 200mm)',
     Math.abs(r.mags[0] - 40) < 0.5 && Math.abs(r.mags[1] - 200) < 0.5);
  ck('許容内は合格、超過は要協議', r.ngs[0] === false && r.ngs[1] === true && r.ngs[2] === null);
  ck('合格は緑、要協議は赤、未計測は灰で描く', green > 0 && red > 0 && grey > 0);
  ck('表題が入る', svg.indexOf('テスト現場') > 0);
  ck('誇張倍率を明記している', /20<\/tspan>倍|20倍/.test(svg));
  ck('許容値を明記している', svg.indexOf('偏芯の許容 100mm') > 0);
  ck('管理値を明記している', svg.indexOf('1/200') > 0);
  ck('スケールバーがある', svg.indexOf('>5m<') > 0);
  ck('文字に白フチが付く（線と重なっても読める）', svg.indexOf('paint-order="stroke"') > 0);
  ck('矢印の定義がある', svg.indexOf('marker-end="url(#ah)"') > 0);
  ck('SVGとして妥当な形', /^<svg[^>]*viewBox="0 0 \d+ \d+"/.test(svg) && svg.endsWith('</svg>'));
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
