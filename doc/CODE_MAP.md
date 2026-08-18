# CODE_MAP

项目核心代码地图。修改代码前请先阅读本文档，修改后请更新对应条目。

## GUI 控制面板（新增模块）

| 文件 | 职责 |
|------|------|
| `gui/design-reference.html` | 控制面板前端页面（HTML 结构 + Tailwind CDN，样式与逻辑已拆分至 css/ js/） |
| `gui/server.js` | 入口（模块化后精简版 ≈85 行）：组装依赖 ctx → 按序调用 lib/routes/ 各路由 → `--generate-summary` CLI → listen。（2026-08-18 重构） |
| `gui/lib/config.js` | 常量（PORT/ROOT/LOGS_DIR…）+ resolveAccountsPath/resolveConfigPath/readJson。（2026-08-18 新增） |
| `gui/lib/httpUtils.js` | sendJson / sendText / readBody（100MB）。（2026-08-18 新增） |
| `gui/lib/validator.js` | validateAccountShape（账号结构校验）。（2026-08-18 新增） |
| `gui/lib/logger.js` | parseLogLine / listLogFiles / readLogFile。（2026-08-18 新增） |
| `gui/lib/summary.js` | summarizeLogs / generateSummary / writeSummaryFile。（2026-08-18 新增） |
| `gui/lib/archive.js` | unzipToDir / zipDir / makeTmpRoot（零依赖压缩解压）。（2026-08-18 新增） |
| `gui/lib/taskManager.js` | startTask / stopTask / getTaskStatus（任务子进程管理）。（2026-08-18 新增） |
| `gui/lib/routes/` | 8 个路由模块（static/config/accounts/logs/sessions/data/tasks/system），统一签名 `(req,res,pathname,ctx)=>boolean`，由 server.js 在 ctx 注入依赖后按序分发。（2026-08-18 新增） |
| `gui/start-gui.bat` | 一键启动脚本：`cd /d %~dp0` → `set PORT=3001`（可改）→ 校验 server.js → 3 秒后 PowerShell 开浏览器 → 当前窗口跑 `node server.js` |
| `gui/start-gui-silent.vbs` | 静默启动（WScript.Shell 隐藏窗口跑 start-gui.bat）。（2026-08-17 新增） |
| `gui/stop-gui.bat` | 按端口（默认 3001）查 PID 并 taskkill /f 停止，避免误杀其他 Node 脚本。（2026-08-17 新增） |
| `gui/README.md` | GUI 专属用户文档。（2026-08-17 新增） |
| `gui/css/main.css` | 公共样式（卡片阴影/滚动条/图表占位） |
| `gui/css/animations.css` | 图表动画辅助样式 |
| `gui/js/animator.js` | Chart.js 动画工具（chartAnimOptions + smoothUpdateChart） |
| `gui/js/app.js` | 前端核心交互逻辑（加载/渲染/任务/导入导出/弹窗/SSE） |

### gui/server.js（及 lib/routes/）提供接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/` | GET | - | 返回 gui/design-reference.html |
| `/api/accounts` | GET | - | 返回账号列表（关联日志摘要） |
| `/api/accounts` | POST | JSON 账号对象 | 新增账号（补全默认字段→重复检查→备份 .bak→写回） |
| `/api/accounts/:email` | PUT | JSON 账号对象 | 更新账号（备份 .bak→校验→合并写回） |
| `/api/accounts/:email` | DELETE | - | 删除账号（备份 .bak→splice→写回，失败回滚） |
| `/api/config` | GET/PUT | JSON 配置对象 | 读取/更新全局配置（宽松校验；强制忽略 parallelSearching；备份 .bak+合并写回） |
| `/api/config/reset` | POST | - | 重置为 src/config.example.json 默认 |
| `/api/config/open` | POST | - | 系统默认程序打开实际 config 文件 |
| `/api/sessions/import` | POST | `{filename,dataBase64}` | 导入 Session zip（白名单 session_*.json+防穿越+.bak） |
| `/api/sessions/export` | GET | - | 导出 Session zip |
| `/api/logs` | GET | - | logs/ 文件列表 |
| `/api/logs/export` | GET | - | 导出日志 zip |
| `/api/logs/import` | POST | `{filename,dataBase64}` | 导入日志 zip（白名单 *.log+防穿越+.bak） |
| `/api/logs/:date` | GET | YYYY-MM-DD | 指定日期日志解析 |
| `/api/logs/summary` | GET | - | 最新日志聚合摘要 |
| `/api/data/export` | GET | - | 一键导出全部数据 zip（sessions+logs+accounts.json+config.json） |
| `/api/data/import` | POST | `{filename,dataBase64}` | 一键导入全部数据 zip（白名单+防穿越+.bak+失败回滚） |
| `/api/start` | POST | - | 启动任务子进程（spawn node dist/index.js） |
| `/api/stop` | POST | - | 停止任务（SIGTERM→10s SIGKILL 兜底） |
| `/api/task` | GET | - | 任务状态 + 最近 100 行日志 |
| `/api/shutdown` | POST | - | 关闭服务（延迟 500ms 退出） |
| `/api/stats`/`/api/summary` | GET | - | 日志统计摘要 |
| `/api/keepalive` | GET | - | SSE 长连接保活（text/event-stream+keep-alive，req.on close→process.exit(0)） |
| `--generate-summary` | CLI | - | `node gui/server.js --generate-summary` 生成 gui/summary.json |

### 关键设计决策

- **日志目录固定为项目根目录 `logs/`**（与 Logger.ts 写入位置一致）。
- **账户保存流程**：备份 `.bak` → 校验 → 合并写入 → 4 空格缩进写回，失败自动恢复。
- **请求体限制**：readBody 100MB（session/日志/数据导入共用）。
- **日志关联**：账号卡片状态经邮箱前缀 `email.split('@')[0]` 匹配日志 `[账户]`。
- **任务启动**：`spawn('node',[dist/index.js])`，cwd=项目根目录，开发模式降级 ts-node。
- **统计防重复**：优先 ACCOUNT-END 权威总计；无则累加 INFO 级活动积分（跳过 DEBUG 差额行）。
- **前端图表**：Chart.js v4 堆叠柱。Stats 柱状图已禁用动画（app.js 中 animations: false，2026-08-19），animator.js 保留供参考；惰性创建（面板可见才 new Chart）。（2026-08-17）
- **Home 总积分兜底与日志账号合并**：latestBalance 优先、finalPoints 兜底；合并"已配置账号 + 日志有收益未配置账号"。（2026-08-17）
- **Stats 零收益过滤**：图例/堆叠柱仅收集 points>0，累计列表仅 totalPoints>0。（2026-08-17）
- **一键导入导出本地数据（2026-08-18）**：仪表盘标题区"导出数据/导入数据"按钮，打包/恢复 sessions+logs+accounts.json+config.json；白名单+防穿越+.bak+回滚。
- **模块化重构（2026-08-18）**：`server.js` 原约 1600 行拆为 `gui/lib/`（7 基础模块）+ `gui/lib/routes/`（8 路由模块），入口精简为组装 ctx+顺序分发。路由签名 `(req,res,pathname,ctx)=>boolean`（true=已处理），ctx 注入 config/http/validator/logger/summary/archive/taskManager 规避循环 require。拆分按依赖递增（config→httpUtils/validator→logger→summary→archive→taskManager→routes→入口）。已验证：`node --check` 通过、`--generate-summary` CLI 正常、前台 `PORT=3001` 下 `/`、`/api/stats`、`/api/accounts` 均 200（3000 被用户其他脚本占用，必须用 3001）。
- **网页关闭自动退出（SSE 长连接，2026-08-18）**：前端 EventSource('/api/keepalive')；服务端 text/event-stream+no-cache+keep-alive、不 res.end()、req.on('close')→process.exit(0)；不受浏览器后台标签页节流影响；前端 beforeunload 防误关。原 /api/heartbeat 短轮询已移除。
- **端口配置**：默认端口 3001（3000 常与用户其他脚本冲突）。start-gui.bat 中 `set PORT=3001` 统一控制。
- **前端响应式**：aside flex-shrink-0 + main min-w-0，防面板撑爆挤瘪侧边栏。（2026-08-16）

## 原有模块（参考）

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：MicrosoftRewardsBot 类，任务流程编排 |
| `src/util/Load.ts` | 加载 accounts.json / config.json |
| `src/util/Validator.ts` | Zod 校验 accounts 与 config 结构 |
| `src/logging/Logger.ts` | 日志写入 `logs/YYYY-MM-DD.log` |

## 变更记录

| 日期 | 内容 |
|------|------|
| 2026-08-19 | `.gitignore` 调整：移除 `.github/` 规则（保留 CI 工作流追踪）；清理重复条目 `accounts.dev.json`、`.DS_Store`；`.vscode/launch.json` 移出 git 追踪（本地文件保留，`git rm --cached`）；`skills-lock.json` 加入追踪 |
