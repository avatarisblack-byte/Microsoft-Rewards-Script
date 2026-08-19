/**
 * 账号路由（GET/POST /api/accounts、PUT/DELETE /api/accounts/:email）
 * 签名：(req, res, pathname, ctx) => boolean
 */
const fs = require('fs')
const path = require('path')

function buildNewAccount(body) {
    return {
        email: body.email,
        password: body.password,
        totpSecret: typeof body.totpSecret === 'string' ? body.totpSecret : '',
        recoveryEmail: typeof body.recoveryEmail === 'string' ? body.recoveryEmail : '',
        geoLocale: typeof body.geoLocale === 'string' ? body.geoLocale : 'auto',
        langCode: typeof body.langCode === 'string' ? body.langCode : 'zh',
        proxy: body.proxy && typeof body.proxy === 'object' && !Array.isArray(body.proxy)
            ? body.proxy
            : { proxyAxios: false, url: '', port: 0, username: '', password: '' },
        saveFingerprint: body.saveFingerprint && typeof body.saveFingerprint === 'object' && !Array.isArray(body.saveFingerprint)
            ? body.saveFingerprint
            : { mobile: true, desktop: true }
    }
}

// 备份 .bak → 写回；失败自动恢复
function backupAndWrite(accountsPath, nextAccounts, res, http, onOk) {
    const backupPath = accountsPath + '.bak'
    try { fs.copyFileSync(accountsPath, backupPath) } catch (e) {
        http.sendJson(res, 500, { error: `备份 accounts.json 失败: ${e.message}` }); return
    }
    try {
        fs.writeFileSync(accountsPath, JSON.stringify(nextAccounts, null, 4) + '\n', 'utf-8')
    } catch (e) {
        try { fs.copyFileSync(backupPath, accountsPath) } catch {}
        http.sendJson(res, 500, { error: `写入 accounts.json 失败: ${e.message}` }); return
    }
    http.sendJson(res, 200, onOk(backupPath))
}

function handleAccounts(req, res, pathname, ctx) {
    const { config, http, validator } = ctx
    const accMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/)

    // GET /api/accounts（关联日志摘要：从预生成缓存读取，避免每次全量扫描原始日志）
    if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = config.readJson(config.resolveAccountsPath())
        if (!accounts) { http.sendJson(res, 500, { error: '无法读取 accounts.json' }); return true }
        const logSummary = ctx.logCache.getCachedData().accountSummary
        const logMap = {}
        for (const s of logSummary) logMap[s.account] = s
        const enriched = accounts.map(a => ({
            ...a,
            status: logMap[a.email.split('@')[0]] || { account: a.email.split('@')[0], entries: 0 }
        }))
        http.sendJson(res, 200, { accounts: enriched, logSummary })
        return true
    }

    // POST /api/accounts（新增）
    if (pathname === '/api/accounts' && req.method === 'POST') {
        return (async () => {
            try {
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return http.sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }
                if (!body.email || typeof body.email !== 'string' || !body.email.includes('@')) {
                    return http.sendJson(res, 400, { error: 'email 必须是非空邮箱字符串' })
                }
                if (!body.password || typeof body.password !== 'string') {
                    return http.sendJson(res, 400, { error: 'password 必填且必须是字符串' })
                }
                const newAccount = buildNewAccount(body)
                const validationError = validator.validateAccountShape(newAccount)
                if (validationError) {
                    return http.sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                if (accounts.some(a => a.email === newAccount.email)) {
                    return http.sendJson(res, 400, { error: `账号已存在: ${newAccount.email}` })
                }
                accounts.push(newAccount)
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${newAccount.email} 已添加`, backup: path.basename(backupPath), account: newAccount
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // DELETE /api/accounts/:email
    if (accMatch && req.method === 'DELETE') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                const removed = accounts[idx]
                accounts.splice(idx, 1)
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${targetEmail} 已删除`, backup: path.basename(backupPath), account: removed
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    // PUT /api/accounts/:email（合并更新）
    if (accMatch && req.method === 'PUT') {
        return (async () => {
            try {
                const targetEmail = decodeURIComponent(accMatch[1])
                const body = await http.readBody(req)
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    return http.sendJson(res, 400, { error: '请求体必须是一个账号对象' })
                }
                if (!body.email || String(body.email) !== targetEmail) {
                    return http.sendJson(res, 400, { error: '请求体中的 email 与目标账号不匹配' })
                }
                const validationError = validator.validateAccountShape(body)
                if (validationError) {
                    return http.sendJson(res, 400, { error: `账号格式校验失败: ${validationError}` })
                }
                const accountsPath = config.resolveAccountsPath()
                const accounts = config.readJson(accountsPath)
                if (!Array.isArray(accounts)) {
                    return http.sendJson(res, 500, { error: 'accounts.json 内容格式异常（应为数组）' })
                }
                const idx = accounts.findIndex(a => a.email === targetEmail)
                if (idx === -1) { return http.sendJson(res, 404, { error: `未找到账号: ${targetEmail}` }) }
                accounts[idx] = { ...accounts[idx], ...body }
                backupAndWrite(accountsPath, accounts, res, http, backupPath => ({
                    success: true, message: `账号 ${targetEmail} 配置已保存`, backup: path.basename(backupPath), account: accounts[idx]
                }))
            } catch (error) {
                return http.sendJson(res, 400, { error: error.message || '无效请求' })
            }
        })()
    }

    return false
}

module.exports = handleAccounts