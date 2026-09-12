// 端到端冒烟脚本：对运行中的服务实际走一遍
// 五代谱系 → 成环检测 → 近交计算 → 非法配对拦截 → 审计 → 重启保留
// 用法：BASE=http://localhost:3024 node scripts/smoke.mjs

const BASE = process.env.BASE || "http://localhost:3024";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name} ${extra}`); }
}

async function api(path, options = {}) {
  const opts = options.body
    ? { ...options, headers: { "Content-Type": "application/json" } }
    : options;
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// 每羽鸽子使用唯一前缀，脚本可重复执行
const U = Date.now().toString(36).toUpperCase();
const r = (s) => `T${U}-${s}`;

console.log("1) 搭建五代谱系 + 重复祖先");
const founders = ["FF1", "FF2", "FF3", "FF4", "X", "Y"];
for (const f of founders) {
  const { status } = await api("/api/pigeons", {
    method: "POST",
    body: JSON.stringify({ ringNo: r(f), owner: "种鸽棚", loft: "种鸽棚" }),
  });
  check(`建档 ${f}`, status === 201, `status=${status}`);
}
const add = (ring, father, mother) =>
  api("/api/pigeons", {
    method: "POST",
    body: JSON.stringify({
      ringNo: r(ring), fatherRing: father ? r(father) : "", motherRing: mother ? r(mother) : "",
      owner: "育种棚", loft: "育种棚", color: "灰",
    }),
  });
// F1=FF1×FF2, F2=FF3×FF4, F3=FF1×FF3（FF1 后续在 T1 谱系中重复）
for (const [ring, fa, mo] of [
  ["F1", "FF1", "FF2"], ["F2", "FF3", "FF4"], ["F3", "FF1", "FF3"],
  ["G1", "F1", "F2"], ["G2", "F3", "X"], ["G3", "F1", "F3"],
  ["P1", "G1", "G2"], ["GP1", "P1", "G3"], ["T1", "GP1", "F2"],
  ["H1", "FF1", "Y"], ["H2", "FF1", "X"], // 严格半同胞：共享始祖 FF1，另一亲 Y/X 无亲缘
]) {
  const { status } = await add(ring, fa, mo);
  check(`建档 ${ring}`, status === 201, `status=${status}`);
}
// G1 的全同胞：G1S = F1×F2
{
  const { status } = await add("G1S", "F1", "F2");
  check("建档全同胞 G1S=F1×F2", status === 201, `status=${status}`);
}

console.log("2) 五代谱系查询：重复祖先 / 缺失父母 / 层数");
{
  const { status, body } = await api(`/api/pigeons/${encodeURIComponent(r("T1"))}/pedigree`);
  check("谱系 200", status === 200);
  check("五代上限", body.maxGenerations === 5);
  // 父线 T1→GP1→P1→G1→F1→FF1
  let n = body.tree;
  const chain = [];
  for (let i = 0; i <= 5; i++) { chain.push(n.ringNo); n = n.father; }
  check("父线五层到 FF1", chain.join("→") === [r("T1"), r("GP1"), r("P1"), r("G1"), r("F1"), r("FF1")].join("→"), chain.join("→"));
  check("F1 重复祖先", (body.repeatedAncestors || []).some(x => x.ringNo === r("F1") && x.count >= 2),
    JSON.stringify(body.repeatedAncestors));
  check("F2 重复祖先", (body.repeatedAncestors || []).some(x => x.ringNo === r("F2")));
  check("标出缺失父母", (body.missingParents || []).some(m => m.ringNo === r("FF1")));
  check("无成环", body.cycles.length === 0, JSON.stringify(body.cycles));
}

console.log("3) 全部后代");
{
  const { body } = await api(`/api/pigeons/${encodeURIComponent(r("FF1"))}/descendants`);
  const gens = new Map(body.descendants.map(d => [d.ringNo, d.generation]));
  check("FF1→F1 一代", gens.get(r("F1")) === 1);
  check("FF1→T1 五代（最短路径）", gens.get(r("T1")) === 4, `实际 ${gens.get(r("T1"))}`);
  check("后代包含 G1S", gens.has(r("G1S")));
}

console.log("4) 成环检测（自相矛盾谱系）");
{
  await add("CY2", "CY1", "");
  const { status } = await add("CY1", "CY2", ""); // CY1 的父是 CY2，CY2 的父是 CY1
  check("成环数据允许录入（检测在查询侧）", status === 201, `status=${status}`);
  const { body } = await api(`/api/pigeons/${encodeURIComponent(r("CY1"))}/pedigree`);
  check("报告 1 个环", body.cycles.length === 1, JSON.stringify(body.cycles));
  const rings = new Set(body.cycles[0]?.path || []);
  check("环上只有 CY1/CY2", rings.size === 2 && rings.has(r("CY1")) && rings.has(r("CY2")));
}

console.log("5) 近交计算与共同祖先路径");
{
  const { status, body } = await api(`/api/breeding/inbreeding?ringA=${encodeURIComponent(r("G1"))}&ringB=${encodeURIComponent(r("G1S"))}`);
  check("分析 200", status === 200);
  check("全同胞 F=0.25", body.coefficient === 0.25, `实际 ${body.coefficient}`);
  check("超过默认门槛 0.125", body.exceedsThreshold === true);
  const anc = (body.commonAncestors || []).map(c => c.ringNo).sort();
  check("共同祖先 F1/F2", anc.join(",") === [r("F1"), r("F2")].sort().join(","), anc.join(","));
  check("每个共同祖先贡献 0.125", body.commonAncestors.every(c => c.contribution === 0.125));
  check("有审计号", body.auditId > 0);
  // 严格半同胞：H1=FF1×Y，H2=FF1×X → 共享 FF1
  const half = await api(`/api/breeding/inbreeding?ringA=${encodeURIComponent(r("H1"))}&ringB=${encodeURIComponent(r("H2"))}`);
  check("半同胞 F=0.125", half.body.coefficient === 0.125, `实际 ${half.body.coefficient}`);
  check("等于门槛不算超限", half.body.exceedsThreshold === false);
  // 无关始祖
  const zero = await api(`/api/breeding/inbreeding?ringA=${encodeURIComponent(r("FF2"))}&ringB=${encodeURIComponent(r("FF4"))}`);
  check("无关 F=0", zero.body.coefficient === 0);
}

console.log("6) 非法配对拦截 + 不留配对记录");
const pairingsBefore = (await api("/api/breeding/pairings")).body.length;
const cases = [
  ["同羽", r("F1"), r("F1"), "same_pigeon"],
  ["父女", r("F1"), r("G1"), "parent_child"],
  ["子母(反方向)", r("G1"), r("F2"), "parent_child"],
  ["祖孙", r("FF1"), r("G1"), "grandparent_grandchild"],
  ["超门槛(全同胞)", r("G1"), r("G1S"), "inbreeding_threshold"],
  ["不存在", r("G1"), r("NOPE"), "pigeon_not_found"],
];
for (const [name, a, b, code] of cases) {
  const { status, body } = await api("/api/breeding/pairings", {
    method: "POST", body: JSON.stringify({ ringA: a, ringB: b }),
  });
  check(`拦截：${name}`, status === 422 && body.violations.some(v => v.code === code),
    `status=${status} codes=${(body.violations || []).map(v => v.code).join(",")}`);
  check(`拦截写审计：${name}`, body.auditId > 0);
}
const pairingsAfterReject = (await api("/api/breeding/pairings")).body.length;
check("被拒配对没有产生记录", pairingsAfterReject === pairingsBefore);

console.log("7) 合法配对写入（半同胞恰为门槛，放行）");
{
  const { status, body } = await api("/api/breeding/pairings", {
    method: "POST", body: JSON.stringify({ ringA: r("H1"), ringB: r("H2"), note: "半同胞试配" }),
  });
  check("半同胞配对 201", status === 201, `status=${status}`);
  check("系数 0.125", body.pairing?.coefficient === 0.125);
  check("配对/审计同号", body.pairing?.id === body.auditId);
}

console.log("8) 审计列表覆盖全部动作");
{
  const { body } = await api("/api/audit?limit=500");
  const actions = new Set(body.items.map(a => a.action));
  for (const a of ["inbreeding_analysis", "pairing_create", "pairing_rejected"]) {
    check(`审计含 ${a}`, actions.has(a));
  }
  const rejected = body.items.filter(a => a.action === "pairing_rejected");
  check("6 条拒绝审计", rejected.length >= 6, `实际 ${rejected.length}`);
  check("审计 id 单调", body.items.every((a, i) => i === 0 || a.id < body.items[i - 1].id));
}

console.log(failures === 0 ? "\n🎉 冒烟全部通过" : `\n⚠️ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
