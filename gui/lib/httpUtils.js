/**
 * GUI HTTP 工具模块（sendJson / sendText / readBody）
 * 零依赖
 */

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    })
    res.end(JSON.stringify(data, null, 2))
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(statusCode, { 'Content-Type': contentType })
    res.end(text)
}

/** 读取请求体（JSON），100MB 上限（session/日志/数据导入共用） */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = ''
        req.on('data', chunk => {
            body += chunk
            if (body.length > 100e6) {
                reject(new Error('请求体过大'))
                req.destroy()
            }
        })
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : null)
            } catch {
                reject(new Error('无效的 JSON 请求体'))
            }
        })
        req.on('error', reject)
    })
}

module.exports = { sendJson, sendText, readBody }