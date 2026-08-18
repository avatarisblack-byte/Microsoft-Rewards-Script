/**
 * GUI 压缩/解压公共模块（PowerShell / unzip / zip，保持零依赖）
 * 依赖：os / child_process
 */
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

/** 跨平台：解压 zip 到目标目录（win32 用 PowerShell Expand-Archive，其他用 unzip） */
function unzipToDir(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32'
            ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`] }
            : { file: 'unzip', args: ['-o', zipPath, '-d', destDir] }
        const ps = spawn(cmd.file, cmd.args)
        ps.on('error', () => reject(new Error('解压工具不可用 (需要 Windows PowerShell 或 unzip)')))
        ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`解压失败 (code ${code})`)))
    })
}

/** 跨平台：将目录内容打包为 zip（win32 用 PowerShell Compress-Archive，其他用 zip） */
function zipDir(stageDir, zipPath) {
    return new Promise((resolve, reject) => {
        const cmd = process.platform === 'win32'
            ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(stageDir, '*')}' -DestinationPath '${zipPath}' -Force`] }
            : { file: 'zip', args: ['-r', '-q', zipPath, '.'] }
        const ps = spawn(cmd.file, cmd.args, { cwd: process.platform === 'win32' ? undefined : stageDir })
        ps.on('error', () => reject(new Error('压缩工具不可用 (需要 Windows PowerShell 或 zip)')))
        ps.on('exit', code => code === 0 ? resolve() : reject(new Error(`压缩失败 (code ${code})`)))
    })
}

/** 生成带时间戳的临时目录根路径 */
function makeTmpRoot(prefix) {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${process.pid}`)
}

module.exports = { unzipToDir, zipDir, makeTmpRoot }