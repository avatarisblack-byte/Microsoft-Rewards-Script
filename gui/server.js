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
            if (body.length > 1e6) {
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

    // API: 账号列表
    if (pathname === '/api/accounts') {
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
    if (pathname === '/api/config') {
        const config = readJson(resolveConfigPath())
        if (!config) return sendJson(res, 500, { error: '无法读取 config.json' })
        return sendJson(res, 200, config)
    }

    // API: 更新单个账号配置 (PUT /api/accounts/:email)
    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/)
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

    // API: 单个日志文件（带日期参数）
    const logMatch = pathname.match(/^\/api\/logs\/(\d{4}-\d{2}-\d{2})$/)
    if (logMatch) {
        return sendJson(res, 200, readLogFile(logMatch[1]))
    }

    // API: 今日/最新日志摘要
    if (pathname === '/api/logs/summary') {
        return sendJson(res, 200, readLogFile(null))
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
