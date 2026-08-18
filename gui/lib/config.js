/**
 * GUI 配置与路径解析模块
 * 零依赖：仅 Node 内置 path / fs
 */
const path = require('path')
const fs = require('fs')

const GUI_DIR = path.join(__dirname, '..')
const PORT = process.env.PORT || 3000
const ROOT = path.join(GUI_DIR, '..')
const HTML_FILE = path.join(GUI_DIR, 'design-reference.html')
const LOGS_DIR = path.join(ROOT, 'logs')

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

module.exports = { PORT, ROOT, GUI_DIR, HTML_FILE, LOGS_DIR, resolveAccountsPath, resolveConfigPath, readJson }