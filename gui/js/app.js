        // ===== 全局状态 =====
        let accountsCache = { accounts: [], logSummary: [] };
        let configCache = null;

        // ===== 工具函数 =====
        function emailUser(email) {
            return email ? email.split('@')[0] : 'unknown';
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&')
                .replace(/</g, '<')
                .replace(/>/g, '>')
                .replace(/"/g, '"');
        }

        async function fetchJson(url) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
            return res.json();
        }

        // 根据邮箱前缀匹配日志摘要
        function findLogStatus(email) {
            const userName = emailUser(email);
            return (accountsCache.logSummary || []).find(s => s.account === userName) || null;
        }

        function getLevelColor(level) {
            switch ((level || '').toUpperCase()) {
                case 'ERROR': return 'text-red-600';
                case 'WARN': return 'text-yellow-600';
                case 'DEBUG': return 'text-gray-400';
                default: return 'text-gray-600';
            }
        }

        function formatDuration(seconds) {
            if (!seconds && seconds !== 0) return '--';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }

        function formatTime(isoStr) {
            if (!isoStr) return '--';
            try {
                const d = new Date(isoStr);
                return d.toLocaleString('zh-CN', { hour12: false });
            } catch {
                return isoStr;
            }
        }

        // ===== 任务控制 =====
        let taskRunning = false;

        function setTaskUI(running) {
            taskRunning = Boolean(running);
            const startBtn = document.getElementById('task-start-btn');
            const stopBtn = document.getElementById('task-stop-btn');
            const dot = document.getElementById('task-status-dot');
            const ping = document.getElementById('task-status-ping');
            const text = document.getElementById('task-status-text');

            if (startBtn) startBtn.classList.toggle('hidden', running);
            if (stopBtn) stopBtn.classList.toggle('hidden', !running);
            if (text) text.innerText = running ? '脚本运行中' : '脚本空闲中';
            if (dot) {
                dot.className = `relative inline-flex rounded-full h-3 w-3 ${running ? 'bg-green-500' : 'bg-gray-400'}`;
            }
            if (ping) {
                ping.className = `animate-ping absolute inline-flex h-full w-full rounded-full ${running ? 'bg-green-400' : 'bg-gray-400'} opacity-75`;
            }
        }

        async function taskStart() {
            try {
                const res = await fetch('/api/start', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    alert(`❌ 启动失败: ${data.error || '未知错误'}`);
                    return;
                }
                setTaskUI(true);
                pollTaskStatus(); // 立即拉取一次状态和日志
                alert(`✅ ${data.message || '任务已启动'}`);
            } catch (e) {
                alert(`❌ 启动失败: ${e.message}`);
            }
        }

        async function taskStop() {
            try {
                const res = await fetch('/api/stop', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    alert(`❌ 停止失败: ${data.error || '未知错误'}`);
                    return;
                }
                alert(`⏹ ${data.message || '停止信号已发送'}`);
                pollTaskStatus();
            } catch (e) {
                alert(`❌ 停止失败: ${e.message}`);
            }
        }

        // 更新 header 状态 + 页面上的任务日志区域
        function renderTaskLog(log) {
            const logBox = document.getElementById('task-log-box');
            if (!logBox) return;
            if (!log || !log.length) {
                logBox.innerHTML = '<p class="text-gray-400 text-xs">暂无任务日志。点击"启动任务"开始运行。</p>';
                return;
            }
            logBox.innerHTML = log.map(entry => {
                const ts = entry.time ? new Date(entry.time).toLocaleString('zh-CN', { hour12: false }) : '';
                return `<div class="text-[11px] leading-tight ${/ERROR|失败/i.test(entry.line) ? 'text-red-500' : /WARN/i.test(entry.line) ? 'text-yellow-600' : /DEBUG/i.test(entry.line) ? 'text-gray-400' : 'text-gray-600'}"><span class="text-gray-300 mr-2">${ts || ''}</span>${escapeHtml(entry.line)}</div>`;
            }).join('');
            // 滚动到底部
            logBox.scrollTop = logBox.scrollHeight;
        }

        async function pollTaskStatus() {
            try {
                const res = await fetchJson('/api/task');
                setTaskUI(res.running);
                renderTaskLog(res.log || []);
            } catch (e) {
                console.error('任务状态拉取失败:', e);
            }
        }

        // ===== 数据加载 =====
        async function loadData() {
            try {
                const [accData, configData] = await Promise.all([
                    fetchJson('/api/accounts'),
                    fetchJson('/api/config')
                ]);
                accountsCache = accData;
                configCache = configData;
                renderAll();
            } catch (error) {
                console.error('加载数据失败:', error);
                document.getElementById('home-total-accounts-sub').innerText = '加载失败，请确认已运行 node gui/server.js';
            }
        }

        // ===== 渲染：Home 面板 =====
        function renderHome() {
            const accounts = accountsCache.accounts || [];
            const cards = document.getElementById('home-account-cards');
            const totalCollectedEl = document.getElementById('home-total-collected');
            const totalBalanceEl = document.getElementById('home-total-balance');
            const totalAccountsEl = document.getElementById('home-total-accounts');
            const totalSubEl = document.getElementById('home-total-accounts-sub');
            const balanceSubEl = document.getElementById('home-total-balance-sub');

            totalAccountsEl.innerText = accounts.length;
            totalSubEl.innerText = `已配置 ${accounts.length} 个账号`;

            // 汇总积分：合并「已配置账号」与「日志中实际有收益的账号」
            // 已配置账号：通过 status 关联日志
            const configuredTotals = accounts.map(a => {
                const log = a.status && a.status.entries ? a.status : null;
                if (!log) return { collected: 0, balance: 0 };
                const collected = log.collectedPoints || 0;
                const balance = (typeof log.latestBalance === 'number' && log.latestBalance > 0)
                    ? log.latestBalance
                    : (log.finalPoints || 0);
                return { collected, balance };
            });
            // 日志账号：logSummary 中未在 accounts.json 里但确有收益的账号
            const configuredNames = new Set(accounts.map(a => emailUser(a.email)));
            const logAccountTotals = (accountsCache.logSummary || [])
                .filter(s => s && !configuredNames.has(s.account))
                .map(s => ({
                    collected: s.collectedPoints || 0,
                    balance: (typeof s.latestBalance === 'number' && s.latestBalance > 0)
                        ? s.latestBalance
                        : (s.finalPoints || 0)
                }));

            const totalCollected = configuredTotals.concat(logAccountTotals).reduce((sum, t) => sum + t.collected, 0);
            const totalBalance = configuredTotals.concat(logAccountTotals).reduce((sum, t) => sum + t.balance, 0);
            totalCollectedEl.innerText = totalCollected;
            totalBalanceEl.innerText = totalBalance;
            balanceSubEl.innerText = '基于日志解析（含未配置账号）';

            if (accounts.length === 0) {
                cards.innerHTML = `
                    <div class="bg-white p-12 rounded-2xl border border-gray-100 card-shadow text-center">
                        <p class="text-gray-500 font-medium">暂无账号</p>
                        <p class="text-sm text-gray-400 mt-1">请先在 accounts.json 中配置账号</p>
                    </div>`;
                return;
            }

            cards.innerHTML = accounts.map((acc, idx) => {
                const log = findLogStatus(acc.email);
                const isRunning = log && log.lastEvent === 'ACCOUNT-START' && !log.collectedPoints;
                const statusDot = isRunning ? 'bg-green-500' : 'bg-gray-300';
                const statusText = isRunning ? '运行中' : (log ? '已完成' : '空闲');
                const collected = log && log.collectedPoints ? `+${log.collectedPoints}` : (log ? '--' : '--');
                const duration = log ? formatDuration(log.duration) : '--';
                const latestMsg = log ? log.lastMessage : '暂无运行记录';

                return `
                <div class="bg-white p-6 rounded-2xl border border-gray-100 card-shadow space-y-5 min-w-0">
                    <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-4 min-w-0 flex-1">
                            <span class="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-lg flex-shrink-0">${idx + 1}</span>
                            <div class="min-w-0">
                                <h3 class="font-bold text-gray-900 text-lg truncate">${escapeHtml(acc.email)}</h3>
                                <p class="text-sm text-gray-500 flex items-center gap-1.5 mt-0.5">
                                    <span class="w-2 h-2 rounded-full ${statusDot}"></span>${statusText}
                                    <span class="text-gray-300 mx-0.5">·</span>
                                    <span class="text-xs text-gray-400">${escapeHtml(log ? '日志条目: ' + log.entries : '无日志')}</span>
                                </p>
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="bg-gray-50/80 p-4 rounded-xl border border-gray-100 min-w-0">
                            <p class="text-xs text-gray-500 mb-1">今日收益</p>
                            <p class="text-2xl font-bold ${collected === '--' ? 'text-gray-400' : 'text-blue-700'}">${collected} pts</p>
                        </div>
                        <div class="bg-blue-50/50 p-4 rounded-xl border border-blue-50">
                            <p class="text-xs text-blue-500 mb-1">最新状态</p>
                            <p class="text-sm font-semibold text-gray-700 line-clamp-2">${escapeHtml(latestMsg)}</p>
                        </div>
                    </div>
                    ${log ? `<p class="text-[11px] text-gray-400">最近活动: ${formatTime(log.lastTime)} · ${escapeHtml(log.lastEvent || '')}</p>` : ''}
                </div>`;
            }).join('');
        }

        // ===== 渲染：Accounts 面板 =====
        function renderAccountsPanel() {
            const accounts = accountsCache.accounts || [];
            const list = document.getElementById('accounts-list');
            const empty = document.getElementById('accounts-empty');

            if (accounts.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }
            empty.classList.add('hidden');

            list.innerHTML = accounts.map((acc, idx) => {
                const log = findLogStatus(acc.email);
                const fingerprintText = [];
                if (acc.saveFingerprint && acc.saveFingerprint.desktop) fingerprintText.push('桌面端指纹');
                if (acc.saveFingerprint && acc.saveFingerprint.mobile) fingerprintText.push('移动端指纹');
                const localeText = acc.geoLocale === 'auto' ? 'Auto Locale' : acc.geoLocale;
                const proxyEnabled = acc.proxy && acc.proxy.proxyAxios;
                const level = log ? log.lastLevel : null;
                const statusBadge = log
                    ? `<span class="text-[11px] px-2 py-0.5 rounded-md font-medium border border-gray-200 ${getLevelColor(level)}">最近: ${escapeHtml(log.lastEvent || '')}</span>`
                    : '<span class="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-400 rounded-md font-medium border border-gray-200">无运行记录</span>';

                return `
                <div class="bg-white p-5 rounded-2xl border border-gray-100 card-shadow flex items-center justify-between gap-4 group">
                    <div class="flex items-center gap-4 flex-1">
                        <span class="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl font-bold">${idx + 1}</span>
                        <div>
                            <h3 class="font-bold text-gray-900 text-lg">${escapeHtml(acc.email)}</h3>
                            <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                                ${fingerprintText.map(t => `<span class="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-600 rounded-md font-medium border border-gray-200">${t}</span>`).join('')}
                                <span class="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-600 rounded-md font-medium border border-gray-200">${escapeHtml(localeText)}</span>
                                ${acc.langCode ? `<span class="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-600 rounded-md font-medium border border-gray-200">lang: ${escapeHtml(acc.langCode)}</span>` : ''}
                                ${proxyEnabled ? '<span class="text-[11px] px-2 py-0.5 bg-green-50 text-green-600 rounded-md font-medium border border-green-100">代理</span>' : ''}
                                ${statusBadge}
                            </div>
                            <p class="text-xs text-gray-400 mt-1.5 truncate max-w-xl">
                                ${log ? escapeHtml(log.lastMessage || '') : '该账户暂无日志记录，启动任务后自动显示运行状态'}
                            </p>
                        </div>
                    </div>
                    <div class="flex gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick="openAccountSettings('${escapeHtml(acc.email)}')" class="p-2.5 text-blue-600 bg-blue-50 rounded-xl hover:bg-blue-100 transition-colors" title="详细设置">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                        </button>
                        <button onclick="deleteAccount('${escapeHtml(acc.email)}')" class="p-2.5 text-red-600 bg-red-50 rounded-xl hover:bg-red-100 transition-colors" title="删除">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                </div>`;
            }).join('');
        }

        // ===== 渲染：Stats 面板（Chart.js 趋势图） =====
        let statsChart = null; // Chart.js 实例缓存（防止重复创建）

        async function renderStats() {
            const barsEl = document.getElementById('stats-account-bars');
            const chartCtx = document.getElementById('stats-trend-chart');

            // 安全兜底（元素不存在时跳过）
            if (!chartCtx && !barsEl) return;

            let statsData = null;
            try {
                statsData = await fetchJson('/api/stats');
            } catch (e) {
                console.error('加载统计失败:', e);
                if (document.getElementById('stats-stats-info')) {
                    document.getElementById('stats-stats-info').innerText = '加载失败，请确认已运行 node gui/server.js';
                }
                return;
            }

            // 顶部三张摘要卡
            const grandTotal = statsData.grandTotal || 0;
            const dailyArr = statsData.daily || [];
            const todayPoints = dailyArr.length > 0 ? dailyArr[dailyArr.length - 1].total : 0;
            const activeDays = dailyArr.length;

            if (document.getElementById('stats-grand-total')) {
                document.getElementById('stats-grand-total').innerText = `${grandTotal} pts`;
            }
            if (document.getElementById('stats-today-points')) {
                document.getElementById('stats-today-points').innerText = `${todayPoints} pts`;
            }
            if (document.getElementById('stats-active-days')) {
                document.getElementById('stats-active-days').innerText = String(activeDays);
            }
            if (document.getElementById('stats-stats-info')) {
                const generatedAt = statsData.generatedAt ? new Date(statsData.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
                document.getElementById('stats-stats-info').innerText = `解析时间: ${generatedAt || '--'}`;
            }

            // === Chart.js 每日趋势堆叠图 ===
            // 惰性创建：Chart 只在统计面板可见时才创建（隐藏容器尺寸 0×0 会导致 scale 布局异常，动画起点错乱）
            const statsPanel = document.getElementById('panel-stats');
            const isStatsVisible = statsPanel && !statsPanel.classList.contains('hidden');
            if (chartCtx && typeof Chart !== 'undefined') {
                // 构建每个账号的时间序列数据
                const dates = dailyArr.map(d => d.date);
                // 收集所有账号名称（仅保留有收益的账户，零收益不显示在图例/堆叠柱中）
                const allAccounts = new Set();
                dailyArr.forEach(d => {
                    (d.accounts || []).forEach(a => {
                        if (a.points > 0) allAccounts.add(a.account);
                    });
                });

                // 调色板（支持最多 12 个账号）
                const PALETTE = [
                    'rgba(59, 130, 246, 0.8)',   // blue-500
                    'rgba(16, 185, 129, 0.8)',   // emerald-500
                    'rgba(249, 115, 22, 0.8)',   // orange-500
                    'rgba(168, 85, 247, 0.8)',   // purple-500
                    'rgba(236, 72, 153, 0.8)',   // pink-500
                    'rgba(14, 165, 233, 0.8)',   // sky-500
                    'rgba(245, 158, 11, 0.8)',   // amber-500
                    'rgba(34, 197, 94, 0.8)',    // green-500
                    'rgba(99, 102, 241, 0.8)',   // indigo-500
                    'rgba(234, 88, 12, 0.8)',    // orange-600
                    'rgba(20, 184, 166, 0.8)',   // teal-500
                    'rgba(190, 24, 93, 0.8)'     // pink-700
                ];

                // 每个账号的每日积分（按日期对齐）
                const datasets = Array.from(allAccounts).map((account, idx) => {
                    const color = PALETTE[idx % PALETTE.length];
                    return {
                        label: emailUser(account),
                        data: dates.map(date => {
                            const day = dailyArr.find(d => d.date === date);
                            const accEntry = day && day.accounts ? day.accounts.find(a => a.account === account) : null;
                            return accEntry ? accEntry.points : 0;
                        }),
                        backgroundColor: color,
                        borderColor: color.replace('0.8', '1'),
                        borderWidth: 1,
                        fill: true,
                        tension: 0.3
                    };
                });

                // 已有实例：用 animator.js 的平滑更新（保留当前显示高度过渡到新值，不归零重飞）
                if (statsChart) {
                    smoothUpdateChart(statsChart, dates, datasets);
                } else if (isStatsVisible) {
                    // 首次创建（仅面板可见时）：合并 animator.js 的动画配置（x 锚定 + y 从 0 竖直生长）
                    statsChart = new Chart(chartCtx, {
                        type: 'bar',
                        data: {
                            labels: dates,
                            datasets: datasets
                        },
                        options: {
                            ...(window.chartAnimOptions || {}),
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                                legend: {
                                    position: 'bottom',
                                    labels: { usePointStyle: true, padding: 16, boxWidth: 10, font: { size: 11 } }
                                },
                                tooltip: {
                                    callbacks: {
                                        label: function (context) {
                                            return `${context.dataset.label}: +${context.raw} pts`;
                                        }
                                    }
                                }
                            },
                            scales: {
                                x: { stacked: true, grid: { display: false } },
                                y: {
                                    stacked: true,
                                    beginAtZero: true,
                                    title: { display: true, text: '积分', font: { size: 11 } }
                                }
                            }
                        }
                    });
                }
            }

            // === 各账号累计收益条 ===
            // 过滤掉累计收益为零的账户（不显示在列表中）
            const accountTotals = (statsData.accountTotals || []).filter(a => a.totalPoints > 0);
            if (!accountTotals.length) {
                barsEl.innerHTML = '<p class="text-gray-400">暂无账号统计数据</p>';
                return;
            }

            const maxAccPoints = Math.max(...accountTotals.map(a => a.totalPoints), 1);
            barsEl.innerHTML = accountTotals.map((acc, idx) => {
                const width = Math.max(4, (acc.totalPoints / maxAccPoints) * 100);
                return `
                <div class="flex items-center gap-3">
                    <span class="w-40 flex-shrink-0 text-xs text-gray-600 truncate text-right">${escapeHtml(acc.account)}</span>
                    <div class="flex-1 min-w-0 bg-gray-100 rounded-full h-5 overflow-hidden">
                        <div class="bg-blue-500 h-full rounded-full transition-all duration-500" style="width: ${width}%"></div>
                    </div>
                    <span class="w-24 flex-shrink-0 text-xs font-bold text-blue-700 text-left">+${acc.totalPoints} pts</span>
                    <span class="w-14 flex-shrink-0 text-[11px] text-gray-400 text-left">${acc.activeDays} 天</span>
                </div>`;
            }).join('');
        }

        // ===== 导出日志压缩包 =====
        async function exportLogs() {
            const btn = document.getElementById('logs-export-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导出中...';
            }

            try {
                const res = await fetch('/api/logs/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'logs.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 导入日志压缩包 =====
        async function importLogs(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            const btn = document.getElementById('logs-import-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导入中...';
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await fetch('/api/logs/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const details = (data.files || []).map(f => `  ${f}`).join('\n');
                alert(`✅ ${data.message}\n\n${details}\n\n目标目录: ${data.target || ''}`);
                // 日志是统计数据源，导入后刷新统计卡/图表
                await loadData();
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 一键导出全部本地数据（sessions + logs + accounts + config） =====
        async function exportAllData() {
            const btn = document.getElementById('data-export-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导出中...';
            }

            try {
                const res = await fetch('/api/data/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'gui-data.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 一键导入全部本地数据 zip =====
        async function importAllData(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            // 导入会覆盖当前数据，提示确认
            if (!confirm('导入将覆盖当前账号/配置/会话/日志数据（原数据会自动备份为 .bak）。\n确定继续吗？')) {
                return;
            }

            const btn = document.getElementById('data-import-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导入中...';
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await fetch('/api/data/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const imp = data.imported || {};
                alert(`✅ ${data.message}\n\nSession: ${imp.sessions || 0}\n日志: ${imp.logs || 0}\n账号: ${imp.accounts || 0}\n配置: ${imp.config || 0}`);
                // 数据被覆盖，刷新面板
                await loadData();
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 导出 Session 压缩包 =====
        async function exportSessions() {
            const btn = document.getElementById('session-export-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导出中...';
            }

            try {
                const res = await fetch('/api/sessions/export');
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 从 Content-Disposition 解析文件名
                const cd = res.headers.get('Content-Disposition') || '';
                const m = cd.match(/filename="?([^"]+)"?/);
                const filename = m ? m[1] : 'sessions.zip';

                // Blob 触发浏览器下载
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            } catch (error) {
                alert(`❌ 导出失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 关闭服务 =====
        async function shutdownServer() {
            if (!confirm('确定要停止服务并退出吗？')) {
                return;
            }

            try {
                const res = await fetch('/api/shutdown', { method: 'POST' });
                if (!res.ok) {
                    let msg = `HTTP ${res.status}`;
                    try {
                        const data = await res.json();
                        if (data && data.error) msg = data.error;
                    } catch {}
                    throw new Error(msg);
                }

                // 停止轮询，避免服务退出后的失败请求刷 console
                const overlays = document.getElementById('shutdown-overlay');
                try {
                    // 尝试关闭当前浏览器页面（若被浏览器拦截则显示遮罩）
                    window.close();
                    setTimeout(() => {
                        // window.close() 被拦截时页面仍在，显示"服务已关闭"遮罩
                        if (overlays) overlays.classList.remove('hidden');
                    }, 500);
                } catch {
                    if (overlays) overlays.classList.remove('hidden');
                }
            } catch (error) {
                alert(`❌ 关闭失败: ${error.message || error}`);
            }
        }

        // ===== 导入 Session 压缩包 =====
        async function importSessionFile(fileInput) {
            const file = fileInput && fileInput.files && fileInput.files[0];
            // 重置 input，允许重复选择同一文件
            if (fileInput) fileInput.value = '';
            if (!file) return;

            const btn = document.getElementById('session-import-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '导入中...';
            }

            try {
                // FileReader → Base64（去掉 data:...;base64, 前缀）
                const dataBase64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === 'string') {
                            resolve(result.split(',')[1]);
                        } else {
                            reject(new Error('文件读取失败'));
                        }
                    };
                    reader.onerror = () => reject(new Error('文件读取失败'));
                    reader.readAsDataURL(file);
                });

                const res = await fetch('/api/sessions/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: file.name, dataBase64 })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                const details = (data.accounts || []).map(a => `  ${a.email} (${a.files.length} 个文件)`).join('\n');
                alert(`✅ ${data.message}\n\n${details}\n\n目标目录: ${data.target || ''}`);
            } catch (error) {
                alert(`❌ 导入失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 渲染：Settings 面板（从 configCache 回显全局配置） =====
        function renderSettings() {
            const cfg = configCache || {};
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el && val !== undefined && val !== null) {
                    if (el.type === 'checkbox') {
                        el.checked = Boolean(val);
                    } else {
                        el.value = String(val);
                    }
                }
            };

            // 基础参数
            set('cfg-baseURL', cfg.baseURL);
            set('cfg-globalTimeout', cfg.globalTimeout);
            set('cfg-headless', cfg.headless);
            set('cfg-ensureStreakProtection', cfg.ensureStreakProtection);
            set('cfg-errorDiagnostics', cfg.errorDiagnostics);
            set('cfg-debugLogs', cfg.debugLogs);
            set('cfg-searchOnBingLocalQueries', cfg.searchOnBingLocalQueries);

            // 任务开关 (workers)
            const w = cfg.workers || {};
            set('cfg-workers-doDailySet', w.doDailySet);
            set('cfg-workers-doClaimBonusPoints', w.doClaimBonusPoints);
            set('cfg-workers-doSpecialPromotions', w.doSpecialPromotions);
            set('cfg-workers-doMorePromotions', w.doMorePromotions);
            set('cfg-workers-doPunchCards', w.doPunchCards);
            set('cfg-workers-doAppPromotions', w.doAppPromotions);
            set('cfg-workers-doDesktopSearch', w.doDesktopSearch);
            set('cfg-workers-doMobileSearch', w.doMobileSearch);
            set('cfg-workers-doDailyCheckIn', w.doDailyCheckIn);
            set('cfg-workers-doReadToEarn', w.doReadToEarn);

            // 低风险新增项
            const px = cfg.proxy || {};
            set('cfg-proxy-queryEngine', px.queryEngine);
            const clf = cfg.consoleLogFilter || {};
            set('cfg-consoleLogFilter-enabled', clf.enabled);

            // 搜索与延迟
            const ss = cfg.searchSettings || {};
            set('cfg-scrollRandomResults', ss.scrollRandomResults);
            set('cfg-clickRandomResults', ss.clickRandomResults);
            set('cfg-searchResultVisitTime', ss.searchResultVisitTime);
            const delay = ss.searchDelay || {};
            set('cfg-searchDelayMin', delay.min);
            set('cfg-searchDelayMax', delay.max);
            const readDelay = ss.readDelay || {};
            set('cfg-readDelayMin', readDelay.min);
            set('cfg-readDelayMax', readDelay.max);
            const ca = ss.chinaApi || {};
            set('cfg-chinaApi-appkey', ca.appkey);

            // 只读配置回显（不参与保存）
            set('ro-sessionPath', cfg.sessionPath);
            set('ro-clusters', cfg.clusters);
            set('ro-queryEngines', ss.queryEngines ? ss.queryEngines.join(', ') : '');
            const clfDetail = cfg.consoleLogFilter || {};
            set('ro-consoleLogFilter', JSON.stringify({
                mode: clfDetail.mode,
                levels: clfDetail.levels,
                keywords: clfDetail.keywords,
                regexPatterns: clfDetail.regexPatterns
            }));
            set('ro-webhook', JSON.stringify(cfg.webhook || {}));
        }

        // ===== 保存全局配置 =====
        async function saveConfig() {
            const get = id => {
                const el = document.getElementById(id);
                return el ? el.value : undefined;
            };
            const getCheck = id => {
                const el = document.getElementById(id);
                return el ? el.checked : undefined;
            };

            const payload = {
                baseURL: get('cfg-baseURL'),
                globalTimeout: get('cfg-globalTimeout'),
                headless: getCheck('cfg-headless'),
                ensureStreakProtection: getCheck('cfg-ensureStreakProtection'),
                errorDiagnostics: getCheck('cfg-errorDiagnostics'),
                debugLogs: getCheck('cfg-debugLogs'),
                searchOnBingLocalQueries: getCheck('cfg-searchOnBingLocalQueries'),
                proxy: {
                    queryEngine: getCheck('cfg-proxy-queryEngine')
                },
                consoleLogFilter: {
                    enabled: getCheck('cfg-consoleLogFilter-enabled')
                },
                workers: {
                    doDailySet: getCheck('cfg-workers-doDailySet'),
                    doClaimBonusPoints: getCheck('cfg-workers-doClaimBonusPoints'),
                    doSpecialPromotions: getCheck('cfg-workers-doSpecialPromotions'),
                    doMorePromotions: getCheck('cfg-workers-doMorePromotions'),
                    doPunchCards: getCheck('cfg-workers-doPunchCards'),
                    doAppPromotions: getCheck('cfg-workers-doAppPromotions'),
                    doDesktopSearch: getCheck('cfg-workers-doDesktopSearch'),
                    doMobileSearch: getCheck('cfg-workers-doMobileSearch'),
                    doDailyCheckIn: getCheck('cfg-workers-doDailyCheckIn'),
                    doReadToEarn: getCheck('cfg-workers-doReadToEarn')
                },
                searchSettings: {
                    scrollRandomResults: getCheck('cfg-scrollRandomResults'),
                    clickRandomResults: getCheck('cfg-clickRandomResults'),
                    searchResultVisitTime: get('cfg-searchResultVisitTime'),
                    chinaApi: {
                        appkey: get('cfg-chinaApi-appkey') || ''
                    },
                    searchDelay: {
                        min: get('cfg-searchDelayMin'),
                        max: get('cfg-searchDelayMax')
                    },
                    readDelay: {
                        min: get('cfg-readDelayMin'),
                        max: get('cfg-readDelayMax')
                    }
                }
            };

            const btn = document.querySelector('#panel-settings .bg-blue-600');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '保存中...';
            }

            try {
                const res = await fetch('/api/config', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n备份文件: ${data.backup || 'N/A'}`);
                // 刷新 configCache 回显
                await loadData();
            } catch (error) {
                alert(`❌ 保存失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 打开配置文件 =====
        async function openConfigFile() {
            const btn = document.getElementById('config-open-btn');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '打开中...';
            }

            try {
                const res = await fetch('/api/config/open', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n文件路径: ${data.path || ''}`);
            } catch (error) {
                alert(`❌ 打开失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 重置全局配置为默认 =====
        async function resetConfig() {
            if (!confirm('确定要将所有设置重置为默认值吗？\n此操作将用 config.example.json 覆盖当前 config.json，且不可撤销。')) {
                return;
            }

            const btn = document.querySelector('#panel-settings .bg-red-600');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '重置中...';
            }

            try {
                const res = await fetch('/api/config/reset', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n备份文件: ${data.backup || 'N/A'}`);
                // 刷新 configCache 回显（所有开关恢复默认）
                await loadData();
            } catch (error) {
                alert(`❌ 重置失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 渲染全部 =====
        function renderAll() {
            renderHome();
            renderAccountsPanel();
            renderStats();
            renderSettings();
        }

        // ===== 删除账号 =====
        async function deleteAccount(email) {
            if (!email) return;
            // 二次确认，防止误删
            if (!confirm(`确定要删除账号 ${email} 吗？\n此操作将立即从 accounts 配置中移除，且不可撤销。`)) {
                return;
            }

            try {
                const res = await fetch(`/api/accounts/${encodeURIComponent(email)}`, {
                    method: 'DELETE'
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}`);
                // 刷新面板数据
                await loadData();
            } catch (error) {
                alert(`❌ 删除失败: ${error.message || error}`);
            }
        }

        // ===== 新增账号 =====
        async function submitAddAccount() {
            const emailInput = document.getElementById('add-account-email');
            const passwordInput = document.getElementById('add-account-password');
            const totpInput = document.getElementById('add-account-totp');
            const recoveryInput = document.getElementById('add-account-recovery');
            if (!emailInput || !passwordInput) return;

            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const totpSecret = totpInput ? totpInput.value.trim() : '';
            const recoveryEmail = recoveryInput ? recoveryInput.value.trim() : '';

            // 前端快速校验
            if (!email || !email.includes('@')) {
                alert('❌ 请输入有效的登录邮箱');
                return;
            }
            if (!password) {
                alert('❌ 请输入密码');
                return;
            }

            const btn = document.querySelector('#modal-add-account .bg-blue-600');
            const originalText = btn ? btn.innerText : '';
            if (btn) {
                btn.disabled = true;
                btn.innerText = '添加中...';
            }

            try {
                const res = await fetch('/api/accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email,
                        password,
                        totpSecret,
                        recoveryEmail
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}`);
                closeModal('modal-add-account');
                // 清空表单
                emailInput.value = '';
                passwordInput.value = '';
                if (totpInput) totpInput.value = '';
                if (recoveryInput) recoveryInput.value = '';
                // 刷新面板数据
                await loadData();
            } catch (error) {
                alert(`❌ 添加失败: ${error.message || error}`);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = originalText;
                }
            }
        }

        // ===== 账号设置弹窗 =====
        let currentEditingEmail = null; // 当前正在编辑的账号邮箱

        function applyProxyFieldsVisibility() {
            const enabled = document.getElementById('settings-proxy-enabled');
            const fields = document.getElementById('settings-proxy-fields');
            if (!enabled || !fields) return;
            if (enabled.checked) {
                fields.classList.remove('opacity-50', 'pointer-events-none');
            } else {
                fields.classList.add('opacity-50', 'pointer-events-none');
            }
        }

        function openAccountSettings(email) {
            const acc = (accountsCache.accounts || []).find(a => a.email === email);
            if (!acc) return;
            currentEditingEmail = email;

            const modal = document.getElementById('modal-account-settings');
            const emailLabel = modal.querySelector('.text-xs.text-gray-500');
            if (emailLabel) emailLabel.innerText = acc.email;

            // === 地理与伪装 ===
            // geoLocale: 处理不在固定选项中的国家代码（动态添加）
            const geoSelect = document.getElementById('settings-geoLocale');
            const EXISTING_VALUES = ['auto', 'us', 'gb', 'cn'];
            for (let i = geoSelect.options.length - 1; i >= 0; i--) {
                if (!EXISTING_VALUES.includes(geoSelect.options[i].value)) {
                    geoSelect.remove(i);
                }
            }
            const geoValue = (acc.geoLocale || 'auto').toLowerCase();
            let found = false;
            for (let i = 0; i < geoSelect.options.length; i++) {
                if (geoSelect.options[i].value === geoValue) {
                    geoSelect.selectedIndex = i;
                    found = true;
                    break;
                }
            }
            if (!found) {
                const opt = document.createElement('option');
                opt.value = geoValue;
                opt.textContent = `${geoValue.toUpperCase()} (自定义)`;
                geoSelect.appendChild(opt);
                geoSelect.value = geoValue;
            }

            // langCode
            document.getElementById('settings-langCode').value = acc.langCode || 'zh';

            // 指纹
            const fp = acc.saveFingerprint || { desktop: true, mobile: true };
            document.getElementById('settings-fp-desktop').checked = Boolean(fp.desktop);
            document.getElementById('settings-fp-mobile').checked = Boolean(fp.mobile);

            // === 网络代理 ===
            const proxy = acc.proxy || { proxyAxios: false, url: '', port: 0, username: '', password: '' };
            document.getElementById('settings-proxy-enabled').checked = Boolean(proxy.proxyAxios);
            document.getElementById('settings-proxy-url').value = proxy.url || '';
            document.getElementById('settings-proxy-port').value = proxy.port || 0;
            document.getElementById('settings-proxy-username').value = proxy.username || '';
            document.getElementById('settings-proxy-password').value = proxy.password || '';
            applyProxyFieldsVisibility();

            openModal('modal-account-settings');
        }

        // ===== 保存账号设置 =====
        async function saveAccountSettings() {
            if (!currentEditingEmail) return;
            const acc = (accountsCache.accounts || []).find(a => a.email === currentEditingEmail);
            if (!acc) return;

            // 从表单收集值
            const proxyEnabled = document.getElementById('settings-proxy-enabled').checked;
            const updatedAccount = {
                // 保留原有核心字段
                email: acc.email,
                password: acc.password,
                totpSecret: acc.totpSecret,      // 未在弹窗中编辑，原样保留
                recoveryEmail: acc.recoveryEmail, // 未在弹窗中编辑，原样保留
                // 表单字段
                geoLocale: document.getElementById('settings-geoLocale').value,
                langCode: document.getElementById('settings-langCode').value || 'zh',
                saveFingerprint: {
                    desktop: document.getElementById('settings-fp-desktop').checked,
                    mobile: document.getElementById('settings-fp-mobile').checked
                },
                proxy: {
                    proxyAxios: proxyEnabled,
                    url: document.getElementById('settings-proxy-url').value || '',
                    port: parseInt(document.getElementById('settings-proxy-port').value, 10) || 0,
                    username: document.getElementById('settings-proxy-username').value || '',
                    password: document.getElementById('settings-proxy-password').value || ''
                }
            };

            // 保存按钮状态反馈
            const saveBtn = document.querySelector('#modal-account-settings .bg-blue-600');
            const originalText = saveBtn.innerText;
            saveBtn.disabled = true;
            saveBtn.innerText = '保存中...';

            try {
                const res = await fetch(`/api/accounts/${encodeURIComponent(currentEditingEmail)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updatedAccount)
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || `HTTP ${res.status}`);
                }
                alert(`✅ ${data.message}\n备份文件: ${data.backup || 'N/A'}`);
                closeModal('modal-account-settings');
                // 刷新数据
                await loadData();
            } catch (error) {
                alert(`❌ 保存失败: ${error.message || error}`);
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerText = originalText;
            }
        }

        // ===== 弹窗 =====
        function openModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.remove('hidden');
                modal.style.opacity = '0';
                setTimeout(() => modal.style.opacity = '1', 10);
            }
        }

        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) {
                modal.classList.add('hidden');
            }
        }

        // ===== 初始化 =====
        document.addEventListener('DOMContentLoaded', () => {
            const navItems = document.querySelectorAll('.nav-item');
            const panels = document.querySelectorAll('.content-panel');
            const currentTabTitle = document.getElementById('currentTabTitle');

            navItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    const targetTab = item.getAttribute('data-tab');

                    navItems.forEach(ni => {
                        ni.classList.remove('bg-blue-50', '!text-blue-700');
                    });
                    item.classList.add('bg-blue-50', '!text-blue-700');

                    panels.forEach(p => p.classList.add('hidden'));
                    document.getElementById(`panel-${targetTab}`).classList.remove('hidden');

                    // 切到统计页时若图表尚未创建（面板刚变为可见），补建一次以触发正确的从 0 生长动画
                    if (targetTab === 'stats' && !statsChart) renderStats();

                    currentTabTitle.innerText = item.innerText.trim();
                });
            });

            // 加载真实数据
            loadData();

            // 初始化时拉取任务状态（若服务端已有子进程在跑则显示运行中）
            pollTaskStatus();

            // 网页长连接保活：通过 EventSource 建立 SSE 长连接。
            // 浏览器对该连接不断开（页面未关闭、仅后台休眠）则进程保持存活；
            // 连接断开（页面真正关闭/刷新/跳转）时服务端立即退出进程。
            // 相比定时 fetch 心跳，SSE 长连接不受后台标签页定时器节流影响。
            const keepaliveSource = new EventSource('/api/keepalive');
            keepaliveSource.onerror = () => {
                // 服务端退出后连接错误属预期，忽略以免刷 console
            };

            // 关闭/刷新页面前弹出浏览器默认的离开确认框，防止误触导致后台进程退出
            window.addEventListener('beforeunload', (event) => {
                event.preventDefault();
                event.returnValue = ''; // 触发浏览器默认的离开确认弹窗
            });

            // 每 5 秒轮询任务状态（子进程日志实时更新）
            setInterval(pollTaskStatus, 5000);

            // 每 30 秒自动刷新面板数据（日志会持续写入）
            setInterval(loadData, 30000);
        });