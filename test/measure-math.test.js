/* =========================================================
   pile.html の計測数式の検証

   合成データ（既知の傾斜を持つ杭を、既知の姿勢のカメラで
   透視投影した画像座標）を作り、アプリと同じ関数に通して
   元の傾斜が復元できるかを確認する。

   実行:  node test/measure-math.test.js
   ========================================================= */
const fs = require('fs'), path = require('path'), vm = require('vm');

/* pile.html から数式部分だけを取り出して評価する
   （アプリ本体と式が二重管理にならないようにするため）      */
function loadMath() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pile.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');
  const cut = (from, to) => js.slice(js.indexOf(from), js.indexOf(to));
  const src =
    'const DB={settings:{tiltN:100,eccMax:100,pitchTol:1,hfov:65,rodAngle:90}};\n' +
    cut('const D2R', '/* ---------------- ステップ定義') +
    '\nconst Sensor={\n' + cut('  fromOrientation(beta, gamma) {', '  push(g) {') + '};\n' +
    cut('/* 画像内の線分', '/* =========================================================\n   データ操作');
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(src + '\nmodule.exports={angleFromTrueVertical,buildView,composeTilt,jointAngle,extrapolate,eccAllow,vecMag,Sensor};', ctx);
  return ctx.module.exports;
}
const M = loadMath();
const D2R = Math.PI/180, R2D = 180/Math.PI;
let fails = 0;
function ok(name, got, want, tol) {
  const bad = !(Math.abs(got - want) <= tol);
  if (bad) fails++;
  console.log((bad ? 'FAIL ' : 'ok   ') + name + '  got=' + got.toFixed(5) + ' want=' + want.toFixed(5));
}

/* ---- ベクトル ---- */
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const n=Math.hypot(...a);return [a[0]/n,a[1]/n,a[2]/n];};

/* ================= 1. 重力ベクトルの式の検証 =================
   直立で自身の面内に phi ロールした姿勢を直接構成し、
   その姿勢に対応する beta/gamma を逆算して式に通す         */
function poseUprightRolled(phiDeg, headingDeg){
  const p=phiDeg*D2R, h=headingDeg*D2R;
  const c=[Math.cos(h),Math.sin(h),0];          // 光軸（水平）
  const r=norm(cross(c,[0,0,1]));                // 画面右（ロール前）
  const u=[0,0,1];
  const xd=[Math.cos(p)*r[0]+Math.sin(p)*u[0],Math.cos(p)*r[1]+Math.sin(p)*u[1],Math.cos(p)*r[2]+Math.sin(p)*u[2]];
  const yd=[-Math.sin(p)*r[0]+Math.cos(p)*u[0],-Math.sin(p)*r[1]+Math.cos(p)*u[1],-Math.sin(p)*r[2]+Math.cos(p)*u[2]];
  const zd=[-c[0],-c[1],-c[2]];
  const g=[0,0,-1];
  return {xd,yd,zd,r,c,u, g:{gx:dot(g,xd),gy:dot(g,yd),gz:dot(g,zd)}};
}
console.log('--- 1. 重力ベクトル (直立+ロール) ---');
[0,5,-12,30].forEach(phi=>{
  const P=poseUprightRolled(phi,37);
  // beta/gamma を R の第3行から逆算: 第3行=[-cB sG, sB, cB cG] = -g_device
  const row3=[-P.g.gx,-P.g.gy,-P.g.gz];
  const beta=Math.asin(Math.max(-1,Math.min(1,row3[1])))*R2D;
  const gamma=Math.atan2(-row3[0],row3[2])*R2D;
  const g2=M.Sensor.fromOrientation(beta,gamma);
  ok('roll='+phi+'° gx',g2.x,P.g.gx,1e-6);
  ok('roll='+phi+'° gy',g2.y,P.g.gy,1e-6);
  ok('roll='+phi+'° gz',g2.z,P.g.gz,1e-6);
});

/* ================= 2. 合成画像からの傾斜復元 ================= */
const W=1920,H=1080;
function shoot(tilt, headingDeg, rollDeg, dist, offsetAcross, hfov){
  const P=poseUprightRolled(rollDeg,headingDeg);
  const f=(W/2)/Math.tan((hfov*D2R)/2);
  // 杭: 原点(z=0)を通り 方向 d、半径 r の円柱
  const d=norm([tilt[0],tilt[1],1]), rad=0.134;
  const C=[-P.c[0]*dist + P.r[0]*offsetAcross, -P.c[1]*dist + P.r[1]*offsetAcross, 1.5];
  const side=norm(cross(d,P.c));                 // 視線と杭軸に直交 = シルエット方向
  const proj=(Pw)=>{
    const v=sub(Pw,C);
    const Zc=dot(v,P.c), Xc=dot(v,P.xd), Yc=dot(v,P.yd);
    return {x:W/2+f*Xc/Zc, y:H/2-f*Yc/Zc};
  };
  const pt=(s,z)=>[d[0]*z+side[0]*s, d[1]*z+side[1]*s, d[2]*z+side[2]*s];
  // 左右エッジ 各2点（高さ 0.5m と 4.0m）
  const A=proj(pt(-rad,0.5)),B=proj(pt(-rad,4.0)),Cp=proj(pt(rad,0.5)),Dp=proj(pt(rad,4.0));
  // 画面左に来る方を「左エッジ」とする
  const l=[B,A],rr=[Dp,Cp];
  const pts = (A.x+B.x)/2 < (Cp.x+Dp.x)/2 ? [B,A,Dp,Cp] : [Dp,Cp,B,A];
  return M.buildView(pts, P.g, W);
}

console.log('\n--- 2. 中央・ロールあり/なしで傾斜を復元 ---');
const tilt=[0.008,-0.006];                       // 1/100 相当の傾き
[[0,0],[0,20],[90,-15],[210,7]].forEach(([hd,roll])=>{
  const P=poseUprightRolled(roll,hd);
  const want=Math.atan(tilt[0]*P.r[0]+tilt[1]*P.r[1])*R2D;   // 視線に直交する成分
  const v=shoot(tilt,hd,roll,12,0,65);
  ok('heading='+hd+'° roll='+roll+'°',v.angle,want,0.02);
});

console.log('\n--- 3. 直交2視点の合成 = 真の傾斜量 ---');
{
  const vA=shoot(tilt,0,0,12,0,65), vB=shoot(tilt,90,0,12,0,65);
  const t=M.composeTilt(vA,vB);
  ok('合成 1/n', t.ratio, 1/Math.hypot(tilt[0],tilt[1]), 0.5);
  ok('合成 度',  t.deg,   Math.atan(Math.hypot(tilt[0],tilt[1]))*R2D, 0.02);
}

console.log('\n--- 4. 画面端に写した場合の遠近誤差 ---');
[0,0.10,0.25,0.40].forEach(fr=>{
  const across=fr*2*12*Math.tan(65*D2R/2);       // 画面幅比 fr に相当する横ズレ
  const v=shoot(tilt,0,0,12,across,65);
  const P=poseUprightRolled(0,0);
  const want=Math.atan(tilt[0]*P.r[0]+tilt[1]*P.r[1])*R2D;
  console.log('     中央から '+(v.offset*100).toFixed(1)+'% → 誤差 '+
              (v.angle-want).toFixed(4)+'°  (見積上限 ±'+v.perspErr.toFixed(4)+'°)');
});

console.log('\n--- 5. 外挿の符号 ---');
{
  // 杭頭が視点A方向の右へ 1/100 で倒れ、計測位置は設計杭頭より 3m 上
  const t={tA:0.01,tB:0,mag:0.01};
  const e={eA:20,eB:0};
  const h=M.extrapolate(e,t,3.0);
  ok('下がると左へ戻る A成分', h.hA, 20-0.01*3000, 1e-6);   // = -10mm
  ok('B成分', h.hB, 0, 1e-6);
}

console.log('\n--- 6. 継手折れ角 ---');
{
  const j=M.jointAngle({tA:0.005,tB:0.000},{tA:0.005,tB:0.010});
  ok('折れ角 1/n', j.ratio, 100, 0.5);
}

console.log('\n--- 6b. 逃げ棒が直交していない場合の合成 ---');
{
  // 既知のズレベクトル v を2方向へ射影し、そこから元の大きさが復元できるか
  const v = [37, -24], want = Math.hypot(v[0], v[1]);
  [90, 75, 105, 60].forEach(ang => {
    const th = ang * D2R;
    const d1 = v[0];                                   // u1 = (1,0)
    const d2 = v[0] * Math.cos(th) + v[1] * Math.sin(th);  // u2 = (cosθ, sinθ)
    ok('成す角 ' + ang + '° から復元', M.vecMag(d1, d2, ang), want, 1e-6);
  });
  ok('直交なら単純な二乗和', M.vecMag(30, 40, 90), 50, 1e-9);
}

console.log('\n--- 7. 偏芯許容値 ---');
ok('φ267.4 → D/4', M.eccAllow(267.4), 66.85, 1e-6);
ok('φ600  → 上限100', M.eccAllow(600), 100, 1e-6);

console.log(fails ? '\n===== ' + fails + ' 件 失敗 =====' : '\n===== 全て合格 =====');
process.exit(fails?1:0);
