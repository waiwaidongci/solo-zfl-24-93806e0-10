// 跨版本测试入口：
// 部分 Node 版本（18.13 及更早）的 `node --test <目录>` 不支持目录参数，
// 个别版本对含中文的子进程输出还有 TAP 解析问题；而直接以子进程执行
// `node <测试文件>` 在 18.7+（node:test 提供 describe 起）都能正确运行并返回退出码。
// 因此这里自行枚举 test/ 下的 *.test.{js,mjs,cjs}，逐文件执行并汇总退出码，
// 任何一文件失败即以非零码退出。

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "test");
const node = process.execPath;

const isTestFile = (name) => /\.test\.(js|mjs|cjs)$/.test(name);

async function listTestFiles() {
  const entries = await readdir(testDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && isTestFile(e.name))
    .map((e) => join(testDir, e.name))
    .sort();
}

function runFile(file, index) {
  return new Promise((resolve) => {
    const rel = file.slice(testDir.length + 1);
    const out = [];
    const child = spawn(node, [file], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { out.push(d); process.stdout.write(`# [${index}] ${rel}\n${d}`); });
    child.stderr.on("data", (d) => { process.stderr.write(d); });
    child.on("close", (code) => {
      // node:test 直接运行文件时，有用例失败即退出码 1
      const text = Buffer.concat(out).toString("utf8");
      // 退出码是权威信号；计数兼容旧版 TAP（"# pass N"）与新版 spec（"ℹ pass N"）
      const passMatch = text.match(/^(?:#|ℹ)\s*pass (\d+)/m);
      const failMatch = text.match(/^(?:#|ℹ)\s*fail (\d+)/m);
      resolve({
        file: rel,
        code,
        pass: passMatch ? Number(passMatch[1]) : null,
        fail: failMatch ? Number(failMatch[1]) : null,
      });
    });
  });
}

async function main() {
  const files = await listTestFiles();
  if (!files.length) {
    console.error(`未在 ${testDir} 找到 *.test.js 测试文件`);
    process.exit(1);
  }
  console.log(`共发现 ${files.length} 个测试文件：${files.map(f => f.slice(testDir.length + 1)).join(", ")}`);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    results.push(await runFile(files[i], i + 1));
  }
  const failed = results.filter((r) => r.code !== 0 || r.fail > 0);
  const totalPass = results.reduce((s, r) => s + (r.pass || 0), 0);
  const totalFail = results.reduce((s, r) => s + (r.fail || 0), 0);
  console.log("\n================ 测试汇总 ================");
  for (const r of results) {
    console.log(`${r.code === 0 && !(r.fail > 0) ? "✅" : "❌"} ${r.file}  pass=${r.pass ?? "?"} fail=${r.fail ?? "?"}`);
  }
  console.log(`合计 pass=${totalPass} fail=${totalFail}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
