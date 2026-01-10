class TerminalManager {
    constructor() {
        this.tabs = [];
        this.activeTabId = null;
        this.tabCounter = 0;
        this.modifierKeys = { Control: false, Alt: false, Shift: false };
        this.theme = localStorage.getItem('theme') || 'dark';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.init();
    }

    init() {
        this.applyTheme();
        this.setupEventListeners();
        this.setupKeyboardShortcuts();
        this.createTab();
        this.detectMobile();
        this.loadSettings();
    }

    // ========== 设置管理 ==========
    loadSettings() {
        const cursorBlink = localStorage.getItem('cursorBlink') !== 'false';
        const bellEnabled = localStorage.getItem('bellEnabled') !== 'false';
        
        document.getElementById('cursor-blink').checked = cursorBlink;
        document.getElementById('bell-enabled').checked = bellEnabled;
        document.getElementById('auto-reconnect').checked = localStorage.getItem('autoReconnect') !== 'false';
    }

    // ========== 主题管理 ==========
    applyTheme() {
        document.body.dataset.theme = this.theme;
        document.querySelector('meta[name="theme-color"]').content = 
            this.theme === 'dark' ? '#1c1c1c' : '#ffffff';
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', this.theme);
        this.applyTheme();
        this.tabs.forEach(tab => {
            if (tab.term) {
                tab.term.options.theme = this.getXTermTheme();
            }
        });
        this.showToast('主题已切换', 'success');
    }

    getXTermTheme() {
        return this.theme === 'light' ? this.getLightTheme() : this.getDarkTheme();
    }

    getLightTheme() {
        return {
            background: '#f3f3f3',
            foreground: '#1c1c1c',
            cursor: '#1c1c1c',
            cursorAccent: '#f3f3f3',
            selection: 'rgba(0, 120, 212, 0.3)',
            black: '#1c1c1c',
            red: '#c50f1f',
            green: '#13a10e',
            yellow: '#c19c00',
            blue: '#0037da',
            magenta: '#881798',
            cyan: '#3a96dd',
            white: '#f3f3f3',
            brightBlack: '#616161',
            brightRed: '#e74856',
            brightGreen: '#16c60c',
            brightYellow: '#f9f1a5',
            brightBlue: '#3b78ff',
            brightMagenta: '#b4009e',
            brightCyan: '#61d6d6',
            brightWhite: '#ffffff'
        };
    }

    getDarkTheme() {
        return {
            background: '#1c1c1c',
            foreground: '#e5e5e5',
            cursor: '#ffffff',
            cursorAccent: '#1c1c1c',
            selection: 'rgba(96, 205, 255, 0.3)',
            black: '#0c0c0c',
            red: '#c50f1f',
            green: '#13a10e',
            yellow: '#c19c00',
            blue: '#0037da',
            magenta: '#881798',
            cyan: '#3a96dd',
            white: '#cccccc',
            brightBlack: '#767676',
            brightRed: '#e74856',
            brightGreen: '#16c60c',
            brightYellow: '#f9f1a5',
            brightBlue: '#3b78ff',
            brightMagenta: '#b4009e',
            brightCyan: '#61d6d6',
            brightWhite: '#f2f2f2'
        };
    }

    // ========== 标签页管理 ==========
    createTab(profile = 'bash') {
        const tabId = `tab-${++this.tabCounter}`;
        
        const tab = {
            id: tabId,
            title: profile,
            term: null,
            fitAddon: null,
            searchAddon: null,
            socket: null,
            element: null,
            paneElement: null,
            sessionLog: [],
            isSplitPane: false,
            parentPaneId: null
        };

        this.createTabElement(tab);
        this.createTerminalPane(tab);
        this.initializeXTerm(tab);
        
        this.tabs.push(tab);
        this.switchTab(tabId);
        this.connectWebSocket(tab);

        return tab;
    }

    createTabElement(tab) {
        const tabElement = document.createElement('button');
        tabElement.className = 'tab';
        tabElement.dataset.tabId = tab.id;
        tabElement.innerHTML = `
            <div class="tab-curve-left"></div>
            <div class="tab-bg"></div>
            <div class="tab-curve-right"></div>
            <span class="tab-title">${tab.title}</span>
            <button class="tab-close">
                <svg viewBox="0 0 12 12" fill="currentColor">
                    <path d="M3 3l6 6m0-6l-6 6" stroke="currentColor" stroke-width="1.5" fill="none"/>
                </svg>
            </button>
        `;

        tabElement.addEventListener('click', (e) => {
            if (!e.target.closest('.tab-close')) {
                this.switchTab(tab.id);
            }
        });

        const closeBtn = tabElement.querySelector('.tab-close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
        });

        tab.element = tabElement;
        document.getElementById('tab-list').appendChild(tabElement);
    }

    createTerminalPane(tab) {
        const paneElement = document.createElement('div');
        paneElement.className = 'terminal-pane';
        paneElement.dataset.tabId = tab.id;
        paneElement.style.display = 'none';

        const wrapperElement = document.createElement('div');
        wrapperElement.className = 'terminal-wrapper';
        paneElement.appendChild(wrapperElement);

        tab.paneElement = paneElement;
        tab.wrapperElement = wrapperElement;
        
        document.getElementById('terminal-container').appendChild(paneElement);
    }

    initializeXTerm(tab) {
        const term = new Terminal({
            fontSize: parseInt(localStorage.getItem('fontSize')) || 16,
            fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
            cursorBlink: localStorage.getItem('cursorBlink') !== 'false',
            cursorStyle: localStorage.getItem('cursorStyle') || 'bar',
            theme: this.getXTermTheme(),
            allowTransparency: false,
            scrollback: parseInt(localStorage.getItem('scrollback')) || 10000,
            tabStopWidth: 4,
            bellSound: localStorage.getItem('bellEnabled') !== 'false' ? 
                'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==' : null
        });

        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        const searchAddon = new SearchAddon.SearchAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.loadAddon(searchAddon);
        term.open(tab.wrapperElement);

        // 设置终端事件监听
        this.setupTerminalEvents(tab, term);

        tab.term = term;
        tab.fitAddon = fitAddon;
        tab.searchAddon = searchAddon;
    }

    setupTerminalEvents(tab, term) {
        // 会话日志记录
        term.onData(data => {
            tab.sessionLog.push({ type: 'input', data, time: Date.now() });
        });
        
        // 标题变化
        term.onTitleChange((title) => {
            if (title && title.trim()) {
                tab.title = title.trim();
                this.updateTabTitle(tab);
            }
        });

        // 自定义键盘事件处理（修复Ctrl+Shift+?问题）
        term.attachCustomKeyEventHandler((e) => {
            // 只在需要拦截的快捷键上处理
            const isCtrl = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;
            const key = e.key;

            // 拦截Ctrl+Shift组合的快捷键
            if (isCtrl && isShift) {
                switch (key.toLowerCase()) {
                    case 'c': // 复制
                    case 'v': // 粘贴
                    case 'a': // 全选
                    case 'f': // 搜索
                    case 't': // 新建标签
                    case 'w': // 关闭标签
                    case 'd': // 水平拆分
                    case 'e': // 垂直拆分
                    case 'q': // 关闭窗格
                    case 'r': // 重置终端
                    case 's': // 保存会话
                    case '?': // 帮助
                        e.preventDefault();
                        return false;
                }
            }

            // F11全屏和F5刷新
            if (key === 'F11' || key === 'F5') {
                e.preventDefault();
                return false;
            }

            return true; // 允许其他所有按键
        });
    }

    switchTab(tabId) {
        // 隐藏所有窗格
        this.tabs.forEach(tab => {
            tab.element.classList.remove('active');
            tab.paneElement.style.display = 'none';
        });

        // 显示目标标签
        const targetTab = this.getTab(tabId);
        if (targetTab) {
            targetTab.element.classList.add('active');
            targetTab.paneElement.style.display = 'flex';
            this.activeTabId = tabId;
            
            // 更新页面标题
            this.updateTabTitle(targetTab);
            
            // 聚焦终端
            setTimeout(() => {
                targetTab.fitAddon.fit();
                this.updateTerminalSize(targetTab);
                this.updateStatusBar(targetTab);
                targetTab.term.focus();
            }, 50);
        }
    }

    closeTab(tabId) {
        const tabIndex = this.tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const tab = this.tabs[tabIndex];
        
        // 处理拆分窗格逻辑
        this.handleSplitPaneCleanup(tab);
        
        // 断开连接
        if (tab.socket) {
            tab.socket.close();
        }
        
        // 移除DOM元素
        if (tab.element.parentNode) {
            tab.element.parentNode.removeChild(tab.element);
        }
        
        if (tab.paneElement.parentNode) {
            tab.paneElement.parentNode.removeChild(tab.paneElement);
        }
        
        // 从数组中移除
        this.tabs.splice(tabIndex, 1);
        
        // 如果关闭的是活动标签，切换到其他标签
        if (this.activeTabId === tabId) {
            if (this.tabs.length > 0) {
                const newIndex = Math.min(tabIndex, this.tabs.length - 1);
                this.switchTab(this.tabs[newIndex].id);
            } else {
                this.activeTabId = null;
                this.createTab(); // 如果没有标签了，创建一个新标签
            }
        }
        
        // 调整剩余终端大小
        setTimeout(() => {
            this.tabs.forEach(t => {
                t.fitAddon.fit();
                this.updateTerminalSize(t);
            });
        }, 100);
    }

    handleSplitPaneCleanup(tab) {
        // 如果这是拆分窗格，清理相关元素
        if (tab.isSplitPane) {
            const container = document.getElementById('terminal-container');
            const pane = tab.paneElement;
            
            // 查找并移除相邻的分隔器
            if (pane.previousElementSibling && 
                pane.previousElementSibling.classList.contains('pane-divider')) {
                container.removeChild(pane.previousElementSibling);
            } else if (pane.nextElementSibling && 
                       pane.nextElementSibling.classList.contains('pane-divider')) {
                container.removeChild(pane.nextElementSibling);
            }
            
            // 重置容器方向（如果只剩一个窗格）
            const remainingPanes = container.querySelectorAll('.terminal-pane');
            if (remainingPanes.length <= 2) { // 当前窗格将被移除，所以检查 <=2
                container.style.flexDirection = '';
            }
            
            // 如果有关联的父窗格，清除其拆分标记
            if (tab.parentPaneId) {
                const parentTab = this.getTab(tab.parentPaneId);
                if (parentTab) {
                    parentTab.isSplitPane = false;
                    parentTab.parentPaneId = null;
                }
            }
        }
    }

    getTab(tabId) {
        return this.tabs.find(t => t.id === tabId);
    }

    getActiveTab() {
        return this.getTab(this.activeTabId);
    }

    // ========== 窗格管理 ==========
    splitPane(direction = 'horizontal') {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        // 标记当前标签为拆分状态
        activeTab.isSplitPane = true;
        
        // 创建新标签
        const newTab = this.createTab();
        newTab.isSplitPane = true;
        newTab.parentPaneId = activeTab.id;
        
        // 设置容器方向
        const container = document.getElementById('terminal-container');
        container.style.flexDirection = direction === 'vertical' ? 'column' : 'row';
        
        // 创建分隔器
        const divider = document.createElement('div');
        divider.className = `pane-divider ${direction === 'vertical' ? 'vertical' : ''}`;
        
        // 将分隔器和新窗格插入到容器中
        const activePane = activeTab.paneElement;
        container.insertBefore(divider, activePane.nextSibling);
        container.insertBefore(newTab.paneElement, divider.nextSibling);
        
        // 设置拖拽调整大小
        this.setupPaneDivider(divider, direction);
        
        // 显示两个窗格
        activeTab.paneElement.style.display = 'flex';
        newTab.paneElement.style.display = 'flex';
        
        // 调整终端大小
        setTimeout(() => {
            activeTab.fitAddon.fit();
            newTab.fitAddon.fit();
            this.updateTerminalSize(activeTab);
            this.updateTerminalSize(newTab);
        }, 100);
        
        this.showToast('窗格已拆分', 'success');
    }

    closePane() {
        const container = document.getElementById('terminal-container');
        const panes = container.querySelectorAll('.terminal-pane');
        
        if (panes.length <= 1) {
            this.showToast('无法关闭最后一个窗格', 'warning');
            return;
        }
        
        const activeTab = this.getActiveTab();
        if (!activeTab) return;
        
        // 关闭当前活动标签（这会自动清理拆分状态）
        this.closeTab(activeTab.id);
        
        this.showToast('窗格已关闭', 'success');
    }

    setupPaneDivider(divider, direction) {
        let isDragging = false;
        let startPos = 0;
        let startSize = 0;

        divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            startPos = direction === 'horizontal' ? e.clientX : e.clientY;
            const prevPane = divider.previousElementSibling;
            startSize = direction === 'horizontal' ? 
                prevPane.offsetWidth : prevPane.offsetHeight;
            divider.classList.add('dragging');
            e.preventDefault();
        });

        const mouseMoveHandler = (e) => {
            if (!isDragging) return;
            
            const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
            const diff = currentPos - startPos;
            const prevPane = divider.previousElementSibling;
            const newSize = Math.max(100, startSize + diff);
            
            if (direction === 'horizontal') {
                prevPane.style.width = `${newSize}px`;
            } else {
                prevPane.style.height = `${newSize}px`;
            }
        };

        const mouseUpHandler = () => {
            if (isDragging) {
                isDragging = false;
                divider.classList.remove('dragging');
                
                // 重新调整终端大小
                this.tabs.forEach(tab => {
                    tab.fitAddon.fit();
                    this.updateTerminalSize(tab);
                });
            }
        };

        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
        
        // 清理事件监听器
        divider.addEventListener('mouseleave', () => {
            if (isDragging) {
                mouseUpHandler();
            }
        });
    }

    // ========== WebSocket连接 ==========
    connectWebSocket(tab) {
        if (tab.socket) {
            tab.socket.close();
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const socketUrl = `${protocol}//${host}/ws`;

        tab.socket = new WebSocket(socketUrl);
        tab.socket.binaryType = 'arraybuffer';

        tab.socket.onopen = () => {
            this.reconnectAttempts = 0;
            this.updateTerminalSize(tab);
            this.updateConnectionStatus(true);
            
            if (tab.term._initialized) {
                tab.term.reset();
                tab.term.focus();
            }
            tab.term._initialized = true;

            // 设置事件监听器
            if (!tab._eventsSetup) {
                tab.term.onData(data => {
                    if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
                        const binaryData = new TextEncoder().encode(data);
                        tab.socket.send(binaryData);
                    }
                });

                tab.socket.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) {
                        const data = new Uint8Array(event.data);
                        const dataStr = new TextDecoder().decode(data);
                        
                        // 提取标题
                        if (dataStr.includes('\x1b]0;') || dataStr.includes('\x1b]2;')) {
                            const titleMatch = dataStr.match(/\x1b\][02];([^\x07]*)\x07/);
                            if (titleMatch && titleMatch[1]) {
                                tab.term.title = titleMatch[1];
                                setTimeout(() => {
                                    this.updateTabTitle(tab);
                                }, 50);
                            }
                        }
                        
                        tab.term.write(data);
                        tab.sessionLog.push({ type: 'output', data, time: Date.now() });
                    }
                };

                tab._eventsSetup = true;
            }
        };

        tab.socket.onclose = () => {
            this.updateConnectionStatus(false);
            
            if (localStorage.getItem('autoReconnect') !== 'false' && 
                this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                setTimeout(() => {
                    if (this.getTab(tab.id)) {
                        this.showToast(`正在重连... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warning');
                        this.connectWebSocket(tab);
                    }
                }, this.reconnectDelay);
            }
        };

        tab.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showToast('连接错误', 'error');
        };
    }

    updateTerminalSize(tab) {
        if (tab.socket && tab.socket.readyState === WebSocket.OPEN) {
            tab.socket.send(JSON.stringify({ 
                col: tab.term.cols, 
                row: tab.term.rows 
            }));
        }
    }

    // ========== 状态和标题更新 ==========
    updateStatusBar(tab) {
        document.getElementById('terminal-info').textContent = 
            `${tab.term.cols}×${tab.term.rows}`;
    }

    updateTabTitle(tab) {
        if (!tab) return;
        
        const title = tab.term.title || tab.title || 'Terminal';
        tab.element.querySelector('.tab-title').textContent = title;
        
        if (tab.id === this.activeTabId) {
            document.title = `${title} - cnoterm`;
        }
    }

    updateConnectionStatus(connected) {
        const statusDot = document.querySelector('#connection-status .status-dot');
        const statusText = document.querySelector('#connection-status span:last-child');
        
        if (connected) {
            statusDot.classList.add('connected');
            statusText.textContent = '已连接';
        } else {
            statusDot.classList.remove('connected');
            statusText.textContent = '未连接';
        }
    }

    // ========== 搜索功能 ==========
    openSearch() {
        const searchPanel = document.getElementById('search-panel');
        searchPanel.classList.add('open');
        document.getElementById('search-input').focus();
    }

    closeSearch() {
        const searchPanel = document.getElementById('search-panel');
        searchPanel.classList.remove('open');
    }

    performSearch(direction = 1) {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        const query = document.getElementById('search-input').value;
        if (!query) return;

        const options = {
            caseSensitive: document.getElementById('search-case').checked,
            regex: document.getElementById('search-regex').checked,
            wholeWord: document.getElementById('search-whole').checked,
            decorations: {
                matchBackground: 'rgba(255, 255, 0, 0.3)',
                matchBorder: '1px solid yellow',
                matchOverviewRuler: 'yellow',
                activeMatchBackground: 'rgba(255, 165, 0, 0.5)',
                activeMatchBorder: '1px solid orange'
            }
        };

        if (direction > 0) {
            activeTab.searchAddon.findNext(query, options);
        } else {
            activeTab.searchAddon.findPrevious(query, options);
        }
    }

    // ========== 会话日志 ==========
    exportSessionLog() {
        const activeTab = this.getActiveTab();
        if (!activeTab) return;

        const log = activeTab.sessionLog.map(entry => {
            try {
                let text = '';
                if (entry.data instanceof Uint8Array || entry.data instanceof ArrayBuffer) {
                    const decoder = new TextDecoder();
                    text = decoder.decode(entry.data);
                } else if (typeof entry.data === 'string') {
                    text = entry.data;
                } else {
                    text = String(entry.data);
                }
                return `[${new Date(entry.time).toISOString()}] ${entry.type}: ${text}`;
            } catch (e) {
                return `[${new Date(entry.time).toISOString()}] ${entry.type}: [解码错误]`;
            }
        }).join('\n');

        const blob = new Blob([log], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `terminal-session-${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);

        this.showToast('会话日志已导出', 'success');
    }

    // ========== 通知系统 ==========
    showToast(message, type = 'info', duration = 3000) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        
        setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }

    // ========== 全屏功能 ==========
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }

    // ========== 事件监听器设置 ==========
    setupEventListeners() {
        // 工具栏按钮
        this.setupToolbarEvents();
        
        // 设置面板
        this.setupSettingsEvents();
        
        // 搜索面板
        this.setupSearchEvents();
        
        // 窗口调整
        this.setupWindowEvents();
        
        // 右键菜单
        this.setupContextMenu();
        
        // 移动端工具栏
        this.setupMobileToolbar();
    }

    setupToolbarEvents() {
        document.getElementById('new-tab-btn').addEventListener('click', () => {
            this.createTab();
        });

        document.getElementById('theme-btn').addEventListener('click', () => {
            this.toggleTheme();
        });

        document.getElementById('split-btn').addEventListener('click', () => {
            this.splitPane('horizontal');
        });

        document.getElementById('fullscreen-btn').addEventListener('click', () => {
            this.toggleFullscreen();
        });

        document.getElementById('search-btn').addEventListener('click', () => {
            this.openSearch();
        });

        document.getElementById('settings-btn').addEventListener('click', () => {
            document.getElementById('settings-panel').classList.toggle('open');
        });

        document.getElementById('help-btn').addEventListener('click', () => {
            document.getElementById('shortcuts-dialog').classList.add('open');
        });
    }

    setupSettingsEvents() {
        const settingsPanel = document.getElementById('settings-panel');
        document.getElementById('close-settings').addEventListener('click', () => {
            settingsPanel.classList.remove('open');
        });

        // 字体大小
        document.getElementById('font-size-select').addEventListener('change', (e) => {
            const fontSize = parseInt(e.target.value);
            localStorage.setItem('fontSize', fontSize);
            this.tabs.forEach(tab => {
                tab.term.options.fontSize = fontSize;
                setTimeout(() => tab.fitAddon.fit(), 50);
            });
        });

        // 光标样式
        document.getElementById('cursor-style-select').addEventListener('change', (e) => {
            const style = e.target.value;
            localStorage.setItem('cursorStyle', style);
            this.tabs.forEach(tab => tab.term.options.cursorStyle = style);
        });

        // 光标闪烁
        document.getElementById('cursor-blink').addEventListener('change', (e) => {
            const blink = e.target.checked;
            localStorage.setItem('cursorBlink', blink);
            this.tabs.forEach(tab => tab.term.options.cursorBlink = blink);
        });

        // 滚动缓冲区
        document.getElementById('scrollback-select').addEventListener('change', (e) => {
            const scrollback = parseInt(e.target.value);
            localStorage.setItem('scrollback', scrollback);
            this.tabs.forEach(tab => tab.term.options.scrollback = scrollback);
        });

        // 铃声
        document.getElementById('bell-enabled').addEventListener('change', (e) => {
            localStorage.setItem('bellEnabled', e.target.checked);
        });

        // 自动重连
        document.getElementById('auto-reconnect').addEventListener('change', (e) => {
            localStorage.setItem('autoReconnect', e.target.checked);
        });

        // 导出日志
        document.getElementById('export-btn').addEventListener('click', () => {
            this.exportSessionLog();
        });

        // 清除存储
        document.getElementById('clear-storage-btn').addEventListener('click', () => {
            if (confirm('确定要清除所有本地存储吗？')) {
                localStorage.clear();
                this.showToast('本地存储已清除', 'success');
            }
        });
    }

    setupSearchEvents() {
        document.getElementById('close-search').addEventListener('click', () => {
            this.closeSearch();
        });

        document.getElementById('search-next').addEventListener('click', () => {
            this.performSearch(1);
        });

        document.getElementById('search-prev').addEventListener('click', () => {
            this.performSearch(-1);
        });

        document.getElementById('search-input').addEventListener('input', () => {
            this.performSearch(1);
        });
    }

    setupWindowEvents() {
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.tabs.forEach(tab => {
                    tab.fitAddon.fit();
                    this.updateTerminalSize(tab);
                });
            }, 100);
        });
    }

    setupContextMenu() {
        const contextMenu = document.getElementById('context-menu');
        const terminalContainer = document.getElementById('terminal-container');

        terminalContainer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            contextMenu.style.display = 'block';
            contextMenu.style.left = Math.min(e.pageX, window.innerWidth - 240) + 'px';
            contextMenu.style.top = Math.min(e.pageY, window.innerHeight - 200) + 'px';
        });

        document.addEventListener('click', () => {
            contextMenu.style.display = 'none';
        });

        contextMenu.addEventListener('click', async (e) => {
            const item = e.target.closest('.context-item');
            if (!item) return;

            const action = item.dataset.action;
            const activeTab = this.getActiveTab();
            if (!activeTab) return;

            switch (action) {
                case 'copy':
                    const selection = activeTab.term.getSelection();
                    if (selection) {
                        await navigator.clipboard.writeText(selection);
                        this.showToast('已复制', 'success');
                    }
                    break;
                case 'paste':
                    try {
                        const text = await navigator.clipboard.readText();
                        activeTab.term.paste(text);
                    } catch (err) {
                        console.error('Paste error:', err);
                    }
                    break;
                case 'select-all':
                    activeTab.term.selectAll();
                    break;
                case 'search':
                    this.openSearch();
                    break;
                case 'split-horizontal':
                    this.splitPane('horizontal');
                    break;
                case 'split-vertical':
                    this.splitPane('vertical');
                    break;
                case 'close-pane':
                    this.closePane();
                    break;
                case 'reset':
                    activeTab.term.reset();
                    this.showToast('终端已重置', 'success');
                    break;
                case 'save-session':
                    this.exportSessionLog();
                    break;
                case 'clear':
                    activeTab.term.clear();
                    break;
                case 'new-tab':
                    this.createTab();
                    break;
                case 'close-tab':
                    if (this.tabs.length > 1) {
                        this.closeTab(this.activeTabId);
                    }
                    break;
            }
        });
    }

    // ========== 键盘快捷键 ==========
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', async (e) => {
            const activeTab = this.getActiveTab();
            if (!activeTab) return;

            const isCtrl = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;
            const key = e.key.toLowerCase();

            // Ctrl+Shift快捷键
            if (isCtrl && isShift) {
                switch (key) {
                    case 'c': // 复制
                        e.preventDefault();
                        const selection = activeTab.term.getSelection();
                        if (selection) {
                            await navigator.clipboard.writeText(selection);
                            this.showToast('已复制', 'success');
                        }
                        break;
                    case 'v': // 粘贴
                        e.preventDefault();
                        try {
                            const text = await navigator.clipboard.readText();
                            activeTab.term.paste(text);
                        } catch (err) {
                            console.error('Paste error:', err);
                        }
                        break;
                    case 'a': // 全选
                        e.preventDefault();
                        activeTab.term.selectAll();
                        break;
                    case 'f': // 搜索
                        e.preventDefault();
                        this.openSearch();
                        break;
                    case 't': // 新建标签
                        e.preventDefault();
                        this.createTab();
                        break;
                    case 'w': // 关闭标签
                        e.preventDefault();
                        if (this.tabs.length > 1) {
                            this.closeTab(this.activeTabId);
                        }
                        break;
                    case 'd': // 水平拆分
                        e.preventDefault();
                        this.splitPane('horizontal');
                        break;
                    case 'e': // 垂直拆分
                        e.preventDefault();
                        this.splitPane('vertical');
                        break;
                    case 'q': // 关闭窗格
                        e.preventDefault();
                        this.closePane();
                        break;
                    case 'r': // 重置终端
                        e.preventDefault();
                        activeTab.term.reset();
                        this.showToast('终端已重置', 'success');
                        break;
                    case 's': // 保存会话
                        e.preventDefault();
                        this.exportSessionLog();
                        break;
                    case '?': // 帮助
                        e.preventDefault();
                        document.getElementById('shortcuts-dialog').classList.add('open');
                        break;
                    case 'tab': // 切换标签
                        e.preventDefault();
                        const currentIndex = this.tabs.findIndex(t => t.id === this.activeTabId);
                        const prevIndex = (currentIndex - 1 + this.tabs.length) % this.tabs.length;
                        this.switchTab(this.tabs[prevIndex].id);
                        break;
                }
            }

            // 独立快捷键
            switch (e.key) {
                case 'F11': // 全屏
                    e.preventDefault();
                    this.toggleFullscreen();
                    break;
                case 'F5': // 刷新
                    e.preventDefault();
                    activeTab.term.reset();
                    this.showToast('终端已刷新', 'success');
                    break;
            }
        });

        // 快捷键帮助对话框关闭
        document.querySelector('.dialog-close').addEventListener('click', () => {
            document.getElementById('shortcuts-dialog').classList.remove('open');
        });

        document.getElementById('shortcuts-dialog').addEventListener('click', (e) => {
            if (e.target.id === 'shortcuts-dialog') {
                document.getElementById('shortcuts-dialog').classList.remove('open');
            }
        });
    }

    // ========== 移动端支持 ==========
    detectMobile() {
        if (this.isMobileDevice()) {
            document.getElementById('mobile-toolbar').style.display = 'block';
            setTimeout(() => {
                const input = document.getElementById('toolbar-input');
                if (input) {
                    input.focus();
                }
            }, 500);
        }
    }

    setupMobileToolbar() {
        const toolbar = document.getElementById('mobile-toolbar');
        const buttons = toolbar.querySelectorAll('.toolbar-btn');
        const input = document.getElementById('toolbar-input');
        const sendBtn = document.getElementById('toolbar-send-btn');
        
        // 设置移动端焦点处理
        this.setupMobileFocusHandling();
        
        const sendInputText = () => {
            const text = input.value;
            if (!text) return;
            
            const activeTab = this.getActiveTab();
            if (!activeTab) return;
            
            // 处理修饰键
            if (this.modifierKeys['Control'] || this.modifierKeys['Alt']) {
                for (let i = 0; i < text.length; i++) {
                    const char = text[i];
                    if (this.modifierKeys['Control'] && this.modifierKeys['Alt']) {
                        activeTab.term.write(`\x1b${char}`);
                    } else if (this.modifierKeys['Control']) {
                        if (char >= 'a' && char <= 'z') {
                            activeTab.term.write(String.fromCharCode(char.charCodeAt(0) - 96));
                        } else {
                            activeTab.term.write(char);
                        }
                    } else if (this.modifierKeys['Alt']) {
                        activeTab.term.write(`\x1b${char}`);
                    }
                }
            } else {
                activeTab.term.paste(text);
            }
            
            input.value = '';
            
            // 重置修饰键
            Object.keys(this.modifierKeys).forEach(k => {
                this.modifierKeys[k] = false;
            });
            buttons.forEach(b => {
                if (b.classList.contains('modifier')) {
                    b.classList.remove('active');
                }
            });
        };
        
        sendBtn.addEventListener('click', (e) => {
            e.preventDefault();
            sendInputText();
        });
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendInputText();
            }
        });

        // 工具栏按钮事件
        buttons.forEach(btn => {
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                btn.classList.add('active');
            }, { passive: false });

            btn.addEventListener('touchend', async (e) => {
                e.preventDefault();
                btn.classList.remove('active');
                
                if (btn.classList.contains('modifier')) {
                    const key = btn.dataset.key;
                    this.modifierKeys[key] = !this.modifierKeys[key];
                    btn.classList.toggle('active', this.modifierKeys[key]);
                    return;
                }
                
                const activeTab = this.getActiveTab();
                if (!activeTab) return;

                const action = btn.dataset.action;
                const key = btn.dataset.key;
                const char = btn.dataset.char;

                if (action === 'paste') {
                    try {
                        const text = await navigator.clipboard.readText();
                        activeTab.term.paste(text);
                    } catch (err) {
                        console.error('Paste error:', err);
                    }
                    return;
                }

                if (key) {
                    this.sendKey(activeTab.term, key);
                } else if (char) {
                    if (this.modifierKeys['Control'] || this.modifierKeys['Alt']) {
                        this.sendKey(activeTab.term, char);
                    } else {
                        activeTab.term.paste(char);
                    }
                }

                // 重置修饰键
                if (!btn.classList.contains('modifier')) {
                    Object.keys(this.modifierKeys).forEach(k => {
                        this.modifierKeys[k] = false;
                    });
                    buttons.forEach(b => {
                        if (b.classList.contains('modifier')) {
                            b.classList.remove('active');
                        }
                    });
                }
            });
        });
    }

    sendKey(term, key) {
        const hasCtrl = this.modifierKeys['Control'];
        const hasAlt = this.modifierKeys['Alt'];
        let sequence = '';
        
        if (hasCtrl && hasAlt) {
            switch(key) {
                case 'ArrowUp': sequence = '\x1b[1;9A'; break;
                case 'ArrowDown': sequence = '\x1b[1;9B'; break;
                case 'ArrowRight': sequence = '\x1b[1;9C'; break;
                case 'ArrowLeft': sequence = '\x1b[1;9D'; break;
                case 'Tab': sequence = '\x1b[1;9I'; break;
                default:
                    if (key.length === 1) {
                        sequence = `\x1b${key}`;
                    }
                    break;
            }
        } else if (hasCtrl) {
            switch(key) {
                case 'ArrowUp': sequence = '\x1b[1;5A'; break;
                case 'ArrowDown': sequence = '\x1b[1;5B'; break;
                case 'ArrowRight': sequence = '\x1b[1;5C'; break;
                case 'ArrowLeft': sequence = '\x1b[1;5D'; break;
                case 'Tab': sequence = '\x1b[1;5I'; break;
                default:
                    if (key.length === 1) {
                        const code = key.charCodeAt(0);
                        if (code >= 97 && code <= 122) {
                            sequence = String.fromCharCode(code - 96);
                        } else if (code >= 64 && code <= 95) {
                            sequence = String.fromCharCode(code - 64);
                        }
                    }
                    break;
            }
        } else if (hasAlt) {
            switch(key) {
                case 'ArrowUp': sequence = '\x1b[1;3A'; break;
                case 'ArrowDown': sequence = '\x1b[1;3B'; break;
                case 'ArrowRight': sequence = '\x1b[1;3C'; break;
                case 'ArrowLeft': sequence = '\x1b[1;3D'; break;
                case 'Tab': sequence = '\x1b[1;3I'; break;
                default:
                    if (key.length === 1) {
                        sequence = `\x1b${key}`;
                    }
                    break;
            }
        } else {
            switch(key) {
                case 'Escape': sequence = '\x1b'; break;
                case 'Tab': sequence = '\t'; break;
                case 'ArrowUp': sequence = '\x1b[A'; break;
                case 'ArrowDown': sequence = '\x1b[B'; break;
                case 'ArrowRight': sequence = '\x1b[C'; break;
                case 'ArrowLeft': sequence = '\x1b[D'; break;
                default: sequence = key; break;
            }
        }
        
        if (sequence) {
            term.paste(sequence);
        }
    }

    setupMobileFocusHandling() {
        const input = document.getElementById('toolbar-input');
        const toolbar = document.getElementById('mobile-toolbar');
        
        // 监听键盘事件，当按下Ctrl键时，将焦点转移到输入框
        document.addEventListener('keydown', (e) => {
            // 只在移动设备上处理此功能
            if (!this.isMobileDevice()) {
                return;
            }
            
            // 如果焦点已经在输入框中，不需要处理
            if (document.activeElement === input) {
                return;
            }
            
            // 按下Ctrl键时，将焦点转移到输入框
            if (e.key === 'Control') {
                e.preventDefault();
                input.focus();
                
                // 滚动到工具栏位置，确保输入框可见
                toolbar.scrollIntoView({ behavior: 'smooth', block: 'end' });
                
                // 显示提示
                this.showToast('输入框已激活，现在可以输入组合键（如A对应Ctrl+A）', 'info', 2000);
            }
        });
        
        // 监听输入框的键盘事件
        input.addEventListener('keydown', (e) => {
            // 如果按下的是修饰键，不处理
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
                return;
            }
            
            const activeTab = this.getActiveTab();
            if (!activeTab) return;
            
            // 处理组合键
            if (e.ctrlKey || e.altKey) {
                e.preventDefault();
                this.sendKey(activeTab.term, e.key);
                // 清空输入框
                input.value = '';
                // 焦点返回终端
                activeTab.term.focus();
            } else if (e.key === 'Enter') {
                // 处理普通文本输入
                e.preventDefault();
                const text = input.value;
                if (text) {
                    activeTab.term.paste(text);
                    input.value = '';
                }
                // 焦点返回终端
                activeTab.term.focus();
            } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
                // 处理单个字符输入，作为Ctrl+字符发送
                e.preventDefault();
                this.sendKey(activeTab.term, e.key);
                // 清空输入框
                input.value = '';
                // 焦点返回终端
                activeTab.term.focus();
            }
        });
        
        // 当输入框失去焦点时，清空内容
        input.addEventListener('blur', () => {
            input.value = '';
        });
    }
    
    // 检测是否为移动设备
    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
               window.innerWidth <= 768;
    }
}

// 初始化
const terminalManager = new TerminalManager();