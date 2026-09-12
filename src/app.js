// HTTP 应用：在原有档案/转让/成绩接口之上，增加
// 谱系、后代、近交分析、配对拦截、审计、设置接口。

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import {
  buildIndex,
  getPedigree,
  getDescendants,
  analyzeMating,
  evaluatePairing,
} from "./pedigree.js";
import { JsonStore } from "./storage.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) {
      tooLarge = true; // 继续排空请求体，避免客户端尚未发完就收到响应导致连接失败
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error("请求体过大"), { status: 413 });
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON 解析失败"), { status: 400 });
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const today = () => new Date().toISOString().slice(0, 10);

function newPigeon(input) {
  const ringNo = String(input.ringNo || "").trim();
  if (!ringNo) throw Object.assign(new Error("足环号不能为空"), { status: 400, code: "ring_required" });
  if (ringNo.length > 64) throw Object.assign(new Error("足环号过长"), { status: 400, code: "ring_too_long" });
  return {
    ringNo,
    owner: String(input.owner || "").trim(),
    fatherRing: String(input.fatherRing || "").trim(),
    motherRing: String(input.motherRing || "").trim(),
    color: String(input.color || "").trim(),
    loft: String(input.loft || "").trim(),
    vaccines: [],
    transfers: [],
    races: [],
  };
}

/**
 * @param {JsonStore} store
 * @param {string} webRoot 静态页面目录
 */
export function createApp(store, webRoot) {
  const thresholdOf = (state) => {
    const t = state.settings?.inbreedingThreshold;
    return typeof t === "number" ? t : 0.125;
  };

  const appendAudit = (draft, entry) => {
    draft.audit.unshift(entry);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "local"}`);
      const path = decodeURIComponent(url.pathname);
      const method = req.method;

      // ---------- 静态页面 ----------
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        const html = await readFile(join(webRoot, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        return res.end(html);
      }
      const staticMatch = path.match(/^\/(?:static\/)?(app\.js|style\.css)$/);
      if (method === "GET" && staticMatch) {
        const file = normalize(staticMatch[1]);
        const data = await readFile(join(webRoot, file));
        res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] });
        return res.end(data);
      }

      // ---------- 档案列表 / 创建 ----------
      if (path === "/api/pigeons" && method === "GET") {
        return sendJson(res, 200, store.state.pigeons);
      }
      if (path === "/api/pigeons" && method === "POST") {
        const input = await readBody(req);
        const pigeon = newPigeon(input);
        const created = await store.mutate((draft) => {
          if (draft.pigeons.some(p => p.ringNo === pigeon.ringNo)) {
            throw Object.assign(new Error("足环号已存在"), { status: 409, code: "ring_exists" });
          }
          draft.pigeons.unshift(pigeon);
          return pigeon;
        }, { label: "pigeon-create" });
        return sendJson(res, 201, created);
      }

      // ---------- 五代谱系 ----------
      let m = path.match(/^\/api\/pigeons\/(.+)\/pedigree$/);
      if (m && method === "GET") {
        const ring = m[1];
        const byRing = buildIndex(store.state.pigeons);
        if (!byRing.has(ring)) return sendJson(res, 404, { error: "pigeon_not_found", ringNo: ring });
        const result = getPedigree(byRing, ring);
        return sendJson(res, 200, result);
      }

      // ---------- 全部后代 ----------
      m = path.match(/^\/api\/pigeons\/(.+)\/descendants$/);
      if (m && method === "GET") {
        const ring = m[1];
        const byRing = buildIndex(store.state.pigeons);
        const result = getDescendants(byRing, ring);
        if (!result.exists) return sendJson(res, 404, { error: "pigeon_not_found", ringNo: ring });
        return sendJson(res, 200, result);
      }

      // ---------- 旧版血统接口（保留兼容） ----------
      m = path.match(/^\/api\/pigeons\/(.+)\/relation$/);
      if (m && method === "GET") {
        const ring = m[1];
        const pigeons = store.state.pigeons;
        const pigeon = pigeons.find(item => item.ringNo === ring);
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        return sendJson(res, 200, {
          pigeon,
          father: pigeons.find(item => item.ringNo === pigeon.fatherRing) || null,
          mother: pigeons.find(item => item.ringNo === pigeon.motherRing) || null,
          children: pigeons.filter(item => item.fatherRing === ring || item.motherRing === ring),
        });
      }

      // ---------- 转让 / 成绩 / 疫苗 ----------
      m = path.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
      if (m && method === "POST") {
        const ring = m[1];
        const kind = m[2];
        const input = await readBody(req);
        const updated = await store.mutate((draft) => {
          const pigeon = draft.pigeons.find(item => item.ringNo === ring);
          if (!pigeon) throw Object.assign(new Error("pigeon_not_found"), { status: 404 });
          if (kind === "transfers") {
            if (!input.to) throw Object.assign(new Error("受让方不能为空"), { status: 400 });
            pigeon.transfers.push({ date: input.date || today(), from: pigeon.owner, to: input.to });
            pigeon.owner = input.to;
          } else if (kind === "races") {
            pigeon.races.push({
              date: input.date || today(),
              event: String(input.event || "未命名赛事"),
              distance: Number(input.distance) || 0,
              returnTime: String(input.returnTime || ""),
              rank: Number(input.rank) || 0,
            });
          } else {
            if (!input.name) throw Object.assign(new Error("疫苗名称不能为空"), { status: 400 });
            pigeon.vaccines.push({ date: input.date || today(), name: input.name });
          }
          return pigeon;
        }, { label: `pigeon-${kind}` });
        return sendJson(res, 200, updated);
      }

      // ---------- 近交分析（结论写审计） ----------
      if (path === "/api/breeding/inbreeding" && method === "GET") {
        const ringA = (url.searchParams.get("ringA") || "").trim();
        const ringB = (url.searchParams.get("ringB") || "").trim();
        if (!ringA || !ringB) {
          return sendJson(res, 400, { error: "ring_required", message: "需要 ringA 与 ringB 两个环号" });
        }
        const threshold = thresholdOf(store.state);
        const byRing = buildIndex(store.state.pigeons);
        const analysis = analyzeMating(byRing, ringA, ringB, threshold);
        if (!analysis.exists) return sendJson(res, 404, { error: "pigeon_not_found", missing: analysis.missing });

        const auditInfo = await store.mutate((draft) => {
          const entry = JsonStore.makeAuditEntry(draft, {
            type: "analysis",
            action: "inbreeding_analysis",
            input: { ringA, ringB },
            result: "ok",
            details: {
              coefficient: analysis.coefficient,
              threshold,
              exceedsThreshold: analysis.exceedsThreshold,
              commonAncestors: analysis.commonAncestors.map(c => ({
                ringNo: c.ringNo,
                paths: c.paths.length,
                contribution: c.contribution,
              })),
              cycles: analysis.cycles.map(c => c.path.join("→")),
            },
          });
          draft.audit.unshift(entry);
          return { auditId: entry.id };
        }, { label: "audit-analysis" });
        return sendJson(res, 200, { ...analysis, auditId: auditInfo.auditId });
      }

      // ---------- 配对（自动拦截，事务写配对 + 审计） ----------
      if (path === "/api/breeding/pairings" && method === "GET") {
        return sendJson(res, 200, store.state.pairings);
      }
      if (path === "/api/breeding/pairings" && method === "POST") {
        const input = await readBody(req);
        const ringA = String(input.ringA || "").trim();
        const ringB = String(input.ringB || "").trim();
        const note = String(input.note || "").trim();
        const forced = input.force === true; // 预留：只有明确强制才跳过阈值，但同羽/直系永远拦截
        const output = await store.mutate((draft) => {
          const byRing = buildIndex(draft.pigeons);
          const threshold = thresholdOf(draft);
          const verdict = evaluatePairing(byRing, ringA, ringB, threshold);

          // 硬性违规（同羽、不存在、直系血亲）即使强制也不允许
          const hardCodes = new Set(["same_pigeon", "pigeon_not_found", "missing_ring", "parent_child", "grandparent_grandchild"]);
          const hard = verdict.violations.filter(v => hardCodes.has(v.code));
          const soft = verdict.violations.filter(v => !hardCodes.has(v.code));
          const blocked = hard.length > 0 || (soft.length > 0 && !forced);

          if (blocked) {
            const entry = JsonStore.makeAuditEntry(draft, {
              type: "pairing",
              action: "pairing_rejected",
              input: { ringA, ringB, note: note || undefined, forced: forced || undefined },
              result: "rejected",
              details: {
                violations: verdict.violations,
                warnings: verdict.warnings,
                coefficient: verdict.coefficient,
                threshold,
              },
            });
            draft.audit.unshift(entry);
            return { status: 422, body: { allowed: false, violations: verdict.violations, warnings: verdict.warnings, coefficient: verdict.coefficient, threshold, auditId: entry.id } };
          }

          const pairing = {
            time: new Date().toISOString(),
            ringA,
            ringB,
            coefficient: verdict.coefficient,
            threshold,
            commonAncestorCount: verdict.commonAncestors.length,
            forced: forced || undefined,
            note: note || "",
          };
          const entry = JsonStore.makeAuditEntry(draft, {
            type: "pairing",
            action: "pairing_create",
            input: { ringA, ringB, note: note || undefined, forced: forced || undefined },
            result: "ok",
            details: {
              coefficient: verdict.coefficient,
              threshold,
              commonAncestors: verdict.commonAncestors.map(c => ({ ringNo: c.ringNo, paths: c.paths.length, contribution: c.contribution })),
              warnings: verdict.warnings,
            },
          });
          pairing.id = entry.id; // 配对与审计共用同一 id，一一对应
          entry.details.pairingId = entry.id;
          draft.pairings.unshift(pairing);
          draft.audit.unshift(entry);
          return { status: 201, body: { allowed: true, pairing, warnings: verdict.warnings, commonAncestors: verdict.commonAncestors, auditId: entry.id } };
        }, { label: "pairing-create" });
        return sendJson(res, output.status, output.body);
      }

      // ---------- 审计 ----------
      if (path === "/api/audit" && method === "GET") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
        const type = url.searchParams.get("type");
        let rows = store.state.audit;
        if (type) rows = rows.filter(r => r.type === type);
        return sendJson(res, 200, { total: rows.length, items: rows.slice(0, limit) });
      }

      // ---------- 设置 ----------
      if (path === "/api/settings" && method === "GET") {
        return sendJson(res, 200, store.state.settings);
      }
      if (path === "/api/settings" && method === "PUT") {
        const input = await readBody(req);
        const output = await store.mutate((draft) => {
          const t = Number(input.inbreedingThreshold);
          if (!Number.isFinite(t) || t < 0 || t > 1) {
            throw Object.assign(new Error("门槛必须是 0~1 之间的数"), { status: 400, code: "bad_threshold" });
          }
          const previous = thresholdOf(draft);
          draft.settings.inbreedingThreshold = Number(t.toFixed(6));
          const entry = JsonStore.makeAuditEntry(draft, {
            type: "analysis",
            action: "settings_update",
            input: { inbreedingThreshold: draft.settings.inbreedingThreshold },
            result: "ok",
            details: { previous },
          });
          draft.audit.unshift(entry);
          return { settings: draft.settings, auditId: entry.id };
        }, { label: "settings-update" });
        return sendJson(res, 200, output);
      }

      return sendJson(res, 404, { error: "not_found", path });
    } catch (error) {
      const status = error.status || 500;
      sendJson(res, status, { error: error.code || "server_error", message: error.message });
    }
  });
}
