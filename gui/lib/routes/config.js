/**
 * 配置路由（GET/PUT /api/config、POST /api/config/reset、POST /api/config/open）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// 宽松校验：布尔/字符串字段类型检查，返回错误数组
function validateConfigBody(body) {
    const errors = []
    for (const f of ['headless', 'ensureStreakProtection', 'errorDiagnostics', 'debugLogs', 'searchOnBingLocalQueries']) {
        if (body[f] !== undefined && typeof body[f] !== 'boolean') errors.push(`${f} 必须是布尔值`)
    }
    if (body.workers !== undefined) {
        if (!body.workers || typeof body.workers !== 'object' || Array.isArray(body.workers)) {
            errors.push('workers 必须是一个对象')
        } else {
            for (const [k, v] of Object.entries(body.workers)) {
                if (typeof v !== 'boolean') errors.push(`workers.${k} 必须是布尔值`)
            }
        }
    }
    if (body.searchSettings !== undefined) {
        const ss = body.searchSettings
        if (!ss || typeof ss !== 'object' || Array.isArray(ss)) {
            errors.push('searchSettings 必须是一个对象')
        } else {
            if (ss.scrollRandomResults !== undefined && typeof ss.scrollRandomResults !== 'boolean') errors.push('searchSettings.scrollRandomResults 必须是布尔值')
            if (ss.clickRandomResults !== undefined && typeof ss.clickRandomResults !== 'boolean') errors.push('searchSettings.clickRandomResults 必须是布尔值')
            if (ss.searchResultVisitTime !== undefined && typeof ss.searchResultVisitTime !== 'string') errors.push('searchSettings.searchResultVisitTime 必须是字符串')
            if (ss.searchDelay !== undefined) {
                if (!ss.searchDelay || typeof ss.searchDelay !== 'object' || Array.isArray(ss.searchDelay)) errors.push('searchSettings.searchDelay 必须是一个对象')
                else {
                    if (ss.searchDelay.min !== undefined && typeof ss.searchDelay.min !== 'string') errors.push('searchSettings.searchDelay.min 必须是字符串')
                    if (ss.searchDelay.max !== undefined && typeof ss.searchDelay.max !== 'string') errors.push('searchSettings.searchDelay.max 必须是字符串')
                }
            }
            if (ss.readDelay !== undefined) {
                if (!ss.readDelay || typeof ss.readDelay !== 'object' || Array.isArray(ss.readDelay)) errors.push('searchSettings.readDelay 必须是一个对象')
                else {
                    if (ss.readDelay.min !== undefined && typeof ss.readDelay.min !== 'string') errors.push('searchSettings.readDelay.min 必须是字符串')
                    if (ss.readDelay.max !== undefined && typeof ss.readDelay.max !== 'string') errors.push('searchSettings.readDelay.max 必须是字符串')
                }
            }
        }
    }
    for (const f of ['baseURL', 'globalTimeout', 'sessionPath']) {
        if (body[f] !== undefined && typeof body[f] !== 'string') errors.push(`${f} 必须是字符串`)
    }
    if (body.proxy !== undefined) {
        const px = body.proxy
        if (!px || typeof px !== 'object' || Array.isArray(px)) errors.push('proxy 必须是一个对象')
        else if (px.queryEngine !== undefined && typeof px.queryEngine !== 'boolean') errors.push('proxy.queryEngine 必须是布尔值')
    }
    if (body.consoleLogFilter !== undefined) {
        const clf = body.consoleLogFilter
        if (!clf || typeof clf !== 'object' || Array.isArray(clf)) errors.push('consoleLogFilter 必须是一个对象')
        else if (clf.enabled !== undefined && typeof clf.enabled !== 'boolean') errors.push('consoleLogFilter.enabled 必须是布尔值')
    }
    if (body.searchSettings && body.searchSettings.chinaApi !== undefined) {
        const ca = body.searchSettings.chinaApi
        if (!ca || typeof ca !== 'object' || Array.isArray(ca)) errors.push('searchSettings.chinaApi 必须是一个对象')
        else if (ca.appkey !== undefined && typeof ca.appkey !== 'string') errors.push('searchSettings.chinaApi.appkey 必须是字符串')
    }
    return errors
}

function handleConfig(req, res, pathname, ctx) {
    const { config, http } = ctx

    // GET /api/config
    if (pathname === '/api/config' && req.method === 'GET') {
        const c = config.readJson(config.resolveConfigPath())
        if (!c) { http.sendJson(res, 500, { error: '无法读取 config.json' }); return true }
        http.sendJson(res, 200, c)
        return true
    }

    // PUT /api/config
    if (pathname === '/api/config' && req.method === 'PUT') {
        return (async () => {
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return http.sendJson(res, 400, { error: '请求体必须是一个配置对象' })
                }
                const errors = validateConfigBody(body)
                if (errors.length) {
                    return http.sendJson(res, 400, { error: `配置校验失败: ${errors.join('；')}` })
                }
                // 强制忽略高风险字段：并行搜索
                if (body.searchSettings) delete body.searchSettings.parallelSearching

                const configPath = config.resolveConfigPath()
                const current = config.readJson(configPath) || {}
                const backupPath = configPath + '.bak'
                try { fs.copyFileSync(configPath, backupPath) } catch (e) {
                    return http.sendJson(res, 500, { error: `备份 config.json 失败: ${e.message}` })
                }
                const merged = {
                    ...current, ...body,
                    ...(body.workers ? { workers: { ...(current.workers || {}), ...body.workers } } : {}),
                    ...(body.proxy ? { proxy: { ...(current.proxy || {}), ...body.proxy } } : {}),
                    ...(body.consoleLogFilter ? { consoleLogFilter: { ...(current.consoleLogFilter || {}), ...body.consoleLogFilter } } : {}),
                    ...(body.searchSettings
                        ? {
                              searchSettings: {
                                  ...(current.searchSettings || {}), ...body.searchSettings,
                                  ...(body.searchSettings.chinaApi ? { chinaApi: { ...(current.searchSettings.chinaApi || {}), ...body.searchSettings.chinaApi } } : {}),
                                  ...(body.searchSettings.searchDelay ? { searchDelay: { ...(current.searchSettings.searchDelay || {}), ...body.searchSettings.searchDelay } } : {}),
                                  ...(body.searchSettings.readDelay ? { readDelay: { ...(current.searchSettings.readDelay || {}), ...body.searchSettings.readDelay } } : {})
                              }
                          }
                        : {})
                }
                try {
                    fs.writeFileSync(configPath, JSON.stringify(merged, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    try { fs.copyFileSync(backupPath, configPath) } catch {}
                    return http.sendJson(res, 500, { error: `写入 config.json 失败: ${e.message}` })
                }
                console.log(`[GUI] 已保存全局配置 (备份: ${path.basename(backupPath)})`)
                return http.sendJson(res, 200, { success: true, message: '全局配置已保存', backup: path.basename(backupPath), config: merged })
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // POST /api/config/open
    if (pathname === '/api/config/open' && req.method === 'POST') {
        const configPath = config.resolveConfigPath()
        try {
            if (!fs.existsSync(configPath)) {
                return http.sendJson(res, 500, { error: `配置文件不存在: ${configPath}` })
            }
            const cmd = process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', configPath]) : spawn('xdg-open', [configPath])
            cmd.on('error', () => http.sendJson(res, 500, { error: '无法打开配置文件（缺少系统默认打开程序）' }))
            cmd.on('spawn', () => http.sendJson(res, 200, { success: true, message: '已打开配置文件', path: configPath }))
            return true
        } catch (error) {
            return http.sendJson(res, 400, { error: error.message || '打开失败' }), true
        }
    }

    // POST /api/config/reset（以 src/config.example.json 为模板覆盖）
    if (pathname === '/api/config/reset' && req.method === 'POST') {
        return (async () => {
            const configPath = config.resolveConfigPath()
            const defaultTemplate = path.join(config.ROOT, 'src', 'config.example.json')
            try {
                if (!fs.existsSync(defaultTemplate)) {
                    return http.sendJson(res, 500, { error: '无法找到默认配置模板: src/config.example.json' })
                }
                const defaults = JSON.parse(fs.readFileSync(defaultTemplate, 'utf-8'))
                const backupPath = configPath + '.bak'
                if (fs.existsSync(configPath)) {
                    try { fs.copyFileSync(configPath, backupPath) } catch (e) {
                        return http.sendJson(res, 500, { error: `备份 config.json 失败: ${e.message}` })
                    }
                }
                try {
                    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 4) + '\n', 'utf-8')
                } catch (e) {
                    try { fs.copyFileSync(backupPath, configPath) } catch {}
                    return http.sendJson(res, 500, { error: `写入 config.json 失败: ${e.message}` })
                }
                console.log(`[GUI] 已重置全局配置为默认值 (备份: ${path.basename(backupPath)})`)
                return http.sendJson(res, 200, { success: true, message: '全局配置已重置为默认值', backup: path.basename(backupPath), config: defaults })
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '重置失败' })
            }
        })()
    }

    return false
}

module.exports = handleConfig