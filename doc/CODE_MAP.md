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
| `gui/lib/summary.js` | summarizeLogs / summarizeAllLogs / generateSummary / writeSummaryFile。（2026-08-18 新增；summarizeAllLogs 2026-08-19 新增） |
| `gui/lib/archive.js` | unzipToDir / zipDir / makeTmpRoot（零依赖压缩解压）。（2026-08-18 新增） |
| `gui/lib/taskManager.js` | startTask / stopTask / getTaskStatus（任务子进程管理）。（2026-08-18 新增） |
| `gui/lib/routes/` | 8 个路由模块（static/config/accounts/logs/sessions/data/tasks/system），统一签名 `(req,res,pathname,ctx)=>boolean`，由 server.js 在 ctx 注入依赖后按序分发。（2026-08-18 新增） |
| `gui/start-gui.bat` | 一键启动脚本：**纯 ASCII（无中文，避免任何代码页乱码）**：`cd /d %~dp0` → `set PORT=3000`（可改）→ 校验 server.js → 3 秒后 PowerShell 开浏览器 → 当前窗口跑 `node server.js` |
| `gui/start-gui-silent.vbs` | 静默启动（WScript.Shell 隐藏窗口跑 start-gui.bat）。（2026-08-17 新增） |
| `gui/stop-gui.bat` | 按端口（默认 3000）查 PID 并 taskkill /f 停止，避免误杀其他 Node 脚本。（2026-08-17 新增） |
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
- **日志关联**：账号卡片状态经邮箱前缀 `email.split('@')[0]` 匹配日志 `[账户]`；`GET /api/accounts` 用 `summarizeAllLogs()` 聚合全部日志（2026-08-19 修复），此前只读最新一天日志导致历史运行过的账号显示"暂无运行记录"。
- **任务启动**：`spawn('node',[dist/index.js])`，cwd=项目根目录，开发模式降级 ts-node。
- **统计防重复**：优先 ACCOUNT-END 权威总计；无则累加 INFO 级活动积分（跳过 DEBUG 差额行）。
- **前端图表**：Chart.js v4 堆叠柱。Stats 柱状图已禁用动画（app.js 中 animations: false，2026-08-19），animator.js 保留供参考；惰性创建（面板可见才 new Chart）。（2026-08-17）
- **Home 总积分兜底与日志账号合并**：latestBalance 优先、finalPoints 兜底；合并"已配置账号 + 日志有收益未配置账号"。（2026-08-17）
- **Stats 零收益过滤**：图例/堆叠柱仅收集 points>0，累计列表仅 totalPoints>0。（2026-08-17）
- **一键导入导出本地数据（2026-08-18）**：仪表盘标题区"导出数据/导入数据"按钮，打包/恢复 sessions+logs+accounts.json+config.json；白名单+防穿越+.bak+回滚。
- **模块化重构（2026-08-18）**：`server.js` 原约 1600 行拆为 `gui/lib/`（7 基础模块）+ `gui/lib/routes/`（8 路由模块），入口精简为组装 ctx+顺序分发。路由签名 `(req,res,pathname,ctx)=>boolean`（true=已处理），ctx 注入 config/http/validator/logger/summary/archive/taskManager 规避循环 require。拆分按依赖递增（config→httpUtils/validator→logger→summary→archive→taskManager→routes→入口）。
- **网页关闭自动退出（SSE 长连接，2026-08-18）**：前端 EventSource('/api/keepalive')；服务端 text/event-stream+no-cache+keep-alive、不 res.end()、req.on('close')→process.exit(0)；不受浏览器后台标签页节流影响；前端 beforeunload 防误关。原 /api/heartbeat 短轮询已移除。
- **端口配置**：默认端口 3000。start-gui.bat 中 `set PORT=3000` 统一控制（stop-gui.bat 的 `PORT_TO_KILL` 需同步）。
- **前端响应式**：aside flex-shrink-0 + main min-w-0，防面板撑爆挤瘪侧边栏。（2026-08-16）

## 原有模块（参考）

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：MicrosoftRewardsBot 类，任务流程编排 |
| `src/util/Load.ts` | 加载 accounts.json / config.json |
| `src/util/Validator.ts` | Zod 校验 accounts 与 config 结构 |
| `src/logging/Logger.ts` | 日志写入 `logs/YYYY-MM-DD.log` |

## 测试

| 文件 | 职责 |
|------|------|
| `test/script/run-log-tests.js` | 日志导入（解析）+ 分析（统计）测试：`node test/script/run-log-tests.js`，零依赖（node:assert），数据源 `test/data/logs-20260819-125022/`（7 份日志）；含独立参考实现（split 法解析 + 逐账户聚合）与被测 `logger.js`/`summary.js` 交叉对拍，动态生成期望值（2026-08-19 新增） |

## 变更记录

| 日期 | 内容 |
|------|------|
| 2026-08-19 | **新增日志导入/分析测试脚本**：`test/script/run-log-tests.js` 用 `test/data/logs-20260819-125022/`（logs-20260819-125022.zip 解压）跑 logger/summary 全流程测试。首次运行 31 项断言全部通过（解析 6551 行/过滤 555 异常行；每日收益 204/113/233/189/142/447/208；accountTotals 与独立参考实现完全一致）。期间测试脚本自身修过 3 处 bug（详见 commit 历史），被测代码零改动。验证了 08-14 同一天两次运行 ACCOUNT-END 累加 = 113、08-15/08-16 未完成账户走活动积分兜底（101/112）、08-19 无 ACCOUNT-END 兜底 208（2026-08-19） |
| 2026-08-19 | **仪表盘总览收益口径修正（累计收益 vs 账户余额）**：`gui/lib/summary.js` 修复收益统计两处 bug——①同一账号同一天多次运行 ACCOUNT-END `总计` 由"覆盖"改为"累加"（`summarizeLogs` 与 `generateSummary` 同步修正），此前只统计最后一次运行导致收益被低估；②统计日期由"UTC 时间戳切片"改为按本地时区换算（`toLocalDateKey`），修复跨 UTC 日界时"今日收益"偏差；`generateSummary` 新增 `todayTotal`（本地时区今日收益）。`gui/design-reference.html` 首页顶部收益卡标题改"今日收益 / 总收益"（原"今日总收益 / 总积分"右侧实为账户余额），统计页"今日收益"卡副标题同步更新。`gui/js/app.js`：新增 `statsCache`，`loadData` 并行拉取 `/api/stats`（30s 轮询已存在），`renderHome` 顶部卡改为读 `todayTotal`/`grandTotal`（脚本执行带来的收益，移除旧余额汇总逻辑），账号卡片"今日收益"改为今日多账号/多次运行累计；`renderStats` 优先用 `statsCache` 减少重复请求，今日收益改用后端 `todayTotal`。日志分析链路（`logger.js` 解析 → `summary.js` 聚合 → routes 分发）经核查拆分合理、无循环依赖，正则与 Logger.ts 输出格式完全匹配（2026-08-19） |
| 2026-08-19 | **GUI 按钮配色优化（设计系统化，方案 B）**：`gui/css/main.css` 新增按钮组件类（`.btn` 基础 + `.btn-dark` 启动任务深色 CTA / `.btn-primary` 蓝色主操作 / `.btn-danger` 红色紧急 / `.btn-secondary` 白底描边次级 / `.btn-danger-ghost` 红字描边次级危险 / `.btn-ghost` 中性描边取消 / `.btn-icon` 图标按钮）；统一按压反馈 `:active scale(0.97)`（emil-design-eng 原则）、`:focus-visible` 焦点环（WCAG 2.4.7）、hover 加深、`prefers-reduced-motion` 降级；`gui/design-reference.html` 约 22 处静态按钮与 `gui/js/app.js` 账号卡片 2 处动态图标按钮全部替换为组件类；`app.js` 中 3 处依赖旧类名的 JS 选择器同步更新（`#panel-settings .btn-danger-ghost` / `#modal-add-account .btn-primary` / `#modal-account-settings .btn-primary`）。设计决策：实心灰次级按钮→白色描边按钮（降低层级，突出蓝色主操作）；红色等重→分级（停止任务=红色实心紧急操作，关闭服务/重置默认=红色描边可逆操作）（2026-08-19） |
| 2026-08-19 | GUI 全局设置改为**即时保存**：移除右上角"保存全部配置"按钮；`gui/js/app.js` 新增 `CONFIG_FIELD_MAP` 字段映射表 + `saveConfigSilent` 增量提交（checkbox 立即保存、text 输入 500ms 防抖）+ 串行链防并发乱序 + 右上角"已自动保存/保存失败"状态提示；成功后用后端合并结果更新 `configCache` 避免 30s 重渲染覆盖；后端 `PUT /api/config` 本身是合并写回，零后端改动（2026-08-19） |
| 2026-08-19 | `gui/design-reference.html` 仪表盘标题区（"仪表盘总览 / 账户汇总与任务运行状态"）距顶部常驻栏距离与其他页面统一：根因是 `#contentPanels` 的 `space-y-8` 仅对非首个面板生效，导致仪表盘（首个 `panel-home`）少了 32px；修复为给 `panel-home` 加 `mt-8`，与其他页面统一为 64px |
| 2026-08-19 | `gui/design-reference.html` 导入/导出图标方向统一：**导出朝上（`m-4-8l-4-4m0 0L8 8m4-4v12`）、导入朝下（`m-4-4l-4 4m0 0L8 12m4 4V4`）**。涉及仪表盘数据、Session、日志三组六个按钮 |
| 2026-08-19 | `start-gui.bat` 修复：曾试 `chcp 65001`，但代码页切换期缓冲错位仍会啃掉后续中文行（报 `'澶勶紙server.js'`），最终**改为纯 ASCII**（英文注释/提示），任何代码页解析一致，从根上消除乱码；端口统一为 3000（start-gui / stop-gui / 文档同步）。`start-gui-silent.vbs` 注释改纯 ASCII，与编码无关 |
| 2026-08-19 | `.gitignore` 再调整（检查报告确认）：①删除 `/.agents` 规则——`.agents/skills/rewards-server-actions/` 技能文件与 `skills-lock.json` 需保留追踪，原忽略规则与现状矛盾；②`Microsoft-Rewards-Script.rar` 改通用 `*.rar`；③新增 `scripts/mac/mac的运行脚本`（中文名说明文件，`git rm --cached` 移出索引，本地保留）、`更新同步原项目.txt`（本地 git 命令备忘，同上）、`test/data/`（测试日志含真实邮箱，不提交） |
