// JSON 文件持久化存储：
// - 所有写操作经互斥队列串行化
// - 落盘采用“写临时文件 -> fsync -> rename -> fsync 目录”，重启后数据不丢
// - 先落盘后提交内存：落盘失败时内存状态不变，绝不留下半条数据
// - 一次 mutate 内的多处变更（如配对 + 审计）在同一文件原子生效

import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  rm,
  readdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_INBREEDING_THRESHOLD = 0.125;

const EMPTY_STATE = () => ({
  pigeons: [],
  pairings: [],
  audit: [],
  settings: { inbreedingThreshold: DEFAULT_INBREEDING_THRESHOLD },
  seq: 0,
});

export class JsonStore {
  constructor(filePath, { writeAttemptFailure = 0 } = {}) {
    this.filePath = filePath;
    // 测试用：让前 N 次落盘抛错，验证失败不留痕
    this.writeAttemptFailure = writeAttemptFailure;
    this._attempts = 0;
    this._state = null;
    this._tail = Promise.resolve();
  }

  async init(seed = null) {
    await mkdir(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      const state = { ...EMPTY_STATE(), ...(seed || {}) };
      await this._persist(state);
      this._state = state;
      return;
    }
    const raw = await readFile(this.filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`数据文件损坏，拒绝启动以免覆盖：${this.filePath} (${error.message})`);
    }
    // 兼容旧版 { pigeons } 结构
    const state = {
      ...EMPTY_STATE(),
      ...parsed,
      settings: { ...EMPTY_STATE().settings, ...(parsed.settings || {}) },
    };
    state.pigeons ??= [];
    state.pairings ??= [];
    state.audit ??= [];
    this._state = state;
  }

  get state() {
    if (!this._state) throw new Error("store 尚未 init");
    return this._state;
  }

  /** 只读快照（浅拷贝由调用方自行处理） */
  read() {
    return this._state;
  }

  /**
   * 串行化变更。fn 收到 draft（当前状态的深拷贝），返回的 draft 整体落盘；
   * 落盘成功后才替换内存状态并把 fn 的返回值交还给调用方。
   */
  mutate(fn, { label = "mutate" } = {}) {
    const run = this._tail.then(async () => {
      const draft = structuredClone(this._state);
      let result;
      try {
        result = await fn(draft);
      } catch (error) {
        error.label = label;
        throw error;
      }
      await this._persist(draft);
      this._state = draft;
      return result;
    });
    // 队列本身不因单次失败而断裂
    this._tail = run.then(() => {}, () => {});
    return run;
  }

  async _persist(state) {
    this._attempts++;
    if (this._attempts <= this.writeAttemptFailure) {
      throw Object.assign(new Error("模拟磁盘写入失败"), { code: "SIMULATED_IO_ERROR" });
    }
    const tmp = `${this.filePath}.tmp-${process.pid}-${this._attempts}`;
    const data = JSON.stringify(state, null, 2);
    let handle;
    try {
      handle = await open(tmp, "w");
      await handle.writeFile(data, "utf8");
      // 同步刷盘，保证 rename 前数据字节已落盘
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tmp, this.filePath);
      await this._fsyncDir(dirname(this.filePath));
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* 忽略 */ }
      }
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async _fsyncDir(dir) {
    let dirHandle;
    try {
      const { open: fsOpen } = await import("node:fs/promises");
      dirHandle = await fsOpen(dir, "r");
      await dirHandle.sync();
    } catch {
      // 某些平台目录不允许 fsync，rename 的原子性已足够保证不留半条
    } finally {
      if (dirHandle) {
        try { await dirHandle.close(); } catch { /* 忽略 */ }
      }
    }
  }

  /** 清理可能残留的临时文件（启动时调用） */
  async cleanupTempFiles() {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) return;
    const entries = await readdir(dir);
    const base = this.filePath.split("/").pop();
    await Promise.all(
      entries
        .filter(name => name.startsWith(`${base}.tmp-`))
        .map(name => rm(join(dir, name), { force: true }))
    );
  }

  // ---------- 审计 ----------

  static makeAuditEntry(draft, { type, action, input, result, details }) {
    draft.seq = (draft.seq || 0) + 1;
    return {
      id: draft.seq,
      time: new Date().toISOString(),
      type, // "analysis" | "pairing"
      action, // "inbreeding_analysis" | "pairing_create" | "pairing_rejected"
      input,
      result, // "ok" | "rejected"
      details: details || {},
    };
  }
}

// 兼容部分测试环境下直接 writeFile 的简单封装（未使用，保留以避免误用非原子写）
export async function safeWriteFile(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
