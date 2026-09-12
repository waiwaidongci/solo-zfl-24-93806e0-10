import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { JsonStore } from "./storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const dataFile = process.env.DATA_FILE || join(rootDir, "data", "registry.json");
const legacyFile = join(rootDir, "data", "pigeons.json");
const webRoot = join(rootDir, "web");
const port = Number(process.env.PORT || 3024);

async function loadSeed() {
  // 首次启动且存在旧版数据文件时迁移
  if (!existsSync(dataFile) && existsSync(legacyFile)) {
    try {
      const legacy = JSON.parse(await readFile(legacyFile, "utf8"));
      if (Array.isArray(legacy.pigeons)) return { pigeons: legacy.pigeons };
    } catch (error) {
      console.warn("旧数据迁移失败，按空库启动：", error.message);
    }
  }
  return null;
}

const store = new JsonStore(dataFile);
await store.cleanupTempFiles();
await store.init(await loadSeed());

const app = createApp(store, webRoot);

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`赛鸽育种登记站已启动：http://localhost:${port}（数据文件 ${dataFile}）`);
  });
}

export { app, store };
