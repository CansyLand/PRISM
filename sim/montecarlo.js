// Monte Carlo of Curve Long vs Curve Short, using the exact model inside curve-simulator.html.
// Run: node sim/montecarlo.js   (3,000 GBM paths per scenario, daily steps)
const src=require("fs").readFileSync(process.argv[2] || require("path").join(__dirname, "curve-simulator.html"),"utf8");
const body=src.slice(src.indexOf("const rate ="), src.indexOf("// ── formatting"));
const P0=5, MAX_STEPS=1500; let Z=[];
eval(body.replace(/const (rate|mult|utilOpen|tMaxDays|tDays) =/g,"var $1 =").replace(/function (bridgePath|simulate|run|monteCarlo)\(/g,"globalThis.$1=function("));
const base={p:2,iv:80,rv:80,fee:10,cut:10,dc:1000,dch:0,df:5000,dfh:0,mode:"grad",uf:true,kink:50,steep:20,useCH:false,useFH:false,mu:0};
const q=(a,x)=>a[Math.round(x*(a.length-1))];
function stat(arr){const s=arr.slice().sort((a,b)=>a-b);const m=s.reduce((a,b)=>a+b,0)/s.length;return{mean:m,med:q(s,.5),win:s.filter(v=>v>0).length/s.length,p5:q(s,.05),p95:q(s,.95)};}
const f=(v)=>(v>=0?"+":"")+(v*100).toFixed(1)+"%";
function scen(name,over,days=90){
  const s={...base,...over}; const mc=monteCarlo(s,days,3000,99);
  const L=stat(mc.res.c), S=stat(mc.res.f);
  const u=s.dc/(s.dc+s.df);
  console.log(`${name.padEnd(34)} util ${(u*100).toFixed(0).padStart(2)}% | LONG avg ${f(L.mean).padStart(7)} med ${f(L.med).padStart(7)} win ${(L.win*100).toFixed(0).padStart(3)}% p5 ${f(L.p5).padStart(7)} | SHORT avg ${f(S.mean).padStart(6)} med ${f(S.med).padStart(6)} win ${(S.win*100).toFixed(0).padStart(3)}% p5 ${f(S.p5).padStart(7)} | wiped ${(mc.wiped/mc.paths*100).toFixed(1)}%`);
}
console.log("90 days, p=2, implied 80%, fee 0.1%, funding cut 10%");
scen("fair vol (rv=iv=80), no util funding",{uf:false});
scen("fair vol, util funding (default)",{});
scen("quiet market rv=50",{rv:50});
scen("wild market rv=120",{rv:120});
scen("fair vol, shorts scarce",{df:1500});
scen("fair vol, shorts very scarce",{df:1100});
scen("fair vol, shorts 4:1 too many",{df:20000});
scen("bull trend +60%/yr",{mu:60});
scen("bear trend -60%/yr",{mu:-60});
console.log("\n365 days");
scen("fair vol, util funding",{},365);
scen("fair vol, shorts scarce",{df:1500},365);
console.log("\n365 days, fair vol, util 17%: effect of steepness above the kink");
for (const st of [0,3,10,20]) scen(`steepness ${st}x`,{steep:st},365);
scen("util funding off",{uf:false},365);
console.log("\n365 days, fair vol, util funding off: pool depth (how far away the cap is)");
for (const df of [5000, 20000, 100000, 1000000]) scen(`shorts ${df}`,{uf:false,df},365);
console.log("\n365 days, fair vol: lower funding (implied vol) to compensate the cap, util 17%");
for (const iv of [80,70,60]) scen(`implied ${iv}%, util off`,{uf:false,iv},365);
