/**
 * GUI 日志统计摘要模块
 * 依赖：lib/logger.js（parseLogLine）、lib/config.js（LOGS_DIR）
 */
const fs = require('fs')
const path = require('path')
const { parseLogLine } = require('./logger')
const { LOGS_DIR } = require('./config')

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
            if (t) acc.collectedPoints = parseInt(t[1], 10)
            if (i) acc.initialPoints = parseInt(i[1], 10)
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

function generateSummary(logsDir = LOGS_DIR) {
    const summary = { generatedAt: new Date().toISOString(), daily: [], accountTotals: [], grandTotal: 0 }
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
            const key = entry.utcTime ? entry.utcTime.slice(0, 10) : file.replace('.log', '')
            if (!dailyMap[key]) dailyMap[key] = {}
            if (!dailyMap[key][entry.account]) dailyMap[key][entry.account] = { accountEnd: null, activityPoints: 0 }
            const d = dailyMap[key][entry.account]
            if (entry.event === 'ACCOUNT-END') {
                const m = entry.message.match(/总计:\s*\+(\d+)/)
                if (m) d.accountEnd = parseInt(m[1], 10)
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
    for (const date of dates) {
        const dayEntries = Object.entries(dailyMap[date]).map(([account, data]) => {
            const points = data.accountEnd !== null ? data.accountEnd : data.activityPoints
            if (!accMap[account]) accMap[account] = { totalPoints: 0, activeDays: 0 }
            accMap[account].totalPoints += points
            accMap[account].activeDays += 1
            return { account, points }
        })
        const dayTotal = dayEntries.reduce((s, e) => s + e.points, 0)
        summary.daily.push({ date, total: dayTotal, accounts: dayEntries })
        summary.grandTotal += dayTotal
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

module.exports = { summarizeLogs, generateSummary, writeSummaryFile }