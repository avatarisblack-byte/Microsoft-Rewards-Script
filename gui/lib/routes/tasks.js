/**
 * 任务路由（POST /api/start、POST /api/stop、GET /api/task）
 * 签名：(req, res, pathname, ctx) => boolean
 */

function handleTasks(req, res, pathname, ctx) {
    const { http, taskManager } = ctx

    // POST /api/start
    if (pathname === '/api/start') {
        const result = taskManager.startTask()
        http.sendJson(res, result.success ? 200 : 400, result)
        return true
    }

    // POST /api/stop
    if (pathname === '/api/stop') {
        const result = taskManager.stopTask()
        http.sendJson(res, result.success ? 200 : 400, result)
        return true
    }

    // GET /api/task
    if (pathname === '/api/task') {
        http.sendJson(res, 200, taskManager.getTaskStatus())
        return true
    }

    return false
}

module.exports = handleTasks