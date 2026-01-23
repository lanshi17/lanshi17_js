// ==UserScript==
// @name         Google 搜索 AI 翻译增强
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  自动将中文搜索翻译成英文搜索，修复重复翻译/流程错误，支持通义千问 DashScope API。
// @author       lanshi17
// @match        https://www.google.com/search?*
// @match        https://www.google.com.hk/search?*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      dashscope.aliyuncs.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置管理 ---
    const DEFAULT_CONFIG = {
        apiKey: '',
        apiEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-mt-flash',
    };
    
    let CURRENT_CONFIG = loadConfig();
    let isProcessing = false; // 防止重复处理
    
    function loadConfig() {
        return {
            apiKey: GM_getValue('aiApiKey', DEFAULT_CONFIG.apiKey),
            apiEndpoint: GM_getValue('aiApiEndpoint', DEFAULT_CONFIG.apiEndpoint),
            model: GM_getValue('aiModel', DEFAULT_CONFIG.model),
        };
    }

    function saveConfig(config) {
        GM_setValue('aiApiKey', config.apiKey);
        GM_setValue('aiApiEndpoint', config.apiEndpoint);
        GM_setValue('aiModel', config.model);
        CURRENT_CONFIG = config;
    }

    // --- UI 样式 ---
    function injectStyles() {
        GM_addStyle(`
            #ai-config-button-container {
                position: absolute; 
                top: 0; 
                right: 50px; 
                z-index: 9999; 
                height: 48px;
                display: flex; 
                align-items: center; 
                justify-content: center; 
                margin-top: 5px;
            }
            #ai-config-button {
                background: #4285F4; 
                color: white; 
                border: none; 
                border-radius: 6px;
                padding: 5px 10px; 
                cursor: pointer; 
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
            }
            #ai-config-button:hover {
                background: #3367d6;
                transform: translateY(-1px);
            }
            #ai-config-button .main-text { 
                font-size: 16px; 
                white-space: nowrap; 
            }
            #ai-config-button .sub-text { 
                font-size: 10px; 
                margin-top: 2px; 
            }
            #translation-status {
                position: fixed; 
                top: 5px; 
                right: 150px; 
                padding: 8px 12px;
                background: #fff3cd; 
                border: 1px solid #ffeeba; 
                color: #856404;
                border-radius: 4px; 
                z-index: 10000;
                font-size: 14px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                max-width: 300px;
                word-wrap: break-word;
            }
            #ai-config-modal {
                position: fixed; 
                top: 50%; 
                left: 50%; 
                transform: translate(-50%, -50%);
                background: white; 
                border: 1px solid #ccc; 
                padding: 25px;
                border-radius: 8px; 
                display: none; 
                width: 420px; 
                z-index: 10001;
                box-shadow: 0 8px 30px rgba(0,0,0,0.3);
                max-height: 80vh;
                overflow-y: auto;
            }
            #ai-config-modal h2 {
                margin-top: 0;
                color: #333;
                border-bottom: 2px solid #4285F4;
                padding-bottom: 10px;
            }
            #ai-config-modal label {
                display: block;
                margin: 15px 0 5px 0;
                font-weight: bold;
                color: #555;
            }
            #ai-config-modal input, #ai-config-modal select {
                width: 100%; 
                padding: 10px; 
                margin-top: 5px;
                border: 1px solid #ddd; 
                border-radius: 4px;
                font-size: 14px;
                box-sizing: border-box;
            }
            #ai-config-modal input:focus, #ai-config-modal select:focus {
                outline: none;
                border-color: #4285F4;
                box-shadow: 0 0 0 2px rgba(66, 133, 244, 0.2);
            }
            #ai-config-modal .config-buttons {
                text-align: right;
                margin-top: 20px;
                padding-top: 15px;
                border-top: 1px solid #eee;
            }
            #ai-config-modal button {
                padding: 10px 20px;
                margin-left: 10px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
            }
            #ai-config-modal .save { 
                background: #34A853; 
                color: white; 
            }
            #ai-config-modal .close { 
                background: #EA4335; 
                color: white; 
            }
            #ai-config-modal .reset {
                background: #fbbc04;
                color: white;
            }
            #ai-config-modal .save:hover {
                background: #2d9247;
            }
            #ai-config-modal .close:hover {
                background: #d32f2f;
            }
            #ai-config-modal .reset:hover {
                background: #eaa002;
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
            </button>
        `;

        // 尝试添加到Google的顶部工具栏
        const topBar = document.querySelector('#gb, [role="banner"], header, nav') || document.body;
        topBar.appendChild(configContainer);

        const modal = document.createElement('div');
        modal.id = 'ai-config-modal';
        modal.innerHTML = `
            <h2>AI 翻译配置</h2>
            <label for="api-key">API 密钥:</label>
            <input id="api-key" type="password" placeholder="请输入您的API密钥">
            
            <label for="api-endpoint">API 端点:</label>
            <input id="api-endpoint" type="text" placeholder="https://example.com/api/v1">
            
            <label for="ai-model">翻译模型:</label>
            <select id="ai-model">
                <option value="qwen-mt-flash">qwen-mt-flash (推荐)</option>
                <option value="qwen-mt-turbo">qwen-turbo</option>
                <option value="qwen-mt-plus">qwen-plus</option>
                <option value="qwen3-max">qwen-max</option>
            </select>
            
            <div class="config-buttons">
                <button class="reset">重置</button>
                <button class="close">关闭</button>
                <button class="save">保存</button>
            </div>
        `;
        document.body.appendChild(modal);

        // 填充当前配置
        const keyInput = document.getElementById("api-key");
        const endpointInput = document.getElementById("api-endpoint");
        const modelSelect = document.getElementById("ai-model");
        
        keyInput.value = CURRENT_CONFIG.apiKey;
        endpointInput.value = CURRENT_CONFIG.apiEndpoint;
        modelSelect.value = CURRENT_CONFIG.model;

        // 事件监听器
        const configButton = document.getElementById("ai-config-button");
        configButton.onclick = () => modal.style.display = "block";
        
        modal.querySelector('.close').onclick = () => {
            modal.style.display = "none";
            // 重置输入框为当前值
            keyInput.value = CURRENT_CONFIG.apiKey;
            endpointInput.value = CURRENT_CONFIG.apiEndpoint;
            modelSelect.value = CURRENT_CONFIG.model;
        };
        
        modal.querySelector('.save').onclick = () => {
            if (!validateAndSaveConfig()) {
                return;
            }
            modal.style.display = "none";
        };
        
        modal.querySelector('.reset').onclick = () => {
            if (confirm('确定要重置所有设置吗？')) {
                keyInput.value = '';
                endpointInput.value = DEFAULT_CONFIG.apiEndpoint;
                modelSelect.value = DEFAULT_CONFIG.model;
                saveConfig(DEFAULT_CONFIG);
                showNotification('设置已重置为默认值');
            }
        };

        // Enter键保存
        keyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') validateAndSaveConfig();
        });
        endpointInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') validateAndSaveConfig();
        });
    }

    function validateAndSaveConfig() {
        const key = document.getElementById("api-key").value.trim();
        const endpoint = document.getElementById("api-endpoint").value.trim();
        const model = document.getElementById("ai-model").value.trim();
        
        if (!key) {
            alert('API密钥不能为空！');
            return false;
        }
        
        if (!endpoint || !isValidUrl(endpoint)) {
            alert('请输入有效的API端点URL！');
            return false;
        }
        
        saveConfig({ apiKey: key, apiEndpoint: endpoint, model: model });
        showNotification('配置已保存！');
        return true;
    }

    function isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }

    function showNotification(message) {
        const notice = document.createElement('div');
        notice.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #333;
            color: white;
            padding: 12px 20px;
            border-radius: 6px;
            z-index: 10002;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        notice.textContent = message;
        document.body.appendChild(notice);
        
        setTimeout(() => {
            if (notice.parentNode) {
                notice.parentNode.removeChild(notice);
            }
        }, 2000);
    }

    // --- AI 翻译功能 ---
    async function translateText(text) {
        if (!CURRENT_CONFIG.apiKey) {
            console.warn('AI翻译：API密钥未配置');
            return null;
        }

        const body = {
            model: CURRENT_CONFIG.model,
            input: {
                messages: [
                    { role: "system", content: "你是一个专业的语言翻译助手，专门负责将中文翻译成准确、自然的英文。请保持原意不变，翻译结果要有专业性。" },
                    { role: "user", content: `请将以下中文文本翻译成英文，要求准确、自然、符合英语表达习惯：\n\n${text}` }
                ]
            },
            parameters: { 
                result_format: "message",
                temperature: 0.3
            }
        };

        try {
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: CURRENT_CONFIG.apiEndpoint,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${CURRENT_CONFIG.apiKey}`
                    },
                    data: JSON.stringify(body),
                    onload: resolve,
                    onerror: reject,
                    timeout: 15000  // 15秒超时
                });
            });

            const result = JSON.parse(response.responseText);
            if (result.output && result.output.choices && result.output.choices[0]) {
                return result.output.choices[0].message.content.trim();
            }
            return null;
        } catch (error) {
            console.error('AI翻译请求失败:', error);
            return null;
        }
    }

    // --- 主处理逻辑 ---
    async function processSearch() {
        if (isProcessing) return; // 防止重复执行
        
        const params = new URLSearchParams(location.search);
        const query = params.get("q");
        
        if (!query) return;

        // 已经是AI翻译过的，跳过
        if (params.get("ai_translated") === "1") return;

        const decodedQuery = decodeURIComponent(query);
        
        // 检测是否包含中文字符
        if (!/[\u4e00-\u9fa5]/.test(decodedQuery)) return;

        isProcessing = true;
        
        // 显示翻译状态
        const status = document.createElement("div");
        status.id = "translation-status";
        status.textContent = `🤖 正在翻译: "${decodedQuery}"`;
        document.body.appendChild(status);

        try {
            const translatedText = await translateText(decodedQuery);
            
            if (status.parentNode) {
                status.parentNode.removeChild(status);
            }

            if (!translatedText) {
                console.warn('AI翻译失败或返回空结果');
                return;
            }

            // 构建新的查询参数
            const newParams = new URLSearchParams();
            newParams.set("q", encodeURIComponent(translatedText));
            newParams.set("ai_translated", "1");

            // 保留其他原始参数
            for (const [key, value] of params) {
                if (key !== "q" && key !== "ai_translated") {
                    newParams.set(key, value);
                }
            }

            // 跳转到翻译后的搜索页面
            const newUrl = `${location.pathname}?${newParams.toString()}`;
            if (newUrl !== location.href) {
                location.replace(newUrl);
            }
        } catch (error) {
            console.error('处理搜索翻译时出错:', error);
            if (status.parentNode) {
                status.parentNode.removeChild(status);
            }
        } finally {
            isProcessing = false;
        }
    }

    // --- 初始化 ---
    function init() {
        createSettingsUI();
        
        // 监听页面变化，处理动态加载的情况
        const observer = new MutationObserver(processSearch);
        observer.observe(document, { childList: true, subtree: true });
        
        // 页面加载完成后立即检查
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', processSearch);
        } else {
            processSearch();
        }
    }

    init();

})();
