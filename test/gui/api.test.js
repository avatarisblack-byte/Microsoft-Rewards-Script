/**
 * GUI HTTP 接口测试（gui/server.js + gui/lib/routes/*）
 *
 * 运行：node --test --test-isolation=none test/gui/api.test.js
 * 隔离：服务在当前进程内以沙箱副本启动，所有读写落在 os.tmpdir() 沙箱中。
 *
 * 本文件不触碰 /api/keepalive 与 /api/shutdown（会调用 process.exit），
 * 这两类用例见 resilience.test.js。
 */
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const H = require('./helpers/sandbox')

let SB = null
let srv = null
let BASE = ''

const readConfigFile = () => JSON.parse(fs.readFileSync(path.join(SB, 'config.json'), 'utf-8'))
const readAccountsFile = () => JSON.parse(fs.readFileSync(path.join(SB, 'accounts.json'), 'utf-8'))
const readGuiSettings = () => JSON.parse(fs.readFileSync(path.join(SB, 'gui', 'gui-settings.json'), 'utf-8'))

// 受限执行环境下（stdio=pipe 被拒绝）压缩/解压相关用例跳过
const archiveSpawnable = (() => {
    const r = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'])
        : spawnSync('sh', ['-c', 'exit 0'])
    return !r.error && r.status === 0
})()

before(async () => {
    SB = H.createSandbox('api')
    srv = H.startServerInProcess(SB, H.pickPort())
    BASE = srv.base
    await H.waitForServer(BASE)
})

after(async () => {
    if (srv) await srv.close()
    H.removeSandbox(SB)
})

// ============ 静态资源与路由分发 ============
describe('I-S 静态资源与路由分发', () => {
    test('I-S01 GET / 返回 HTML 页面', async () => {
        const r = await H.request(BASE, '/')
        assert.strictEqual(r.status, 200)
        assert.match(r.headers.get('content-type') || '', /text\/html/)
        assert.match(r.text(), /<html/i)
    })

    test('I-S02 GET /js/app.js 返回 JS 资源', async () => {
        const r = await H.request(BASE, '/js/app.js')
        assert.strictEqual(r.status, 200)
        assert.match(r.headers.get('content-type') || '', /javascript/)
    })

    test('I-S03 GET /css/main.css 返回样式资源', async () => {
        const r = await H.request(BASE, '/css/main.css')
        assert.strictEqual(r.status, 200)
        assert.match(r.headers.get('content-type') || '', /text\/css/)
    })

    test('I-S04 GET /js/notfound.js 返回 404 JSON', async () => {
        const r = await H.request(BASE, '/js/notfound.js')
        assert.strictEqual(r.status, 404)
        assert.ok(r.json && r.json.error)
    })

    test('I-S05 编码路径穿越 /js/%2e%2e%2fserver.js 不泄漏源码', async () => {
        const r = await H.request(BASE, '/js/%2e%2e%2fserver.js')
        assert.notStrictEqual(r.status, 200)
        assert.ok(!r.text().includes('createServer'), '疑似泄漏 server.js 内容')
    })

    test('I-S06 未知接口返回 404 JSON', async () => {
        const r = await H.request(BASE, '/api/not-exist')
        assert.strictEqual(r.status, 404)
        assert.match(r.json.error, /未知接口/)
    })

    test('I-S07 未知普通路径返回 404', async () => {
        const r = await H.request(BASE, '/whatever')
        assert.strictEqual(r.status, 404)
    })
})

// ============ /api/config ============
describe('I-C 全局配置接口', () => {
    test('I-C01 GET /api/config 返回配置对象', async () => {
        const r = await H.request(BASE, '/api/config')
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.json.baseURL, 'https://rewards.bing.com')
    })

    test('I-C02 PUT 空请求体返回 400', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT' })
        assert.strictEqual(r.status, 400)
    })

    test('I-C03 PUT 非法 JSON 返回 400', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', raw: '{oops' })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /JSON/)
    })

    test('I-C04 PUT 顶层数组返回 400', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: [] })
        assert.strictEqual(r.status, 400)
    })

    test('I-C05 PUT 字面 null 返回 400', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', raw: 'null' })
        assert.strictEqual(r.status, 400)
    })

    test('I-C06 类型错误的布尔字段被拒绝且不产生落盘副作用', async () => {
        const before = readConfigFile()
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { headless: 'true' } })
        assert.strictEqual(r.status, 400)
        assert.deepStrictEqual(readConfigFile(), before, '校验失败仍改动了 config.json')
    })

    test('I-C07 workers 子字段类型错误被拒绝', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { workers: { doDailySet: 'yes' } } })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /workers\.doDailySet/)
    })

    test('I-C08 searchSettings 深层字段类型错误被拒绝', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { searchSettings: { searchDelay: { min: 5 } } } })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /searchDelay\.min/)
    })

    test('I-C09 合法配置写入成功并生成 .bak 备份', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { headless: true, globalTimeout: '45s' } })
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.json.success, true)
        const disk = readConfigFile()
        assert.strictEqual(disk.headless, true)
        assert.strictEqual(disk.globalTimeout, '45s')
        assert.ok(fs.existsSync(path.join(SB, 'config.json.bak')), '未生成 .bak 备份')
    })

    test('I-C10 高风险字段 parallelSearching 被强制丢弃', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { searchSettings: { parallelSearching: true, searchResultVisitTime: '6s' } } })
        assert.strictEqual(r.status, 200)
        assert.strictEqual(readConfigFile().searchSettings.parallelSearching, undefined)
        assert.strictEqual(readConfigFile().searchSettings.searchResultVisitTime, '6s')
    })

    test('I-C11 未知字段应被拒绝而不是写入配置文件【回归防护：PUT 走合并写回，未知键值会直接落盘污染脚本配置】', async () => {
        const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { evilKey: { nested: 'x'.repeat(1000) } } })
        const disk = readConfigFile()
        assert.strictEqual(r.status, 400, `未知字段被接受（HTTP ${r.status}），落盘内容: ${JSON.stringify(disk.evilKey ?? null).slice(0, 60)}`)
        assert.strictEqual(disk.evilKey, undefined, '未知字段已落盘')
    })

    test('I-C12 __proto__ 注入不污染 Object 原型', async () => {
        await H.request(BASE, '/api/config', { method: 'PUT', raw: '{"__proto__":{"polluted":true},"debugLogs":true}' })
        assert.strictEqual({}.polluted, undefined)
        const r = await H.request(BASE, '/api/config')
        assert.strictEqual(r.status, 200)
    })

    test('I-C13 config.json 缺少 searchSettings 时合并 chinaApi 不应失败【回归防护：合并前需对 current.searchSettings 做空值保护】', async () => {
        const cfgPath = path.join(SB, 'config.json')
        const backup = fs.readFileSync(cfgPath, 'utf-8')
        const stripped = JSON.parse(backup)
        delete stripped.searchSettings
        fs.writeFileSync(cfgPath, JSON.stringify(stripped, null, 4), 'utf-8')
        try {
            const r = await H.request(BASE, '/api/config', { method: 'PUT', json: { searchSettings: { chinaApi: { appkey: 'test-key' } } } })
            assert.strictEqual(r.status, 200, `合并失败: HTTP ${r.status} ${r.json && r.json.error}`)
            assert.strictEqual(readConfigFile().searchSettings.chinaApi.appkey, 'test-key')
        } finally {
            fs.writeFileSync(cfgPath, backup, 'utf-8')
        }
    })

    test('I-C14 POST /api/config/reset 用模板覆盖并备份', async () => {
        const r = await H.request(BASE, '/api/config/reset', { method: 'POST' })
        assert.strictEqual(r.status, 200)
        const tpl = JSON.parse(fs.readFileSync(path.join(SB, 'src', 'config.example.json'), 'utf-8'))
        assert.deepStrictEqual(readConfigFile(), tpl)
    })

    test('I-C15 配置文件全部缺失时 GET 返回 500、open 返回错误且不启动外部程序', async () => {
        const cfgPath = path.join(SB, 'config.json')
        const tplPath = path.join(SB, 'src', 'config.example.json')
        const cfgBackup = fs.readFileSync(cfgPath, 'utf-8')
        const tplBackup = fs.readFileSync(tplPath, 'utf-8')
        fs.rmSync(cfgPath)
        fs.rmSync(tplPath)
        try {
            const get = await H.request(BASE, '/api/config')
            assert.strictEqual(get.status, 500)
            assert.match(get.json.error, /无法读取/)
            const open = await H.request(BASE, '/api/config/open', { method: 'POST' })
            assert.ok([400, 500].includes(open.status), `期望 4xx/5xx，实际 ${open.status}`)
            assert.ok(open.json && open.json.error)
            const reset = await H.request(BASE, '/api/config/reset', { method: 'POST' })
            assert.strictEqual(reset.status, 500)
            assert.match(reset.json.error, /模板/)
        } finally {
            fs.writeFileSync(cfgPath, cfgBackup, 'utf-8')
            fs.writeFileSync(tplPath, tplBackup, 'utf-8')
        }
    })
})

// ============ /api/gui-settings ============
describe('I-G GUI 专属设置接口', () => {
    test('I-G01 GET 返回设置对象', async () => {
        const r = await H.request(BASE, '/api/gui-settings')
        assert.strictEqual(r.status, 200)
        assert.strictEqual(typeof r.json.port, 'number')
    })

    test('I-G02 端口边界值 80 / 1023 / 65536 / 0 / -1 全部拒绝', async () => {
        for (const port of [80, 1023, 65536, 0, -1]) {
            const r = await H.request(BASE, '/api/gui-settings', { method: 'PUT', json: { port } })
            assert.strictEqual(r.status, 400, `port=${port} 未被拒绝`)
        }
    })

    test('I-G03 端口为字符串 / 浮点 / null / 缺失全部拒绝', async () => {
        for (const body of [{ port: '3000' }, { port: 3000.5 }, { port: null }, {}]) {
            const r = await H.request(BASE, '/api/gui-settings', { method: 'PUT', json: body })
            assert.strictEqual(r.status, 400, `body=${JSON.stringify(body)} 未被拒绝`)
        }
    })

    test('I-G04 合法端口 1024 / 65535 / 31234 保存成功', async () => {
        for (const port of [1024, 65535, 31234]) {
            const r = await H.request(BASE, '/api/gui-settings', { method: 'PUT', json: { port } })
            assert.strictEqual(r.status, 200, `port=${port} 未被接受`)
            assert.strictEqual(readGuiSettings().port, port)
        }
    })

    test('I-G05 保存端口不应丢失其他已存在的 GUI 设置【期望依据：writeGuiSettings 以 {port} 整体覆盖文件，非端口设置会被静默清除】', async () => {
        const file = path.join(SB, 'gui', 'gui-settings.json')
        fs.writeFileSync(file, JSON.stringify({ port: 3000, theme: 'dark', autoRefresh: true }, null, 4), 'utf-8')
        const r = await H.request(BASE, '/api/gui-settings', { method: 'PUT', json: { port: 31235 } })
        assert.strictEqual(r.status, 200)
        const after = readGuiSettings()
        assert.strictEqual(after.theme, 'dark', `其他设置被覆盖丢失，落盘内容: ${JSON.stringify(after)}`)
    })
})

// ============ /api/accounts ============
describe('I-A 账号接口', () => {
    test('I-A01 GET 返回账号列表且附带日志状态', async () => {
        const r = await H.request(BASE, '/api/accounts')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.json.accounts))
        assert.ok(r.json.accounts.length >= 1)
        assert.ok(r.json.accounts[0].status, '缺少 status 字段')
        assert.ok(Array.isArray(r.json.logSummary))
    })

    test('I-A02 POST 空请求体 / 数组 / 非法 JSON 返回 400', async () => {
        for (const opt of [{}, { json: [] }, { raw: '{bad' }]) {
            const r = await H.request(BASE, '/api/accounts', { method: 'POST', ...opt })
            assert.strictEqual(r.status, 400)
        }
    })

    test('I-A03 缺 email / email 无 @ / 缺 password 返回 400', async () => {
        const cases = [
            { password: 'p' },
            { email: 'no-at-sign', password: 'p' },
            { email: 'x@example.com' },
            { email: '', password: 'p' },
            { email: 123, password: 'p' },
        ]
        for (const body of cases) {
            const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: body })
            assert.strictEqual(r.status, 400, `body=${JSON.stringify(body)} 未被拒绝`)
        }
    })

    test('I-A04 合法新增账号写入成功并补全默认字段', async () => {
        const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email: 'new.user@example.com', password: 'Pw123456' } })
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.json.account.geoLocale, 'auto')
        assert.strictEqual(r.json.account.langCode, 'zh')
        assert.ok(readAccountsFile().some(a => a.email === 'new.user@example.com'))
    })

    test('I-A05 重复账号返回 400', async () => {
        const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email: 'new.user@example.com', password: 'Pw123456' } })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /已存在/)
    })

    test('I-A06 超长 email（5000 字符）应被拒绝【期望依据：无长度上限会把畸形数据写入 accounts.json，后续被脚本与日志模块消费】', async () => {
        const email = 'a'.repeat(5000) + '@example.com'
        const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email, password: 'p' } })
        assert.strictEqual(r.status, 400, `超长 email 被接受（HTTP ${r.status}）`)
    })

    test('I-A07 email 含换行/制表符应被拒绝【期望依据：控制字符会破坏日志行结构，导致日志解析与统计错乱】', async () => {
        const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email: 'evil\n\t@example.com', password: 'p' } })
        assert.strictEqual(r.status, 400, `含控制字符的 email 被接受（HTTP ${r.status}）`)
    })

    test('I-A08 email 含 HTML/脚本片段应被拒绝【期望依据：账号名会回显到前端列表，未过滤即存储型 XSS 风险】', async () => {
        const r = await H.request(BASE, '/api/accounts', { method: 'POST', json: { email: '<img src=x onerror=alert(1)>@example.com', password: 'p' } })
        assert.strictEqual(r.status, 400, `含脚本片段的 email 被接受（HTTP ${r.status}）`)
    })

    test('I-A09 PUT 请求体 email 与路径不一致返回 400', async () => {
        const r = await H.request(BASE, '/api/accounts/new.user%40example.com', { method: 'PUT', json: { ...H.fixtureAccount('other@example.com') } })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /不匹配/)
    })

    test('I-A10 PUT 不存在的账号返回 404', async () => {
        const email = 'ghost@example.com'
        const r = await H.request(BASE, `/api/accounts/${encodeURIComponent(email)}`, { method: 'PUT', json: H.fixtureAccount(email) })
        assert.strictEqual(r.status, 404)
    })

    test('I-A11 PUT 合法更新落盘成功', async () => {
        const email = 'new.user@example.com'
        const body = { ...H.fixtureAccount(email), geoLocale: 'us', langCode: 'en' }
        const r = await H.request(BASE, `/api/accounts/${encodeURIComponent(email)}`, { method: 'PUT', json: body })
        assert.strictEqual(r.status, 200)
        const disk = readAccountsFile().find(a => a.email === email)
        assert.strictEqual(disk.geoLocale, 'us')
        assert.strictEqual(disk.langCode, 'en')
    })

    test('I-A12 PUT 非法 proxy 结构返回 400', async () => {
        const email = 'new.user@example.com'
        const body = { ...H.fixtureAccount(email), proxy: [] }
        const r = await H.request(BASE, `/api/accounts/${encodeURIComponent(email)}`, { method: 'PUT', json: body })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /proxy/)
    })

    test('I-A13 DELETE 不存在的账号返回 404', async () => {
        const r = await H.request(BASE, '/api/accounts/ghost%40example.com', { method: 'DELETE' })
        assert.strictEqual(r.status, 404)
    })

    test('I-A14 DELETE 非法百分号编码返回 400 且服务不崩溃', async () => {
        const r = await H.request(BASE, '/api/accounts/%E0%A4%A', { method: 'DELETE' })
        assert.strictEqual(r.status, 400)
        const alive = await H.request(BASE, '/api/task')
        assert.strictEqual(alive.status, 200)
    })

    test('I-A15 DELETE 合法账号成功并从文件移除', async () => {
        const r = await H.request(BASE, '/api/accounts/new.user%40example.com', { method: 'DELETE' })
        assert.strictEqual(r.status, 200)
        assert.ok(!readAccountsFile().some(a => a.email === 'new.user@example.com'))
    })

    test('I-A16 并发新增 10 个不同账号不丢失写入【读-改-写全量文件的并发一致性】', async () => {
        const emails = Array.from({ length: 10 }, (_, i) => `bulk${i}@example.com`)
        const results = await Promise.all(emails.map(email =>
            H.request(BASE, '/api/accounts', { method: 'POST', json: { email, password: 'Pw123456' } })
        ))
        const okCount = results.filter(r => r.status === 200).length
        const disk = readAccountsFile().map(a => a.email)
        const missing = emails.filter(e => !disk.includes(e))
        assert.strictEqual(okCount, 10, `仅 ${okCount}/10 个请求成功`)
        assert.deepStrictEqual(missing, [], `并发写入丢失账号: ${missing.join(', ')}`)
    })

    test('I-A17 并发重复新增同一账号只允许成功一次', async () => {
        const email = 'race@example.com'
        const results = await Promise.all(Array.from({ length: 10 }, () =>
            H.request(BASE, '/api/accounts', { method: 'POST', json: { email, password: 'Pw123456' } })
        ))
        const okCount = results.filter(r => r.status === 200).length
        const dupCount = readAccountsFile().filter(a => a.email === email).length
        assert.strictEqual(okCount, 1, `${okCount} 个并发请求同时成功`)
        assert.strictEqual(dupCount, 1, `accounts.json 中出现 ${dupCount} 条重复账号`)
    })
})

// ============ /api/logs ============
describe('I-L 日志接口', () => {
    test('I-L01 GET /api/logs 返回 3 个夹具日志文件', async () => {
        const r = await H.request(BASE, '/api/logs')
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.json.files.length, 3)
    })

    test('I-L02 GET /api/logs/summary 返回条目与账号聚合', async () => {
        const r = await H.request(BASE, '/api/logs/summary')
        assert.strictEqual(r.status, 200)
        assert.ok(r.json.entries.length > 0)
        assert.ok(Array.isArray(r.json.summary))
    })

    test('I-L03 GET /api/logs/2026-03-03 应返回当日明细【期望依据：前端"按日期查看日志"依赖该接口，logger.readLogFile 未补 .log 后缀】', async () => {
        const r = await H.request(BASE, '/api/logs/2026-03-03')
        assert.strictEqual(r.status, 200)
        assert.ok(r.json.entries.length > 0, `按日期查询返回空明细: ${JSON.stringify(r.json)}`)
    })

    test('I-L04 GET 非法日期（9999-99-99）返回空结构且不崩溃', async () => {
        const r = await H.request(BASE, '/api/logs/9999-99-99')
        assert.strictEqual(r.status, 200)
        assert.deepStrictEqual(r.json.entries, [])
    })

    test('I-L05 DELETE /api/logs 应被拒绝【回归防护：读接口需限定 GET，避免任意方法命中读取分支】', async () => {
        const r = await H.request(BASE, '/api/logs', { method: 'DELETE' })
        assert.ok([404, 405].includes(r.status), `DELETE 被当作读取处理，返回 ${r.status}`)
    })

    test('I-L06 导入接口参数校验（空体/非 zip/缺数据）均返回 400', async () => {
        const cases = [
            {},
            { json: { filename: 'a.txt', dataBase64: 'AAAA' } },
            { json: { filename: 'a.zip' } },
            { json: { filename: 'a.zip', dataBase64: '' } },
        ]
        for (const opt of cases) {
            const r = await H.request(BASE, '/api/logs/import', { method: 'POST', ...opt })
            assert.strictEqual(r.status, 400, `参数组合 ${JSON.stringify(opt)} 未被拒绝`)
        }
    })

    test('I-L07 非法 base64 载荷返回 400 且服务存活', async () => {
        const r = await H.request(BASE, '/api/logs/import', { method: 'POST', json: { filename: 'a.zip', dataBase64: '!!!not-base64!!!' } })
        assert.strictEqual(r.status, 400)
        const alive = await H.request(BASE, '/api/logs')
        assert.strictEqual(alive.status, 200)
    })

    test('I-L08 合法 zip 导入成功并写入 logs 目录', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过压缩相关用例')
        const zip = H.makeZip([
            { name: '2026-03-10.log', data: H.logLine('2026-03-10T04:00:00.000Z', 'tester.imp', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: imp | 总计: +7 | 原始: 1 → 新值: 8') + '\n' },
            { name: 'nested/2026-03-11.log', data: H.logLine('2026-03-11T04:00:00.000Z', 'tester.imp', 'INFO', '主进程', 'ACCOUNT-END', '已完成账户: imp | 总计: +9 | 原始: 8 → 新值: 17') + '\n' },
        ])
        const r = await H.request(BASE, '/api/logs/import', { method: 'POST', json: { filename: 'logs.zip', dataBase64: zip.toString('base64') } })
        assert.strictEqual(r.status, 200, `导入失败: ${JSON.stringify(r.json)}`)
        assert.ok(fs.existsSync(path.join(SB, 'logs', '2026-03-10.log')))
        assert.ok(fs.existsSync(path.join(SB, 'logs', '2026-03-11.log')), '嵌套目录内的日志未被导入')
    })

    test('I-L09 zip slip 穿越条目不得写出 logs 目录之外', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过压缩相关用例')
        const zip = H.makeZip([{ name: '../../evil-escape.log', data: 'malicious' }])
        await H.request(BASE, '/api/logs/import', { method: 'POST', json: { filename: 'evil.zip', dataBase64: zip.toString('base64') } })
        assert.ok(!fs.existsSync(path.join(SB, '..', 'evil-escape.log')), '穿越写入成功，存在目录穿越漏洞')
        assert.ok(!fs.existsSync(path.join(SB, 'evil-escape.log')), '穿越写入到沙箱根目录')
    })

    test('I-L10 GET /api/logs/export 返回 zip 附件', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过压缩相关用例')
        const r = await H.request(BASE, '/api/logs/export')
        assert.strictEqual(r.status, 200)
        assert.match(r.headers.get('content-type') || '', /application\/zip/)
        assert.match(r.headers.get('content-disposition') || '', /logs-\d{8}-\d{6}\.zip/)
        assert.ok(r.buffer.length > 0)
    })
})

// ============ /api/data 与 /api/sessions ============
describe('I-D 数据与 Session 接口', () => {
    test('I-D01 数据导入参数校验均返回 400', async () => {
        for (const opt of [{}, { json: { filename: 'x.rar', dataBase64: 'AA' } }, { json: { filename: 'x.zip' } }]) {
            const r = await H.request(BASE, '/api/data/import', { method: 'POST', ...opt })
            assert.strictEqual(r.status, 400)
        }
    })

    test('I-D02 Session 导入参数校验均返回 400', async () => {
        for (const opt of [{}, { json: { filename: 'x.zip' } }, { json: { filename: 'x.txt', dataBase64: 'AA' } }]) {
            const r = await H.request(BASE, '/api/sessions/import', { method: 'POST', ...opt })
            assert.strictEqual(r.status, 400)
        }
    })

    test('I-D03 无 Session 目录时导出返回 400 提示', async () => {
        const r = await H.request(BASE, '/api/sessions/export')
        assert.strictEqual(r.status, 400)
        assert.ok(r.json.error)
    })

    test('I-D04 一键数据导出返回 zip', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过压缩相关用例')
        const r = await H.request(BASE, '/api/data/export')
        assert.strictEqual(r.status, 200)
        assert.match(r.headers.get('content-type') || '', /application\/zip/)
    })

    test('I-D05 Session 导入落盘到 dist/browser/sessions 且拒绝非 session 文件', async t => {
        if (!archiveSpawnable) return t.skip('当前执行环境禁止子进程管道（EPERM），跳过压缩相关用例')
        const zip = H.makeZip([
            { name: 'user@example.com/session_desktop.json', data: '{"cookies":[]}' },
            { name: 'user@example.com/not-a-session.txt', data: 'ignored' },
        ])
        const r = await H.request(BASE, '/api/sessions/import', { method: 'POST', json: { filename: 's.zip', dataBase64: zip.toString('base64') } })
        assert.strictEqual(r.status, 200, `导入失败: ${JSON.stringify(r.json)}`)
        const target = path.join(SB, 'dist', 'browser', 'sessions', 'user@example.com')
        assert.ok(fs.existsSync(path.join(target, 'session_desktop.json')))
        assert.ok(!fs.existsSync(path.join(target, 'not-a-session.txt')), '非 session 文件被导入')
    })
})

// ============ /api/start | /api/stop | /api/task ============
describe('I-T 任务控制接口', () => {
    test('I-T01 GET /api/task 返回完整状态结构', async () => {
        const r = await H.request(BASE, '/api/task')
        assert.strictEqual(r.status, 200)
        assert.strictEqual(typeof r.json.running, 'boolean')
        assert.ok('pid' in r.json)
        assert.ok(Array.isArray(r.json.log))
    })

    test('I-T02 GET /api/start 应被拒绝【回归防护：读方法不得产生副作用，否则浏览器预取/爬虫/CSRF 都能拉起脚本子进程】', async () => {
        const r = await H.request(BASE, '/api/start')
        assert.ok([404, 405].includes(r.status), `GET 触发了任务启动接口，返回 ${r.status} ${JSON.stringify(r.json)}`)
    })

    test('I-T03 GET /api/stop 应被拒绝【回归防护：同上，读方法不得产生副作用】', async () => {
        const r = await H.request(BASE, '/api/stop')
        assert.ok([404, 405].includes(r.status), `GET 触发了任务停止接口，返回 ${r.status}`)
    })

    test('I-T04 并发启动任务只允许一个成功', async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => H.request(BASE, '/api/start', { method: 'POST' })))
        for (const r of results) assert.ok([200, 400].includes(r.status), `异常响应码 ${r.status}`)
        const okCount = results.filter(r => r.json && r.json.success).length
        assert.ok(okCount <= 1, `${okCount} 个并发启动请求同时成功，存在多进程并发风险`)
    })

    test('I-T05 停止任务后状态可查询且服务存活', async () => {
        const stop = await H.request(BASE, '/api/stop', { method: 'POST' })
        assert.ok([200, 400].includes(stop.status))
        const status = await H.request(BASE, '/api/task')
        assert.strictEqual(status.status, 200)
    })
})

// ============ /api/stats | /api/summary | /api/setup ============
describe('I-Y 系统接口', () => {
    test('I-Y01 GET /api/stats 返回统计缓存且总计与日志一致', async () => {
        const r = await H.request(BASE, '/api/stats')
        assert.strictEqual(r.status, 200)
        assert.ok(Array.isArray(r.json.daily))
        assert.strictEqual(typeof r.json.grandTotal, 'number')
        assert.ok(r.json.grandTotal >= H.FIXTURE_EXPECT.grandTotal, `grandTotal=${r.json.grandTotal} 小于夹具期望 ${H.FIXTURE_EXPECT.grandTotal}`)
    })

    test('I-Y02 GET /api/summary 与 /api/stats 结果一致', async () => {
        const a = await H.request(BASE, '/api/stats')
        const b = await H.request(BASE, '/api/summary')
        assert.strictEqual(b.status, 200)
        assert.strictEqual(a.json.grandTotal, b.json.grandTotal)
    })

    test('I-Y03 DELETE /api/stats 应被拒绝【回归防护：统计读接口需限定 GET】', async () => {
        const r = await H.request(BASE, '/api/stats', { method: 'DELETE' })
        assert.ok([404, 405].includes(r.status), `DELETE 被当作读取处理，返回 ${r.status}`)
    })

    test('I-Y04 缺少 setup.bat 时返回 400 且不启动外部进程', async () => {
        const r = await H.request(BASE, '/api/setup', { method: 'POST' })
        assert.strictEqual(r.status, 400)
        assert.match(r.json.error, /setup\.bat/)
    })
})

// ============ 并发与压力 ============
describe('I-P 并发与高频操作', () => {
    test('I-P01 50 并发 GET /api/stats 全部成功', async () => {
        const started = Date.now()
        const results = await Promise.all(Array.from({ length: 50 }, () => H.request(BASE, '/api/stats')))
        const bad = results.filter(r => r.status !== 200)
        assert.strictEqual(bad.length, 0, `${bad.length}/50 个请求失败`)
        assert.ok(Date.now() - started < 20000, '50 并发耗时超过 20s')
    })

    test('I-P02 30 并发 GET /api/accounts（缓存重建路径）全部成功', async () => {
        const cacheFile = path.join(SB, 'gui', 'cache', 'account-summary.json')
        try { fs.rmSync(cacheFile, { force: true }) } catch { /* 忽略 */ }
        const results = await Promise.all(Array.from({ length: 30 }, () => H.request(BASE, '/api/accounts')))
        const bad = results.filter(r => r.status !== 200)
        assert.strictEqual(bad.length, 0, `${bad.length}/30 个请求失败（缓存并发重建异常）`)
    })

    test('I-P03 20 并发 PUT /api/config 后配置文件仍为合法 JSON', async () => {
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
            H.request(BASE, '/api/config', { method: 'PUT', json: { globalTimeout: `${20 + i}s` } })
        ))
        const bad = results.filter(r => r.status !== 200)
        assert.strictEqual(bad.length, 0, `${bad.length}/20 个写请求失败`)
        assert.doesNotThrow(() => readConfigFile(), 'config.json 被并发写坏')
    })

    test('I-P04 客户端中途中断 10 次后服务仍正常响应', async () => {
        for (let i = 0; i < 10; i++) {
            const ac = new AbortController()
            const p = H.request(BASE, '/api/config', { method: 'PUT', raw: '{"headless":true,"pad":"' + 'x'.repeat(200000) + '"}', signal: ac.signal }).catch(() => null)
            setTimeout(() => ac.abort(), 1)
            await p
        }
        const alive = await H.request(BASE, '/api/task')
        assert.strictEqual(alive.status, 200)
    })

    test('I-P05 8MB 请求体在 20s 内被处理完毕（不阻塞后续请求）', async () => {
        const payload = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64')
        const started = Date.now()
        const r = await H.request(BASE, '/api/logs/import', { method: 'POST', json: { filename: 'big.zip', dataBase64: payload } })
        const cost = Date.now() - started
        assert.ok([200, 400].includes(r.status), `异常响应码 ${r.status}`)
        assert.ok(cost < 20000, `大请求体处理耗时 ${cost}ms`)
        const alive = await H.request(BASE, '/api/task')
        assert.strictEqual(alive.status, 200)
    })
})
