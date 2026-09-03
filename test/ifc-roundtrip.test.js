/* =========================================================
   IFC の取り込み → 計測 → 元ファイルへの書き戻し の検証

   既に杭のIFCがある現場では、新しいファイルを作り直すと GUID が
   変わって上流と結び直せなくなる。だから元のテキストをそのまま保ち、
   出来形のプロパティセットだけを追記する方式を採っている。
   その往復で、GUID・既存プロパティ・形状が一切変わらないことを確かめる。

   実行:  npm i playwright-core && pip install ifcopenshell
          node test/ifc-roundtrip.test.js
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

  /* まず「設計側のIFC」を作る（6本ぶん）。実務では他所から来るファイル。 */
  const src = await p.evaluate(() => {
    for (let i = 1; i <= 6; i++)
      addPile('No.' + i, 406.4, 2.3, false,
        { x: (i - 1) * 3600, y: 0, len: 5.0, thick: 12.7, steel: 'STK490', method: 'N-ECS' });
    return buildIFC();
  });
  const srcFile = path.join(os.tmpdir(), 'rt_src_' + process.pid + '.ifc');
  fs.writeFileSync(srcFile, src);

  /* 台帳をまっさらにしてから、そのIFCを取り込む */
  await p.evaluate(() => { DB.piles = []; DB.meas = []; DB.selPile = null; saveDB(); renderPiles(); });
  await p.setInputFiles('#ifc-input', srcFile);
  await p.waitForSelector('#ifc-body', { state: 'visible', timeout: 15000 });
  const info = (await p.textContent('#ifc-info')).replace(/\s+/g, ' ').trim();
  await p.click('#ifc-go');
  await p.waitForTimeout(300);
  const imported = await p.evaluate(() => DB.piles.map(x => ({
    no: x.no, guid: x.ifcGuid, x: x.x, y: x.y, dia: x.dia, thick: x.thick,
    len: x.len, steel: x.steel, head: x.headDepth })));
  console.log('取り込み:', info);
  console.log('  ' + imported.length + '本  例) ' + JSON.stringify(imported[0]));

  /* 2本だけ計測して書き戻す */
  const merged = await p.evaluate(() => {
    DB.settings.rod1 = 'X通り'; DB.settings.rod2 = 'Y通り'; DB.settings.tiltN = 200;
    const sensor = (m, x, y) => {
      const mk = v => ({ mode: 'sensor', angle: v, tan: Math.tan(v * Math.PI / 180),
        edgeDiff: 0, offset: 0, perspErr: 0, pitch: 0, roll: 0, stab: null,
        n: 1, sd: null, sem: null, sensor: 'WT901', at: Date.now(), pts: [] });
      m.A = mk(x); m.B = mk(y);
    };
    [['No.1', 1535, 1180, 0.20, 0.12], ['No.3', 1610, 1265, 0.35, 0.28]].forEach(([no, f1, f2, tx, ty]) => {
      const pl = DB.piles.find(q => q.no === no);
      const so = ensureMeas(pl.id, 'setout');
      sensor(so, 0.05, -0.02); so.ecc = { mode: 'rods', r1: 1500, r2: 1200, measH: 0, at: Date.now() };
      commitMeas(so);
      const fi = ensureMeas(pl.id, 'final');
      sensor(fi, tx, ty); fi.ecc = { mode: 'rods', r1: f1, r2: f2, measH: 0.5, at: Date.now() };
      commitMeas(fi);
    });
    // No.1 だけ、後日 根切り後に杭頭を出して実測した想定（本来の出来形）
    {
      const pl = DB.piles.find(q => q.no === 'No.1');
      const dg = ensureMeas(pl.id, 'dug');
      dg.ecc = { mode: 'offset', eA: 41, eB: -22, measH: 0, by: '光波 / 元請', at: Date.now() };
      commitMeas(dg);
    }
    const r = mergeIFC();
    // 二度実行しても増殖しないこと
    const again = mergeIFC();
    return { text: r.text, count: r.count, twiceSame: again.text.length === r.text.length,
             src: IFCSRC.text };
  });
  const outFile = path.join(os.tmpdir(), 'rt_out_' + process.pid + '.ifc');
  fs.writeFileSync(outFile, merged.text);
  console.log('書き戻し: ' + merged.count + '本ぶん  ' +
    (fs.statSync(srcFile).size / 1024).toFixed(1) + 'KB → ' + (merged.text.length / 1024).toFixed(1) + 'KB');
  await b.close(); srv.close();

  let fail = 0;
  const ck = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };

  const py = `
import ifcopenshell, ifcopenshell.util.element as ue, json
a = ifcopenshell.open(${JSON.stringify(srcFile)}); b = ifcopenshell.open(${JSON.stringify(outFile)})
pa = {p.GlobalId: p for p in a.by_type('IfcPile')}
pb = {p.GlobalId: p for p in b.by_type('IfcPile')}
def geo(p):
    s = p.Representation.Representations[0].Items[0]
    pr = s.SweptArea
    return (pr.is_a(), pr.Radius, getattr(pr, 'WallThickness', None), s.Depth,
            tuple(s.ExtrudedDirection.DirectionRatios),
            tuple(p.ObjectPlacement.RelativePlacement.Location.Coordinates))
out = {
 'na': len(pa), 'nb': len(pb), 'same_guids': sorted(pa) == sorted(pb),
 'spec_same': sum(1 for g in pa if ue.get_psets(pa[g]).get('Pset_杭設計値') == ue.get_psets(pb[g]).get('Pset_杭設計値')),
 'geom_same': sum(1 for g in pa if geo(pa[g]) == geo(pb[g])),
 'withNew': sorted(p.Name for p in pb.values() if 'Pset_杭出来形' in ue.get_psets(p)),
 'sample': None, 'schema': b.schema,
}
out['withRec'] = sorted(p.Name for p in pb.values() if 'Pset_杭施工記録' in ue.get_psets(p))
for p in pb.values():
    ps = ue.get_psets(p)
    if p.Name == 'No.1':
        out['sample'] = ps.get('Pset_杭施工記録')
        out['dug'] = ps.get('Pset_杭出来形')
    if p.Name == 'No.3':
        out['dug3'] = ps.get('Pset_杭出来形')
print(json.dumps(out, ensure_ascii=False))
`;
  let r = null;
  try { r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' })); }
  catch (e) {
    console.log('スキップ: ifcopenshell で検証できません');
    [srcFile, outFile].forEach(f => fs.unlinkSync(f));
    process.exit(fail ? 1 : 0);
  }
  const s = r.sample || {};
  console.log('\nifcopenshell で読み直した結果:');
  console.log('  ' + r.na + '本 → ' + r.nb + '本　GUID一致 ' + r.same_guids +
    '　設計値Pset無傷 ' + r.spec_same + '/' + r.na + '　形状同一 ' + r.geom_same + '/' + r.na);
  console.log('  施工記録が付いた杭: ' + r.withRec.join(', ') + '　出来形(根切り後): ' + r.withNew.join(', '));
  console.log('  No.1 推定 ' + Number(s['推定_杭頭偏芯_合成_mm']).toFixed(1) + 'mm → ' + s['推定での判定'] +
    '　傾斜 ' + s['傾斜_合成'] + ' → ' + s['傾斜_判定']);
  console.log('  No.1 根切り後の実測 ' + Number(r.dug['実測_杭頭偏芯_合成_mm']).toFixed(1) + 'mm → ' +
    r.dug['判定'] + '　推定との差 ' + Number(r.dug['地上からの推定との差_mm']).toFixed(1) + 'mm（' +
    r.dug['計測者_方法'] + '）');

  console.log('');
  const stripped = merged.text.replace(/\/\* SEKOBASE-BEGIN \*\/[\s\S]*?\/\* SEKOBASE-END \*\/\n?/g, '');
  ck('追記部分を除くと元のバイト列と完全一致（非破壊）', stripped === merged.src);
  ck('取り込みで6本すべてのGUIDが入る', imported.length === 6 && imported.every(x => x.guid && x.guid.length === 22));
  ck('設計値が取り込まれる (φ406.4 / t12.7 / L5 / STK490)',
     imported[0].dia === 406.4 && imported[0].thick === 12.7 && imported[0].len === 5 && imported[0].steel === 'STK490');
  ck('杭天端 GL-2.3m が設計杭頭深さになる', Math.abs(imported[0].head - 2.3) < 0.001);
  ck('設計座標が取り込まれる', imported.some(x => x.x === 10800));
  ck('書き戻しても杭が増減しない', r.na === 6 && r.nb === 6);
  ck('GUIDが1つも変わらない', r.same_guids === true);
  ck('元の設計値Psetが無傷', r.spec_same === 6);
  ck('形状の定義が一切変わらない', r.geom_same === 6);
  ck('計測した杭だけに施工記録が付く', r.withRec.length === 2 && r.withRec.join() === 'No.1,No.3');
  ck('地上の計測は「推定」として入る', Math.abs(s['推定_杭頭偏芯_合成_mm'] - 36.1) < 1 && s['推定での判定'] === '合格');
  ck('根切り後の実測がある杭だけに出来形が付く', r.withNew.join() === 'No.1' && !r.dug3);
  ck('出来形は実測値そのもの', Math.abs(r.dug['実測_杭頭偏芯_合成_mm'] - Math.hypot(41, 22)) < 0.5);
  // 差は「実測 − 推定」。推定の成分は同じ施工記録のPsetに入っているので、そこから検算する
  const wantDiff = Math.hypot(41 - s['推定_杭頭偏芯_X通り_mm'], -22 - s['推定_杭頭偏芯_Y通り_mm']);
  ck('推定との差が実測−推定と一致 (' + wantDiff.toFixed(1) + 'mm)',
     Math.abs(r.dug['地上からの推定との差_mm'] - wantDiff) < 0.2);
  ck('出来形は根切り後だと明記される', r.dug['計測時期'].indexOf('根切り後') === 0);
  ck('管理値1/200で傾斜が判定される', s['傾斜_管理値'] === '1/200');
  ck('二度書き戻しても増殖しない', merged.twiceSame === true);
  ck('IFC4のまま', r.schema === 'IFC4');
  ck('JSエラーなし', errs.length === 0);
  if (errs.length) console.log(errs.join('\n'));

  [srcFile, outFile].forEach(f => fs.unlinkSync(f));
  console.log(fail ? '\n===== ' + fail + ' 件 失敗 =====' : '\n===== 全て合格 =====');
  process.exit(fail ? 1 : 0);
});
