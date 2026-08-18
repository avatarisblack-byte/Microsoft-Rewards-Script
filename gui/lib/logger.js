/**
 * GUI 日志解析与读取模块
 * 依赖：lib/config.js（LOGS_DIR）
 */
const fs = require('fs')
const path = require('path')
const { LOGS_DIR } = require('./config')

function parseLogLine(line) {
    if (!line || line.trim() === '') return null
    const m = line.match(
        /^(\S+)\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+([^\s]+)\s+\[([^\]]+)\]\s+(.*)$/
    )
    if (!m) return null
    return { utcTime: m[1], localTime: m[2], account: m[3], level: m[4], platform: m[5], event: m[6], message: m[7] }
}

function listLogFiles() {
    try {
        if (!fs.existsSync(LOGS_DIR)) return []
        return fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log')).sort().reverse()
    } catch {
        return []
    }
}

function readLogFile(dateStr, limit = 0) {
    const files = dateStr ? [dateStr] : listLogFiles().slice(0, 1)
    if (files.length === 0) return { date: dateStr || null, entries: [], summary: null }
    const filePath = path.join(LOGS_DIR, files[0])
    try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        const startIndex = limit > 0 ? Math.max(0, lines.length - limit) : 0
        const entries = lines.slice(startIndex).map(parseLogLine).filter(Boolean)
        return { date: files[0].replace('.log', ''), entries, summary: null }
    } catch {
        return { date: dateStr || null, entries: [], summary: null }
    }
}

module.exports = { parseLogLine, listLogFiles, readLogFile, LOGS_DIR }