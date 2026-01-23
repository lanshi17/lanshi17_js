// ==UserScript==
// @name         Google 搜索 AI 翻译增强
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  自动将中文搜索翻译成英文搜索，修复重复翻译/流程错误，支持通义千问 DashScope API 翻译模式
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
        model: 'qwen-mt-plus',
        sourceLang: 'zh-CN',
        targetLang: 'en-US',
        useTranslationMode: true // 使用专用翻译模式
    };
    
    let CURRENT_CONFIG = loadConfig();
    let isProcessing = false;
    
    function loadConfig() {
        return {
            apiKey: GM_getValue('aiApiKey', DEFAULT_CONFIG.apiKey),
            apiEndpoint: GM_getValue('aiApiEndpoint', DEFAULT_CONFIG.apiEndpoint),
            model: GM_getValue('aiModel', DEFAULT_CONFIG.model),
            sourceLang: GM_getValue('sourceLang', DEFAULT_CONFIG.sourceLang),
            targetLang: GM_getValue('targetLang', DEFAULT_CONFIG.targetLang),
            useTranslationMode: GM_getValue('useTranslationMode', DEFAULT_CONFIG.useTranslationMode)
        };
    }

    function saveConfig(config) {
        GM_setValue('aiApiKey', config.apiKey);
        GM_setValue('aiApiEndpoint', config.apiEndpoint);
        GM_setValue('aiModel', config.model);
        GM_setValue('sourceLang', config.sourceLang);
        GM_setValue('targetLang', config.targetLang);
        GM_setValue('useTranslationMode', config.useTranslationMode);
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
                background: linear-gradient(135deg, #4285F4, #34A853); 
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
            #translation-status {
                position: fixed; 
                top: 5px; 
                right: 150px; 
                padding: 8px 12px;
                background: linear-gradient(135deg, #fff3cd, #ffeaa7); 
                border: 1px solid #ffeeba; 
                color: #856404;
                border-radius: 4px; 
                z-index: 10000;
                font-size: 14px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                max-width: 400px;
                word-wrap: break-word;
                min-width: 200px;
            }
            #translation-status::before {
                content: '🔄';
                margin-right: 5px;
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
                width: 500px; 
                z-index: 10001;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
                backdrop-filter: blur(10px);
                max-height: 85vh;
                overflow-y: auto;
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
                min-width: 120px;
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
            .switch {
                position: relative;
                display: inline-block;
                width: 50px;
                height: 24px;
            }
            .switch input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            .slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: #ccc;
                transition: .4s;
                border-radius: 24px;
            }
            .slider:before {
                position: absolute;
                content: "";
                height: 18px;
                width: 18px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: .4s;
                border-radius: 50%;
            }
            input:checked + .slider {
                background-color: #4285F4;
            }
            input:checked + .slider:before {
                transform: translateX(26px);
            }
            #ai-config-modal .config-buttons {
                text-align: right;
                margin-top: 25px;
                padding-top: 20px;
                border-top: 1px solid #eee;
                display: flex;
                justify-content: space-between;
                align-items: center;
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
            .lang-selector {
                display: flex;
                gap: 10px;
                margin-top: 8px;
            }
            .lang-select {
                flex: 1;
                padding: 8px;
                border: 1px solid #dfe1e5;
                border-radius: 4px;
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
            </button>
        `;

        const topBar = document.querySelector('#gb, [role="banner"], header, nav') || document.body;
        topBar.appendChild(configContainer);

        const modal = document.createElement('div');
        modal.id = 'ai-config-modal';
        modal.innerHTML = `
            <h2>🤖 AI 翻译配置</h2>
            
            <div class="config-section">
                <div class="config-row">
                    <label class="config-label">API密钥</label>
                    <input id="api-key" type="password" class="config-input" placeholder="sk-xxx">
                </div>
                
                <div class="config-row">
                    <label class="config-label">API端点</label>
                    <input id="api-endpoint" type="text" class="config-input" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1">
                </div>
                
                <div class="config-row">
                    <label class="config-label">翻译模型</label>
                    <select id="ai-model" class="config-input">
                        <option value="qwen-mt-plus">qwen-mt-plus (推荐)</option>
                        <option value="qwen-mt-turbo">qwen-mt-turbo</option>
                        <option value="qwen-mt-max">qwen-mt-max</option>
                        <option value="qwen3">qwen3</option>
                    </select>
                </div>
                
                <div class="config-row">
                    <label class="config-label">启用翻译模式</label>
                    <label class="switch">
                        <input type="checkbox" id="use-translation-mode">
                        <span class="slider"></span>
                    </label>
                    <span class="info-icon" title="使用专用翻译模式，提供更好的翻译质量">ℹ️</span>
                </div>
            </div>
            
            <div class="config-section">
                <div class="config-row">
                    <label class="config-label">语言设置</label>
                    <div class="lang-selector">
                        <select id="source-lang" class="lang-select">
                            <option value="zh-CN">中文</option>
                            <option value="en-US">英文</option>
                            <option value="ja-JP">日文</option>
                            <option value="ko-KR">韩文</option>
                        </select>
                        <span>→</span>
                        <select id="target-lang" class="lang-select">
                            <option value="en-US">英文</option>
                            <option value="zh-CN">中文</option>
                            <option value="ja-JP">日文</option>
                            <option value="ko-KR">韩文</option>
                        </select>
                    </div>
                </div>
            </div>
            
            <div class="config-buttons">
                <div>
                    <button class="reset">重置配置</button>
                </div>
                <div>
                    <button class="close">关闭</button>
                    <button class="save">保存配置</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // 填充当前配置
        fillConfigForm();

        // 事件监听
        document.getElementById("ai-config-button").onclick = () => modal.style.display = "block";
        
        document.querySelector('#ai-config-modal .close').onclick = () => {
            modal.style.display = "none";
            fillConfigForm(); // 取消时恢复原有配置
        };
        
        document.querySelector('#ai-config-modal .save').onclick = validateAndSaveConfig;
        document.querySelector('#ai-config-modal .reset').onclick = resetToDefault;
        
        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'block') {
                modal.style.display = 'none';
                fillConfigForm();
            }
        });
    }

    function fillConfigForm() {
        document.getElementById("api-key").value = CURRENT_CONFIG.apiKey;
        document.getElementById("api-endpoint").value = CURRENT_CONFIG.apiEndpoint;
        document.getElementById("ai-model").value = CURRENT_CONFIG.model;
        document.getElementById("use-translation-mode").checked = CURRENT_CONFIG.useTranslationMode;
        document.getElementById("source-lang").value = CURRENT_CONFIG.sourceLang;
        document.getElementById("target-lang").value = CURRENT_CONFIG.targetLang;
    }

    function validateAndSaveConfig() {
        const key = document.getElementById("api-key").value.trim();
        const endpoint = document.getElementById("api-endpoint").value.trim();
        const model = document.getElementById("ai-model").value.trim();
        const useTranslationMode = document.getElementById("use-translation-mode").checked;
        const sourceLang = document.getElementById("source-lang").value;
        const targetLang = document.getElementById("target-lang").value;
        
        if (!key) {
            showNotification('❌ 请输入API密钥');
            return false;
        }
        
        if (!endpoint || !isValidUrl(endpoint)) {
            showNotification('❌ 请输入有效的API端点URL');
            return false;
        }
        
        if (!model) {
            showNotification('❌ 请选择翻译模型');
            return false;
        }
        
        saveConfig({ 
            apiKey: key, 
            apiEndpoint: endpoint, 
            model: model,
            useTranslationMode: useTranslationMode,
            sourceLang: sourceLang,
            targetLang: targetLang
        });
        
        showNotification('✅ 配置已保存！');
        return true;
    }

    function resetToDefault() {
        if (confirm('确定要重置所有设置为默认值吗？')) {
            saveConfig(DEFAULT_CONFIG);
            fillConfigForm();
            showNotification('✅ 配置已重置');
        }
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
        // 移除之前的提示
        const existing = document.getElementById('ai-notification');
        if (existing) document.body.removeChild(existing);
        
        const notice = document.createElement('div');
        notice.id = 'ai-notification';
        notice.textContent = message;
        notice.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #333;
            color: white;
            padding: 16px 24px;
            border-radius: 8px;
            z-index: 10002;
            font-size: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            animation: fadeInOut 3s ease-in-out;
        `;
        
        document.body.appendChild(notice);
        
        setTimeout(() => {
            if (notice.parentNode) {
                notice.parentNode.removeChild(notice);
            }
        }, 3000);
    }

    GM_addStyle(`
        @keyframes fadeInOut {
            0% { opacity: 0; transform: translate(-50%, -40%); }
            20% { opacity: 1; transform: translate(-50%, -50%); }
            80% { opacity: 1; transform: translate(-50%, -50%); }
            100% { opacity: 0; transform: translate(-50%, -40%); }
        }
    `);

    // --- AI 翻译功能 ---
    async function translateText(text) {
        if (!CURRENT_CONFIG.apiKey) {
            console.warn('AI翻译：API密钥未配置');
            return null;
        }

        let requestBody;

        if (CURRENT_CONFIG.useTranslationMode) {
            // 使用翻译模式
            requestBody = {
                model: CURRENT_CONFIG.model,
                messages: [
                    { role: "user", content: text }
                ],
                translation_options: {
                    source_lang: CURRENT_CONFIG.sourceLang,
                    target_lang: CURRENT_CONFIG.targetLang
                }
            };
        } else {
            // 使用普通聊天模式
            requestBody = {
                model: CURRENT_CONFIG.model,
                messages: [
                    { role: "system", content: "你是一个专业的语言翻译助手，专门负责将中文翻译成准确、自然的英文。请保持原意不变，翻译结果要有专业性。" },
                    { role: "user", content: `请将以下文本翻译成${getLanguageName(CURRENT_CONFIG.targetLang)}，要求准确、自然、符合目标语言表达习惯：\n\n${text}` }
                ],
                parameters: { 
                    result_format: "message",
                    temperature: 0.3
                }
            };
        }

        try {
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: CURRENT_CONFIG.apiEndpoint,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${CURRENT_CONFIG.apiKey}`,
                        "Accept": "application/json"
                    },
                    data: JSON.stringify(requestBody),
                    onload: resolve,
                    onerror: reject,
                    timeout: 30000  // 30秒超时
                });
            });

            const result = JSON.parse(response.responseText);
            
            if (CURRENT_CONFIG.useTranslationMode) {
                // 翻译模式的响应结构
                if (result.choices && result.choices[0]?.message?.content) {
                    return result.choices[0].message.content.trim();
                }
            } else {
                // 普通聊天模式的响应结构
                if (result.output && result.output.choices && result.output.choices[0]?.message?.content) {
                    return result.output.choices[0].message.content.trim();
                }
            }
            return null;
        } catch (error) {
            console.error('AI翻译请求失败:', error);
            if (error instanceof SyntaxError) {
                console.error('JSON解析失败:', response.responseText);
            }
            return null;
        }
    }

    function getLanguageName(langCode) {
        const langMap = {
            'zh-CN': '中文',
            'en-US': '英文',
            'ja-JP': '日文',
            'ko-KR': '韩文'
        };
        return langMap[langCode] || langCode;
    }

    // --- 主处理逻辑 ---
    async function processSearch() {
        if (isProcessing) return;
        
        const params = new URLSearchParams(location.search);
        const query = params.get("q");
        
        if (!query) return;

        // 已翻译过的跳过
        if (params.get("ai_translated") === "1") return;

        const decodedQuery = decodeURIComponent(query);
        
        // 检测中文
        if (!/[\u4e00-\u9fa5]/.test(decodedQuery)) return;

        isProcessing = true;
        
        // 显示翻译状态
        const status = document.createElement("div");
        status.id = "translation-status";
        status.textContent = `🤖 翻译中: "${decodedQuery}"`;
        document.body.appendChild(status);

        try {
            const translatedText = await translateText(decodedQuery);
            
            if (status.parentNode) {
                status.parentNode.removeChild(status);
            }

            if (!translatedText) {
                console.warn('AI翻译失败或返回空结果');
                showNotification('⚠️ 翻译失败，请检查API配置');
                return;
            }

            // 构建新URL
            const newParams = new URLSearchParams();
            newParams.set("q", encodeURIComponent(translatedText));
            newParams.set("ai_translated", "1");

            for (const [key, value] of params) {
                if (key !== "q" && key !== "ai_translated") {
                    newParams.set(key, encodeURIComponent(value));
                }
            }

            const newUrl = `${location.pathname}?${newParams.toString()}`;
            if (newUrl !== location.href) {
                location.replace(newUrl);
            }
        } catch (error) {
            console.error('处理搜索翻译时出错:', error);
            if (status.parentNode) {
                status.parentNode.removeChild(status);
            }
            showNotification('❌ 处理翻译时出现错误');
        } finally {
            isProcessing = false;
        }
    }

    // --- 初始化 ---
    function init() {
        createSettingsUI();
        
        // 页面加载后立即检查
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', processSearch);
        } else {
            setTimeout(processSearch, 100);
        }
        
        // 监听URL变化
        let currentUrl = location.href;
        setInterval(() => {
            if (location.href !== currentUrl) {
                currentUrl = location.href;
                setTimeout(processSearch, 200);
            }
        }, 500);
    }

    init();

})();
