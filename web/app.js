// 育种站前端逻辑
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = { pigeons: [], settings: { inbreedingThreshold: 0.125 } };

async function api(path, options = {}) {
  const opts = options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || "请求失败");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(3)}%（${Number(x).toFixed(6)}）`);
const SIDE = { father: "父", mother: "母", root: "" };

function showMsg(el, kind, html) {
  el.innerHTML = html ? `<div class="alert ${kind}">${html}</div>` : "";
}

// ---------- Tabs ----------
$$("nav button").forEach((btn) => {
  btn.onclick = () => {
    $$("nav button").forEach(b => b.classList.toggle("active", b === btn));
    $$(".tab").forEach(t => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "audit") loadAudit();
    if (btn.dataset.tab === "pairing") loadPairings();
  };
});

// ---------- 档案 ----------
async function loadPigeons() {
  state.pigeons = await api("/api/pigeons");
  const sorted = [...state.pigeons].sort((a, b) => a.ringNo.localeCompare(b.ringNo));
  $("#ringList").innerHTML = sorted.map(p => `<option value="${esc(p.ringNo)}">`).join("");
  $("#pigeonCount").textContent = `共 ${sorted.length} 羽`;
  $("#pigeonTable tbody").innerHTML = sorted.map(p => `
    <tr>
      <td><b>${esc(p.ringNo)}</b></td>
      <td>${esc(p.owner)}</td>
      <td>${p.fatherRing ? esc(p.fatherRing) : '<span class="muted">—</span>'}</td>
      <td>${p.motherRing ? esc(p.motherRing) : '<span class="muted">—</span>'}</td>
      <td>${esc(p.color)} · ${esc(p.loft)}</td>
      <td><button class="ghost" data-ped="${esc(p.ringNo)}">谱系</button>
          <button class="ghost" data-inb="${esc(p.ringNo)}">分析</button></td>
    </tr>`).join("");
  $$("[data-ped]").forEach(b => b.onclick = () => {
    $$("nav button").find(x => x.dataset.tab === "pedigree").click();
    $("#pedRing").value = b.dataset.ped;
    loadPedigree();
  });
  $$("[data-inb]").forEach(b => b.onclick = () => {
    $$("nav button").find(x => x.dataset.tab === "inbreeding").click();
    if (!$("#inbA").value) $("#inbA").value = b.dataset.inb;
    else $("#inbB").value = b.dataset.inb;
  });
}

$("#pigeonForm").onsubmit = async (e) => {
  e.preventDefault();
  const form = $("#pigeonForm");
  try {
    const body = Object.fromEntries(new FormData(form).entries());
    await api("/api/pigeons", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    showMsg($("#registryMsg"), "ok", "档案已保存");
    await loadPigeons();
  } catch (err) {
    showMsg($("#registryMsg"), "error", esc(err.message));
  }
};

// ---------- 谱系树 ----------
function renderTreeNode(node, rootRing, repeatedSet) {
  const classes = ["node"];
  if (node.ringNo === rootRing) classes.push("root");
  if (!node.registered) classes.push("unregistered");
  else if (repeatedSet.has(node.ringNo)) classes.push("repeat");
  const badges = [];
  if (repeatedSet.has(node.ringNo) && node.ringNo !== rootRing) badges.push(`<span class="pill amber">重复×${node.occurrences}</span>`);
  if (!node.registered) badges.push(`<span class="pill red">未登记</span>`);
  if (node.missingParentRings.length) {
    const miss = node.missingParentRings.map(s => `缺${SIDE[s]}`).join("/");
    badges.push(`<span class="pill red">${miss}</span>`);
  }
  const html = `<span class="${classes.join(" ")}">${SIDE[node.side] ? `<span class="meta">${SIDE[node.side]}系 · </span>` : ""}<b>${esc(node.ringNo)}</b><span class="badges">${badges.join("")}</span></span>`;
  const childrenHtml = [];
  if (node.father) childrenHtml.push(`<li>${renderTreeNode(node.father, rootRing, repeatedSet)}</li>`);
  if (node.mother) childrenHtml.push(`<li>${renderTreeNode(node.mother, rootRing, repeatedSet)}</li>`);
  return html + (childrenHtml.length ? `<ul>${childrenHtml.join("")}</ul>` : "");
}

async function loadPedigree() {
  const ring = $("#pedRing").value.trim();
  const msg = $("#pedMsg");
  const result = $("#pedResult");
  result.innerHTML = "";
  if (!ring) return showMsg(msg, "warn", "请输入足环号");
  try {
    const [ped, desc] = await Promise.all([
      api(`/api/pigeons/${encodeURIComponent(ring)}/pedigree`),
      api(`/api/pigeons/${encodeURIComponent(ring)}/descendants`).catch(() => ({ descendants: [] })),
    ]);
    showMsg(msg, "", "");
    const repeatedSet = new Set(ped.repeatedAncestors.map(r => r.ringNo));

    const cycleHtml = ped.cycles.length ? `
      <div class="panel">
        <h2>⚠️ 谱系成环</h2>
        ${ped.cycles.map(c => `<div class="alert error path-chain">${c.path.map(esc).join(" → ")}（沿 ${c.sides.map(s => SIDE[s]).join("→")} 线回到自身）</div>`).join("")}
        <p class="meta">成环意味着谱系数据存在矛盾（某羽同时是自己的祖先），请核对档案。</p>
      </div>` : "";

    const flagsHtml = `
      <div class="panel">
        <h2>检测结论</h2>
        <div>
          ${ped.repeatedAncestors.length
            ? ped.repeatedAncestors.map(r => `<span class="pill amber">重复祖先 ${esc(r.ringNo)} ×${r.count}</span>`).join("")
            : '<span class="pill green">五代内无重复祖先</span>'}
          ${ped.missingParents.length
            ? ped.missingParents.map(m => `<span class="pill red">${esc(m.ringNo)} 缺${SIDE[m.side]}鸽</span>`).join("")
            : '<span class="pill green">已登记节点父母齐全</span>'}
          ${ped.cycles.length ? '<span class="pill red">谱系成环</span>' : '<span class="pill green">未发现成环</span>'}
          ${ped.truncated ? '<span class="pill blue">已达五代上限，更高祖先被截断</span>' : ""}
        </div>
      </div>`;

    const descRows = desc.descendants.map(d => `
      <tr><td>${esc(d.ringNo)}</td><td>第 ${d.generation} 代</td>
      <td>${d.paths.length}</td>
      <td class="path-chain">${esc(d.paths[0].map(step => step.to).join(" → "))}</td></tr>`).join("");

    result.innerHTML = `
      ${cycleHtml}
      ${flagsHtml}
      <div class="panel">
        <h2>${esc(ring)} 的五代祖先谱系</h2>
        <div class="legend">
          <span><span class="node root" style="padding:1px 6px">本鸽</span></span>
          <span><span class="node repeat" style="padding:1px 6px">重复祖先</span></span>
          <span><span class="node unregistered" style="padding:1px 6px">引用了未登记鸽</span></span>
        </div>
        <div class="tree"><ul><li>${renderTreeNode(ped.tree, ring, repeatedSet)}</li></ul></div>
      </div>
      <div class="panel">
        <h2>全部后代（${desc.descendants.length} 羽）</h2>
        ${desc.descendants.length ? `<div style="overflow-x:auto"><table>
          <thead><tr><th>环号</th><th>代数</th><th>路径数</th><th>其中一条路径</th></tr></thead>
          <tbody>${descRows}</tbody></table></div>` : '<p class="meta">暂无登记后代。</p>'}
      </div>`;
  } catch (err) {
    showMsg(msg, "error", esc(err.message));
  }
}
$("#pedBtn").onclick = loadPedigree;
$("#pedRing").addEventListener("keydown", e => { if (e.key === "Enter") loadPedigree(); });

// ---------- 近交分析 ----------
$("#inbBtn").onclick = async () => {
  const ringA = $("#inbA").value.trim();
  const ringB = $("#inbB").value.trim();
  const msg = $("#inbMsg");
  const result = $("#inbResult");
  result.innerHTML = "";
  if (!ringA || !ringB) return showMsg(msg, "warn", "请填写两个环号");
  try {
    const r = await api(`/api/breeding/inbreeding?ringA=${encodeURIComponent(ringA)}&ringB=${encodeURIComponent(ringB)}`);
    showMsg(msg, "", "");
    const over = r.exceedsThreshold;
    result.innerHTML = `
      <div class="panel">
        <h2>${esc(ringA)} × ${esc(ringB)}</h2>
        <div class="grid2">
          <div>
            <div class="meta">后代预期近交系数 F</div>
            <div class="coef-big" style="color:${over ? "var(--red)" : "var(--green)"}">${pct(r.coefficient)}</div>
            <div style="margin-top:8px">
              <span class="pill ${over ? "red" : "green"}">${over ? `超过门槛 ${pct(r.threshold)}，配对将被拦截` : `未超门槛 ${pct(r.threshold)}`}</span>
              ${r.cycles.length ? '<span class="pill red">谱系成环，系数为截断结果</span>' : ""}
            </div>
          </div>
          <dl class="kv">
            <dt>共同祖先数</dt><dd>${r.commonAncestors.length}</dd>
            <dt>审计编号</dt><dd>#${r.auditId}</dd>
          </dl>
        </div>
      </div>
      ${r.cycles.length ? `<div class="panel"><h2>成环</h2>${r.cycles.map(c => `<div class="alert error path-chain">${c.path.map(esc).join(" → ")}</div>`).join("")}</div>` : ""}
      <div class="panel">
        <h2>共同祖先路径（${r.commonAncestors.length}）</h2>
        ${r.commonAncestors.length ? `<div style="overflow-x:auto"><table>
          <thead><tr><th>共同祖先</th><th>路径明细</th><th class="right">贡献</th></tr></thead>
          <tbody>${r.commonAncestors.map(c => `
            <tr>
              <td><b>${esc(c.ringNo)}</b><br>
                <span class="meta">${c.registered ? "" : "未登记 · "}${c.founder ? "始祖(F=0)" : `自身近交 ${pct(c.inbreedingOfAncestor)}`}</span>
              </td>
              <td>${c.paths.map(p => `
                <div class="path-chain" style="margin-bottom:4px">
                  ${p.nodesA.map(esc).reverse().join(" ← ")} ⇅ ${p.nodesB.map(esc).reverse().join(" ← ")}
                  <span class="meta">(上${p.generationsA}代 / 上${p.generationsB}代)</span>
                </div>`).join("")}
              </td>
              <td class="right">${pct(c.contribution)}</td>
            </tr>`).join("")}
          </tbody></table></div>` : '<p class="meta">无共同祖先，近交系数为 0。</p>'}
      </div>`;
  } catch (err) {
    showMsg(msg, "error", esc(err.message));
  }
};

// ---------- 配对 ----------
async function loadPairings() {
  const pairings = await api("/api/breeding/pairings");
  $("#pairTable tbody").innerHTML = pairings.map(p => `
    <tr>
      <td>#${p.id}</td><td class="meta">${esc(new Date(p.time).toLocaleString())}</td>
      <td>${esc(p.ringA)}</td><td>${esc(p.ringB)}</td>
      <td>${pct(p.coefficient)}</td><td>${p.commonAncestorCount}</td>
      <td>${esc(p.note || "")}</td>
    </tr>`).join("") || '<tr><td colspan="7" class="meta">暂无配对记录</td></tr>';
  $("#pairThresholdText").textContent = pct(state.settings.inbreedingThreshold);
}

$("#pairBtn").onclick = async () => {
  const ringA = $("#pairA").value.trim();
  const ringB = $("#pairB").value.trim();
  const note = $("#pairNote").value.trim();
  const msg = $("#pairMsg");
  if (!ringA || !ringB) return showMsg(msg, "warn", "请填写两个环号");
  try {
    const r = await api("/api/breeding/pairings", {
      method: "POST",
      body: JSON.stringify({ ringA, ringB, note }),
    });
    showMsg(msg, "ok", `配对已建立：${esc(r.pairing.ringA)} × ${esc(r.pairing.ringB)}，近交系数 ${pct(r.pairing.coefficient)}，审计 #${r.auditId}${
      r.warnings.length ? r.warnings.map(w => `<br>⚠️ ${esc(w.message)}`).join("") : ""}`);
    $("#pairA").value = ""; $("#pairB").value = ""; $("#pairNote").value = "";
    await loadPairings();
  } catch (err) {
    const d = err.data || {};
    const violations = (d.violations || []).map(v => `<li>${esc(v.message || v.code)}</li>`).join("");
    const warnings = (d.warnings || []).map(w => `<li class="meta">${esc(w.message)}</li>`).join("");
    showMsg(msg, "error", `配对被拦截（审计 #${d.auditId ?? "—"}，系数 ${d.coefficient == null ? "—" : pct(d.coefficient)}）<ul style="margin:6px 0">${violations}${warnings}</ul>`);
  }
};

// ---------- 审计 ----------
async function loadAudit() {
  const type = $("#auditType").value;
  const items = (await api(`/api/audit?limit=200${type ? `&type=${encodeURIComponent(type)}` : ""}`)).items;
  const ACTION = {
    inbreeding_analysis: "近交分析",
    pairing_create: "配对建立",
    pairing_rejected: "配对拦截",
    settings_update: "门槛修改",
  };
  $("#auditTable tbody").innerHTML = items.map(a => `
    <tr>
      <td>#${a.id}</td>
      <td class="meta">${esc(new Date(a.time).toLocaleString())}</td>
      <td>${ACTION[a.action] || esc(a.action)}</td>
      <td>${a.result === "ok" ? '<span class="pill green">成功</span>' : '<span class="pill red">拦截</span>'}</td>
      <td class="path-chain">${esc(Object.entries(a.input || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" "))}</td>
      <td class="path-chain meta">${esc(formatDetails(a))}</td>
    </tr>`).join("") || '<tr><td colspan="6" class="meta">暂无审计记录</td></tr>';
}
function formatDetails(a) {
  const d = a.details || {};
  if (a.action === "inbreeding_analysis") {
    return `F=${d.coefficient} 门槛=${d.threshold}${d.exceedsThreshold ? " 超限" : ""} 共同祖先=${(d.commonAncestors || []).map(c => c.ringNo).join(",")}${(d.cycles || []).length ? ` 成环=${d.cycles.join(" / ")}` : ""}`;
  }
  if (a.action === "pairing_create") {
    return `配对#${d.pairingId} F=${d.coefficient} 共同祖先=${(d.commonAncestors || []).map(c => c.ringNo).join(",")}`;
  }
  if (a.action === "pairing_rejected") {
    return `F=${d.coefficient ?? "—"} 原因=${(d.violations || []).map(v => v.code).join(",")}`;
  }
  if (a.action === "settings_update") return `${d.previous} → ${a.input.inbreedingThreshold}`;
  return JSON.stringify(d);
}
$("#auditReload").onclick = loadAudit;
$("#auditType").onchange = loadAudit;

// ---------- 门槛 ----------
$("#thresholdSave").onclick = async () => {
  const v = Number($("#threshold").value);
  try {
    const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ inbreedingThreshold: v }) });
    state.settings = r.settings;
    $("#threshold").value = r.settings.inbreedingThreshold;
    $("#pairThresholdText").textContent = pct(r.settings.inbreedingThreshold);
    alert(`门槛已保存为 ${pct(r.settings.inbreedingThreshold)}，已写审计 #${r.auditId}`);
  } catch (err) {
    alert(err.message);
  }
};

// ---------- 初始化 ----------
(async function init() {
  try {
    state.settings = await api("/api/settings");
    $("#threshold").value = state.settings.inbreedingThreshold;
    $("#pairThresholdText").textContent = pct(state.settings.inbreedingThreshold);
    await loadPigeons();
  } catch (err) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="alert error">初始化失败：${esc(err.message)}</div>`);
  }
})();
