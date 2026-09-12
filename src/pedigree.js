// 谱系与近交分析核心算法（纯函数，不碰持久化）
//
// 数据模型：pigeon = { ringNo, fatherRing, motherRing, ... }
// fatherRing/motherRing 为 "" 或 null 表示未知；非空但在档案中找不到表示“引用了未登记的祖先”。

export const MAX_ANCESTOR_GENERATIONS = 5;
// 深度防环上限：真实鸽谱极深也很少超过 20 代，成环数据靠 cycle 检测单独呈现
const MAX_TRAVERSAL_DEPTH = 50;

/** 建立 ringNo -> pigeon 索引，重复环号只保留第一羽 */
export function buildIndex(pigeons) {
  const byRing = new Map();
  for (const p of pigeons) {
    if (p && !byRing.has(p.ringNo)) byRing.set(p.ringNo, p);
  }
  return byRing;
}

function parentRingOf(pigeon, side) {
  return (side === "father" ? pigeon.fatherRing : pigeon.motherRing) || "";
}

/** 找到从 ringNo 出发沿父/母边可回到自身的环，返回 { path:[...,ringNo], sides:[...] }，无环返回 null */
export function findCycle(byRing, ringNo) {  const dfs = (ring, trail, sideTrail) => {
    if (!byRing.has(ring)) return null;
    const hit = trail.indexOf(ring);
    if (hit >= 0) return { path: [...trail.slice(hit), ring], sides: sideTrail.slice(hit) };
    if (trail.length >= MAX_TRAVERSAL_DEPTH) return null;
    const pigeon = byRing.get(ring);
    for (const side of ["father", "mother"]) {
      const next = parentRingOf(pigeon, side);
      if (!next) continue;
      const result = dfs(next, [...trail, ring], [...sideTrail, side]);
      if (result) return result;
    }
    return null;
  };
  return dfs(ringNo, [], []);
}

function buildAncestorTree(byRing, rootRing, maxGenerations) {
  const occurrences = []; // 祖先每次出现都记录，供重复统计
  let truncated = false;

  const build = (ring, gen, side, occurrencePath) => {
    const node = {
      ringNo: ring,
      generation: gen,
      registered: byRing.has(ring),
      side,
      missingParentRings: [],
      father: null,
      mother: null,
      occurrences: 1,
    };
    occurrences.push({ ringNo: ring, generation: gen });

    const pigeon = byRing.get(ring);
    if (!pigeon) return node; // 未登记祖先：无法继续向上

    for (const parentSide of ["father", "mother"]) {
      const parentRing = parentRingOf(pigeon, parentSide);
      if (parentRing) {
        if (gen >= maxGenerations) {
          truncated = true;
          continue;
        }
        node[parentSide] = build(parentRing, gen + 1, parentSide, [
          ...occurrencePath,
          { from: ring, side: parentSide, to: parentRing },
        ]);
      } else {
        node.missingParentRings.push(parentSide);
      }
    }
    return node;
  };

  const root = build(rootRing, 0, "root", []);

  const counts = new Map();
  for (const occ of occurrences) {
    if (occ.ringNo === rootRing) continue; // 本鸽自身不算“重复祖先”
    counts.set(occ.ringNo, (counts.get(occ.ringNo) || 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([ringNo, count]) => ({ ringNo, count }))
    .sort((a, b) => b.count - a.count || a.ringNo.localeCompare(b.ringNo));

  const fill = (node) => {
    if (!node) return;
    node.occurrences = node.ringNo === rootRing ? 1 : counts.get(node.ringNo) || 1;
    fill(node.father);
    fill(node.mother);
  };
  fill(root);

  return { tree: root, repeated, truncated };
}

/**
 * 五代以内祖先谱系。
 * 返回 tree / repeatedAncestors / missingParents / cycles / truncated / exists / children
 */
export function getPedigree(byRing, ringNo, maxGenerations = MAX_ANCESTOR_GENERATIONS) {
  if (!byRing.has(ringNo)) return { exists: false, ringNo };

  const { tree, repeated, truncated } = buildAncestorTree(byRing, ringNo, maxGenerations);

  const missingParents = [];
  const walk = (node) => {
    if (!node) return;
    if (node.registered) {
      for (const side of node.missingParentRings) {
        missingParents.push({ ringNo: node.ringNo, side });
      }
    }
    walk(node.father);
    walk(node.mother);
  };
  walk(tree);

  // 谱系里出现过的每个环号各自做一次成环检测（同一环不重复报告）
  const cycleRoots = new Set();
  const collect = (node) => {
    if (!node) return;
    cycleRoots.add(node.ringNo);
    collect(node.father);
    collect(node.mother);
  };
  collect(tree);
  // 同一物理环从不同节点各会被检测一次，按“最小环号为起点”的旋转规范化去重
  const seenCycles = new Set();
  const cycles = [];
  for (const r of cycleRoots) {
    const cy = findCycle(byRing, r);
    if (!cy) continue;
    const nodes = cy.path.slice(0, -1); // 去掉重复的收尾节点
    const start = nodes.reduce((best, ring, i) => (ring < nodes[best] ? i : best), 0);
    const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
    const key = rotated.join("→");
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    cycles.push({
      path: [...rotated, rotated[0]],
      sides: [...cy.sides.slice(start), ...cy.sides.slice(0, start)],
    });
  }

  const children = [];
  for (const p of byRing.values()) {
    if (p.fatherRing === ringNo) children.push({ ringNo: p.ringNo, side: "father" });
    if (p.motherRing === ringNo) children.push({ ringNo: p.ringNo, side: "mother" });
  }

  return {
    exists: true,
    ringNo,
    maxGenerations,
    tree,
    repeatedAncestors: repeated,
    missingParents,
    cycles,
    truncated,
    children: children.sort((a, b) => a.ringNo.localeCompare(b.ringNo)),
  };
}

/**
 * 全部后代（BFS，带成环保护）。
 * 返回 [{ ringNo, generation, paths: [[{from,to,side}...]] }]
 */
export function getDescendants(byRing, ringNo) {
  if (!byRing.has(ringNo)) return { exists: false, ringNo, descendants: [] };

  const childrenOf = new Map();
  for (const p of byRing.values()) {
    for (const side of ["fatherRing", "motherRing"]) {
      const parent = p[side];
      if (!parent) continue;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push({
        ringNo: p.ringNo,
        side: side === "fatherRing" ? "father" : "mother",
      });
    }
  }

  const seen = new Map(); // ringNo -> { generation, paths }
  const queue = [{ ring: ringNo, gen: 0, path: [] }];

  while (queue.length) {
    const { ring, gen, path } = queue.shift();
    if (gen > 0) {
      if (!seen.has(ring)) seen.set(ring, { ringNo: ring, generation: gen, paths: [path] });
      else {
        const rec = seen.get(ring);
        rec.paths.push(path);
        rec.generation = Math.min(rec.generation, gen);
      }
    }
    if (gen >= MAX_TRAVERSAL_DEPTH) continue;
    const pathNodes = new Set(path.map(s => s.to));
    for (const child of childrenOf.get(ring) || []) {
      // 回到起点或回到当前路径上已有的节点 = 成环，不入队，防止死循环
      if (child.ringNo === ringNo || pathNodes.has(child.ringNo)) continue;
      queue.push({
        ring: child.ringNo,
        gen: gen + 1,
        path: [...path, { from: ring, to: child.ringNo, side: child.side }],
      });
    }
  }

  const descendants = [...seen.values()].sort(
    (a, b) => a.generation - b.generation || a.ringNo.localeCompare(b.ringNo)
  );
  return { exists: true, ringNo, descendants };
}

/**
 * 枚举 ring 到其全部“祖先候选”的箭头路径，包含长度为 0 的自身路径。
 * 每条路径：{ ancestor, sides:["father",...], nodes:[ring, ..., ancestor] }
 * trail 保证单条路径上节点不重复（成环保护）。
 */
function enumeratePaths(byRing, ring, depth, trail, sides, nodes, out) {
  out.push({ ancestor: ring, sides: [...sides], nodes: [...nodes] });
  if (depth >= MAX_TRAVERSAL_DEPTH) return;
  const pigeon = byRing.get(ring);
  if (!pigeon) return;
  for (const side of ["father", "mother"]) {
    const parent = parentRingOf(pigeon, side);
    if (!parent || trail.has(parent)) continue;
    trail.add(parent);
    sides.push(side);
    nodes.push(parent);
    enumeratePaths(byRing, parent, depth + 1, trail, sides, nodes, out);
    sides.pop();
    nodes.pop();
    trail.delete(parent);
  }
}

function pathsUp(byRing, ring, memo) {
  if (memo.paths.has(ring)) return memo.paths.get(ring);
  const out = [];
  enumeratePaths(byRing, ring, 0, new Set([ring]), [], [ring], out);
  memo.paths.set(ring, out);
  return out;
}

function isFounder(byRing, ring) {
  const p = byRing.get(ring);
  return !!p && !p.fatherRing && !p.motherRing;
}

/** 某羽鸽的近交系数 F = 其父母的共祖度（Wright），带 memo 与成环保护 */
function inbreedCoeff(byRing, ring, memo, computing) {
  if (memo.f.has(ring)) return memo.f.get(ring);
  const pigeon = byRing.get(ring);
  if (!pigeon || !pigeon.fatherRing || !pigeon.motherRing || pigeon.fatherRing === pigeon.motherRing) {
    memo.f.set(ring, 0);
    return 0;
  }
  if (computing.has(ring)) return 0; // 谱系成环：截断递归
  computing.add(ring);
  const f = coancestry(byRing, pigeon.fatherRing, pigeon.motherRing, memo, computing);
  computing.delete(ring);
  memo.f.set(ring, f);
  return f;
}

/**
 * 共祖度（亲缘系数）f(A,B)，Wright 路径公式：
 *   对每个共同祖先 C 与每一对路径（A→…→C、B→…→C），
 *   仅当两条路径除 C 外没有任何共有节点时计入：
 *       (1/2)^(nA+nB+1) * (1 + F_C)
 * 该规则对父女配（nA=0）、全/半同胞、祖孙、表亲等构型均给出标准结果。
 */
function coancestry(byRing, ringA, ringB, memo, computing) {
  if (!byRing.has(ringA) || !byRing.has(ringB)) return 0;
  const key = ringA < ringB ? `${ringA}|${ringB}` : `${ringB}|${ringA}`;
  if (memo.kin.has(key)) return memo.kin.get(key);
  if (computing.has(key)) return 0;
  computing.add(key);

  const pathsA = pathsUp(byRing, ringA, memo);
  const pathsB = pathsUp(byRing, ringB, memo);
  const byAncestorA = groupByAncestor(pathsA);
  const byAncestorB = groupByAncestor(pathsB);

  let f = 0;
  for (const [ancestor, listA] of byAncestorA) {
    const listB = byAncestorB.get(ancestor);
    if (!listB) continue;
    const fAncestor = isFounder(byRing, ancestor)
      ? 0
      : inbreedCoeff(byRing, ancestor, memo, computing);
    for (const pa of listA) {
      const setA = new Set(pa.nodes);
      for (const pb of listB) {
        let shared = 0;
        for (const node of pb.nodes) if (setA.has(node)) shared++;
        if (shared !== 1) continue; // 两条路径只能在共同祖先 C 处相交
        f += Math.pow(0.5, pa.sides.length + pb.sides.length + 1) * (1 + fAncestor);
      }
    }
  }

  computing.delete(key);
  memo.kin.set(key, f);
  return f;
}

function groupByAncestor(paths) {
  const map = new Map();
  for (const p of paths) {
    if (!map.has(p.ancestor)) map.set(p.ancestor, []);
    map.get(p.ancestor).push(p);
  }
  return map;
}

/**
 * 计算任意两羽赛鸽配对所产后代的近交系数，并列出共同祖先路径明细。
 */
export function analyzeMating(byRing, ringA, ringB, threshold = null) {
  const existsA = byRing.has(ringA);
  const existsB = byRing.has(ringB);
  if (!existsA || !existsB) {
    return {
      exists: false,
      ringA,
      ringB,
      missing: [!existsA ? ringA : null, !existsB ? ringB : null].filter(Boolean),
      coefficient: null,
      commonAncestors: [],
      cycles: [],
    };
  }

  const memo = { f: new Map(), kin: new Map(), paths: new Map() };
  const coefficient = coancestry(byRing, ringA, ringB, memo, new Set());

  // 复用已枚举路径，整理共同祖先明细
  const byAncestorA = groupByAncestor(pathsUp(byRing, ringA, memo));
  const byAncestorB = groupByAncestor(pathsUp(byRing, ringB, memo));
  const commonAncestors = [];
  for (const [ancestor, listA] of byAncestorA) {
    const listB = byAncestorB.get(ancestor);
    if (!listB) continue;
    const fAncestor = isFounder(byRing, ancestor) ? 0 : (memo.f.get(ancestor) ?? 0);
    const paths = [];
    for (const pa of listA) {
      const setA = new Set(pa.nodes);
      for (const pb of listB) {
        let shared = 0;
        for (const node of pb.nodes) if (setA.has(node)) shared++;
        if (shared !== 1) continue;
        paths.push({
          fromA: ringA,
          sidesA: pa.sides,
          nodesA: pa.nodes,
          generationsA: pa.sides.length,
          fromB: ringB,
          sidesB: pb.sides,
          nodesB: pb.nodes,
          generationsB: pb.sides.length,
          contribution: Number(
            (Math.pow(0.5, pa.sides.length + pb.sides.length + 1) * (1 + fAncestor)).toFixed(10)
          ),
        });
      }
    }
    if (!paths.length) continue;
    paths.sort((x, y) => y.contribution - x.contribution);
    commonAncestors.push({
      ringNo: ancestor,
      registered: byRing.has(ancestor),
      founder: isFounder(byRing, ancestor),
      inbreedingOfAncestor: Number(fAncestor.toFixed(10)),
      paths,
      contribution: Number(paths.reduce((s, p) => s + p.contribution, 0).toFixed(10)),
    });
  }
  commonAncestors.sort((x, y) => y.contribution - x.contribution || x.ringNo.localeCompare(y.ringNo));

  const cycles = [];
  const seenCycles = new Set();
  for (const c of [findCycle(byRing, ringA), findCycle(byRing, ringB)]) {
    if (!c) continue;
    const nodes = c.path.slice(0, -1);
    const start = nodes.reduce((best, ring, i) => (ring < nodes[best] ? i : best), 0);
    const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
    const key = rotated.join("→");
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    cycles.push({ path: [...rotated, rotated[0]], sides: [...c.sides.slice(start), ...c.sides.slice(0, start)] });
  }

  return {
    exists: true,
    ringA,
    ringB,
    coefficient: Number(coefficient.toFixed(10)),
    commonAncestors,
    cycles,
    ...(threshold === null ? {} : {
      threshold,
      exceedsThreshold: coefficient > threshold + 1e-12,
    }),
  };
}

/**
 * 配对规则校验。按优先级返回违规：
 * same_pigeon / pigeon_not_found / parent_child / grandparent_grandchild /
 * inbreeding_threshold；成环作为警告（不影响规则计算）。
 */
export function evaluatePairing(byRing, ringA, ringB, threshold) {
  const violations = [];
  const warnings = [];

  if (!ringA || !ringB) {
    return {
      allowed: false,
      violations: [{ code: "missing_ring", message: "配对双方环号都必须填写" }],
      warnings,
      coefficient: null,
      commonAncestors: [],
    };
  }
  if (ringA === ringB) {
    return {
      allowed: false,
      violations: [{ code: "same_pigeon", message: `${ringA} 不能与自身配对` }],
      warnings,
      coefficient: null,
      commonAncestors: [],
    };
  }

  const missing = [];
  if (!byRing.has(ringA)) missing.push(ringA);
  if (!byRing.has(ringB)) missing.push(ringB);
  if (missing.length) {
    return {
      allowed: false,
      violations: [{ code: "pigeon_not_found", message: `档案中不存在：${missing.join("、")}`, missing }],
      warnings,
      coefficient: null,
      commonAncestors: [],
    };
  }

  const a = byRing.get(ringA);
  const b = byRing.get(ringB);

  if (a.fatherRing === ringB || a.motherRing === ringB) {
    violations.push({
      code: "parent_child",
      message: `${ringB} 是 ${ringA} 的${a.fatherRing === ringB ? "父" : "母"}鸽，禁止父母与子女配对`,
    });
  }
  if (b.fatherRing === ringA || b.motherRing === ringA) {
    violations.push({
      code: "parent_child",
      message: `${ringA} 是 ${ringB} 的${b.fatherRing === ringA ? "父" : "母"}鸽，禁止父母与子女配对`,
    });
  }

  const grandparentRingsOf = (pigeon) => {
    const rings = [];
    for (const pRing of [pigeon.fatherRing, pigeon.motherRing].filter(Boolean)) {
      const parent = byRing.get(pRing);
      if (!parent) continue;
      if (parent.fatherRing) rings.push(parent.fatherRing);
      if (parent.motherRing) rings.push(parent.motherRing);
    }
    return rings;
  };
  if (grandparentRingsOf(a).includes(ringB)) {
    violations.push({ code: "grandparent_grandchild", message: `${ringB} 是 ${ringA} 的祖父/母鸽，禁止祖孙配对` });
  }
  if (grandparentRingsOf(b).includes(ringA)) {
    violations.push({ code: "grandparent_grandchild", message: `${ringA} 是 ${ringB} 的祖父/母鸽，禁止祖孙配对` });
  }

  const analysis = analyzeMating(byRing, ringA, ringB, threshold);
  if (analysis.cycles.length) {
    warnings.push({
      code: "pedigree_cycle",
      message: "谱系存在成环，近交系数按截断后的可计算部分得出",
      cycles: analysis.cycles,
    });
  }
  if (typeof threshold === "number" && analysis.coefficient > threshold + 1e-12) {
    violations.push({
      code: "inbreeding_threshold",
      message: `近交系数 ${analysis.coefficient} 超过门槛 ${threshold}`,
      coefficient: analysis.coefficient,
      threshold,
    });
  }

  return {
    allowed: violations.length === 0,
    violations,
    warnings,
    coefficient: analysis.coefficient,
    commonAncestors: analysis.commonAncestors,
  };
}
