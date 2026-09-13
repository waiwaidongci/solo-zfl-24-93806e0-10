# 赛鸽育种谱系与近交分析登记站

在原有档案/转让/成绩登记之上，新增育种谱系、近交分析、配对拦截与审计功能。零第三方依赖，Node.js ≥ 18.17（已在 18.17 / 20 / 22 / 24 验证）。

## 启动

```bash
npm start            # http://localhost:3024
PORT=4000 npm start
DATA_FILE=/path/to/registry.json npm start   # 自定义数据文件
```

首次启动若检测到旧版 `data/pigeons.json` 会自动迁移到 `data/registry.json`。

## 功能

- **五代谱系**：按环号查询最多五代祖先树，标出：
  - 重复祖先（同一祖先经多条路径出现，附出现次数）
  - 缺失父母（逐羽、逐父/母侧列出）
  - 谱系成环（数据矛盾：某羽沿父母边回到自己，按环旋转规范化去重）
  - 引用了未登记鸽的祖先节点（虚线红框）
  - 达到五代上限时提示被截断
- **全部后代**：BFS 枚举，给每羽后代标注代数与全部回溯路径（成环数据不死循环）。
- **近交系数**：任意两羽按 Wright 路径公式计算配对后代的预期近交系数 F；
  列出每个共同祖先、其自身近交系数、每一对计入路径（双方各上溯几代）与单项贡献。
  已用标准构型验证：无亲缘 0、表亲 1/32、半同胞/祖孙 1/8、全同胞/父女 1/4、
  共同祖先自身近交 0.25 的半同胞型 0.15625。
- **配对拦截**（`POST /api/breeding/pairings`），硬性规则：
  - 同羽配对（`same_pigeon`）
  - 档案不存在（`pigeon_not_found`）
  - 父母-子女（`parent_child`，双向检测）
  - 祖父/母-孙（`grandparent_grandchild`）
  - 近交系数严格大于门槛（`inbreeding_threshold`，默认 0.125，可在页面/接口调整，0~1）
- **审计**：每次近交分析、每次配对（成功与拦截）、门槛修改都写一条审计；
  成功配对与审计共用同一 id。拒绝的配对不产生配对记录。
- **不留下半条数据**：配对与审计在同一个事务（一次文件落盘）内提交；
  写盘走「临时文件 + fsync + rename + 目录 fsync」，写失败回滚内存并清理临时文件；
  所有写操作经互斥队列串行化，并发下不丢更新、id 不重复。
- **重启保留**：数据为单一 JSON 文件，重启后全部记录继续可查；文件损坏时拒绝启动而非覆盖。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pigeons` | 档案列表 |
| POST | `/api/pigeons` | 新建档案（重复环号 409） |
| GET | `/api/pigeons/:ring/pedigree` | 五代谱系与三类标记 |
| GET | `/api/pigeons/:ring/descendants` | 全部后代与路径 |
| GET | `/api/pigeons/:ring/relation` | 旧版一代血统（兼容） |
| POST | `/api/pigeons/:ring/transfers\|races\|vaccines` | 转让/成绩/疫苗 |
| GET | `/api/breeding/inbreeding?ringA=&ringB=` | 近交系数与共同祖先路径（写审计） |
| POST | `/api/breeding/pairings` | 建立配对（违规返回 422，拦截也写审计） |
| GET | `/api/breeding/pairings` | 配对记录 |
| GET | `/api/audit?type=&limit=` | 审计记录 |
| GET/PUT | `/api/settings` | 读取/修改近交门槛 |

## 测试

```bash
npm test                 # 56 个用例：算法、存储、HTTP、并发、边界
                         # 自动发现 test/*.test.js，无需手动补文件匹配
BASE=http://localhost:3024 node scripts/smoke.mjs   # 对运行中的服务端到端走查
```

> `npm test` 通过零依赖启动器 `scripts/run-tests.mjs` 自动枚举 `test/` 下的
> `*.test.js` 逐文件执行，因此在旧版 Node（`node --test <目录>` 不支持目录参数）
> 和新版 Node 24（不再接受目录位置参数）上都可直接运行。

覆盖：经典近交构型、重复/缺失/成环、五代截断、成环不死循环、四类配对拦截、
阈值边界（等于门槛放行）、50 并发写不丢不重、事务中途失败/模拟磁盘故障不留半条、
坏 JSON/超大请求体/404/超长环号等边界、重启后配对/审计/门槛全部可查。

## 目录

```
src/pedigree.js   谱系树、后代、成环检测、Wright 近交与配对规则（纯函数）
src/storage.js    互斥队列 + 临时文件 rename 原子落盘
src/app.js        HTTP 路由与事务
src/main.js       启动入口（旧数据迁移）
web/              管理页面（档案 / 谱系 / 近交 / 配对 / 审计 五个标签页）
test/             node:test 单元 + HTTP 集成测试
scripts/smoke.mjs 端到端冒烟脚本（可重复执行）
```
