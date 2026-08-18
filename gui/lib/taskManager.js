/**
 * GUI 任务子进程管理模块
 * 依赖：lib/config.js（ROOT）+ child_process
 * 方案 A: spawn('node', [dist/index.js])，cwd=项目根目录
 */
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { ROOT } = require('./config')

let taskProcess = null
const taskLogBuffer = []
const MAX_TASK_LOG_LINES = 500
const RUN_SCRIPT = process.platform === 'win32' ? 'node.exe' : 'node'

function appendTaskLog(line) {
    if (!line) return
    taskLogBuffer.push({ time: new Date().toISOString(), line })
    if (taskLogBuffer.length > MAX_TASK_LOG_LINES) {
        taskLogBuffer.splice(0, taskLogBuffer.length - MAX_TASK_LOG_LINES)
    }
}

// 子进程入口：优先 dist/index.js，否则 ts-node 跑 src/index.ts（开发模式）
function resolveEntryFile() {
    const distEntry = path.join(ROOT, 'dist', 'index.js')
    if (fs.existsSync(distEntry)) return distEntry
    const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
    if (fs.existsSync(tsNodeBin)) {
        return null
    }
    return distEntry
}

function startTask() {
    if (taskProcess && !taskProcess.killed) {
        return { success: false, error: '任务已在运行中' }
    }

    const entryFile = resolveEntryFile()
    let args
    if (entryFile) {
        args = [entryFile]
    } else {
        const tsNodeBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ts-node.cmd' : 'ts-node')
        args = [tsNodeBin, path.join(ROOT, 'src', 'index.ts')]
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
        chunk.toString().split('\n').forEach(line => appendTaskLog(line))
    })
    taskProcess.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => appendTaskLog(line))
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
        startedAt: null,
        log: taskLogBuffer.slice(-100)
    }
}

module.exports = { startTask, stopTask, getTaskStatus }