# CODE_MAP

项目核心代码地图。修改代码前请先阅读本文档，修改后请更新对应条目。

## 项目概览

| 模块 | 说明 |
|------|------|
| `src/` | 主脚本（TypeScript v3.1.6.4）：Microsoft Rewards 积分自动化（patchright 浏览器 + 指纹注入 + Cheerio 解析 + 多进程集群） |
| `gui/` | 控制面板（零依赖 Node 服务 + 原生前端）：浏览器可视化管理账号/配置/统计/任务 |
| `scripts/` | 运维脚本：Docker 容器、macOS 启动、浏览器 Session 管理 CLI |
| `test/` | 日志解析与统计的交叉对拍测试 |
| `doc/` | 文档系统（本文件为入口） |

---

## GUI 控制面板（gui/）

### 目录结构

| 文件 | 职责 |
|------|------|
| `gui/design-reference.html` | 控制面板前端页面（HTML 结构 + Tailwind CDN + Chart.js CDN，样式与逻辑已拆分至 css/ js/） |
| `gui/server.js` | 入口（≈59 行）：组装 ctx → 按序调用 lib/routes/ 各路由 → `--generate-summary` CLI → listen（2026-08-18 重构） |
| `gui/lib/config.js` | 常量（PORT/ROOT/GUI_DIR/HTML_FILE/LOGS_DIR）+ resolveAccountsPath/resolveConfigPath/readJson（2026-08-18 新增） |
| `gui/lib/httpUtils.js` | sendJson / sendText / readBody（100MB 上限）（2026-08-18 新增） |
| `gui/lib/validator.js` | validateAccountShape（账号结构校验，与 src/util/Validator.ts 字段规则对齐）（2026-08-18 新增） |
| `gui/lib/logger.js` | parseLogLine / listLogFiles / readLogFile（2026-08-18 新增） |
| `gui/lib/summary.js` | summarizeLogs / summarizeAllLogs / generateSummary / writeSummaryFile；收益口径：ACCOUNT-END 累加 + 本地时区日期键 + todayTotal（2026-08-18/19 新增） |
| `gui/lib/archive.js` | unzipToDir / zipDir / makeTmpRoot（PowerShell/unzip 跨平台零依赖压缩解压）（2026-08-18 新增） |
| `gui/lib/taskManager.js` | startTask / stopTask / getTaskStatus（子进程 spawn node dist/index.js，SIGTERM→10s SIGKILL 兜底，500 行环形日志缓冲）（2026-08-18 新增） |
| `gui/lib/routes/static.js` | 静态页 + `/css/*` `/js/*` 分发（防路径穿越黑名单）（2026-08-18 新增） |
| `gui/lib/routes/config.js` | 配置 CRUD：GET/PUT `/api/config`、POST `/api/config/reset`、POST `/api/config/open`（2026-08-18 新增） |
| `gui/lib/routes/accounts.js` | 账号 CRUD：GET/POST `/api/accounts`、PUT/DELETE `/api/accounts/:email`（.bak 备份+回滚）（2026-08-18 新增） |
| `gui/lib/routes/logs.js` | 日志：GET `/api/logs`、导出/导入 zip、GET `/api/logs/:date`、GET `/api/logs/summary`（2026-08-18 新增） |
| `gui/lib/routes/sessions.js` | Session zip 导入/导出（白名单 session_*.json + 防穿越 + .bak）（2026-08-18 新增） |
| `gui/lib/routes/data.js` | 一键数据导入/导出（sessions+logs+accounts.json+config.json 打包恢复）（2026-08-18 新增） |
| `gui/lib/routes/tasks.js` | 任务：POST `/api/start`、POST `/api/stop`、GET `/api/task`（2026-08-18 新增） |
| `gui/lib/routes/system.js` | 系统：POST `/api/shutdown`、GET `/api/stats`/`/api/summary`、GET `/api/keepalive`（SSE 保活）（2026-08-18 新增） |
| `gui/start-gui.bat` | 一键启动脚本：**纯 ASCII（无中文，避免任何代码页乱码）**：`cd /d %~dp0` → `set PORT=3000`（可改）→ 校验 server.js → 3 秒后 PowerShell 开浏览器 → 当前窗口跑 `node server.js` |
| `gui/start-gui-silent.vbs` | 静默启动（WScript.Shell 隐藏窗口跑 start-gui.bat）（2026-08-17 新增） |
| `gui/stop-gui.bat` | 按端口（默认 3000）查 PID 并 taskkill /f 停止，避免误杀其他 Node 脚本（2026-08-17 新增） |
| `gui/README.md` | GUI 专属用户文档（2026-08-17 新增；2026-08-20 全面重写） |
| `gui/css/main.css` | 公共样式：卡片阴影/滚动条/图表占位 + 按钮组件类（.btn 家族）+ 弹窗/开关/进度条动效 + reduced-motion 降级（2026-08-19/20 扩充） |
| `gui/css/animations.css` | 图表容器辅助样式（user-select 禁用、加载占位骨架） |
| `gui/js/animator.js` | Chart.js 动画工具：chartAnimOptions（x 锚定 + y 从 0 生长）+ smoothUpdateChart（保留当前高度过渡，显式 400ms，reduced-motion 0ms）（2026-08-20 收敛时长） |
| `gui/js/app.js` | 前端核心交互逻辑（加载/渲染/任务/导入导出/弹窗/SSE 保活/全局配置即时保存） |
| `gui/summary.json` | `--generate-summary` CLI 生成的持久化统计产物（不入库） |

### gui/server.js（及 lib/routes/）提供接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/` | GET | - | 返回 gui/design-reference.html |
| `/api/accounts` | GET | - | 返回账号列表（经 summarizeAllLogs 关联全量日志摘要） |
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
| `/api/start` | POST | - | 启动任务子进程（spawn node dist/index.js，开发模式降级 ts-node） |
| `/api/stop` | POST | - | 停止任务（SIGTERM→10s SIGKILL 兜底） |
| `/api/task` | GET | - | 任务状态 + 最近 100 行日志 |
| `/api/shutdown` | POST | - | 关闭服务（延迟 500ms 退出） |
| `/api/stats`/`/api/summary` | GET | - | 日志统计摘要（即时重算） |
| `/api/keepalive` | GET | - | SSE 长连接保活（text/event-stream+keep-alive，req.on close→process.exit(0)） |
| `--generate-summary` | CLI | - | `node gui/server.js --generate-summary` 生成 gui/summary.json |

### 关键设计决策

- **日志目录固定为项目根目录 `logs/`**（与 Logger.ts 写入位置一致）。
- **账户保存流程**：备份 `.bak` → 校验 → 合并写入 → 4 空格缩进写回，失败自动恢复。
- **请求体限制**：readBody 100MB（session/日志/数据导入共用）。
- **日志关联**：账号卡片状态经邮箱前缀 `email.split('@')[0]` 匹配日志 `[账户]`；`GET /api/accounts` 用 `summarizeAllLogs()` 聚合全部日志（2026-08-19 修复），此前只读最新一天日志导致历史运行过的账号显示"暂无运行记录"。
- **任务启动**：`spawn('node',[dist/index.js])`，cwd=项目根目录，开发模式降级 ts-node。
- **统计防重复**：优先 ACCOUNT-END 权威总计（同日多次运行累加）；无则累加 INFO 级活动积分（跳过 DEBUG 差额行）。
- **前端图表**：Chart.js v4 堆叠柱。首次创建 `animations: false`（隐藏面板时尺寸 0×0 会导致动画起点错乱，惰性创建）；更新走 `smoothUpdateChart`（animator.js）保留当前显示高度过渡、显式 400ms（原 Chart.js 默认 1000ms 偏慢）。
- **Home 总积分兜底与日志账号合并**：latestBalance 优先、finalPoints 兜底；合并"已配置账号 + 日志有收益未配置账号"。（2026-08-17）
- **Stats 零收益过滤**：图例/堆叠柱仅收集 points>0，累计列表仅 totalPoints>0。（2026-08-17）
- **一键导入导出本地数据（2026-08-18）**：仪表盘标题区"导出数据/导入数据"按钮，打包/恢复 sessions+logs+accounts.json+config.json；白名单+防穿越+.bak+回滚。
- **模块化重构（2026-08-18）**：`server.js` 原约 1600 行拆为 `gui/lib/`（7 基础模块）+ `gui/lib/routes/`（8 路由模块），入口精简为组装 ctx+顺序分发。路由签名 `(req,res,pathname,ctx)=>boolean`（true=已处理），ctx 注入 config/http/validator/logger/summary/archive/taskManager 规避循环 require。拆分按依赖递增（config→httpUtils/validator→logger→summary→archive→taskManager→routes→入口）。
- **网页关闭自动退出（SSE 长连接，2026-08-18）**：前端 EventSource('/api/keepalive')；服务端 text/event-stream+no-cache+keep-alive、不 res.end()、req.on('close')→process.exit(0)；不受浏览器后台标签页节流影响；前端 beforeunload 防误关。原 /api/heartbeat 短轮询已移除。
- **端口配置**：默认端口 3000。start-gui.bat 中 `set PORT=3000` 统一控制（stop-gui.bat 的 `PORT_TO_KILL` 需同步）。
- **前端响应式**：aside flex-shrink-0 + main min-w-0，防面板撑爆挤瘪侧边栏。（2026-08-16）
- **全局配置即时保存（2026-08-19）**：checkbox 立即提交、text 500ms 防抖 + 失焦兜底；`CONFIG_FIELD_MAP` 字段映射表 + `saveConfigSilent` 增量提交；串行 Promise 链防并发写盘乱序；右上角"已自动保存/保存失败"状态提示（2.5s 后淡出）。
- **前端动效规范（2026-08-20）**：按 emil-design-eng / review-animations 标准落地——按钮按压 `scale(0.97)` 160ms；弹窗进出对称（opacity + scale(0.96)↔1，250ms ease-out，关闭先播退出再 display:none，`data-open` 属性驱动，防快速开关竞态）；开关滑块 `after:transition-transform` + 轨道颜色 150ms ease（消除 `transition: all`）；面板切换 160ms 极轻淡入（tens/天高频克制档）；收益进度条 DOM diff 更新 + `transform: scaleX`（GPU，400ms）；全局 `prefers-reduced-motion` 降级（保留 opacity/颜色、移除位移）。

---

## 主脚本（src/）

### 入口与流程

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：`MicrosoftRewardsBot` 类。任务流程编排（RUN-START→逐账户 Main 流程→RUN-END）；集群模式（cluster 多进程分片跑账号，主进程聚合统计）；AsyncLocalStorage 执行上下文（isMobile/account）；SIGINT/SIGTERM/uncaughtException 兜底；webhook 摘要发送 |
| `src/constants.ts` | 全局常量：超时、重试次数、魔法数字（TIMEOUTS 等） |
| `src/crontab.template` | crontab 定时运行模板（Docker/服务器部署参考） |
| `src/accounts.example.json` | 账号模板（GUI 回退读取源之一） |
| `src/config.example.json` | 配置模板（GUI 回退读取源 + 重置默认模板） |

### browser/ 浏览器层（patchright + 指纹）

| 文件 | 职责 |
|------|------|
| `src/browser/Browser.ts` | 浏览器工厂：patchright 启动 chromium，fingerprint-injector 注入反检测指纹，会话恢复（cookies+指纹）与保存 |
| `src/browser/BrowserFunc.ts` | 浏览器功能：Dashboard 数据拉取（REST API + 新版 UI Server Actions）、可赚积分、当前余额、Server Action 部署 ID 提取（`extractDeploymentId`）、浏览器关闭清理 |
| `src/browser/BrowserUtils.ts` | 浏览器工具：Cheerio 解析 DOM、ghost-cursor 人类化点击/滚动/输入、页面导航封装 |
| `src/browser/UserAgent.ts` | UA 管理：从 fingerprint-generator 取 Chrome/Edge 版本与 UA，维护可用 UA 池 |
| `src/browser/auth/Login.ts` | 登录编排：选择登录方式、会话恢复/保存、获取 App Access Token |
| `src/browser/auth/methods/EmailLogin.ts` | 邮箱+密码登录 |
| `src/browser/auth/methods/GetACodeLogin.ts` | 代码验证登录（收验证码） |
| `src/browser/auth/methods/MobileAccessLogin.ts` | 移动访问令牌登录（randomBytes 构造授权请求） |
| `src/browser/auth/methods/PasswordlessLogin.ts` | 无密码登录 |
| `src/browser/auth/methods/RecoveryEmailLogin.ts` | 恢复邮箱登录 |
| `src/browser/auth/methods/Totp2FALogin.ts` | TOTP 2FA 登录（otpauth 生成动态码） |
| `src/browser/auth/methods/LoginUtils.ts` | 登录工具：错误/副标题信息提取、readline 交互输入 |

### functions/ 活动层

| 文件 | 职责 |
|------|------|
| `src/functions/Workers.ts` | 活动 worker 基类：封装 Axios 请求、积分获取与通用活动逻辑 |
| `src/functions/Activities.ts` | 活动聚合：连击保护（doStreakProtection）、每日签到（doDailyCheckIn）、阅读奖励（doReadToEarn） |
| `src/functions/SearchManager.ts` | 搜索编排：计算缺失搜索积分，调度移动端+桌面端搜索（独立浏览器会话、指纹轮换） |
| `src/functions/QueryEngine.ts` | 查询引擎：Google/趋势/Reddit/Wikipedia 与中国热搜源（百度/头条/抖音/微博/知乎），限流退避、日志聚合 |
| `src/functions/activities/api/ClaimBonusPoints.ts` | 领取 dashboard 奖励积分（新版 UI Server Action） |
| `src/functions/activities/api/DoubleSearchPoints.ts` | 双倍搜索积分活动 |
| `src/functions/activities/api/FindClippy.ts` | 找 Clippy 活动 |
| `src/functions/activities/api/Quiz.ts` | 测验解答（0 分与 30-40 分变体、此或彼、ABC、投票） |
| `src/functions/activities/api/StreakProtection.ts` | 连击保护 Server Action（toggleStreakProtection） |
| `src/functions/activities/api/UrlReward.ts` | URL 奖励（旧版 REST） |
| `src/functions/activities/api/UrlRewardNew.ts` | URL 奖励（新版 Server Actions，部署 ID 守卫） |
| `src/functions/activities/app/AppReward.ts` | App 奖励（随机 UUID 构造请求） |
| `src/functions/activities/app/DailyCheckIn.ts` | App 每日签到 |
| `src/functions/activities/app/ReadToEarn.ts` | 阅读文章奖励 |
| `src/functions/activities/browser/Search.ts` | 浏览器搜索活动（QueryCore 驱动） |
| `src/functions/activities/browser/SearchOnBing.ts` | Bing 本地化查询（bing.com 搜索） |
| `src/functions/bing-search-activity-queries.json` | Bing 搜索活动查询词库 |
| `src/functions/search-queries.json` | 本地查询词库（标准词，含中国地区热词） |

### interface/ 类型定义

| 文件 | 职责 |
|------|------|
| `src/interface/Account.ts` | 账号结构（含代理、指纹保留、2FA 字段） |
| `src/interface/Config.ts` | 全局配置结构（workers 开关、搜索设置、webhook 等） |
| `src/interface/DashboardData.ts` | Dashboard REST 数据（活动项、计数器、促销类型） |
| `src/interface/AppDashBoardData.ts` / `AppUserData.ts` | App 端 Dashboard / 用户数据 |
| `src/interface/PanelFlyoutData.ts` | 新版 UI 面板弹出数据（Server Actions 用） |
| `src/interface/XboxDashboardData.ts` | Xbox 面板数据 |
| `src/interface/Points.ts` | 可赚取积分结构 |
| `src/interface/QuizData.ts` | 测验数据（题目/选项/完成态） |
| `src/interface/Search.ts` | 搜索源响应类型（Google/趋势/Reddit/Wikipedia） |
| `src/interface/ActivityHandler.ts` | 活动处理器契约 |
| `src/interface/UserAgentUtil.ts` | Chrome/Edge 版本数据结构 |

### logging/ 日志与通知

| 文件 | 职责 |
|------|------|
| `src/logging/Logger.ts` | 日志：控制台着色（chalk）+ 写入 `logs/YYYY-MM-DD.log` + 集群 IPC 转发 + 过滤（LogFilter） |
| `src/logging/Discord.ts` | Discord webhook（p-queue 队列化发送+flush） |
| `src/logging/Ntfy.ts` | ntfy.sh webhook |
| `src/logging/PushPlus.ts` | PushPlus 微信推送（运行摘要） |

### util/ 工具

| 文件 | 职责 |
|------|------|
| `src/util/Load.ts` | 加载 accounts.json / config.json（Zod 校验后缓存），会话（cookies/指纹）读写 |
| `src/util/Validator.ts` | Zod schema：validateAccounts / validateConfig；checkNodeVersion（semver 版本检查） |
| `src/util/Axios.ts` | 带代理的 HTTP 客户端（http/https/socks5 代理，axios-retry 重试） |
| `src/util/ErrorDiagnostic.ts` | 错误诊断：出错时保存页面截图 + DOM 快照到 diagnostics/ |
| `src/util/Utils.ts` | 通用工具：ms 时长解析、chunkArray、wait、邮箱用户名提取、随机延迟 |

---

## 运维脚本（scripts/）

| 文件 | 职责 |
|------|------|
| `scripts/utils.js` | 共享工具（ESM）：路径解析（getDirname/getProjectRoot）、配置/账号加载、参数解析、cookies/指纹加载、代理构造、清理钩子 |
| `scripts/main/browserSession.js` | 浏览器会话管理 CLI（`npm run open-session`）：为指定账号打开浏览器/加载会话/注入指纹 |
| `scripts/main/clearSessions.js` | 清理会话 CLI（`npm run clear-sessions`）：按 config.sessionPath 删除全部账号会话目录 |
| `scripts/docker/entrypoint.sh` | Docker 容器入口：设置 PLAYWRIGHT_BROWSERS_PATH、每日调度 |
| `scripts/docker/run_daily.sh` | Docker 每日运行脚本（TZ 时区、循环调度） |
| `scripts/mac/mac_script.sh` | macOS 启动脚本（随机延迟后 npm start） |
| `scripts/mac/local.npm-start.plist` / `local.npm-start.example.plist` | macOS launchd 开机/定时任务 plist |

## 测试

| 文件 | 职责 |
|------|------|
| `test/script/run-log-tests.js` | 日志导入（解析）+ 分析（统计）测试：`node test/script/run-log-tests.js`，零依赖（node:assert），数据源 `test/data/logs-20260819-125022/`（7 份日志）；含独立参考实现（split 法解析 + 逐账户聚合）与被测 `logger.js`/`summary.js` 交叉对拍，动态生成期望值（2026-08-19 新增） |

## 根目录配置

| 文件 | 职责 |
|------|------|
| `package.json` | 主脚本 v3.1.6.4；scripts：build/start/dev/lint/format/clear-sessions/open-session/create-docker；Node ≥24 |
| `tsconfig.json` | TypeScript 编译配置 |
| `eslint.config.mjs` / `.prettierrc` | 代码规范（ESLint 10 + Prettier 3） |
| `Dockerfile` / `compose.yaml` / `.dockerignore` | Docker 构建与编排（`npm run create-docker`） |
| `env.example` | 环境变量示例 |
| `run.bat` / `setup.bat` | Windows 一键安装/运行 |
| `diagnose-cron.sh` | Linux 定时任务诊断脚本 |

## 变更记录

| 日期 | 内容 |
|------|------|
| 2026-08-20 | **CodeMap 全面同步**：gui 模块补全（lib/routes/ 8 路由拆行、summary.json、动效说明），"原有模块（参考）"扩写为完整 src/ 架构（browser/functions/interface/logging/util 五层），新增 scripts/ 与根目录配置小节，追加 GUI 前端动效规范设计决策 |
| 2026-08-20 | **GUI 前端动效优化（emil-design-eng / review-animations 规范落地）**：①弹窗进出对称动画——打开 opacity+scale(0.96)→1（250ms ease-out，`data-open` 属性 + 双 rAF 触发，替代原 10ms setTimeout 纯淡入），关闭先播退出动画再 display:none（transitionend + 300ms 兜底，`_closing` 防快速开关竞态）；②开关组件——滑块 `after:transition-all`→`after:transition-transform duration-200 ease-out`（消除 `transition: all` 硬性违规），轨道颜色补 `.toggle-track` 150ms ease 过渡；③收益进度条——`transition-all duration-500` + innerHTML 全量重绘（过渡永不生效、宽度瞬跳）改为 DOM diff 更新 + `transform: scaleX`（transform-origin:left，400ms ease-out，GPU 合成属性）；④面板切换 160ms 极轻淡入（tens/天高频克制档，不做过位移动画）；⑤图表动画——animator.js 首次生长 600ms→400ms、smoothUpdateChart 显式 `update({duration:400})`（原 Chart.js 默认 1000ms 拖沓）、reduced-motion 0ms；⑥`animate-ping`/面板/遮罩/保存提示/代理字段禁用态补齐 reduced-motion 或过渡；⑦日志自动滚动仅在用户接近底部时触发。涉及文件：`gui/css/main.css`、`gui/js/app.js`、`gui/js/animator.js`、`gui/design-reference.html` |
| 2026-08-19 | **新增日志导入/分析测试脚本**：`test/script/run-log-tests.js` 用 `test/data/logs-20260819-125022/`（logs-20260819-125022.zip 解压）跑 logger/summary 全流程测试。首次运行 31 项断言全部通过（解析 6551 行/过滤 555 异常行；每日收益 204/113/233/189/142/447/208；accountTotals 与独立参考实现完全一致）。期间测试脚本自身修过 3 处 bug（详见 commit 历史），被测代码零改动。验证了 08-14 同一天两次运行 ACCOUNT-END 累加 = 113、08-15/08-16 未完成账户走活动积分兜底（101/112）、08-19 无 ACCOUNT-END 兜底 208（2026-08-19） |
| 2026-08-19 | **仪表盘总览收益口径修正（累计收益 vs 账户余额）**：`gui/lib/summary.js` 修复收益统计两处 bug——①同一账号同一天多次运行 ACCOUNT-END `总计` 由"覆盖"改为"累加"（`summarizeLogs` 与 `generateSummary` 同步修正），此前只统计最后一次运行导致收益被低估；②统计日期由"UTC 时间戳切片"改为按本地时区换算（`toLocalDateKey`），修复跨 UTC 日界时"今日收益"偏差；`generateSummary` 新增 `todayTotal`（本地时区今日收益）。`gui/design-reference.html` 首页顶部收益卡标题改"今日收益 / 总收益"（原"今日总收益 / 总积分"右侧实为账户余额），统计页"今日收益"卡副标题同步更新。`gui/js/app.js`：新增 `statsCache`，`loadData` 并行拉取 `/api/stats`（30s 轮询已存在），`renderHome` 顶部卡改为读 `todayTotal`/`grandTotal`（脚本执行带来的收益，移除旧余额汇总逻辑），账号卡片"今日收益"改为今日多账号/多次运行累计；`renderStats` 优先用 `statsCache` 减少重复请求，今日收益改用后端 `todayTotal`。日志分析链路（`logger.js` 解析 → `summary.js` 聚合 → routes 分发）经核查拆分合理、无循环依赖，正则与 Logger.ts 输出格式完全匹配（2026-08-19） |
| 2026-08-19 | **GUI 按钮配色优化（设计系统化，方案 B）**：`gui/css/main.css` 新增按钮组件类（`.btn` 基础 + `.btn-dark` 启动任务深色 CTA / `.btn-primary` 蓝色主操作 / `.btn-danger` 红色紧急 / `.btn-secondary` 白底描边次级 / `.btn-danger-ghost` 红字描边次级危险 / `.btn-ghost` 中性描边取消 / `.btn-icon` 图标按钮）；统一按压反馈 `:active scale(0.97)`（emil-design-eng 原则）、`:focus-visible` 焦点环（WCAG 2.4.7）、hover 加深、`prefers-reduced-motion` 降级；`gui/design-reference.html` 约 22 处静态按钮与 `gui/js/app.js` 账号卡片 2 处动态图标按钮全部替换为组件类；`app.js` 中 3 处依赖旧类名的 JS 选择器同步更新（`#panel-settings .btn-danger-ghost` / `#modal-add-account .btn-primary` / `#modal-account-settings .btn-primary`）。设计决策：实心灰次级按钮→白色描边按钮（降低层级，突出蓝色主操作）；红色等重→分级（停止任务=红色实心紧急操作，关闭服务/重置默认=红色描边可逆操作）（2026-08-19） |
| 2026-08-19 | GUI 全局设置改为**即时保存**：移除右上角"保存全部配置"按钮；`gui/js/app.js` 新增 `CONFIG_FIELD_MAP` 字段映射表 + `saveConfigSilent` 增量提交（checkbox 立即保存、text 输入 500ms 防抖）+ 串行链防并发乱序 + 右上角"已自动保存/保存失败"状态提示；成功后用后端合并结果更新 `configCache` 避免 30s 重渲染覆盖；后端 `PUT /api/config` 本身是合并写回，零后端改动（2026-08-19） |
| 2026-08-19 | `gui/design-reference.html` 仪表盘标题区（"仪表盘总览 / 账户汇总与任务运行状态"）距顶部常驻栏距离与其他页面统一：根因是 `#contentPanels` 的 `space-y-8` 仅对非首个面板生效，导致仪表盘（首个 `panel-home`）少了 32px；修复为给 `panel-home` 加 `mt-8`，与其他页面统一为 64px |
| 2026-08-19 | `gui/design-reference.html` 导入/导出图标方向统一：**导出朝上（`m-4-8l-4-4m0 0L8 8m4-4v12`）、导入朝下（`m-4-4l-4 4m0 0L8 12m4 4V4`）**。涉及仪表盘数据、Session、日志三组六个按钮 |
| 2026-08-19 | `start-gui.bat` 修复：曾试 `chcp 65001`，但代码页切换期缓冲错位仍会啃掉后续中文行（报 `'澶勶紙server.js'`），最终**改为纯 ASCII**（英文注释/提示），任何代码页解析一致，从根上消除乱码；端口统一为 3000（start-gui / stop-gui / 文档同步）。`start-gui-silent.vbs` 注释改纯 ASCII，与编码无关 |
| 2026-08-19 | `.gitignore` 再调整（检查报告确认）：①删除 `/.agents` 规则——`.agents/skills/rewards-server-actions/` 技能文件与 `skills-lock.json` 需保留追踪，原忽略规则与现状矛盾；②`Microsoft-Rewards-Script.rar` 改通用 `*.rar`；③新增 `scripts/mac/mac的运行脚本`（中文名说明文件，`git rm --cached` 移出索引，本地保留）、`更新同步原项目.txt`（本地 git 命令备忘，同上）、`test/data/`（测试日志含真实邮箱，不提交） |
