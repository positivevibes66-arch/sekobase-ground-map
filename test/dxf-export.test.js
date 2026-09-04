/* =========================================================
   DXF 書き出し（施工記録を杭伏図に重ねる）の検証

   取り込んだ杭伏図と同じ座標系のまま出すので、CAD で開けば
   元の図にそのまま重なる。同じ台帳から IFC も出るので、
   図面とモデルが同じ数値を指す。
   CAD は拡大できるので既定は実寸。誇張は SVG（印刷用）の側でやる。

   書き出した DXF を ezdxf で読み直して確かめる。
   実行:  npm i playwright-core && pip install ezdxf
          node test/dxf-export.test.js
   ========================================================= */
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch (e) { console.log('スキップ: playwright-core が見つかりません'); process.exit(0); }
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
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

  /* 4本: 推定で合格 / 推定で要協議 / 根切り後の実測あり / 未計測 */
  const out = await p.evaluate(() => {
    DB.settings.rod1 = 'X通り'; DB.settings.rod2 = 'Y通り'; DB.settings.tiltN = 200;
    const mk = (no, x, y) => addPile(no, 406.4, 2.3, false,
      { x, y, len: 5, thick: 12.7, steel: 'STK490', method: 'N-ECS' });
    mk('No.1', 0, 0); mk('No.2', 3600, 0); mk('No.3', 7200, 0); mk('No.4', 10800, 0);
    const sensor = (m, x, y) => {
      const f = v => ({ mode: 'sensor', angle: v, tan: Math.tan(v * Math.PI / 180),
        edgeDiff: 0, offset: 0, perspErr: 0, pitch: 0, roll: 0, stab: null,
        n: 1, sd: null, sem: null, sensor: 'test', at: Date.now(), pts: [] });
      m.A = f(x); m.B = f(y);
    };
    // 傾斜ゼロにして、偏芯がそのまま杭頭に出るようにする
    [['No.1', 1540, 1200], ['No.2', 1700, 1200], ['No.3', 1520, 1200]].forEach(([no, r1, r2]) => {
      const pl = DB.piles.find(q => q.no === no);
      const so = ensureMeas(pl.id, 'setout');
      sensor(so, 0, 0); so.ecc = { mode: 'rods', r1: 1500, r2: 1200, measH: 0, at: Date.now() };
      commitMeas(so);
      const fi = ensureMeas(pl.id, 'final');
      sensor(fi, 0, 0); fi.ecc = { mode: 'rods', r1, r2, measH: 0, at: Date.now() };
      commitMeas(fi);
    });
    // No.3 は根切り後に実測が返ってきた
    {
      const pl = DB.piles.find(q => q.no === 'No.3');
      const dg = ensureMeas(pl.id, 'dug');
      dg.ecc = { mode: 'offset', eA: 60, eB: 0, measH: 0, by: '光波', at: Date.now() };
      commitMeas(dg);
    }
    return { real: buildDXF({ mag: 1 }), exag: buildDXF({ mag: 20 }) };
  });
  await b.close(); srv.close();

  const f1 = path.join(os.tmpdir(), 'dxf1_' + process.pid + '.dxf');
  const f2 = path.join(os.tmpdir(), 'dxf20_' + process.pid + '.dxf');
  fs.writeFileSync(f1, out.real); fs.writeFileSync(f2, out.exag);

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };

  const py = `
import ezdxf, json
def read(p):
    d = ezdxf.readfile(p); m = d.modelspace()
    def circ(lay): return [[round(e.dxf.center.x,2), round(e.dxf.center.y,2), round(e.dxf.radius,2)]
                           for e in m.query('CIRCLE[layer=="%s"]' % lay)]
    return {
      'ver': d.dxfversion, 'units': d.header.get('$INSUNITS'),
      'layers': {l.dxf.name: l.dxf.color for l in d.layers if l.dxf.name.startswith('SEKO')},
      'design': circ('SEKO-設計位置'), 'meas': circ('SEKO-計測位置'), 'ng': circ('SEKO-要協議'),
      'nums': [e.dxf.text for e in m.query('TEXT[layer=="SEKO-番号"]')],
      'vals': [e.dxf.text for e in m.query('TEXT[layer=="SEKO-数値"]')],
      'unmeas': [e.dxf.text for e in m.query('TEXT[layer=="SEKO-未計測"]')],
      'notes': [e.dxf.text for e in m.query('TEXT[layer=="SEKO-凡例"]')],
      'arrows': len(m.query('LINE[layer=="SEKO-偏芯"]')),
    }
print(json.dumps({'real': read(${JSON.stringify(f1)}), 'exag': read(${JSON.stringify(f2)})}, ensure_ascii=False))
`;
  let r = null;
  try { r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' })); }
  catch (e) {
    console.log('スキップ: ezdxf で検証できません（pip install ezdxf）');
    [f1, f2].forEach(x => fs.unlinkSync(x)); process.exit(0);
  }
  const A = r.real, B = r.exag;
  console.log('DXF: ' + A.ver + '　単位 $INSUNITS=' + A.units + '　レイヤ ' + Object.keys(A.layers).length);
  console.log('  設計位置:', A.design.map(c => '(' + c[0] + ',' + c[1] + ')').join(' '));
  console.log('  計測位置:', A.meas.map(c => '(' + c[0] + ',' + c[1] + ')').join(' '), ' 要協議:', A.ng.length);
  console.log('  番号:', A.nums.join(' '), '　数値:', A.vals.join(' / '));
  console.log('  凡例:'); A.notes.forEach(t => console.log('    ' + t));

  console.log('');
  ck('DXF として読める', A.ver === 'AC1021');
  ck('単位がミリメートル ($INSUNITS=4)', A.units === 4);
  ck('レイヤが色付きで分かれている', Object.keys(A.layers).length >= 7 &&
     A.layers['SEKO-要協議'] === 1 && A.layers['SEKO-計測位置'] === 3);
  ck('日本語のレイヤ名が往復する', !!A.layers['SEKO-設計位置']);
  ck('設計位置が杭伏図の座標そのまま', A.design.length === 4 &&
     A.design.some(c => c[0] === 0 && c[1] === 0) && A.design.some(c => c[0] === 10800));
  ck('杭径から半径が出る (203.2)', A.design.every(c => Math.abs(c[2] - 203.2) < 0.01));
  ck('計測位置が実寸で正しい位置に出る (No.1 は +40mm)',
     A.meas.some(c => Math.abs(c[0] - 40) < 0.5 && Math.abs(c[1] - 0) < 0.5));
  ck('許容超過は別レイヤになる', A.ng.length === 1 && Math.abs(A.ng[0][0] - 3800) < 0.5);
  ck('根切り後の実測も実寸で出る (No.3 は +60mm)',
     A.meas.some(c => Math.abs(c[0] - 7260) < 0.5));
  ck('推定には * を付けて実測と区別する',
     A.vals.filter(t => t.indexOf('*') >= 0).length === 2 &&
     A.vals.filter(t => t.indexOf('*') < 0).length === 1);
  ck('未計測が明示される', A.unmeas.length === 1 && A.unmeas[0] === '未計測');
  ck('出来形ではないと凡例に書く', A.notes[0].indexOf('出来形ではない') > 0);
  ck('実測と推定の本数を凡例に出す', A.notes[2].indexOf('実測 1本 / 推定 2本') === 0);
  ck('実寸であることを明記する', A.notes[3].indexOf('実寸') > 0);
  ck('倍率を上げると位置が誇張される',
     B.meas.some(c => Math.abs(c[0] - 800) < 1) && B.notes[3].indexOf('20倍') > 0);
  ck('矢印が引かれる', A.arrows > 3);
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  [f1, f2].forEach(x => fs.unlinkSync(x));
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
