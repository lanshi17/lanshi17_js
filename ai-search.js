// ==UserScript==
// @name         Google 搜索 AI 翻译增强-MT版
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  自动将中文搜索翻译成英文搜索，修复重复翻译/流程错误，支持通义千问 DashScope API，可拖动设置按钮
// @author       lanshi17
// @match        https://www.google.com/search?*
// @match        https://www.google.com.hk/search?*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置管理 ---
    const DEFAULT_CONFIG = {
        apiKey: '',
        buttonPosition: { x: 50, y: 0 }
    };
    
    let CURRENT_CONFIG = loadConfig();
    let isProcessing = false;
    let dragState = { isDragging: false, offsetX: 0, offsetY: 0 };
    
    function loadConfig() {
        return {
            apiKey: GM_getValue('aiApiKey', DEFAULT_CONFIG.apiKey),
            buttonPosition: GM_getValue('buttonPosition', DEFAULT_CONFIG.buttonPosition)
        };
    }

    function saveConfig(config) {
        GM_setValue('aiApiKey', config.apiKey);
        GM_setValue('buttonPosition', config.buttonPosition);
        CURRENT_CONFIG = config;
    }

    // --- 拖动功能 ---
    function makeDraggable(element) {
        element.style.position = 'absolute';
        element.style.cursor = 'move';
        
        const pos = CURRENT_CONFIG.buttonPosition;
        element.style.left = pos.x + 'px';
        element.style.top = pos.y + 'px';

        element.addEventListener('mousedown', startDrag);
        
        function startDrag(e) {
            e.preventDefault();
            
            dragState.isDragging = true;
            dragState.offsetX = e.clientX - element.getBoundingClientRect().left;
            dragState.offsetY = e.clientY - element.getBoundingClientRect().top;
            
            document.addEventListener('mousemove', dragElement);
            document.addEventListener('mouseup', stopDrag);
            
            element.style.opacity = '0.8';
            element.style.transition = 'none';
        }
        
        function dragElement(e) {
            if (!dragState.isDragging) return;
            
            const newX = e.clientX - dragState.offsetX;
            const newY = e.clientY - dragState.offsetY;
            
            const maxX = window.innerWidth - element.offsetWidth;
            const maxY = window.innerHeight - element.offsetHeight;
            
            const clampedX = Math.max(0, Math.min(newX, maxX));
            const clampedY = Math.max(0, Math.min(newY, maxY));
            
            element.style.left = clampedX + 'px';
            element.style.top = clampedY + 'px';
        }
        
        function stopDrag() {
            dragState.isDragging = false;
            document.removeEventListener('mousemove', dragElement);
            document.removeEventListener('mouseup', stopDrag);
            
            element.style.opacity = '';
            element.style.transition = '';
            
            const rect = element.getBoundingClientRect();
            CURRENT_CONFIG.buttonPosition = {
                x: rect.left,
                y: rect.top
            };
            saveConfig(CURRENT_CONFIG);
        }
    }

    // --- UI 样式 ---
    function injectStyles() {
        GM_addStyle(`
            #ai-config-button-container {
                position: absolute; 
                z-index: 9999; 
                height: 48px;
                display: flex; 
                align-items: center; 
                justify-content: center; 
                margin-top: 5px;
                user-select: none;
            }
            #ai-config-button {
                background: linear-gradient(135deg, #4285F4, #34A853); 
                color: white; 
                border: none; 
                border-radius: 6px;
                padding: 5px 10px; 
                cursor: move; 
                font-size: 14px; 
                line-height: 1.2;
                font-weight: bold; 
                display: flex; 
                flex-direction: column; 
                align-items: center;
                width: 75px; 
                height: 38px; 
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                transition: all 0.2s ease;
                position: relative;
            }
            #ai-config-button:hover {
                background: linear-gradient(135deg, #3367d6, #2d9247);
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0,0,0,0.25);
            }
            #ai-config-button .main-text { 
                font-size: 16px; 
                white-space: nowrap; 
            }
            #ai-config-button .sub-text { 
                font-size: 10px; 
                margin-top: 2px; 
            }
            #ai-config-button .drag-handle {
                position: absolute;
                top: -4px;
                right: -4px;
                width: 12px;
                height: 12px;
                background: #4285F4;
                border-radius: 50%;
                opacity: 0.6;
            }
            #ai-config-modal {
                position: fixed; 
                top: 50%; 
                left: 50%; 
                transform: translate(-50%, -50%);
                background: white; 
                border: 1px solid #ddd; 
                padding: 25px;
                border-radius: 12px; 
                display: none; 
                width: 400px; 
                z-index: 10001;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
                backdrop-filter: blur(10px);
            }
            #ai-config-modal h2 {
                margin-top: 0;
                color: #202124;
                border-bottom: 2px solid #4285F4;
                padding-bottom: 15px;
                font-size: 24px;
                font-weight: 600;
            }
            .config-section {
                margin-bottom: 20px;
                padding: 15px;
                background: #f8f9fa;
                border-radius: 8px;
            }
            .config-row {
                display: flex;
                align-items: center;
                margin: 12px 0;
            }
            .config-label {
                min-width: 100px;
                font-weight: 500;
                color: #5f6368;
            }
            .config-input {
                flex: 1;
                padding: 10px 12px;
                border: 1px solid #dfe1e5;
                border-radius: 4px;
                font-size: 14px;
                transition: all 0.2s;
            }
            .config-input:focus {
                outline: none;
                border-color: #4285F4;
                box-shadow: 0 0 0 2px rgba(66, 133, 244, 0.2);
            }
            #ai-config-modal .config-buttons {
                text-align: right;
                margin-top: 25px;
                padding-top: 20px;
                border-top: 1px solid #eee;
            }
            #ai-config-modal button {
                padding: 10px 20px;
                margin-left: 10px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.2s;
            }
            #ai-config-modal .save { 
                background: linear-gradient(135deg, #34A853, #188038); 
                color: white; 
            }
            #ai-config-modal .save:hover {
                background: linear-gradient(135deg, #2d9247, #136b2d);
                transform: translateY(-1px);
            }
            #ai-config-modal .close { 
                background: linear-gradient(135deg, #EA4335, #D93025); 
                color: white; 
            }
            #ai-config-modal .close:hover {
                background: linear-gradient(135deg, #d32f2f, #c5221f);
                transform: translateY(-1px);
            }
            #ai-config-modal .reset {
                background: linear-gradient(135deg, #fbbc04, #F29900);
                color: white;
            }
            #ai-config-modal .reset:hover {
                background: linear-gradient(135deg, #eaa002, #E08600);
                transform: translateY(-1px);
            }
            .info-icon {
                margin-left: 5px;
                color: #5f6368;
                font-size: 12px;
                cursor: help;
            }
        `);
    }

    // --- 设置界面 ---
    function createSettingsUI() {
        injectStyles();
        
        const configContainer = document.createElement('div');
        configContainer.id = 'ai-config-button-container';
        configContainer.innerHTML = `
            <button id="ai-config-button">
                <span class="main-text">🤖 AI 配</span>
                <span class="sub-text">置</span>
                <div class="drag-handle"></div>
            </button>
        `;

        const topBar = document.querySelector('#gb, [role="banner"], header, nav') || document.body;
        topBar.appendChild(configContainer);

        makeDraggable(configContainer);

        const modal = document.createElement('div');
        modal.id = 'ai-config-modal';
        modal.innerHTML = `
            <h2>🤖 说明</h2>
            
            <div class="config-section">
                <p style="color: #5f6368; line-height: 1.6;">
                    <strong>功能已暂停</strong><br><br>
                    由于阿里云DashScope API存在网络访问限制，在浏览器环境中无法直接调用API进行翻译。<br><br>
                    建议使用Google翻译或其他浏览器翻译扩展来实现网页翻译功能。<br><br>
                    如需使用AI翻译功能，建议使用桌面应用或服务端解决方案。
                </p>
            </div>
            
            <div style="text-align: center; margin-top: 10px; color: #5f6368; font-size: 14px;">
                该脚本仅保留配置界面供参考
            </div>
            
            <div class="config-buttons">
                <button class="reset">重置位置</button>
                <button class="close">关闭</button>
            </div>
        `;
        document.body.appendChild(modal);

        document.getElementById("ai-config-button").addEventListener('click', function(e) {
            if (dragState.isDragging) return;
            document.getElementById('ai-config-modal').style.display = "block";
        });
        
        document.querySelector('#ai-config-modal .close').onclick = () => {
            document.getElementById('ai-config-modal').style.display = "none";
        };
        
        document.querySelector('#ai-config-modal .reset').onclick = resetToDefault;
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.getElementById('ai-config-modal').style.display === 'block') {
                document.getElementById('ai-config-modal').style.display = 'none';
            }
        });
    }

    function resetToDefault() {
        if (confirm('确定要重置按钮位置为默认值吗？')) {
            saveConfig(Object.assign({}, CURRENT_CONFIG, {
                buttonPosition: DEFAULT_CONFIG.buttonPosition
            }));
            const buttonContainer = document.getElementById('ai-config-button-container');
            if (buttonContainer) {
                buttonContainer.style.left = DEFAULT_CONFIG.buttonPosition.x + 'px';
                buttonContainer.style.top = DEFAULT_CONFIG.buttonPosition.y + 'px';
                CURRENT_CONFIG.buttonPosition = DEFAULT_CONFIG.buttonPosition;
            }
            alert('按钮位置已重置');
        }
    }

    // --- 主处理逻辑 ---
    async function processSearch() {
        // 什么都不做 - 已经知道API无法工作
        console.log('AI翻译功能已暂停：由于浏览器环境限制无法调用API');
        return;
    }

    // --- 初始化 ---
    function init() {
        createSettingsUI();
        
        // 检查是否已配置
        if (!CURRENT_CONFIG.apiKey) {
            console.log('AI翻译功能已暂停使用说明');
        }
        
        // 即使没有API，也保留页面监控以便将来可能的恢复
        let currentUrl = location.href;
        setInterval(() => {
            if (location.href !== currentUrl) {
                currentUrl = location.href;
                console.log('页面URL变化检测');
                // 不执行任何翻译操作
            }
        }, 500);
    }

    init();

})();
