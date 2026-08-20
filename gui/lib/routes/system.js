/**
 * 系统路由（POST /api/shutdown、GET /api/stats|/api/summary、GET /api/keepalive、POST /api/setup）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// ===== 静默期（Grace Period）状态：客户端断开后延迟销毁，刷新页面不掉服务 =====
// 页面刷新会短暂断开 SSE 连接，若立即 process.exit 会导致"刷新即掉线"。
// 改为：断开后进入 5s 倒计时，期间有新连接（用户刷新）则取消销毁；倒计时结束仍无连接才退出。
let activeKeepaliveConnections = 0 // 当前活跃的 keepalive 连接数（支持多标签页）
let graceTimer = null              // 静默期倒计时句柄
const GRACE_PERIOD_MS = 5000       // 5 秒缓冲

function cancelGracePeriod() {
    if (graceTimer) {
        clearTimeout(graceTimer)
        graceTimer = null
        console.log('[GUI] 检测到新连接，取消服务销毁')
    }
}

function startGracePeriod() {
    if (graceTimer) return // 已在倒计时中，无需重复启动
    console.log(`[GUI] 客户端连接全部断开，进入 ${GRACE_PERIOD_MS / 1000}s 静默期...`)
    graceTimer = setTimeout(() => {
        graceTimer = null
        console.log('[GUI] 静默期结束，无新连接，服务退出')
        process.exit(0)
    }, GRACE_PERIOD_MS)
}

function handleSystem(req, res, pathname, ctx) {
    const { http, logCache } = ctx

    // POST /api/shutdown（先返回响应，延迟 500ms 退出）
    if (pathname === '/api/shutdown' && req.method === 'POST') {
        console.log('[GUI] 收到关闭请求，500ms 后退出服务...')
        const data = { success: true, message: '服务正在关闭...' }
        http.sendJson(res, 200, data)
        setTimeout(() => {
            console.log('[GUI] 服务已退出')
            process.exit(0)
        }, 500)
        return true
    }

    // POST /api/setup（运行根目录 setup 程序：安装依赖 + 构建环境）
    // 异步非阻塞：cmd /c start /min 开独立最小化窗口，detached + unref 与 GUI 进程解耦，
    // HTTP 立即响应，GUI 界面不会卡顿；stdio:ignore 完全丢弃子进程输出，不污染 GUI。
    // 冲突防护：任务运行中时 setup 的构建步骤（rimraf dist）可能中断任务子进程，
    // 前端已做警告确认（见 app.js setupEnvironment）。
    // 注意：必须「先 sendJson 再 return true」——sendJson 无返回值，
    // 若写成 return http.sendJson(...) 会返回 undefined（falsy），
    // 导致 server.js 路由分发继续走到 404 兜底对已响应 res 二次 writeHead → ERR_HTTP_HEADERS_SENT。
    if (pathname === '/api/setup' && req.method === 'POST') {
        const setupBat = path.join(ctx.config.ROOT, 'setup.bat')
        if (!fs.existsSync(setupBat)) {
            http.sendJson(res, 400, { error: '未找到 setup.bat（项目根目录）' })
            return true
        }
        try {
            const child = spawn('cmd', ['/c', 'start', '', '/min', 'setup.bat'], {
                cwd: ctx.config.ROOT, // setup.bat 内相对路径（npm/npx）基于项目根目录
                detached: true,
                stdio: 'ignore'
            })
            child.unref() // GUI 进程退出不影响 setup 继续
            console.log('[GUI] 已启动安装环境（setup.bat）')
            http.sendJson(res, 200, { success: true, message: '安装环境已在独立最小化窗口启动，请等待其完成' })
            return true
        } catch (e) {
            http.sendJson(res, 500, { error: `启动 setup 失败: ${e.message}` })
            return true
        }
    }

    // GET /api/stats | /api/summary（日志统计摘要：读预生成缓存，新鲜则零解析成本）
    if (pathname === '/api/stats' || pathname === '/api/summary') {
        http.sendJson(res, 200, logCache.getCachedData().summary)
        return true
    }

    // GET /api/keepalive（SSE 长连接保活 + 静默期优雅降级）
    // 连接计数：支持多标签页/刷新时的并行连接；仅当所有连接都断开才进入静默期倒计时
    if (pathname === '/api/keepalive') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        })
        res.write(': connected\n\n')
        activeKeepaliveConnections++
        cancelGracePeriod() // 新连接到达：取消销毁倒计时，复用现有服务
        req.on('close', () => {
            activeKeepaliveConnections--
            if (activeKeepaliveConnections <= 0) {
                startGracePeriod() // 全部断开：进入静默期，而非立即退出
            }
        })
        return true
    }

    return false
}

module.exports = handleSystem