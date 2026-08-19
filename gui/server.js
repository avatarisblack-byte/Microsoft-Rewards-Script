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
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${config.PORT}`)
    const pathname = url.pathname
    for (const route of routes) {
        if (route(req, res, pathname, ctx)) return
    }
    httpUtils.sendJson(res, 404, { error: `未知接口: ${pathname}` })
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