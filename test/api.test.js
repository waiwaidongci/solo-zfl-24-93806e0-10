import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "../src/storage.js";
import { createApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..", "web");

let dir, store, server, base;

async function start(seed = null) {
  dir = await mkdtemp(join(tmpdir(), "pigeon-e2e-"));
  store = new JsonStore(join(dir, "registry.json"));
  await store.init(seed);
  const app = createApp(store, webRoot);
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
}

async function req(path, options = {}) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
const post = (path, obj) => req(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const put = (path, obj) => req(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

// 构造一个本鸽向上恰为五代的谱系，并刻意安排重复祖先：
//   T1 = GP1 × F2
//   GP1 = P1 × G3
//   P1 = G1 × G2
//   G1 = F1 × F2   G2 = F3 × F4   G3 = F1 × F3
//   F1 = FF1 × FF2  F2 = FF3 × FF4  F3 = FF1 × FF3  F4 = FF2 × FF4
const fiveGenSeed = () => {
  const pigeons = [
    { ringNo: "FF1", fatherRing: "", motherRing: "" },
    { ringNo: "FF2", fatherRing: "", motherRing: "" },
    { ringNo: "FF3", fatherRing: "", motherRing: "" },
    { ringNo: "FF4", fatherRing: "", motherRing: "" },
    { ringNo: "F1", fatherRing: "FF1", motherRing: "FF2" },
    { ringNo: "F2", fatherRing: "FF3", motherRing: "FF4" },
    { ringNo: "F3", fatherRing: "FF1", motherRing: "FF3" },
    { ringNo: "F4", fatherRing: "FF2", motherRing: "FF4" },
    { ringNo: "G1", fatherRing: "F1", motherRing: "F2" },
    { ringNo: "G2", fatherRing: "F3", motherRing: "F4" },
    { ringNo: "G3", fatherRing: "F1", motherRing: "F3" },
    { ringNo: "P1", fatherRing: "G1", motherRing: "G2" },
    { ringNo: "GP1", fatherRing: "P1", motherRing: "G3" },
    { ringNo: "T1", fatherRing: "GP1", motherRing: "F2" },
  ];
  return { pigeons };
};

describe("HTTP 端到端", () => {
  beforeEach(() => start(fiveGenSeed()));
  afterEach(stop);

  test("页面与静态资源可访问", async () => {
    const home = await req("/");
    assert.equal(home.status, 200);
    assert.match(home.body, /育种谱系/);
    const js = await req("/app.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const css = await req("/style.css");
    assert.equal(css.status, 200);
  });

  test("五代谱系：本鸽→父→…→始祖共五层，重复祖先与缺失被标出", async () => {
    const r = await req("/api/pigeons/T1/pedigree");
    assert.equal(r.status, 200);
    const { tree, repeatedAncestors, missingParents, cycles, maxGenerations } = r.body;
    assert.equal(maxGenerations, 5);
    assert.deepEqual(cycles, []);

    // 沿父线走 5 层：T1 -> GP1 -> P1 -> G1 -> F1 -> FF1（第 5 代）
    const chain = [];
    let n = tree;
    for (let i = 0; i <= 5; i++) { chain.push(n.ringNo); n = n.father; }
    assert.deepEqual(chain, ["T1", "GP1", "P1", "G1", "F1", "FF1"]);
    assert.equal(tree.father.father.father.father.father.father, null, "第五代之外不再展开");

    // F1 经 G1、G3 两条线出现；F2 既是 T1 的母又是 G1 的母 → 均为重复祖先
    const rings = repeatedAncestors.map(x => x.ringNo);
    assert.ok(rings.includes("F1"), `F1 应是重复祖先，实际 ${rings}`);
    assert.ok(rings.includes("F2"), `F2 应是重复祖先，实际 ${rings}`);
    assert.equal(repeatedAncestors.find(x => x.ringNo === "F1").count, 2);

    // 始祖 FF1..FF4 都缺父母
    const missingRings = new Set(missingParents.map(m => m.ringNo));
    for (const f of ["FF1", "FF2", "FF3", "FF4"]) assert.ok(missingRings.has(f));
  });

  test("全部后代：F1 向下能查到 G1/G3/P1/GP1/T1 并带代数", async () => {
    const r = await req("/api/pigeons/F1/descendants");
    assert.equal(r.status, 200);
    const map = new Map(r.body.descendants.map(d => [d.ringNo, d.generation]));
    assert.equal(map.get("G1"), 1);
    assert.equal(map.get("G3"), 1);
    assert.equal(map.get("P1"), 2);
    // GP1 = P1 × G3，G3 也是 F1 的子代 → 最短两代
    assert.equal(map.get("GP1"), 2);
    // T1 = GP1 × F2，经 GP1 最短三代
    assert.equal(map.get("T1"), 3);
    // T1 经 G1 线和 G3 线都能回溯到 F1 → 多条路径
    const t1 = r.body.descendants.find(d => d.ringNo === "T1");
    assert.ok(t1.paths.length >= 2);
  });

  test("成环检测：制造自相矛盾谱系后 API 标出环", async () => {
    // F1 的父改成 T1：F1 -> T1 -> GP1 -> P1 -> G1 -> F1
    const created = await post("/api/pigeons", { ringNo: "CYC", owner: "x", fatherRing: "CYC2", motherRing: "" });
    assert.equal(created.status, 201);
    await post("/api/pigeons", { ringNo: "CYC2", owner: "x", fatherRing: "CYC", motherRing: "" });
    const r = await req("/api/pigeons/CYC/pedigree");
    assert.equal(r.status, 200);
    assert.equal(r.body.cycles.length, 1);
    assert.deepEqual(new Set(r.body.cycles[0].path), new Set(["CYC", "CYC2", "CYC"]));
  });

  test("近交分析：全同胞型配对给 0.25 且写审计、列出共同祖先路径", async () => {
    const r = await req("/api/breeding/inbreeding?ringA=G1&ringB=G1X");
    // G1X 不存在 → 404
    assert.equal(r.status, 404);

    // 新增一羽与 G1 同为 F1×F2 的全同胞
    await post("/api/pigeons", { ringNo: "G1S", fatherRing: "F1", motherRing: "F2" });
    const ok = await req("/api/breeding/inbreeding?ringA=G1&ringB=G1S");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.coefficient, 0.25);
    assert.equal(ok.body.exceedsThreshold, true, "默认门槛 0.125，0.25 应超限");
    const ancestors = ok.body.commonAncestors.map(c => c.ringNo).sort();
    assert.deepEqual(ancestors, ["F1", "F2"]);
    assert.ok(ok.body.auditId > 0);
  });

  test("非法配对依次被拦截：同羽 / 父母子女 / 祖孙 / 超门槛，且不留配对记录", async () => {
    const same = await post("/api/breeding/pairings", { ringA: "F1", ringB: "F1" });
    assert.equal(same.status, 422);
    assert.ok(same.body.violations.some(v => v.code === "same_pigeon"));
    assert.ok(same.body.auditId, "拒绝也要有审计号");

    const pc = await post("/api/breeding/pairings", { ringA: "F1", ringB: "G1" });
    assert.equal(pc.status, 422);
    assert.ok(pc.body.violations.some(v => v.code === "parent_child"));

    const gp = await post("/api/breeding/pairings", { ringA: "F1", ringB: "P1" });
    assert.equal(gp.status, 422);
    assert.ok(gp.body.violations.some(v => v.code === "grandparent_grandchild"));

    // 超门槛：G1 与新增全同胞 G1S（0.25 > 0.125）
    await post("/api/pigeons", { ringNo: "G1S", fatherRing: "F1", motherRing: "F2" });
    const over = await post("/api/breeding/pairings", { ringA: "G1", ringB: "G1S" });
    assert.equal(over.status, 422);
    assert.ok(over.body.violations.some(v => v.code === "inbreeding_threshold"));

    // 不存在的环号
    const nf = await post("/api/breeding/pairings", { ringA: "G1", ringB: "NOPE" });
    assert.equal(nf.status, 422);
    assert.ok(nf.body.violations.some(v => v.code === "pigeon_not_found"));

    // 配对表里没有任何成功记录
    const list = await req("/api/breeding/pairings");
    assert.equal(list.body.length, 0);
  });

  test("合法配对成功写入，配对与审计在同一响应后均可查", async () => {
    // 两个无亲缘始祖 FF2 × FF4，F=0
    const r = await post("/api/breeding/pairings", { ringA: "FF2", ringB: "FF4", note: "远缘杂交" });
    assert.equal(r.status, 201);
    assert.equal(r.body.pairing.coefficient, 0);
    assert.equal(r.body.pairing.ringA, "FF2");
    assert.equal(r.body.pairing.note, "远缘杂交");
    assert.equal(r.body.pairing.id, r.body.auditId);

    const list = await req("/api/breeding/pairings");
    assert.equal(list.body.length, 1);
    const audits = await req("/api/audit?type=pairing");
    const createEntry = audits.body.items.find(a => a.action === "pairing_create");
    assert.ok(createEntry);
    assert.equal(createEntry.details.pairingId, r.body.pairing.id);
  });

  test("拒绝配对不产生半条数据：配对数与审计明细一致", async () => {
    await post("/api/breeding/pairings", { ringA: "F1", ringB: "F1" });
    await post("/api/breeding/pairings", { ringA: "F1", ringB: "F2" }).then(() => {}); // F1×F2 合法
    const rejected = await post("/api/breeding/pairings", { ringA: "G1", ringB: "F1" });
    assert.equal(rejected.status, 422);

    const pairings = (await req("/api/breeding/pairings")).body;
    const auditAll = (await req("/api/audit?type=pairing&limit=500")).body;
    const creates = auditAll.items.filter(a => a.action === "pairing_create");
    assert.equal(pairings.length, creates.length);
    const rejectedEntries = auditAll.items.filter(a => a.action === "pairing_rejected");
    assert.ok(rejectedEntries.length >= 2);
    for (const e of rejectedEntries) {
      assert.equal(e.result, "rejected");
      assert.ok(e.details.violations.length >= 1);
    }
  });

  test("门槛设置：非法值 400；改门槛后配对拦截随之变化并写审计", async () => {
    const bad = await put("/api/settings", { inbreedingThreshold: 2 });
    assert.equal(bad.status, 400);
    const bad2 = await put("/api/settings", { inbreedingThreshold: -0.1 });
    assert.equal(bad2.status, 400);

    await post("/api/pigeons", { ringNo: "G1S", fatherRing: "F1", motherRing: "F2" });
    // 默认 0.125：0.25 被拦
    assert.equal((await post("/api/breeding/pairings", { ringA: "G1", ringB: "G1S" })).status, 422);
    // 提高到 0.5：放行
    const saved = await put("/api/settings", { inbreedingThreshold: 0.5 });
    assert.equal(saved.status, 200);
    const ok = await post("/api/breeding/pairings", { ringA: "G1", ringB: "G1S" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.pairing.threshold, 0.5);

    const audits = await req("/api/audit?type=analysis");
    assert.ok(audits.body.items.some(a => a.action === "settings_update"));
  });

  test("重启保留：成功配对、拒绝审计、门槛修改在新实例里都查得到", async () => {
    await post("/api/pigeons", { ringNo: "G1S", fatherRing: "F1", motherRing: "F2" });
    await post("/api/breeding/pairings", { ringA: "F1", ringB: "F1" }); // 拒绝
    await put("/api/settings", { inbreedingThreshold: 0.3 });
    await post("/api/breeding/pairings", { ringA: "F1", ringB: "F3" }); // 成功
    await req("/api/breeding/inbreeding?ringA=G1&ringB=G1S"); // 分析

    const dataFile = join(dir, "registry.json");
    const before = JSON.parse(await readFile(dataFile, "utf8"));
    await new Promise(r => server.close(r));
    const store2 = new JsonStore(dataFile);
    await store2.init();
    const server2 = createApp(store2, webRoot);
    const address = await new Promise(resolve => {
      const s = server2.listen(0, () => resolve(s.address()));
      server = s;
    });
    base = `http://127.0.0.1:${address.port}`;

    assert.equal((await req("/api/breeding/pairings")).body.length, 1);
    const audits = (await req("/api/audit?limit=500")).body;
    const actions = audits.items.map(a => a.action);
    assert.ok(actions.includes("pairing_create"));
    assert.ok(actions.includes("pairing_rejected"));
    assert.ok(actions.includes("settings_update"));
    assert.ok(actions.includes("inbreeding_analysis"));
    assert.equal((await req("/api/settings")).body.inbreedingThreshold, 0.3);
    assert.equal((await req("/api/pigeons/T1/pedigree")).status, 200);
    // 磁盘内容与重启前一致
    assert.deepEqual(JSON.parse(await readFile(dataFile, "utf8")).audit.length, before.audit.length);
  });

  test("并发建立配对：成功者配对/审计一一对应，审计 id 不重复", async () => {
    // 新增 10 羽与 F* 无直系关系的对象，全部 F=0 合法
    for (let i = 0; i < 10; i++) {
      await post("/api/pigeons", { ringNo: `M${i}` });
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post("/api/breeding/pairings", { ringA: `M${i}`, ringB: "F2" })
      )
    );
    assert.ok(results.every(r => r.status === 201));
    const pairings = (await req("/api/breeding/pairings")).body;
    const audits = (await req("/api/audit?type=pairing&limit=500")).body;
    const creates = audits.items.filter(a => a.action === "pairing_create");
    assert.equal(pairings.length, 10);
    assert.equal(creates.length, 10);
    const pairingIds = pairings.map(p => p.id);
    assert.equal(new Set(pairingIds).size, 10);
    for (const p of pairings) {
      assert.ok(creates.some(a => a.details.pairingId === p.id));
    }
  });

  test("边界：坏 JSON 400、超大体 413、未知路由 404、缺环号 400", async () => {
    const bad = await req("/api/pigeons", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    const huge = await req("/api/pigeons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ringNo: "X", junk: "a".repeat(2_000_000) }),
    });
    assert.equal(huge.status, 413);
    assert.equal((await req("/api/nope")).status, 404);
    assert.equal((await req("/api/breeding/inbreeding?ringA=F1")).status, 400);
  });

  test("边界：重复环号 409、空环号 400、超长环号 400，且失败后档案不增加", async () => {
    assert.equal((await post("/api/pigeons", { ringNo: "F1" })).status, 409);
    assert.equal((await post("/api/pigeons", { ringNo: "  " })).status, 400);
    assert.equal((await post("/api/pigeons", { ringNo: "a".repeat(65) })).status, 400);
    const count = (await req("/api/pigeons")).body.length;
    assert.equal(count, fiveGenSeed().pigeons.length);
  });

  test("谱系/后代查询不存在环号返回 404", async () => {
    assert.equal((await req("/api/pigeons/NOPE/pedigree")).status, 404);
    assert.equal((await req("/api/pigeons/NOPE/descendants")).status, 404);
  });
});
