/**
 * Microsoft-Rewards-Script GUI 控制台入口（模块化后）
 * 业务逻辑已拆分至 lib/，本文件仅负责：组装 ctx + 路由分发 + CLI + 启动
 */
const http = require('http')
const path = require('path')

// ===== 依赖模块 =====
const config = require('./lib/config')
const httpUtils = require('./lib/httpUtils')
const validator = require('./lib/validator')
const logger = require('./lib/logger')
const summary = require('./lib/summary')
const archive = require('./lib/archive')
const taskManager = require('./lib/taskManager')
const logCache = require('./lib/logCache')

// ===== 路由处理器（统一签名 (req,res,pathname,ctx)=>boolean，true=已处理） =====
const rStatic = require('./lib/routes/static')
const rConfig = require('./lib/routes/config')
const rAccounts = require('./lib/routes/accounts')
const rLogs = require('./lib/routes/logs')
const rSessions = require('./lib/routes/sessions')
const rData = require('./lib/routes/data')
const rTasks = require('./lib/routes/tasks')
const rSystem = require('./lib/routes/system')

// ===== 共享上下文（注入依赖，规避循环 require） =====
const ctx = { config, http: httpUtils, validator, logger, summary, archive, taskManager, logCache }
const routes = [rStatic, rConfig, rAccounts, rSessions, rData, rTasks, rLogs, rSystem]

// ===== HTTP 服务：按序分发，未命中返回 404 =====
// 异常兜底（2026-08-20）：路由内未捕获的异常若逃逸到这里，会成为进程级 uncaughtException
// 直接终止 GUI 服务（脏 accounts.json、缓存目录被占位等场景均可触发）。统一转 500 响应，服务保持存活。
const server = http.createServer((req, res) => {
    let pathname = req.url
    try {
        pathname = new URL(req.url, `http://localhost:${config.PORT}`).pathname
        for (const route of routes) {
            const handled = route(req, res, pathname, ctx)
            if (handled) {
                // 异步路由（async IIFE）返回 Promise：补 reject 兜底，
                // 避免未处理拒绝 + 客户端永久挂起
                if (typeof handled.then === 'function') {
                    handled.catch(err => {
                        console.error(`[GUI] 异步路由异常 ${pathname}:`, err)
                        if (!res.writableEnded) {
                            httpUtils.sendJson(res, 500, { error: `服务器内部错误: ${err.message}` })
                        }
                    })
                }
                return
            }
        }
        // 防御：若某路由已发送响应但返回了 falsy（未遵守「返回 true=已处理」契约），
        // 跳过 404 兜底，避免对已结束的 res 二次 writeHead 抛 ERR_HTTP_HEADERS_SENT 导致进程崩溃
        if (!res.writableEnded) {
            httpUtils.sendJson(res, 404, { error: `未知接口: ${pathname}` })
        }
    } catch (err) {
        console.error(`[GUI] 请求处理异常 ${pathname}:`, err)
        if (!res.writableEnded) {
            httpUtils.sendJson(res, 500, { error: `服务器内部错误: ${err.message}` })
        }
    }
})

// ===== CLI 模式：node gui/server.js --generate-summary =====
if (process.argv.includes('--generate-summary')) {
    const s = summary.generateSummary()
    const target = summary.writeSummaryFile(s, path.join(config.GUI_DIR, 'summary.json'))
    if (target) {
        console.log(`\n统计摘要已写入 ${target}`)
        console.log(`共 ${s.daily.length} 天数据，总计 ${s.grandTotal} 积分`)
        console.log(`账号统计: ${JSON.stringify(s.accountTotals, null, 2)}`)
    }
    process.exit(0)
}

// ===== 启动 =====
server.listen(config.PORT, () => {
    console.log(`Microsoft-Rewards-Script 控制台已启动: http://localhost:${config.PORT}`)
    console.log(`账号文件: ${config.resolveAccountsPath()}`)
    console.log(`配置来源: ${config.resolveConfigPath()}`)
    console.log(`日志目录: ${config.LOGS_DIR}`)
})