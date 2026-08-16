# CODE_MAP

项目核心代码地图。修改代码前请先阅读本文档，修改后请更新对应条目。

## GUI 控制面板（新增模块）

| 文件 | 职责 |
|------|------|
| `gui/design-reference.html` | 控制面板前端页面（Tailwind CSS 单文件） |
| `gui/server.js` | 零依赖本地服务（Node 内置 http/fs），提供静态页面与 JSON API |

### gui/server.js 提供接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/` | GET | - | 返回 gui/design-reference.html |
| `/api/accounts` | GET | - | 返回账号列表（关联日志摘要） |
| `/api/accounts/:email` | PUT | JSON 账号对象 | 更新单个账号配置（先备份 .bak → 校验 → 写回） |
| `/api/config` | GET | - | 返回 config.json |
| `/api/start` | POST | - | 启动任务子进程 `spawn('node', [dist/index.js])` |
| `/api/stop` | POST | - | 停止任务（SIGTERM → 10秒后 SIGKILL 兜底） |
| `/api/task` | GET | - | 任务运行状态 + 最近 100 行实时日志 |
| `/api/stats` | GET | - | 日志统计摘要（ACCOUNT-END 权威总计 + INFO 活动积分兜底） |
| `/api/logs` | GET | - | 返回 logs/ 目录文件列表 |
| `/api/logs/:date` | GET | YYYY-MM-DD | 返回指定日期日志解析结果 |
| `/api/logs/summary` | GET | - | 返回最新日志聚合摘要 |
| `--generate-summary` | CLI | - | `node gui/server.js --generate-summary` 生成 gui/summary.json |

### 关键设计决策

- **日志目录固定为项目根目录 `logs/`**（与 Logger.ts 写入位置一致），不做 logssample 兼容。
- **账号保存流程**：备份 `accounts.json → accounts.json.bak` → 格式校验（与 src/util/Validator.ts 的 AccountSchema 字段规则一致）→ 合并写入 → 写回时自动恢复格式（4 空格缩进）。
- **日志关联**：账号卡片状态通过邮箱前缀 `email.split('@')[0]` 匹配日志中 `[账户]` 字段。
- **任务启动（方案 A）**：`spawn('node', [dist/index.js])`，cwd=项目根目录。跨平台、kill() 干净（脚本自带 SIGTERM/SIGINT handler 正常清理）。开发模式自动降级为 ts-node。
- **统计防重复**：优先 ACCOUNT-END 唯一权威总计；无 ACCOUNT-END 时仅累加 INFO 级事件积分（跳过 DEBUG 余额差分行避免重复计数）。
- **前端图表**：Chart.js v4 CDN，Stacked 柱状图展示每日每账号收益。
- **前端响应式布局**：侧边栏 `aside` 固定 `flex-shrink-0`、内容区 `main` 固定 `min-w-0`（防止面板内容撑爆挤压侧边栏）；面板内横向排列容器统一使用 `flex-wrap` + 响应式 `grid md:` 断点（参照 accounts/settings 面板写法，2026-08-16 修复 90%/125% 缩放下 home/stats 面板跑版问题）。

## 原有模块（参考）

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：MicrosoftRewardsBot 类，任务流程编排 |
| `src/util/Load.ts` | 加载 accounts.json / config.json |
| `src/util/Validator.ts` | Zod 校验 accounts 与 config 结构 |
| `src/logging/Logger.ts` | 日志写入 `logs/YYYY-MM-DD.log` |