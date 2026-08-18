/**
 * 系统路由（POST /api/shutdown、GET /api/stats|/api/summary、GET /api/keepalive）
 * 签名：(req, res, pathname, ctx) => boolean
 */

function handleSystem(req, res, pathname, ctx) {
    const { http, summary } = ctx

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

    // GET /api/stats | /api/summary（日志统计摘要，即时重算）
    if (pathname === '/api/stats' || pathname === '/api/summary') {
        http.sendJson(res, 200, summary.generateSummary())
        return true
    }

    // GET /api/keepalive（SSE 长连接保活：断开即退出）
    if (pathname === '/api/keepalive') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        })
        res.write(': connected\n\n')
        req.on('close', () => {
            console.log('网页连接已断开，正在退出进程...')
            process.exit(0)
        })
        return true
    }

    return false
}

module.exports = handleSystem