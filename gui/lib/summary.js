/**
 * GUI 日志统计摘要模块
 * 依赖：lib/logger.js（parseLogLine）、lib/config.js（LOGS_DIR）
 *
 * 2026-08-19 收益口径修正：
 * - 同一账号同一天多次运行时 ACCOUNT-END 收益改为累加（原为覆盖，导致只统计最后一次运行、漏计收益）
 * - 统计日期按本地时区（由 UTC 时间戳换算），替代直接取 UTC 日期切片，修复跨 UTC 日界的"今日收益"偏差
 * - generateSummary 新增 todayTotal（今日收益，本地时区）
 */
const fs = require('fs')
const path = require('path')
const { parseLogLine } = require('./logger')
const { LOGS_DIR } = require('./config')

// 由 UTC ISO 时间戳换算本地日期 YYYY-MM-DD（避免 toLocaleString 系统区域格式差异）
function toLocalDateKey(utcTime, fallback) {
    if (utcTime) {
        const d = new Date(utcTime)
        if (!isNaN(d.getTime())) {
            const y = d.getFullYear()
            const m = String(d.getMonth() + 1).padStart(2, '0')
            const day = String(d.getDate()).padStart(2, '0')
            return `${y}-${m}-${day}`
        }
    }
    return fallback || null
}

function summarizeLogs(entries) {
    const accounts = {}
    for (const e of entries) {
        if (!e || e.account === '主进程') continue
        if (!accounts[e.account]) {
            accounts[e.account] = { account: e.account, entries: 0, lastEvent: null, lastLevel: null, lastTime: null, lastMessage: null, collectedPoints: null, initialPoints: null, finalPoints: null }
        }
        const acc = accounts[e.account]
        acc.entries++
        acc.lastTime = e.utcTime || e.localTime
        acc.lastEvent = e.event
        acc.lastLevel = e.level
        acc.lastMessage = e.message

        if (e.event === 'ACCOUNT-END') {
            const t = e.message.match(/总计:\s*\+(\d+)/)
            const i = e.message.match(/原始:\s*(\d+)\s*→/)
            const f = e.message.match(/→\s*新值:\s*(\d+)/)
            // 同一天多次运行：收益累加；原始积分保留第一次，新值保留最后一次
            if (t) acc.collectedPoints = (acc.collectedPoints || 0) + parseInt(t[1], 10)
            if (i && acc.initialPoints === null) acc.initialPoints = parseInt(i[1], 10)
            if (f) acc.finalPoints = parseInt(f[1], 10)
        } else if (e.event === 'URL-REWARD' && e.message.includes('完成UrlReward')) {
            const g = e.message.match(/获得积分=(\d+)/)
            const n = e.message.match(/新余额=(\d+)/)
            if (g) acc.collectedFromLastRun = parseInt(g[1], 10)
            if (n) acc.latestBalance = parseInt(n[1], 10)
        } else if (e.event === 'SEARCH-BING' && e.message.includes('获得积分')) {
            const g = e.message.match(/获得积分=(\d+)/)
            if (g) acc.searchPoints = (acc.searchPoints || 0) + parseInt(g[1], 10)
        } else if (e.event === 'DAILY-CHECK-IN' && e.message.includes('完成每日签到')) {
            const g = e.message.match(/获得积分=(\d+)/)
            if (g) acc.checkInPoints = parseInt(g[1], 10)
        }
    }
    return Object.values(accounts)
}

function summarizeAllLogs(logsDir = LOGS_DIR) {
    const entries = []
    let logFiles = []
    try {
        if (fs.existsSync(logsDir)) logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
    } catch { logFiles = [] }
    for (const file of logFiles) {
        let content
        try { content = fs.readFileSync(path.join(logsDir, file), 'utf-8') } catch { continue }
        for (const line of content.split('\n')) {
            const entry = parseLogLine(line)
            if (entry) entries.push(entry)
        }
    }
    return summarizeLogs(entries)
}

function generateSummary(logsDir = LOGS_DIR) {
    const summary = { generatedAt: new Date().toISOString(), daily: [], accountTotals: [], grandTotal: 0, todayTotal: 0 }
    let logFiles = []
    try {
        if (fs.existsSync(logsDir)) logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log')).sort()
    } catch { logFiles = [] }
    if (!logFiles.length) return summary

    const dailyMap = {}
    for (const file of logFiles) {
        let content
        try { content = fs.readFileSync(path.join(logsDir, file), 'utf-8') } catch { continue }
        for (const line of content.split('\n')) {
            const entry = parseLogLine(line)
            if (!entry || entry.account === '主进程') continue
            const key = toLocalDateKey(entry.utcTime, file.replace('.log', ''))
            if (!dailyMap[key]) dailyMap[key] = {}
            if (!dailyMap[key][entry.account]) dailyMap[key][entry.account] = { accountEndSum: 0, hasAccountEnd: false, activityPoints: 0 }
            const d = dailyMap[key][entry.account]
            if (entry.event === 'ACCOUNT-END') {
                const m = entry.message.match(/总计:\s*\+(\d+)/)
                if (m) {
                    d.accountEndSum += parseInt(m[1], 10)
                    d.hasAccountEnd = true
                }
            } else if (entry.level === 'INFO') {
                let p = null
                if (entry.message.includes('完成UrlReward') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (entry.message.includes('完成每日签到') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (entry.message.includes('阅读文章') && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                } else if (entry.event === 'SEARCH-BING' && entry.message.includes('获得积分')) {
                    const m = entry.message.match(/获得积分=(\d+)/); if (m) p = parseInt(m[1], 10)
                }
                if (p !== null) d.activityPoints += p
            }
        }
    }

    const accMap = {}
    const dates = Object.keys(dailyMap).sort()
    const todayKey = toLocalDateKey(new Date().toISOString())
    for (const date of dates) {
        const dayEntries = Object.entries(dailyMap[date]).map(([account, data]) => {
            const points = data.hasAccountEnd ? data.accountEndSum : data.activityPoints
            if (!accMap[account]) accMap[account] = { totalPoints: 0, activeDays: 0 }
            accMap[account].totalPoints += points
            accMap[account].activeDays += 1
            return { account, points }
        })
        const dayTotal = dayEntries.reduce((s, e) => s + e.points, 0)
        summary.daily.push({ date, total: dayTotal, accounts: dayEntries })
        summary.grandTotal += dayTotal
        if (date === todayKey) summary.todayTotal = dayTotal
    }
    summary.accountTotals = Object.entries(accMap)
        .map(([account, v]) => ({ account, totalPoints: v.totalPoints, activeDays: v.activeDays }))
        .sort((a, b) => b.totalPoints - a.totalPoints)
    return summary
}

function writeSummaryFile(summary, target) {
    try {
        fs.writeFileSync(target, JSON.stringify(summary, null, 4) + '\n', 'utf-8')
        return target
    } catch (e) {
        console.error(`[GUI] 写入 summary.json 失败: ${e.message}`)
        return null
    }
}

module.exports = { summarizeLogs, summarizeAllLogs, generateSummary, writeSummaryFile }
