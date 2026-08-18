/**
 * Microsoft-Rewards-Script GUI 控制台本地服务
 * 零依赖：仅使用 Node.js 内置 http / fs 模块
 * 
 * 启动方式: node gui/server.js
 * 默认端口: 3000，可通过环境变量 PORT 覆盖
 * 
 * 提供:
 *   GET /               → 返回 gui/design-reference.html（控制面板页面）
 *   GET /api/accounts   → 读取项目根目录 accounts.json 并返回
 *   GET /api/config     → 读取项目根目录 config.json 并返回
 *   GET /api/logs       → 读取 logs/ 目录下最近的日志文件，返回合并解析结果
 *   GET /api/logs/:date → 读取指定日期的日志文件, date 格式 YYYY-MM-DD
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PORT = process.env.PORT || 3000
const ROOT = path.join(__dirname, '..')
const GUI_DIR = __dirname
const HTML_FILE = path.join(GUI_DIR, 'design-reference.html')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json')
// 日志目录：脚本运行时 Logger.ts 写入的位置（项目根目录 /logs）
const LOGS_DIR = path.join(ROOT, 'logs')

/**
 * 账户配置的查找顺序：
 * 1. 项目根目录 accounts.json（dist 模式下为 dist/accounts.json）
 * 2. src/accounts.example.json（开发模板）
 */
function resolveAccountsPath() {
    const candidates = [
        path.join(ROOT, 'accounts.json'),
        path.join(ROOT, 'dist', 'accounts.json'),
        path.join(ROOT, 'src', 'accounts.example.json')
    ]
    for (const p of candidates) {
        if (fs.existsSync(p)) return p
    }
    return candidates[0]
}

/**
 * config 配置的查找顺序同上
 */
function resolveConfigPath() {
    const candidates = [
        path.join(ROOT, 'config.json'),
        path.join(ROOT, 'dist', 'config.json'),
        path.join(ROOT, 'src', 'config.example.json')
    ]
    for (const p of candidates) {
        if (fs.existsSync(p)) return p
    }
    return candidates[0]
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
        return null
    }
}

/**
 * 校验单个账号对象是否符合项目 AccountSchema 格式要求
 * 与 src/util/Validator.ts 中的 Zod 校验保持一致的字段规则
 */
function validateAccountShape(acc) {
    if (!acc || typeof acc !== 'object' || Array.isArray(acc)) {
        return '账号必须是一个对象'
    }

    const errors = []

    if (typeof acc.email !== 'string' || !acc.email.includes('@')) {
        errors.push('email 必须是非空邮箱字符串')
    }
    if (typeof acc.password !== 'string') {
        errors.push('password 必须是字符串')
    }
    if (acc.totpSecret !== undefined && typeof acc.totpSecret !== 'string') {
        errors.push('totpSecret 必须是字符串')
    }
    if (acc.recoveryEmail !== undefined && typeof acc.recoveryEmail !== 'string') {
        errors.push('recoveryEmail 必须是字符串')
    }
    if (typeof acc.geoLocale !== 'string') {
        errors.push('geoLocale 必须是字符串 (如 "auto" / "us" / "cn")')
    }
    if (typeof acc.langCode !== 'string') {
        errors.push('langCode 必须是字符串 (如 "zh" / "en")')
    }

    // proxy 对象校验
    const p = acc.proxy
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push('proxy 必须是一个对象')
    } else {
        if (typeof p.proxyAxios !== 'boolean') errors.push('proxy.proxyAxios 必须是布尔值')
        if (typeof p.url !== 'string') errors.push('proxy.url 必须是字符串')
        if (typeof p.port !== 'number' || !Number.isFinite(p.port)) errors.push('proxy.port 必须是数字')
        if (typeof p.username !== 'string') errors.push('proxy.username 必须是字符串')
        if (typeof p.password !== 'string') errors.push('proxy.password 必须是字符串')
    }

    // saveFingerprint 对象校验
    const sf = acc.saveFingerprint
    if (!sf || typeof sf !== 'object' || Array.isArray(sf)) {
        errors.push('saveFingerprint 必须是一个对象')
    } else {
        if (typeof sf.mobile !== 'boolean') errors.push('saveFingerprint.mobile 必须是布尔值')
        if (typeof sf.desktop !== 'boolean') errors.push('saveFingerprint.desktop 必须是布尔值')
    }

    return errors.length > 0 ? errors.join('；') : null
}

/**
 * 从日志行中解析出结构化数据
 * 日志格式: [UTC时间] [本地时间] [账户] [级别] [设备] [事件] 消息
 * 例: 2026-08-16T02:10:44.484Z [2026/8/16 10:10:44] [avatar.is.black] [INFO] 主进程 [RUN-START] ...
 */
function parseLogLine(line) {
    if (!line || line.trim() === '') return null
    const m = line.match(
        /^(\S+)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+([^\s]+)\s+\[([^\]]+)\]\s+(.*)$/
    )
    if (!m) return null
    return {
        utcTime: m[1],
        localTime: m[2],
        account: m[3],
        level: m[4],
        platform: m[5],
        event: m[6],
        message: m[7]
    }
}

/**
 * 读取 logs/ 目录下的日志文件，返回按日期倒序排列的文件列表
 */
function listLogFiles() {
    try {
        if (!fs.existsSync(LOGS_DIR)) return []
        return fs
            .readdirSync(LOGS_DIR)
            .filter(f => f.endsWith('.log'))
            .sort()
            .reverse()
    } catch {
        return []
    }
}

/**
 * 解析日志文件内容，并附带一些聚合统计
 */
function readLogFile(dateStr, limit = 0) {
    const files = dateStr ? [dateStr] : listLogFiles().slice(0, 1)
    if (files.length === 0) return { date: dateStr || null, entries: [], summary: null }

    const filePath = path.join(LOGS_DIR, files[0])
    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        const startIndex = limit > 0 ? Math.max(0, lines.length - limit) : 0
        const entries = lines
            .slice(startIndex)
            .map(parseLogLine)
            .filter(Boolean)

        return {
            date: files[0].replace('.log', ''),
            entries,
            summary: summarizeLogs(entries)
        }
    } catch {
        return { date: dateStr || null, entries: [], summary: null }
    }
}

/**
 * 聚合日志中的关键数据：
 * - 每个账号的积分增长情况（ACCOUNT-END 事件）
 * - 每个账号的最近活动状态
 */
function summarizeLogs(entries) {
    const accounts = {}

    for (const e of entries) {
        if (!e || e.account === '主进程') continue

        if (!accounts[e.account]) {
            accounts[e.account] = {
                account: e.account,
                entries: 0,
                lastEvent: null,
                lastLevel: null,
                lastTime: null,
                lastMessage: null,
                collectedPoints: null,
                initialPoints: null,
                finalPoints: null
            }
        }

        const acc = accounts[e.account]
        acc.entries++
        acc.lastTime = e.utcTime || e.localTime
        acc.lastEvent = e.event
        acc.lastLevel = e.level
        acc.lastMessage = e.message
        acc.lastPlatform = e.platform

        // ACCOUNT-END / FLOW 事件中包含积分汇总
        if (e.event === 'ACCOUNT-END') {
            const totalMatch = e.message.match(/总计:\s*\+(\d+)/)
            const initialMatch = e.message.match(/原始:\s*(\d+)\s*→/)
            const finalMatch = e.message.match(/→\s*新值:\s*(\d+)/)
            if (totalMatch) acc.collectedPoints = parseInt(totalMatch[1], 10)
            if (initialMatch) acc.initialPoints = parseInt(initialMatch[1], 10)
            if (finalMatch) acc.finalPoints = parseInt(finalMatch[1], 10)
        }

        // 记录最新的积分余额变化（URL-REWARD / SEARCH-BING 等）
        if (e.event === 'URL-REWARD' && e.message.includes('完成UrlReward')) {
            const gained = e.message.match(/获得积分=(\d+)/)
            const newBalance = e.message.match(/新余额=(\d+)/)
            if (gained) acc.collectedFromLastRun = parseInt(gained[1], 10)
            if (newBalance) acc.latestBalance = parseInt(newBalance[1], 10)
        } else if (e.event === 'SEARCH-BING' && e.message.includes('获得积分')) {
            const gained = e.message.match(/获得积分=(\d+)/)
            if (gained) acc.searchPoints = (acc.searchPoints || 0) + parseInt(gained[1], 10)
        } else if (e.event === 'DAILY-CHECK-IN' && e.message.includes('完成每日签到')) {
            const gained = e.message.match(/获得积分=(\d+)/)
            if (gained) acc.checkInPoints = parseInt(gained[1], 10)
        }
    }

    return Object.values(accounts)
}

/**
 * 生成每日积分统计摘要（summary.json 的数据源）
 * 
 * 核心策略（避免重复计数）：
 * - 优先使用 ACCOUNT-END 事件的 "总计: +N"（每个账号每天唯一且权威）
 * - 若无 ACCOUNT-END（运行中断/跨天），则累加 INFO 级别的事件积分：
 *   完成UrlReward / 完成每日签到 / 阅读文章 / SEARCH-BING 获得积分
 * - 跳过 DEBUG 级别的余额差分行（"UrlReward后的余额差额"等），它们与 INFO 重复
 * 
 * @param {string} logsDir 日志目录
 * @returns {object} summary 数据
 */
function generateSummary(logsDir = LOGS_DIR) {
    const summary = {
        generatedAt: new Date().toISOString(),
        daily: [], // [{ date, total, accounts: [{ account, points }] }]
        accountTotals: [], // [{ account, totalPoints, activeDays }]
        grandTotal: 0
    }

    // 使用传入的日志目录列出文件（而非全局 LOGS_DIR）
    let logFiles = []
    try {
        if (fs.existsSync(logsDir)) {
            logFiles = fs
                .readdirSync(logsDir)
                .filter(f => f.endsWith('.log'))
                .sort()
        }
    } catch {
        logFiles = []
    }
    if (!logFiles.length) return summary

    // 按日期聚合: date -> account -> { accountEnd, activityPoints }
    const dailyMap = {}

    for (const file of logFiles) {
        const date = file.replace('.log', '')
        const filePath = path.join(logsDir, file)
        if (!fs.existsSync(filePath)) continue

        let content
        try {
            content = fs.readFileSync(filePath, 'utf-8')
        } catch {
            continue
        }

        for (const line of content.split('\n')) {
            const entry = parseLogLine(line)
            if (!entry || entry.account === '主进程') continue

            const dateKey = entry.utcTime ? entry.utcTime.slice(0, 10) : date
            const accName = entry.account

            if (!dailyMap[dateKey]) dailyMap[dateKey] = {}
            if (!dailyMap[dateKey][accName]) {
                dailyMap[dateKey][accName] = { accountEnd: null, activityPoints: 0 }
            }
            const accData = dailyMap[dateKey][accName]

            // ACCOUNT-END 权威总计
            if (entry.event === 'ACCOUNT-END') {
                const m = entry.message.match(/总计:\s*\+(\d+)/)
                if (m) accData.accountEnd = parseInt(m[1], 10)
            }
            // INFO 级活动积分（确保不超过重复计数的级别）
            else if (entry.level === 'INFO') {
                let points = null
                if (entry.message.includes('完成UrlReward') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/)
                    if (m) points = parseInt(m[1], 10)
                } else if (entry.message.includes('完成每日签到') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/)
                    if (m) points = parseInt(m[1], 10)
                } else if (entry.message.includes('阅读文章') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/)
                    if (m) points = parseInt(m[1], 10)
                } else if (entry.event === 'SEARCH-BING' && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/)
                    if (m) points = parseInt(m[1], 10)
                }
                if (points !== null) {
                    accData.activityPoints += points
                }
            }
        }
    }

    // 汇总输出
    const accountTotalMap = {}
    const sortedDates = Object.keys(dailyMap).sort()

    for (const date of sortedDates) {
        const dayAccounts = dailyMap[date]
        const dayEntries = Object.entries(dayAccounts).map(([account, data]) => {
            // 优先 ACCOUNT-END；否则用活动积分累加
            const points = data.accountEnd !== null ? data.accountEnd : data.activityPoints
            if (!accountTotalMap[account]) {
                accountTotalMap[account] = { totalPoints: 0, activeDays: 0 }
            }
            accountTotalMap[account].totalPoints += points
            accountTotalMap[account].activeDays += 1
            return { account, points }
        })

        const dayTotal = dayEntries.reduce((s, e) => s + e.points, 0)
        summary.daily.push({ date, total: dayTotal, accounts: dayEntries })
        summary.grandTotal += dayTotal
    }

    summary.accountTotals = Object.entries(accountTotalMap)
        .map(([account, v]) => ({ account, totalPoints: v.totalPoints, activeDays: v.activeDays }))
        .sort((a, b) => b.totalPoints - a.totalPoints)

    return summary
}

/**
 * 写入 summary.json（生成可重复执行的持久化产物）
 */
function writeSummaryFile(summary) {
    const target = path.join(GUI_DIR, 'summary.json')
    try {
        fs.writeFileSync(target, JSON.stringify(summary, null, 4) + '\n', 'utf-8')
        console.log(`[GUI] summary.json 已生成: ${target}`)
        return target
    } catch (e) {
        console.error(`[GUI] 写入 summary.json 失败: ${e.message}`)
        return null
    }
}

// ===== 网页长连接保活（SSE） =====
// 前端通过 EventSource 保持 /api/keepalive 长连接；连接断开即视为网页已关闭，进程自动退出

// ===== 任务子进程管理 =====
// 方案 A: 直接 spawn('node', ['dist/index.js'])，cwd=项目根目录
// 跨平台、不依赖 npm/cmd 外壳、kill() 干净（脚本自带 SIGTERM/SIGINT handler 会正常清理退出）
let taskProcess = null // 当前运行的任务子进程
const taskLogBuffer = [] // 任务日志环形缓冲（最多 500 行）
const MAX_TASK_LOG_LINES = 500
const RUN_SCRIPT = process.platform === 'win32' ? 'node.exe' : 'node'

function appendTaskLog(line) {
    if (!line) return
    taskLogBuffer.push({ time: new Date().toISOString(), line })
    if (taskLogBuffer.length > MAX_TASK_LOG_LINES) {
        taskLogBuffer.splice(0, taskLogBuffer.length - MAX_TASK_LOG_LINES)
    }
}

// 子进程入口文件：优先 dist/index.js（编译后），否则 src/index.ts（开发模式）
function resolveEntryFile() {
    const distEntry = path.join(ROOT, 'dist', 'index.js')
    if (fs.existsSync(distEntry)) return distEntry
    // 开发模式：使用 ts-node 运行 src/index.ts
    const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
    if (fs.existsSync(tsNodeBin)) {
        return null // 由 startTask 特殊处理 ts-node 启动
    }
    return distEntry // 兜底（文件不存在时 spawn 会报错）
}

function startTask() {
    if (taskProcess && !taskProcess.killed) {
        return { success: false, error: '任务已在运行中' }
    }

    const entryFile = resolveEntryFile()
    let args
    let useTsNode = false

    if (entryFile) {
        args = [entryFile]
    } else {
        // 开发模式：ts-node 启动
        const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
        args = [tsNodeBin, path.join(ROOT, 'src', 'index.ts')]
        useTsNode = true
    }

    appendTaskLog(`[GUI] 启动任务: node ${args.join(' ')}`)
    console.log(`[GUI] 启动任务: node ${args.join(' ')}`)

    try {
        taskProcess = spawn(RUN_SCRIPT, args, {
            cwd: ROOT,
            env: { ...process.env },
            windowsHide: false,
            stdio: ['pipe', 'pipe', 'pipe']
        })
    } catch (error) {
        appendTaskLog(`[GUI] 启动失败: ${error.message}`)
        return { success: false, error: `启动失败: ${error.message}` }
    }

    taskProcess.stdout.on('data', chunk => {
        const text = chunk.toString()
        text.split('\n').forEach(line => appendTaskLog(line))
    })
    taskProcess.stderr.on('data', chunk => {
        const text = chunk.toString()
        text.split('\n').forEach(line => appendTaskLog(line))
    })
    taskProcess.on('exit', (code, signal) => {
        appendTaskLog(`[GUI] 任务进程退出 | code=${code ?? 'n/a'} signal=${signal ?? 'n/a'}`)
        console.log(`[GUI] 任务进程退出 | code=${code ?? 'n/a'} signal=${signal ?? 'n/a'}`)
        taskProcess = null
    })
    taskProcess.on('error', error => {
        appendTaskLog(`[GUI] 任务进程错误: ${error.message}`)
        console.error(`[GUI] 任务进程错误:`, error)
        taskProcess = null
    })

    return { success: true, message: '任务已启动' }
}

function stopTask() {
    if (!taskProcess || taskProcess.killed) {
        return { success: false, error: '没有正在运行的任务' }
    }

    appendTaskLog('[GUI] 发送停止信号 (SIGTERM)...')
    console.log('[GUI] 发送停止信号 (SIGTERM)...')

    try {
        // 先发 SIGTERM 让脚本内部正常清理（SIGTERM handler 会 flush webhooks 后退出）
        taskProcess.kill('SIGTERM')

        // 10 秒后仍未退出则强制 SIGKILL
        setTimeout(() => {
            if (taskProcess && !taskProcess.killed) {
                appendTaskLog('[GUI] 10秒内未正常退出，强制 SIGKILL')
                console.warn('[GUI] 10秒内未正常退出，强制 SIGKILL')
                taskProcess.kill('SIGKILL')
            }
        }, 10000).unref()

        return { success: true, message: '停止信号已发送' }
    } catch (error) {
        return { success: false, error: `停止失败: ${error.message}` }
    }
}

function getTaskStatus() {
    return {
        running: Boolean(taskProcess && !taskProcess.killed),
        pid: taskProcess ? taskProcess.pid : null,
        startedAt: null, // TODO: 可记录启动时间
        log: taskLogBuffer.slice(-100) // 最近 100 行
    }
}

// ===== 简单的 JSON 路由 =====
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(data, null, 2))
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(statusCode, { 'Content-Type': contentType })
    res.end(text)
}

/** 读取请求体（JSON） */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = ''
        req.on('data', chunk => {
            body += chunk
            // 100MB 上限：session 导入与日志导入共用（日志累积可达数 MB + Base64 膨胀），仍防异常大包
            if (body.length > 100e6) {
                reject(new Error('请求体过大'))
                req.destroy()
            }
        })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : null)
            } catch {
                reject(new Error('无效的 JSON 请求体'))
            }
        })
        req.on('error', reject)
    })
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const pathname = url.pathname

    // 静态页面
    if (pathname === '/' || pathname === '/index.html') {
        if (!fs.existsSync(HTML_FILE)) {
            return sendText(res, 404, 'GUI 文件不存在: gui/design-reference.html')
        }
        return sendText(res, 200, fs.readFileSync(HTML_FILE, 'utf-8'), 'text/html; charset=utf-8')
    }

    // 静态资源：/css/* 与 /js/*（映射到 gui 目录，带路径穿越防护）
    const staticMatch = pathname.match(/^\/(css|js)\/([^/]+)$/)
    if (staticMatch && req.method === 'GET') {
        const subDir = staticMatch[1]   // 'css' 或 'js'
        const fileName = staticMatch[2] // 文件名
        // 防路径穿越：文件名不允许含 '..' 或路径分隔符
        if (fileName.includes('..') || fileName.includes('\\') || fileName.includes('/')) {
            return sendJson(res, 400, { error: '非法文件路径' })
        }
        const filePath = path.join(GUI_DIR, subDir, fileName)
        try {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                return sendJson(res, 404, { error: `静态文件不存在: /${subDir}/${fileName}` })
            }
            const mime = fileName.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'application/javascript; charset=utf-8'
            return sendText(res, 200, fs.readFileSync(filePath, 'utf-8'), mime)
        } catch (e) {
            return sendJson(res, 500, { error: `读取静态文件失败: ${e.message}` })
        }
    }

    // API: 账号列表
    if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = readJson(resolveAccountsPath())
        if (!accounts) return sendJson(res, 500, { error: '无法读取 accounts.json' })
        // 关联日志数据：为每个账号补充日志摘要
        const logSummary = readLogFile(null).summary || []
        const logMap = {}
        for (const s of logSummary) {
            logMap[s.account] = s
        }
        const enriched = accounts.map(a => ({
            ...a,
            status: logMap[a.email.split('@')[0]] || { account: a.email.split('@')[0], entries: 0 }
        }))
        return sendJson(res, 200, { accounts: enriched, logSummary })
    }

    // API: 配置
    if (pathname === '/api/config' && req.method === 'GET') {
        const config = readJson(resolveConfigPath())
        if (!config) return sendJson(res, 500, { error: '无法读取 config.json' })
        return sendJson(res, 200, config)
    }

    // API: 更新全局配置 (PUT /api/config)
    // 宽松校验关键字段类型（与 config.example.json 结构对应），备份 config.json.bak 后合并写回
    if (pathname === '/api/config' && req.method === 'PUT') {
        return (async () => {
            try {
                const body = await readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return sendJson(res, 400, { error: '请求体必须是一个配置对象' })
                }

                // 宽松校验：布尔字段必须是 boolean，字符串字段必须是 string
                const boolFields = [
                    'headless', 'ensureStreakProtection', 'errorDiagnostics', 'debugLogs',
                    'searchOnBingLocalQueries'
                ]
                const errors = []
                for (const f of boolFields) {
                    if (body[f] !== undefined && typeof body[f] !== 'boolean') errors.push(`${f} 必须是布尔值`)
                }
                if (body.workers !== undefined) {
                    if (!body.workers || typeof body.workers !== 'object' || Array.isArray(body.workers)) {
                        errors.push('workers 必须是一个对象')
                    } else {
                        for (const [k, v] of Object.entries(body.workers)) {
                            if (typeof v !== 'boolean') errors.push(`workers.${k} 必须是布尔值`)
                        }
                    }
                }
                if (body.searchSettings !== undefined) {
                    const ss = body.searchSettings
                    if (!ss || typeof ss !== 'object' || Array.isArray(ss)) {
                        errors.push('searchSettings 必须是一个对象')
                    } else {
                        if (ss.scrollRandomResults !== undefined && typeof ss.scrollRandomResults !== 'boolean') errors.push('searchSettings.scrollRandomResults 必须是布尔值')
                        if (ss.clickRandomResults !== undefined && typeof ss.clickRandomResults !== 'boolean') errors.push('searchSettings.clickRandomResults 必须是布尔值')
                        if (ss.parallelSearching !== undefined && typeof ss.parallelSearching !== 'boolean') errors.push('searchSettings.parallelSearching 必须是布尔值')
                        if (ss.searchResultVisitTime !== undefined && typeof ss.searchResultVisitTime !== 'string') errors.push('searchSettings.searchResultVisitTime 必须是字符串')
                        if (ss.searchDelay !== undefined) {
                            if (!ss.searchDelay || typeof ss.searchDelay !== 'object' || Array.isArray(ss.searchDelay)) {
                                errors.push('searchSettings.searchDelay 必须是一个对象')
                            } else {
                                if (ss.searchDelay.min !== undefined && typeof ss.searchDelay.min !== 'string') errors.push('searchSettings.searchDelay.min 必须是字符串')
                                if (ss.searchDelay.max !== undefined && typeof ss.searchDelay.max !== 'string') errors.push('searchSettings.searchDelay.max 必须是字符串')
                            }
                        }
                        if (ss.readDelay !== undefined) {
                            if (!ss.readDelay || typeof ss.readDelay !== 'object' || Array.isArray(ss.readDelay)) {
                                errors.push('searchSettings.readDelay 必须是一个对象')
                            } else {
                                if (ss.readDelay.min !== undefined && typeof ss.readDelay.min !== 'string') errors.push('searchSettings.readDelay.min 必须是字符串')
                                if (ss.readDelay.max !== undefined && typeof ss.readDelay.max !== 'string') errors.push('searchSettings.readDelay.max 必须是字符串')
                            }
                        }
                    }
                }
                for (const f of ['baseURL', 'globalTimeout', 'sessionPath']) {
                    if (body[f] !== undefined && typeof body[f] !== 'string') errors.push(`${f} 必须是字符串`)
                }
                // 低风险嵌套字段校验
                if (body.proxy !== undefined) {
                    const px = body.proxy
                    if (!px || typeof px !== 'object' || Array.isArray(px)) {
                        errors.push('proxy 必须是一个对象')
                    } else if (px.queryEngine !== undefined && typeof px.queryEngine !== 'boolean') {
                        errors.push('proxy.queryEngine 必须是布尔值')
                    }
                }
                if (body.consoleLogFilter !== undefined) {
                    const clf = body.consoleLogFilter
                    if (!clf || typeof clf !== 'object' || Array.isArray(clf)) {
                        errors.push('consoleLogFilter 必须是一个对象')
                    } else if (clf.enabled !== undefined && typeof clf.enabled !== 'boolean') {
                        errors.push('consoleLogFilter.enabled 必须是布尔值')
                    }
                }
                if (body.searchSettings && body.searchSettings.chinaApi !== undefined) {
                    const ca = body.searchSettings.chinaApi
                    if (!ca || typeof ca !== 'object' || Array.isArray(ca)) {
                        errors.push('searchSettings.chinaApi 必须是一个对象')
                    } else if (ca.appkey !== undefined && typeof ca.appkey !== 'string') {
                        errors.push('searchSettings.chinaApi.appkey 必须是字符串')
                    }
                }
                if (errors.length) {
                    return sendJson(res, 400, { error: `配置校验失败: ${errors.join('；')}` })
                }

                // 强制忽略高风险字段：并行搜索会制造异常流量模式，显著增加封号风险（不允许通过 GUI 写入）
                if (body.searchSettings) {
                    delete body.searchSettings.parallelSearching
                }

                const configPath = resolveConfigPath()
                const current = readJson(configPath) || {}

                // 1. 备份原文件
                const backupPath = configPath + '.bak'
                try {
                    fs.copyFileSync(configPath, backupPath)
                } catch (e) {
                    return sendJson(res, 500, { error: `备份 config.json 失败: ${e.message}` })
                }

                // 2. 合并更新（保留未提交的深层字段）
                const merged = {
                    ...current,
                    ...body,
                    ...(body.workers ? { workers: { ...(current.workers || {}), ...body.workers } } : {}),
                    ...(body.proxy ? { proxy: { ...(current.proxy || {}), ...body.proxy } } : {}),
                    ...(body.consoleLogFilter ? { consoleLogFilter: { ...(current.consoleLogFilter || {}), ...body.consoleLogFilter } } : {}),
                    ...(body.searchSettings
                        ? {
                              searchSettings: {
                                  ...(current.searchSettings || {}),
                                  ...body.searchSettings,
                                  ...(body.searchSettings.chinaApi
                                      ? { chinaApi: { ...(current.searchSettings.chinaApi || {}), ...body.searchSettings.chinaApi } }
                                      : {}),
                                  ...(body.searchSettings.searchDelay
                                      ? { searchDelay: { ...(current.searchSettings.searchDelay || {}), ...body.searchSettings.searchDelay } }
                                      : {}),
                                  ...(body.searchSettings.readDelay
                                      ? { readDelay: { ...(current.searchSettings.readDelay || {}), ...body.searchSettings.readDelay } }
                                      : {})
                              }
                          }
                        : {})
                }

                // 3. 写回（保持 4 空格缩进与项目风格一致）
                try {
                    fs.writeFileSync(configPath, JSON.stringify(merged, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    // 写入失败，尝试恢复备份
                    try { fs.copyFileSync(backupPath, configPath) } catch {}
                    return sendJson(res, 500, { error: `写入 config.json 失败: ${e.message}` })
                }

                console.log(`[GUI] 已保存全局配置 (备份: ${path.basename(backupPath)})`)
                return sendJson(res, 200, {
                    success: true,
                    message: '全局配置已保存',
                    backup: path.basename(backupPath),
                    config: merged
                })
            } catch (error) {
                return sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // API: 打开配置文件 (POST /api/config/open)
    // 用系统默认程序打开实际 config 文件（便于手动编辑高风险字段）
    if (pathname === '/api/config/open' && req.method === 'POST') {
        const configPath = resolveConfigPath()
        try {
            if (!fs.existsSync(configPath)) {
                return sendJson(res, 500, { error: `配置文件不存在: ${configPath}` })
            }
            const cmd = process.platform === 'win32'
                ? spawn('cmd', ['/c', 'start', '', configPath])
                : spawn('xdg-open', [configPath])
            cmd.on('error', () => sendJson(res, 500, { error: '无法打开配置文件（缺少系统默认打开程序）' }))
            cmd.on('spawn', () => sendJson(res, 200, { success: true, message: '已打开配置文件', path: configPath }))
            return
        } catch (error) {
            return sendJson(res, 400, { error: error.message || '打开失败' })
        }
    }

    // API: 重置全局配置为默认 (POST /api/config/reset)
    // 以 src/config.example.json 为权威默认模板，备份后整体写回
    if (pathname === '/api/config/reset' && req.method === 'POST') {
        return (async () => {
            const configPath = resolveConfigPath()
            const defaultTemplate = path.join(ROOT, 'src', 'config.example.json')
            try {
                if (!fs.existsSync(defaultTemplate)) {
                    return sendJson(res, 500, { error: '无法找到默认配置模板: src/config.example.json' })
                }
                const defaults = JSON.parse(fs.readFileSync(defaultTemplate, 'utf-8'))

                // 1. 备份当前配置
                const backupPath = configPath + '.bak'
                if (fs.existsSync(configPath)) {
                    try {
                        fs.copyFileSync(configPath, backupPath)
                    } catch (e) {
                        return sendJson(res, 500, { error: `备份 config.json 失败: ${e.message}` })
                    }
                }

                // 2. 写回默认模板（保持 4 空格缩进）
                try {
                    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    // 写入失败，尝试恢复备份
                    try { fs.copyFileSync(backupPath, configPath) } catch {}
                    return sendJson(res, 500, { error: `写入 config.json 失败: ${e.message}` })
                }

                console.log(`[GUI] 已重置全局配置为默认值 (备份: ${path.basename(backupPath)})`)
                return sendJson(res, 200, {
                    success: true,
                    message: '全局配置已重置为默认值',
                    backup: path.basename(backupPath),
                    config: defaults
                })
            } catch (error) {
                return sendJson(res, 400, { error: error.message || '重置失败' })
            }
        })()
    }

    // API: 新增账号 (POST /api/accounts)
    if (pathname === '/api/accounts' && req.method === 'POST') {
        return (async () => {
            try {
                const body = await readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }

                // 必填字段校验（email / password）
                if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
                    return sendJson(res, 400, { error: 'email 必须是非空邮箱字符串' })
                }
                if (!body.password || typeof body.password !== 'string') {
                    return sendJson(res, 400, { error: 'password 必填且必须是字符串' })
                }

                // 后端补全默认字段（与 src/accounts.example.json 模板一致）
                const newAccount = {
                    email: body.email,
                    password: body.password,
                    totpSecret: typeof body.totpSecret === 'string' ? body.totpSecret : '',
                    recoveryEmail: typeof body.recoveryEmail === 'string' ? body.recoveryEmail : '',
                    geoLocale: typeof body.geoLocale === 'string' ? body.geoLocale : 'auto',
                    langCode: typeof body.langCode === 'string' ? body.langCode : 'zh',
                    proxy: body.proxy && typeof body.proxy === 'object' && !Array.isArray(body.proxy)
                        ? body.proxy
                        : { proxyAxios: false, url: '', port: 0, username: '', password: '' },
                    saveFingerprint: body.saveFingerprint && typeof body.saveFingerprint === 'object' && !Array.isArray(body.saveFingerprint)
                        ? body.saveFingerprint
                        : { mobile: true, desktop: true }
                }

                // 格式校验（复用现有校验逻辑）
                const validationError = validateAccountShape(newAccount)
                if (validationError) {
                    return sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }

                const accountsPath = resolveAccountsPath()
                const accounts = readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }

                // 重复邮箱检查
                if (accounts.some(a => a.email === newAccount.email)) {
                    return sendJson(res, 400, { error: `账号已存在: ${newAccount.email}` })
                }

                // 1. 备份原文件
                const backupPath = accountsPath + '.bak'
                try {
                    fs.copyFileSync(accountsPath, backupPath)
                } catch (e) {
                    return sendJson(res, 500, { error: `备份 accounts.json 失败: ${e.message}` })
                }

                // 2. 追加新账号
                accounts.push(newAccount)

                // 3. 写回（保持 4 空格缩进与项目风格一致）
                try {
                    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    // 写入失败，尝试恢复备份
                    try { fs.copyFileSync(backupPath, accountsPath) } catch {}
                    return sendJson(res, 500, { error: `写入 accounts.json 失败: ${e.message}` })
                }

                console.log(`[GUI] 已新增账号: ${newAccount.email} (备份: ${path.basename(backupPath)})`)
                return sendJson(res, 200, {
                    success: true,
                    message: `账号 ${newAccount.email} 已添加`,
                    backup: path.basename(backupPath),
                    account: newAccount
                })
            } catch (error) {
                return sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // API: 导入 Session 压缩包 (POST /api/sessions/import)
    // 安全策略：白名单只接受 session_*.json，double-check 防路径穿越，目标固定 dist/browser/sessions/
    if (pathname === '/api/sessions/import' && req.method === 'POST') {
        return (async () => {
            const SESSIONS_ROOT = path.join(ROOT, 'dist', 'browser', 'sessions')
            let tmpRoot = null
            try {
                const body = await readBody(req)
                if (!body || typeof body !== 'object') {
                    return sendJson(res, 400, { error: '请求体必须包含 filename 和 dataBase64' })
                }
                if (typeof body.filename !== 'string' || !/\.zip$/i.test(body.filename)) {
                    return sendJson(res, 400, { error: '仅支持 .zip 压缩包' })
                }
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
                    return sendJson(res, 400, { error: '缺少压缩包数据 (dataBase64)' })
                }

                // 1. 解码 Base64 → 临时目录
                tmpRoot = path.join(os.tmpdir(), `gui-session-import-${Date.now()}-${process.pid}`)
                const zipPath = path.join(tmpRoot, 'import.zip')
                const extractDir = path.join(tmpRoot, 'extracted')
                fs.mkdirSync(extractDir, { recursive: true })
                fs.writeFileSync(zipPath, Buffer.from(body.dataBase64, 'base64'))

                // 2. 解压（Windows 用系统 PowerShell Expand-Archive，其他平台用 unzip；保持零依赖）
                await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32'
                        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`] }
                        : { file: 'unzip', args: ['-o', zipPath, '-d', extractDir] }
                    const ps = spawn(cmd.file, cmd.args)
                    ps.on('error', () => reject(new Error('解压工具不可用 (需要 Windows PowerShell 或 unzip)')))
                    ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败 (code ${code})`)))
                })

                // 3. 白名单扫描：只收集 session_*.json，防路径穿越
                const imported = {}
                const scanDir = dir => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = path.relative(extractDir, full)
                        // 防穿越第一层：相对路径不允许出 extractDir
                        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                        if (entry.isDirectory()) {
                            scanDir(full)
                        } else if (/^session_.*\.json$/.test(entry.name)) {
                            const relParts = rel.split(path.sep)
                            // 需要至少一层目录（email 目录）+ 文件名
                            if (relParts.length < 2) continue
                            const emailDir = relParts.slice(0, -1).join(path.sep)
                            const fileName = relParts[relParts.length - 1]
                            const targetDir = path.join(SESSIONS_ROOT, emailDir)
                            // 防穿越第二层：目标必须位于 SESSIONS_ROOT 内
                            const relTarget = path.relative(SESSIONS_ROOT, targetDir)
                            if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) continue
                            // 创建目标目录 + 同名文件先 .bak 备份
                            fs.mkdirSync(targetDir, { recursive: true })
                            const targetFile = path.join(targetDir, fileName)
                            if (fs.existsSync(targetFile)) {
                                try { fs.copyFileSync(targetFile, targetFile + '.bak') } catch {}
                            }
                            fs.copyFileSync(full, targetFile)
                            if (!imported[emailDir]) imported[emailDir] = []
                            imported[emailDir].push(fileName)
                        }
                    }
                }
                scanDir(extractDir)

                // 4. 清理临时目录
                if (tmpRoot) {
                    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                    tmpRoot = null
                }

                const emails = Object.keys(imported)
                if (!emails.length) {
                    return sendJson(res, 400, { error: '压缩包内未找到 session_*.json 文件，导入失败' })
                }
                console.log(`[GUI] 已导入 ${emails.length} 个账号的 Session → ${SESSIONS_ROOT}`)
                return sendJson(res, 200, {
                    success: true,
                    message: `已导入 ${emails.length} 个账号的 Session`,
                    accounts: emails.map(e => ({ email: e, files: imported[e] })),
                    target: SESSIONS_ROOT
                })
            } catch (error) {
                if (tmpRoot) {
                    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                }
                return sendJson(res, 400, { error: error.message || '导入失败' })
            }
        })()
    }

    // API: 导出 Session 压缩包 (GET /api/sessions/export)
    // 与导入白名单对称：只打包 session_*.json（跳过 .bak），按 账号目录/session文件 结构归档
    if (pathname === '/api/sessions/export' && req.method === 'GET') {
        return (async () => {
            const SESSIONS_ROOT = path.join(ROOT, 'dist', 'browser', 'sessions')
            let zipPath = null
            try {
                if (!fs.existsSync(SESSIONS_ROOT)) {
                    return sendJson(res, 400, { error: 'No session directory found: dist/browser/sessions/' })
                }

                // 1. 扫描账号目录，收集 session_*.json（一层目录，与导入结构一致）
                const accountDirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => d.name)
                const sessions = []
                for (const emailDir of accountDirs) {
                    const dirPath = path.join(SESSIONS_ROOT, emailDir)
                    if (!fs.existsSync(dirPath)) continue
                    const files = fs.readdirSync(dirPath).filter(f => /^session_.*\.json$/.test(f))
                    for (const fileName of files) {
                        sessions.push({ emailDir, fileName, fullPath: path.join(dirPath, fileName) })
                    }
                }

                if (!sessions.length) {
                    return sendJson(res, 400, { error: '没有可导出的 Session（dist/browser/sessions/ 下无 session_*.json）' })
                }

                // 2. 在临时目录按 账号/文件 结构重建后打包
                const tmpRoot = path.join(os.tmpdir(), `gui-session-export-${Date.now()}-${process.pid}`)
                const stageDir = path.join(tmpRoot, 'export')
                for (const s of sessions) {
                    const dir = path.join(stageDir, s.emailDir)
                    fs.mkdirSync(dir, { recursive: true })
                    fs.copyFileSync(s.fullPath, path.join(dir, s.fileName))
                }

                // 3. PowerShell Compress-Archive 打包（与导入 Expand-Archive 对称，保持零依赖）
                zipPath = path.join(tmpRoot, 'sessions.zip')
                await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32'
                        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(stageDir, '*')}' -DestinationPath '${zipPath}' -Force`] }
                        : { file: 'zip', args: ['-r', '-q', zipPath, '.'] }
                    const ps = spawn(cmd.file, cmd.args, { cwd: process.platform === 'win32' ? undefined : stageDir })
                    ps.on('error', () => reject(new Error('压缩工具不可用 (需要 Windows PowerShell 或 zip)')))
                    ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`压缩失败 (code ${code})`)))
                })

                // 4. 以 zip 二进制流返回（浏览器触发下载）
                const now = new Date()
                const pad = n => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const fileData = fs.readFileSync(zipPath)
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="sessions-${stamp}.zip"`,
                    'Content-Length': fileData.length,
                    'Access-Control-Allow-Origin': '*'
                })
                res.end(fileData)

                // 5. 清理临时目录
                try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                zipPath = null
            } catch (error) {
                if (zipPath) {
                    try { fs.rmSync(path.dirname(zipPath), { recursive: true, force: true }) } catch {}
                }
                return sendJson(res, 400, { error: error.message || '导出失败' })
            }
        })()
    }

    // API: 删除单个账号 (DELETE /api/accounts/:email)
    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/)
    if (accMatch && req.method === 'DELETE') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const accountsPath = resolveAccountsPath()
                const accounts = readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }

                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) {
                    return sendJson(res, 404, { error: `未找到账号: ${targetEmail}` })
                }

                const removed = accounts[idx]

                // 1. 备份原文件
                const backupPath = accountsPath + '.bak'
                try {
                    fs.copyFileSync(accountsPath, backupPath)
                } catch (e) {
                    return sendJson(res, 500, { error: `备份 accounts.json 失败: ${e.message}` })
                }

                // 2. 删除目标账号
                accounts.splice(idx, 1)

                // 3. 写回（保持 4 空格缩进与项目风格一致）
                try {
                    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    // 写入失败，尝试恢复备份
                    try { fs.copyFileSync(backupPath, accountsPath) } catch {}
                    return sendJson(res, 500, { error: `写入 accounts.json 失败: ${e.message}` })
                }

                console.log(`[GUI] 已删除账号: ${targetEmail} (备份: ${path.basename(backupPath)})`)
                return sendJson(res, 200, {
                    success: true,
                    message: `账号 ${targetEmail} 已删除`,
                    backup: path.basename(backupPath),
                    account: removed
                })
            } catch (error) {
                return sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // API: 更新单个账号配置 (PUT /api/accounts/:email)
    if (accMatch && req.method === 'PUT') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const body = await readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }

                // 确保 email 匹配 URL 中的目标账号（防错改）
                if (!body.email || String(body.email) !== targetEmail) {
                    return sendJson(res, 400, { error: '请求体中的 email 与目标账号不匹配' })
                }

                // 格式校验
                const validationError = validateAccountShape(body)
                if (validationError) {
                    return sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }

                const accountsPath = resolveAccountsPath()
                const accounts = readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }

                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) {
                    return sendJson(res, 404, { error: `未找到账号: ${targetEmail}` })
                }

                // 1. 备份原文件
                const backupPath = accountsPath + '.bak'
                try {
                    fs.copyFileSync(accountsPath, backupPath)
                } catch (e) {
                    return sendJson(res, 500, { error: `备份 accounts.json 失败: ${e.message}` })
                }

                // 2. 合并更新（保留未提交的字段，如 totpSecret / recoveryEmail 未在弹窗中展示）
                accounts[idx] = { ...accounts[idx], ...body }

                // 3. 写回（保持 4 空格缩进与项目风格一致）
                try {
                    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    // 写入失败，尝试恢复备份
                    try { fs.copyFileSync(backupPath, accountsPath) } catch {}
                    return sendJson(res, 500, { error: `写入 accounts.json 失败: ${e.message}` })
                }

                console.log(`[GUI] 已保存账号配置: ${targetEmail} (备份: ${path.basename(backupPath)})`)
                return sendJson(res, 200, {
                    success: true,
                    message: `账号 ${targetEmail} 配置已保存`,
                    backup: path.basename(backupPath),
                    account: accounts[idx]
                })
            } catch (error) {
                return sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // API: 启动任务
    if (pathname === '/api/start') {
        const result = startTask()
        return sendJson(res, result.success ? 200 : 400, result)
    }

    // API: 停止任务
    if (pathname === '/api/stop') {
        const result = stopTask()
        return sendJson(res, result.success ? 200 : 400, result)
    }

    // API: 任务状态（运行中/空闲 + 实时日志）
    if (pathname === '/api/task') {
        return sendJson(res, 200, getTaskStatus())
    }

    // API: 关闭服务 (POST /api/shutdown)
    // 先返回响应告知前端成功，再延迟 500ms 退出（确保 response 已送达客户端）
    if (pathname === '/api/shutdown' && req.method === 'POST') {
        console.log('[GUI] 收到关闭请求，500ms 后退出服务...')
        const data = { success: true, message: '服务正在关闭...' }
        sendJson(res, 200, data)
        setTimeout(() => {
            console.log('[GUI] 服务已退出')
            process.exit(0)
        }, 500)
        return
    }

    // API: 统计摘要（每次请求重新解析 logs/ 目录，不缓存）
    if (pathname === '/api/stats' || pathname === '/api/summary') {
        const summary = generateSummary()
        return sendJson(res, 200, summary)
    }

    // API: 日志列表
    if (pathname === '/api/logs') {
        const files = listLogFiles()
        return sendJson(res, 200, { files, logsDir: LOGS_DIR })
    }

    // API: 导出日志压缩包 (GET /api/logs/export)
    // 只打包 logs/ 下 *.log（跳过 .bak），与 Session 导出模式对称
    if (pathname === '/api/logs/export' && req.method === 'GET') {
        return (async () => {
            let zipPath = null
            try {
                if (!fs.existsSync(LOGS_DIR)) {
                    return sendJson(res, 400, { error: '没有可导出的日志（logs/ 目录不存在）' })
                }

                // 1. 收集 *.log 文件
                const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'))
                if (!logFiles.length) {
                    return sendJson(res, 400, { error: '没有可导出的日志（logs/ 下无 .log 文件）' })
                }

                // 2. 在临时目录重建后打包
                const tmpRoot = path.join(os.tmpdir(), `gui-log-export-${Date.now()}-${process.pid}`)
                const stageDir = path.join(tmpRoot, 'export')
                fs.mkdirSync(stageDir, { recursive: true })
                for (const f of logFiles) {
                    fs.copyFileSync(path.join(LOGS_DIR, f), path.join(stageDir, f))
                }

                // 3. PowerShell Compress-Archive 打包（与 Session 导出一致）
                zipPath = path.join(tmpRoot, 'logs.zip')
                await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32'
                        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(stageDir, '*')}' -DestinationPath '${zipPath}' -Force`] }
                        : { file: 'zip', args: ['-r', '-q', zipPath, '.'] }
                    const ps = spawn(cmd.file, cmd.args, { cwd: process.platform === 'win32' ? undefined : stageDir })
                    ps.on('error', () => reject(new Error('压缩工具不可用 (需要 Windows PowerShell 或 zip)')))
                    ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`压缩失败 (code ${code})`)))
                })

                // 4. 以 zip 二进制流返回
                const now = new Date()
                const pad = n => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
                const fileData = fs.readFileSync(zipPath)
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="logs-${stamp}.zip"`,
                    'Content-Length': fileData.length,
                    'Access-Control-Allow-Origin': '*'
                })
                res.end(fileData)

                // 5. 清理临时目录
                try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                zipPath = null
            } catch (error) {
                if (zipPath) {
                    try { fs.rmSync(path.dirname(zipPath), { recursive: true, force: true }) } catch {}
                }
                return sendJson(res, 400, { error: error.message || '导出失败' })
            }
        })()
    }

    // API: 导入日志压缩包 (POST /api/logs/import)
    // 安全策略：白名单只接受 *.log，double-check 防路径穿越，目标固定 logs/
    if (pathname === '/api/logs/import' && req.method === 'POST') {
        return (async () => {
            let tmpRoot = null
            try {
                const body = await readBody(req)
                if (!body || typeof body !== 'object') {
                    return sendJson(res, 400, { error: '请求体必须包含 filename 和 dataBase64' })
                }
                if (typeof body.filename !== 'string' || !/\.zip$/i.test(body.filename)) {
                    return sendJson(res, 400, { error: '仅支持 .zip 压缩包' })
                }
                if (typeof body.dataBase64 !== 'string' || !body.dataBase64) {
                    return sendJson(res, 400, { error: '缺少压缩包数据 (dataBase64)' })
                }

                // 1. 解码 Base64 → 临时目录
                tmpRoot = path.join(os.tmpdir(), `gui-log-import-${Date.now()}-${process.pid}`)
                const zipPath = path.join(tmpRoot, 'import.zip')
                const extractDir = path.join(tmpRoot, 'extracted')
                fs.mkdirSync(extractDir, { recursive: true })
                fs.writeFileSync(zipPath, Buffer.from(body.dataBase64, 'base64'))

                // 2. 解压
                await new Promise((resolve, reject) => {
                    const cmd = process.platform === 'win32'
                        ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`] }
                        : { file: 'unzip', args: ['-o', zipPath, '-d', extractDir] }
                    const ps = spawn(cmd.file, cmd.args)
                    ps.on('error', () => reject(new Error('解压工具不可用 (需要 Windows PowerShell 或 unzip)')))
                    ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败 (code ${code})`)))
                })

                // 3. 白名单扫描：只收集 *.log，双重防路径穿越
                const imported = []
                fs.mkdirSync(LOGS_DIR, { recursive: true })
                const scanDir = dir => {
                    if (!fs.existsSync(dir)) return
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const full = path.join(dir, entry.name)
                        const rel = path.relative(extractDir, full)
                        if (rel.startsWith('..') || path.isAbsolute(rel)) continue
                        if (entry.isDirectory()) {
                            scanDir(full)
                        } else if (entry.name.endsWith('.log')) {
                            const targetFile = path.join(LOGS_DIR, entry.name)
                            // 防穿越：目标必须位于 LOGS_DIR 内
                            const relTarget = path.relative(LOGS_DIR, targetFile)
                            if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) continue
                            // 同名文件先 .bak 备份
                            if (fs.existsSync(targetFile)) {
                                try { fs.copyFileSync(targetFile, targetFile + '.bak') } catch {}
                            }
                            fs.copyFileSync(full, targetFile)
                            imported.push(entry.name)
                        }
                    }
                }
                scanDir(extractDir)

                // 4. 清理临时目录
                if (tmpRoot) {
                    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                    tmpRoot = null
                }

                if (!imported.length) {
                    return sendJson(res, 400, { error: '压缩包内未找到 .log 文件，导入失败' })
                }
                console.log(`[GUI] 已导入 ${imported.length} 个日志文件 → ${LOGS_DIR}`)
                return sendJson(res, 200, {
                    success: true,
                    message: `已导入 ${imported.length} 个日志文件`,
                    files: imported,
                    target: LOGS_DIR
                })
            } catch (error) {
                if (tmpRoot) {
                    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
                }
                return sendJson(res, 400, { error: error.message || '导入失败' })
            }
        })()
    }

    // API: 单个日志文件（带日期参数）
    const logMatch = pathname.match(/^\/api\/logs\/(\d{4}-\d{2}-\d{2})$/)
    if (logMatch) {
        return sendJson(res, 200, readLogFile(logMatch[1]))
    }

    // API: 今日/最新日志摘要
    if (pathname === '/api/logs/summary') {
        return sendJson(res, 200, readLogFile(null))
    }

    // API: 网页长连接保活（SSE）——前端 EventSource 保持此连接，断开即视为网页关闭
    if (pathname === '/api/keepalive') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        })
        // 初始帧：让 EventSource 立即确认连接建立成功
        res.write(': connected\n\n')
        // 监听前端断开连接（关闭页面 / 刷新 / 跳转）：立即退出进程
        req.on('close', () => {
            console.log('网页连接已断开，正在退出进程...')
            process.exit(0)
        })
        // 注意：不主动调用 res.end()，保持长连接
        return
    }

    return sendJson(res, 404, { error: `未知接口: ${pathname}` })
})

// ===== CLI 模式：node gui/server.js --generate-summary =====
// 独立执行批量生成 summary.json（不启动 HTTP 服务）
if (process.argv.includes('--generate-summary')) {
    const summary = generateSummary()
    const target = writeSummaryFile(summary)
    if (target) {
        console.log(`\n统计摘要已写入 ${target}`)
        console.log(`共 ${summary.daily.length} 天数据，总计 ${summary.grandTotal} 积分`)
        console.log(`账号统计: ${JSON.stringify(summary.accountTotals, null, 2)}`)
    }
    process.exit(0)
}

server.listen(PORT, () => {
    console.log(`Microsoft-Rewards-Script 控制台已启动: http://localhost:${PORT}`)
    console.log(`账号文件: ${resolveAccountsPath()}`)
    console.log(`配置来源: ${resolveConfigPath()}`)
    console.log(`日志目录: ${LOGS_DIR}`)
})
