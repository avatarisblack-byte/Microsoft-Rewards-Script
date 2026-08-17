# CODE_MAP

项目核心代码地图。修改代码前请先阅读本文档，修改后请更新对应条目。

## GUI 控制面板（新增模块）

| 文件 | 职责 |
|------|------|
| `gui/design-reference.html` | 控制面板前端页面（HTML 结构 + Tailwind CDN，样式与逻辑已拆分至 css/ js/） |
| `gui/server.js` | 零依赖本地服务（Node 内置 http/fs），提供静态页面与 JSON API |
| `gui/start-gui.bat` | 一键启动脚本（重写版）：`cd /d %~dp0` 锁定 gui 目录 → 设置 `PORT=3001` 环境变量（可改此处换端口，server.js 读取）→ 校验 server.js 存在 → 3 秒后 PowerShell 开浏览器 `http://localhost:%PORT%` → 当前窗口运行 `node server.js` + `pause` 保持主窗口查看日志 |
| `gui/start-gui-silent.vbs` | 静默启动脚本：WScript.Shell 以隐藏窗口模式（窗口模式参数 0）运行 start-gui.bat，双击无黑框后台启动服务。（2026-08-17 新增） |
| `gui/stop-gui.bat` | 停止服务脚本：按端口（默认 3001，与 start-gui.bat 的 PORT 保持一致）查找监听 PID 并 taskkill /f 强制结束，避免误杀其他 Node 进程。（2026-08-17 新增） |
| `gui/README.md` | GUI 专属用户文档（与根目录 README 的差异对照、快速开始、界面指南、安全保护、项目结构、GUI 视角 FAQ）。（2026-08-17 新增） |
| `gui/css/main.css` | 公共样式（.chart-placeholder / .card-shadow / 自定义滚动条），由 HTML head 引用 |
| `gui/css/animations.css` | 图表动画辅助样式（.chart-canvas-wrapper 禁选中 / 加载占位），由 HTML head 引用 |
| `gui/js/animator.js` | Chart.js 动画工具（chartAnimOptions 竖向上生长 + smoothUpdateChart 平滑更新），挂 window 全局供 app.js 调用 |
| `gui/js/app.js` | 前端核心交互逻辑（数据加载/渲染/任务控制/导入导出/弹窗），由 HTML body 底部引用 |

### gui/server.js 提供接口

| 接口 | 方法 | 参数 | 说明 |
|------|------|------|------|
| `/` | GET | - | 返回 gui/design-reference.html |
| `/api/accounts` | GET | - | 返回账号列表（关联日志摘要） |
| `/api/accounts` | POST | JSON 账号对象 | 新增账号（后端补全默认字段 → 重复检查 → 备份 .bak → 写回） |
| `/api/accounts/:email` | PUT | JSON 账号对象 | 更新单个账号配置（先备份 .bak → 校验 → 写回） |
| `/api/accounts/:email` | DELETE | - | 删除单个账号（备份 .bak → splice → 写回，写失败自动恢复备份） |
| `/api/sessions/import` | POST | JSON `{filename, dataBase64}` | 导入 Session 压缩包（Base64 → PowerShell 解压 → session_*.json 白名单 → 防路径穿越 → 备份 .bak → 复制到 dist/browser/sessions/） |
| `/api/sessions/export` | GET | - | 导出 Session 压缩包（扫描 dist/browser/sessions/ → session_*.json 白名单跳过 .bak → PowerShell Compress-Archive → zip 下载，文件名 sessions-时间戳.zip） |
| `/api/config` | GET | - | 返回 config.json |
| `/api/config` | PUT | JSON 配置对象 | 更新全局配置（宽松类型校验含 workers/searchSettings 布尔与字符串字段 → 强制忽略高风险字段 searchSettings.parallelSearching → 备份 config.json.bak → 合并写回保留未提交深层字段（queryEngines/chinaApi 等）→ 写失败自动恢复备份） |
| `/api/config/reset` | POST | - | 重置全局配置为默认（读 src/config.example.json 模板 → 备份 config.json.bak → 整体写回） |
| `/api/config/open` | POST | - | 用系统默认程序打开实际 config 文件（spawn cmd/xdg-open，便于手动编辑高风险字段） |
| `/api/start` | POST | - | 启动任务子进程 `spawn('node', [dist/index.js])` |
| `/api/stop` | POST | - | 停止任务（SIGTERM → 10秒后 SIGKILL 兜底） |
| `/api/task` | GET | - | 任务运行状态 + 最近 100 行实时日志 |
| `/api/shutdown` | POST | - | 关闭服务（先返回 response 告知前端 → 延迟 500ms → process.exit(0) 退出 Node 进程） |
| `/api/stats` | GET | - | 日志统计摘要（ACCOUNT-END 权威总计 + INFO 活动积分兜底） |
| `/api/logs` | GET | - | 返回 logs/ 目录文件列表 |
| `/api/logs/export` | GET | - | 导出日志压缩包（扫描 logs/ → *.log 白名单跳过 .bak → PowerShell Compress-Archive → zip 下载，文件名 logs-时间戳.zip） |
| `/api/logs/import` | POST | JSON `{filename, dataBase64}` | 导入日志压缩包（Base64 → PowerShell 解压 → *.log 白名单 → 防路径穿越 → 同名 .bak 备份 → 复制到 logs/） |
| `/api/logs/:date` | GET | YYYY-MM-DD | 返回指定日期日志解析结果 |
| `/api/logs/summary` | GET | - | 返回最新日志聚合摘要 |
| `/api/heartbeat` | GET | - | 心跳检测：刷新 lastHeartbeat 时间戳；服务端每 3 秒检查，超过 8 秒未收到心跳则自动退出（网页已关闭时清理进程）。（2026-08-17 新增） |
| `--generate-summary` | CLI | - | `node gui/server.js --generate-summary` 生成 gui/summary.json |

### 关键设计决策

- **日志目录固定为项目根目录 `logs/`**（与 Logger.ts 写入位置一致），不做 logssample 兼容。
- **账户保存流程**：备份 `accounts.json → accounts.json.bak` → 格式校验（与 src/util/Validator.ts 的 AccountSchema 字段规则一致）→ 合并写入 → 写回时自动恢复格式（4 空格缩进）。
- **请求体大小限制**：`readBody` 上限 100MB（session 导入与日志导入共用；日志累积可达数 MB + Base64 膨胀 33%）。
- **日志关联**：账号卡片状态通过邮箱前缀 `email.split('@')[0]` 匹配日志中 `[账户]` 字段。
- **任务启动（方案 A）**：`spawn('node', [dist/index.js])`，cwd=项目根目录。跨平台、kill() 干净（脚本自带 SIGTERM/SIGINT handler 正常清理）。开发模式自动降级为 ts-node。
- **统计防重复**：优先 ACCOUNT-END 唯一权威总计；无 ACCOUNT-END 时仅累加 INFO 级事件积分（跳过 DEBUG 余额差分行避免重复计数）。
- **前端图表**：Chart.js v4 CDN，Stacked 柱状图展示每日每账号收益。动画由 `js/animator.js` 统一提供：首次创建用 `chartAnimOptions`（x 方向 from 锚定到柱子最终 x 坐标 + y 的 from 回调从 y 轴 0 值像素位置竖向上生长，几何上杜绝"左上角斜飞"），30 秒自动刷新时用 `smoothUpdateChart`（更新前删除 y.from 回调）从当前显示值平滑过渡（不归零重飞）。**惰性创建**：Chart 仅在统计面板可见时才 `new Chart`（隐藏容器 0×0 布局会导致 scale 异常、动画起点错乱），导航切到 stats 且图表未创建时补建。（2026-08-17：app.js 接入 animator.js；HTML 引用 animations.css；修复斜飞与重飞 + 惰性创建）
- **Home 总积分兜底与日志账号合并**：仪表盘"总积分"合并统计「已配置账号」（通过 status 关联日志）与「日志中有收益但未在 accounts.json 配置的账号」（logSummary 中排除已配置前缀的项），避免当前仅配置占位账号时总积分显示为 0；单账号余额优先 `latestBalance`（URL-REWARD 的 新余额=），缺失时用 ACCOUNT-END 的权威最终值 `finalPoints`（日志 `→ 新值:`）兜底。（2026-08-17）
- **Stats 面板零收益过滤**：数据统计页不显示收益为零的账户——图表图例/堆叠柱仅收集 `points > 0` 的账户，累计收益列表仅渲染 `totalPoints > 0` 的账户（前端 renderStats() 过滤，不动后端数据源；2026-08-17）
- **心跳检测**：前端页面加载后每 3 秒 fetch `/api/heartbeat`；`server.js` 记录 `lastHeartbeat`，用 `setInterval`（3 秒）检查，超过 8 秒未收到心跳视为网页已关闭 → 打印日志并 `process.exit(0)` 自动退出，避免静默启动的 Node 服务残留。（2026-08-17）
- **端口配置**：GUI 默认端口改为 3001（原 3000 常与用户其他脚本冲突）。`server.js` 读取 `PORT` 环境变量（`process.env.PORT \|\| 3000` 作为兜底），`start-gui.bat` 中 `set PORT=3001` 统一控制，改 bat 末尾端口号即可整体换端口。（2026-08-17）
- **前端响应式布局**：侧边栏 `aside` 固定 `flex-shrink-0`、内容区 `main` 固定 `min-w-0`（防止面板内容撑爆挤压侧边栏）；面板内横向排列容器统一使用 `flex-wrap` + 响应式 `grid md:` 断点（参照 accounts/settings 面板写法，2026-08-16 修复 90%/125% 缩放下 home/stats 面板跑版问题）。

## 原有模块（参考）

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口：MicrosoftRewardsBot 类，任务流程编排 |
| `src/util/Load.ts` | 加载 accounts.json / config.json |
| `src/util/Validator.ts` | Zod 校验 accounts 与 config 结构 |
| `src/logging/Logger.ts` | 日志写入 `logs/YYYY-MM-DD.log` |