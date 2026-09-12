import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/storage.js";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pigeon-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => join(dir, "registry.json");

test("首次启动写种子，结构含四个集合与设置", async () => {
  const store = new JsonStore(file());
  await store.init({ pigeons: [{ ringNo: "A", fatherRing: "", motherRing: "" }] });
  const onDisk = JSON.parse(await readFile(file(), "utf8"));
  assert.equal(onDisk.pigeons.length, 1);
  assert.deepEqual(onDisk.pairings, []);
  assert.deepEqual(onDisk.audit, []);
  assert.equal(onDisk.settings.inbreedingThreshold, 0.125);
});

test("重启后数据仍可查询", async () => {
  let store = new JsonStore(file());
  await store.init();
  await store.mutate(d => {
    d.pigeons.push({ ringNo: "A", fatherRing: "", motherRing: "" });
    d.pairings.push({ id: 1, ringA: "A", ringB: "B" });
    d.audit.push(JsonStore.makeAuditEntry(d, {
      type: "pairing", action: "pairing_create", input: { ringA: "A", ringB: "B" }, result: "ok",
    }));
  });

  store = new JsonStore(file());
  await store.init();
  assert.equal(store.state.pigeons[0].ringNo, "A");
  assert.equal(store.state.pairings[0].id, 1);
  assert.equal(store.state.audit.length, 1);
});

test("一次 mutate 中多集合同生共死（配对+审计原子）", async () => {
  const store = new JsonStore(file());
  await store.init();
  await assert.rejects(
    store.mutate((d) => {
      d.pigeons.push({ ringNo: "A" });
      throw new Error("故意在事务中途失败");
    }),
    /故意在事务中途失败/
  );
  // 失败后：内存里没有半条数据
  assert.equal(store.state.pigeons.length, 0);
  // 磁盘文件也不含 A
  const onDisk = JSON.parse(await readFile(file(), "utf8"));
  assert.equal(onDisk.pigeons.length, 0);
});

test("磁盘写入失败不留半条、不产生残留临时文件", async () => {
  const store = new JsonStore(file(), { writeAttemptFailure: 2 });
  await assert.rejects(store.init(), (err) => err.code === "SIMULATED_IO_ERROR");
  // init 写失败：没有留下正式文件或临时文件
  const entries = await readdir(dir);
  assert.deepEqual(entries.filter(n => !n.startsWith(".")), []);
});

test("先有成功数据，随后一次写失败：旧数据完好且临时文件被清理", async () => {
  let store = new JsonStore(file());
  await store.init({ pigeons: [{ ringNo: "OLD" }] });
  await store.mutate(d => d.pigeons.push({ ringNo: "BASE" }));

  store = new JsonStore(file(), { writeAttemptFailure: 1 });
  await store.init();
  await assert.rejects(store.mutate(d => d.pigeons.push({ ringNo: "SHOULD_NOT_PERSIST" })));
  // 内存未提交
  assert.ok(!store.state.pigeons.some(p => p.ringNo === "SHOULD_NOT_PERSIST"));
  const onDisk = JSON.parse(await readFile(file(), "utf8"));
  assert.ok(!onDisk.pigeons.some(p => p.ringNo === "SHOULD_NOT_PERSIST"));
  assert.ok(onDisk.pigeons.some(p => p.ringNo === "BASE"));
  const entries = await readdir(dir);
  assert.deepEqual(entries.filter(n => n.includes(".tmp-")), []);
});

test("失败的 mutate 不阻塞后续写（写队列不中断）", async () => {
  const good = new JsonStore(join(dir, "good.json"));
  await good.init();
  await assert.rejects(good.mutate(() => { throw new Error("业务失败"); }), /业务失败/);
  const result = await good.mutate(d => { d.seq = 42; return "ok"; });
  assert.equal(result, "ok");
  assert.equal(good.state.seq, 42);
});

test("并发 50 次写全部生效、无丢失无重复、审计 id 单调", async () => {
  const store = new JsonStore(file());
  await store.init();
  const N = 50;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    store.mutate((d) => {
      const entry = JsonStore.makeAuditEntry(d, {
        type: "analysis", action: "inbreeding_analysis",
        input: { ringA: `A${i}`, ringB: "B" }, result: "ok",
      });
      d.audit.unshift(entry);
    })
  ));
  const ids = store.state.audit.map(a => a.id);
  assert.equal(ids.length, N);
  assert.equal(new Set(ids).size, N, "审计 id 不应重复");
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "id 单调递增");
  // 重启核对
  const reopened = new JsonStore(file());
  await reopened.init();
  assert.equal(reopened.state.audit.length, N);
});

test("并发下读永远读到完整状态（读不看到半截事务）", async () => {
  const store = new JsonStore(file());
  await store.init();
  const check = async () => {
    for (let i = 0; i < 200; i++) {
      const s = store.state;
      // 不变量：pairing 与 audit 要么都不动，要么每个配对都有对应审计
      for (const p of s.pairings) {
        assert.ok(s.audit.some(a => a.details?.pairingId === p.id));
      }
      await new Promise(r => setTimeout(r, 0));
    }
  };
  const writers = Array.from({ length: 8 }, (_, i) =>
    store.mutate(d => {
      const entry = JsonStore.makeAuditEntry(d, {
        type: "pairing", action: "pairing_create",
        input: { ringA: `A${i}`, ringB: `B${i}` }, result: "ok",
        details: {},
      });
      entry.details.pairingId = entry.id;
      d.pairings.unshift({ id: entry.id, ringA: `A${i}`, ringB: `B${i}` });
      d.audit.unshift(entry);
    })
  );
  await Promise.all([...writers, check()]);
});

test("兼容旧版 { pigeons } 数据结构并补齐新字段", async () => {
  await writeFile(file(), JSON.stringify({ pigeons: [{ ringNo: "OLD", fatherRing: "", motherRing: "" }] }));
  const store = new JsonStore(file());
  await store.init();
  assert.equal(store.state.pigeons[0].ringNo, "OLD");
  assert.deepEqual(store.state.pairings, []);
  assert.equal(store.state.settings.inbreedingThreshold, 0.125);
});

test("数据文件损坏时拒绝启动而非覆盖", async () => {
  await writeFile(file(), "{ 这不是合法 JSON");
  const store = new JsonStore(file());
  await assert.rejects(store.init(), /损坏/);
  // 坏文件仍在，没被覆盖成空库
  const raw = await readFile(file(), "utf8");
  assert.ok(raw.includes("这不是合法 JSON"));
});

test("启动时清理残留临时文件", async () => {
  await writeFile(join(dir, "registry.json.tmp-123-1"), "junk");
  await writeFile(join(dir, "registry.json.tmp-123-2"), "junk");
  const store = new JsonStore(file());
  await store.cleanupTempFiles();
  await store.init();
  const entries = await readdir(dir);
  assert.deepEqual(entries.filter(n => n.includes(".tmp-")), []);
});
