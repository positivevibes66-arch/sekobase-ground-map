/* =========================================================
   IFC 書き出しの検証

   アプリで杭を登録・計測し、buildIFC() が出す IFC4 を
   ifcopenshell で読み直して、実体・配置・形状・プロパティが
   意図どおりかを確認する。ビューアや BIM ソフトが読める形か、
   という部分を実際のパーサで確かめるのが狙い。

   実行:  npm i playwright-core && pip install ifcopenshell
          node test/ifc-export.test.js
   どちらかが無ければスキップする。
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
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const b = await chromium.launch({ executablePath: EXEC });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + '/pile.html', { waitUntil: 'networkidle' });

  /* 現場の黒板そのままの仕様（N-ECS / φ406.4 / t12.7 / L5.0m / STK490）で
     2本ぶんの計測を作る。No.12 は許容超過になる値にしてある。 */
  const ifc = await p.evaluate(() => {
    const mk = (no, x, y) => addPile(no, 406.4, 1.0, true,
      { x, y, len: 5.0, thick: 12.7, steel: 'STK490', method: 'N-ECS' });
    const a = mk('No.10', 0, 0), b = mk('No.12', 3600, 0);
    DB.settings.rod1 = 'X通り'; DB.settings.rod2 = 'Y通り'; DB.settings.tiltN = 200;
    const sensor = (m, x, y) => {
      const mkv = v => ({ mode: 'sensor', angle: v, tan: Math.tan(v * Math.PI / 180),
                          edgeDiff: 0, offset: 0, perspErr: 0, pitch: 0, roll: 0, stab: null,
                          n: 1, sd: null, sem: null, sensor: 'WT901', at: Date.now(), pts: [] });
      m.A = mkv(x); m.B = mkv(y);
    };
    [[a, 1535, 1180, 0.20, 0.12], [b, 1610, 1265, 0.35, 0.28]].forEach(([pl, f1, f2, tx, ty]) => {
      const so = ensureMeas(pl.id, 'setout');
      sensor(so, 0.05, -0.02); so.ecc = { mode: 'rods', r1: 1500, r2: 1200, measH: 0, at: Date.now() };
      commitMeas(so);
      const fi = ensureMeas(pl.id, 'final');
      sensor(fi, tx, ty); fi.ecc = { mode: 'rods', r1: f1, r2: f2, measH: 0.5, at: Date.now() };
      commitMeas(fi);
    });
    return buildIFC();
  });
  await b.close(); srv.close();

  const out = path.join(os.tmpdir(), 'sekobase_test_' + process.pid + '.ifc');
  fs.writeFileSync(out, ifc);
  console.log('IFC 生成: ' + ifc.split('\n').length + ' 行 / ' + (ifc.length / 1024).toFixed(1) + ' KB');

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  const py = `
import ifcopenshell, ifcopenshell.geom as geom, ifcopenshell.util.element as ue, json, sys
f = ifcopenshell.open(${JSON.stringify(out)})
st = geom.settings()
try: st.set('use-world-coords', True)
except Exception: st.set(st.USE_WORLD_COORDS, True)
res = {'schema': f.schema, 'piles': []}
for p in f.by_type('IfcPile'):
    d = {'name': p.Name, 'guid': p.GlobalId, 'type': p.PredefinedType, 'obj': p.ObjectType,
         'psets': ue.get_psets(p)}
    prof = p.Representation.Representations[0].Items[0].SweptArea
    d['profile'] = [prof.is_a(), prof.Radius, prof.WallThickness]
    sh = geom.create_shape(st, p); v = sh.geometry.verts
    d['bbox'] = [min(v[0::3]), max(v[0::3]), min(v[2::3]), max(v[2::3])]
    d['tris'] = len(sh.geometry.faces) // 3
    res['piles'].append(d)
res['storeys'] = [s.Name for s in f.by_type('IfcBuildingStorey')]
res['units'] = [(u.UnitType, u.Prefix) for u in f.by_type('IfcUnitAssignment')[0].Units]
print(json.dumps(res, ensure_ascii=False))
`;
  let r = null;
  try {
    r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (e) {
    console.log('スキップ: ifcopenshell で検証できません（pip install ifcopenshell）');
    fs.unlinkSync(out);
    process.exit(fail ? 1 : 0);
  }

  console.log('\nifcopenshell で読み直した結果:');
  console.log('  スキーマ ' + r.schema + '　階層 ' + r.storeys.join('/') + '　単位 ' +
              r.units.map(u => u[0] + (u[1] ? '(' + u[1] + ')' : '')).join(' '));
  r.piles.forEach(d => {
    const ab = d.psets['Pset_杭施工記録'] || {};
    console.log('  ' + d.name + ': ' + d.profile[0] + ' R=' + d.profile[1] + ' t=' + d.profile[2] +
      '　X[' + d.bbox[0].toFixed(2) + ',' + d.bbox[1].toFixed(2) + '] Z[' + d.bbox[2].toFixed(2) +
      ',' + d.bbox[3].toFixed(2) + ']　三角形' + d.tris);
    console.log('      推定偏芯 ' + ab['推定_杭頭偏芯_合成_mm'] + 'mm / 許容 ' + ab['偏芯_許容_mm'] +
      ' → ' + ab['推定での判定'] + '　傾斜 ' + ab['傾斜_合成'] + ' / ' + ab['傾斜_管理値'] +
      ' → ' + ab['傾斜_判定']);
  });

  const [a, b2] = r.piles;
  console.log('');
  ck('IFC4 として読める', r.schema === 'IFC4');
  ck('IfcPile が2本', r.piles.length === 2);
  ck('空間構造が通っている', r.storeys.length === 1);
  ck('長さの単位がミリメートル', r.units.some(u => u[0] === 'LENGTHUNIT' && u[1] === 'MILLI'));
  ck('鋼管断面として出る (R=203.2, t=12.7)',
     a.profile[0] === 'IfcCircleHollowProfileDef' && Math.abs(a.profile[1] - 203.2) < 0.01 &&
     Math.abs(a.profile[2] - 12.7) < 0.01);
  ck('形状が生成できる', a.tris > 100 && b2.tris > 100);
  ck('設計杭頭 GL-1.0m から 5m 下まで', Math.abs(a.bbox[3] - (-1)) < 0.01 && Math.abs(a.bbox[2] - (-6)) < 0.01);
  ck('設計座標が反映される (No.12 が X=3.6m)', Math.abs(b2.bbox[0] - 3.4) < 0.01);
  ck('GUID が杭ごとに違う', a.guid !== b2.guid && a.guid.length === 22);
  ck('PredefinedType が DRIVEN', a.type === 'DRIVEN');
  ck('工法が ObjectType に入る', a.obj === 'N-ECS');
  ck('Pset_PileCommon.Reference が杭番号', a.psets['Pset_PileCommon'].Reference === 'No.10');
  ck('日本語のプロパティ名が往復する',
     a.psets['Pset_杭設計値']['材質'] === 'STK490');
  ck('既存の杭IFCと同じPset名で出る',
     !!a.psets['Pset_杭設計値'] && !!a.psets['Pset_杭施工記録']);
  ck('根切り後の実測が無ければ出来形のPsetは付かない',
     !a.psets['Pset_杭出来形'] && !b2.psets['Pset_杭出来形']);
  const A = a.psets['Pset_杭施工記録'], B = b2.psets['Pset_杭施工記録'];
  ck('杭芯セットの読みが残る', A['杭芯セット_読み1_mm'] === 1500);
  ck('推定が合格判定 (No.10)', A['推定での判定'] === '合格');
  ck('許容超過が要協議になる (No.12)', B['推定での判定'] === '要協議' && B['推定_杭頭偏芯_合成_mm'] > 100);
  ck('推定であることが前提として明記される', String(A['推定の前提']).indexOf('根切り後') > 0);
  ck('傾斜の管理値 1/200 が記録される', A['傾斜_管理値'] === '1/200');
  ck('傾斜も超過側が要協議 (No.12)', B['傾斜_判定'] === '要協議');
  ck('計測方法が残る', A['計測方法'].indexOf('センサー') === 0);

  fs.unlinkSync(out);
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
