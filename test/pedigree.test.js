import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndex,
  analyzeMating,
  evaluatePairing,
  getPedigree,
  getDescendants,
  findCycle,
} from "../src/pedigree.js";

const P = (ringNo, fatherRing = "", motherRing = "") => ({ ringNo, fatherRing, motherRing });
const idx = (rows) => buildIndex(rows);
const coef = (db, a, b, t = null) => analyzeMating(db, a, b, t).coefficient;

// 无亲缘的四个始祖
const FOUNDERS = ["A", "B", "C", "D", "M", "N", "X", "Y"].map(r => P(r));

describe("Wright 近交系数 — 经典构型", () => {
  test("无亲缘始祖 F=0", () => {
    assert.equal(coef(idx(FOUNDERS), "A", "B"), 0);
  });

  test("半同胞 F=1/8", () => {
    // E=A×C，F鸽=A×D，共享父 A
    const db = idx([...FOUNDERS, P("E", "A", "C"), P("F鸽", "A", "D")]);
    assert.equal(coef(db, "E", "F鸽"), 0.125);
  });

  test("全同胞 F=1/4", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B"), P("H", "A", "B")]);
    assert.equal(coef(db, "G", "H"), 0.25);
  });

  test("父女配 F=1/4（路径长度含 0）", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B")]);
    assert.equal(coef(db, "A", "G"), 0.25);
  });

  test("母子配同样 F=1/4", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B")]);
    assert.equal(coef(db, "B", "G"), 0.25);
  });

  test("祖孙配 F=1/8", () => {
    // I=G×C，G=A×B；A 是 I 的祖父
    const db = idx([...FOUNDERS, P("G", "A", "B"), P("I", "G", "C")]);
    assert.equal(coef(db, "A", "I"), 0.125);
  });

  test("堂/表亲 F=1/32", () => {
    // E=A×C，F鸽=A×D；J=E×X，K=F鸽×Y
    const db = idx([
      ...FOUNDERS,
      P("E", "A", "C"), P("F鸽", "A", "D"),
      P("J", "E", "X"), P("K", "F鸽", "Y"),
    ]);
    assert.equal(coef(db, "J", "K"), 0.03125);
  });

  test("共同祖先本身近交 F_P=1/4 时，半同胞型配对 F=0.15625", () => {
    // G、H 为 A×B 全同胞；P=G×H（F_P=0.25）；Q=P×M，R=P×N
    const db = idx([
      ...FOUNDERS,
      P("G", "A", "B"), P("H", "A", "B"),
      P("P", "G", "H"),
      P("Q", "P", "M"), P("R", "P", "N"),
    ]);
    const result = analyzeMating(db, "Q", "R");
    assert.equal(result.coefficient, 0.15625);
    assert.equal(result.commonAncestors.length, 1);
    assert.equal(result.commonAncestors[0].ringNo, "P");
    assert.equal(result.commonAncestors[0].inbreedingOfAncestor, 0.25);
  });

  test("共同祖先路径明细与贡献可核对", () => {
    const db = idx([...FOUNDERS, P("E", "A", "C"), P("F鸽", "A", "D")]);
    const r = analyzeMating(db, "E", "F鸽");
    assert.equal(r.commonAncestors.length, 1);
    const c = r.commonAncestors[0];
    assert.equal(c.ringNo, "A");
    assert.equal(c.paths.length, 1);
    const path = c.paths[0];
    assert.equal(path.generationsA, 1);
    assert.equal(path.generationsB, 1);
    assert.equal(path.contribution, 0.125);
    assert.deepEqual(path.nodesA, ["E", "A"]);
    assert.deepEqual(path.nodesB, ["F鸽", "A"]);
  });

  test("全同胞明细包含父系与母系两条共同祖先", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B"), P("H", "A", "B")]);
    const r = analyzeMating(db, "G", "H");
    const rings = r.commonAncestors.map(c => c.ringNo).sort();
    assert.deepEqual(rings, ["A", "B"]);
    for (const c of r.commonAncestors) assert.equal(c.contribution, 0.125);
  });

  test("结果与性别顺序无关（对称性）", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B"), P("H", "A", "B")]);
    assert.equal(coef(db, "G", "H"), coef(db, "H", "G"));
  });
});

describe("五代谱系与标记", () => {
  test("重复祖先被统计并带出现次数", () => {
    // J 的父系与母系都汇入 A：E=A×C，F鸽=A×D，J=E×F鸽
    const db = idx([
      ...FOUNDERS,
      P("E", "A", "C"), P("F鸽", "A", "D"), P("J", "E", "F鸽"),
    ]);
    const ped = getPedigree(db, "J");
    assert.deepEqual(ped.repeatedAncestors, [{ ringNo: "A", count: 2 }]);
  });

  test("缺失父母逐羽逐侧列出", () => {
    const db = idx([P("G", "A", ""), P("A")]); // A 父母双缺，G 缺母
    const ped = getPedigree(db, "G");
    const sides = ped.missingParents.map(m => `${m.ringNo}:${m.side}`).sort();
    assert.deepEqual(sides, ["A:father", "A:mother", "G:mother"]);
  });

  test("引用未登记祖先：节点标记 registered=false 且不崩", () => {
    const db = idx([P("G", "GHOST", "")]);
    const ped = getPedigree(db, "G");
    assert.equal(ped.tree.father.registered, false);
    assert.equal(ped.tree.father.ringNo, "GHOST");
  });

  test("超过五代的祖先链触发 truncated 且只建五层", () => {
    const rows = [];
    for (let i = 0; i < 9; i++) rows.push(P(`g${i}`, i === 0 ? "" : `g${i - 1}`, ""));
    const db = idx(rows);
    const ped = getPedigree(db, "g8");
    assert.equal(ped.truncated, true);
    let depth = 0;
    let node = ped.tree;
    while (node.father) { node = node.father; depth++; }
    assert.equal(depth, 5);
  });

  test("恰好五代不截断", () => {
    const rows = [];
    for (let i = 0; i <= 5; i++) rows.push(P(`g${i}`, i === 0 ? "" : `g${i - 1}`, ""));
    const db = idx(rows);
    assert.equal(getPedigree(db, "g5").truncated, false);
  });
});

describe("全部后代", () => {
  test("跨代数、多路径全部列出", () => {
    // A 的子女 E,F鸽；孙 J；J 又有子代 Q
    const db = idx([
      ...FOUNDERS,
      P("E", "A", "C"), P("F鸽", "A", "D"),
      P("J", "E", "F鸽"), P("Q", "J", "X"),
    ]);
    const { descendants } = getDescendants(db, "A");
    const map = new Map(descendants.map(d => [d.ringNo, d]));
    assert.deepEqual([...map.keys()].sort(), ["E", "F鸽", "J", "Q"]);
    assert.equal(map.get("E").generation, 1);
    assert.equal(map.get("J").generation, 2);
    assert.equal(map.get("Q").generation, 3);
    // J 经由 E 与 F鸽 两条路径都可回到 A
    assert.equal(map.get("J").paths.length, 2);
  });

  test("成环数据下后代枚举不死循环", () => {
    // A 父为 Q；Q=J×X；J=E×... E=A×C → A 是自己的祖先
    const db = idx([
      P("A", "Q", ""), P("C"), P("X"),
      P("E", "A", "C"), P("J", "E", "X"), P("Q", "J", "C"),
    ]);
    const { descendants } = getDescendants(db, "A");
    assert.ok(descendants.length > 0);
    assert.ok(descendants.length < 50);
    const rings = descendants.map(d => d.ringNo);
    assert.equal(new Set(rings).size, rings.length);
  });
});

describe("成环检测", () => {
  test("能发现自相矛盾的父线环并给出路径", () => {
    const db = idx([P("A", "X", ""), P("E", "A", "C"), P("X", "E", ""), P("C")]);
    const cy = findCycle(db, "A");
    assert.ok(cy);
    assert.equal(cy.path[0], cy.path[cy.path.length - 1]);
    assert.deepEqual(new Set(cy.path.slice(0, -1)), new Set(["A", "E", "X"]));
  });

  test("同一物理环只报告一次（旋转规范化）", () => {
    const db = idx([P("A", "X", ""), P("E", "A", "C"), P("X", "E", ""), P("C")]);
    const ped = getPedigree(db, "X");
    assert.equal(ped.cycles.length, 1);
  });

  test("无环谱系返回空", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B")]);
    assert.equal(findCycle(db, "G"), null);
  });

  test("成环数据上近交计算仍给出有限值并附带 cycles 警告来源", () => {
    const db = idx([
      P("A", "Q", ""), P("C"), P("X"),
      P("E", "A", "C"), P("J", "E", "X"), P("Q", "J", "C"),
    ]);
    const r = analyzeMating(db, "E", "X");
    assert.ok(Number.isFinite(r.coefficient));
    assert.ok(r.cycles.length >= 1);
  });
});

describe("配对规则 evaluatePairing", () => {
  test("同羽配对：same_pigeon", () => {
    const v = evaluatePairing(idx(FOUNDERS), "A", "A", 0.125);
    assert.equal(v.allowed, false);
    assert.deepEqual(v.violations.map(x => x.code), ["same_pigeon"]);
  });

  test("空环号：missing_ring", () => {
    assert.equal(evaluatePairing(idx(FOUNDERS), "", "B", 0.125).violations[0].code, "missing_ring");
  });

  test("档案不存在：pigeon_not_found", () => {
    const v = evaluatePairing(idx(FOUNDERS), "A", "ZZZ", 0.125);
    assert.deepEqual(v.violations.map(x => x.code), ["pigeon_not_found"]);
    assert.deepEqual(v.violations[0].missing, ["ZZZ"]);
  });

  test("父女配（两个方向都报）：parent_child", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B")]);
    assert.ok(evaluatePairing(db, "A", "G", 0.9).violations.some(v => v.code === "parent_child"));
    assert.ok(evaluatePairing(db, "G", "A", 0.9).violations.some(v => v.code === "parent_child"));
  });

  test("祖孙配：grandparent_grandchild", () => {
    const db = idx([...FOUNDERS, P("G", "A", "B"), P("I", "G", "C")]);
    const v = evaluatePairing(db, "A", "I", 0.9);
    assert.ok(v.violations.some(x => x.code === "grandparent_grandchild"));
  });

  test("全同胞超默认门槛被拦，半同胞等于门槛放行", () => {
    const db = idx([
      ...FOUNDERS,
      P("G", "A", "B"), P("H", "A", "B"),
      P("E", "A", "C"), P("F鸽", "A", "D"),
    ]);
    const full = evaluatePairing(db, "G", "H", 0.125);
    assert.ok(full.violations.some(v => v.code === "inbreeding_threshold"));
    assert.equal(full.allowed, false);
    const half = evaluatePairing(db, "E", "F鸽", 0.125);
    assert.equal(half.allowed, true);
    assert.equal(half.violations.length, 0);
  });

  test("门槛为 0 时半同胞也被拦截（非直系只靠阈值）", () => {
    const db = idx([...FOUNDERS, P("E", "A", "C"), P("F鸽", "A", "D")]);
    const v = evaluatePairing(db, "E", "F鸽", 0);
    assert.equal(v.allowed, false);
    assert.deepEqual(v.violations.map(x => x.code), ["inbreeding_threshold"]);
  });

  test("无亲缘始祖配对永远放行", () => {
    const v = evaluatePairing(idx(FOUNDERS), "A", "B", 0);
    assert.equal(v.allowed, true);
    assert.equal(v.coefficient, 0);
  });

  test("阈值边界严格大于才判超限", () => {
    assert.equal(analyzeMating(idx([P("A"), P("B")]), "A", "B", 0).exceedsThreshold, false);
  });
});
