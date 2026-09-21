// ==UserScript==
// @name         超星作业代码助手 - 悬浮粘贴工具
// @namespace    http://tampermonkey.net/
// @version      1.402
// @description  解除超星作业粘贴限制，在页面添加悬浮输入框方便粘贴代码,目前仅通过湖南农业大学的高级算法设计课的作业复制粘贴的测试
// @author       lanshi
// @supportURL  https://github.com/lanshi17/Study_Pass_Remove_copy-paste_restriction_for_code_questions/issues
// @license     MIT
// @match        *://mooc1-api.chaoxing.com/
// @match        *://mooc1.chaoxing.com/mooc-ans/mooc2/*
// @match        *://*.chaoxing.com/mooc-ans/mooc2/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const HELPER_ID = 'floating-code-helper';
    const QUESTION_SELECTOR = '.questionLi[typename="程序题"]';
    const EDITOR_SELECTOR = `${QUESTION_SELECTOR}, .codeEditorBoxDiv, .CodeMirror`;
    const editorBindings = new Map();
    let currentActiveEditor = null;
    let container;
    let inputArea;
    let statusDiv;
    let statusTimer;
    let scanTimer;

    // 创建悬浮窗元素
    function createFloatingWindow() {
        container = document.createElement("div");
        container.id = HELPER_ID;
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 300px;
            max-width: calc(100vw - 40px);
            box-sizing: border-box;
            background-color: #fff;
            border: 1px solid #ccc;
            box-shadow: 0 0 10px rgba(0,0,0,0.2);
            z-index: 99999;
            font-family: Arial, sans-serif;
            font-size: 14px;
            padding: 10px;
            border-radius: 6px;
        `;

        container.innerHTML = `
            <div style="font-weight:bold;margin-bottom:8px;">📝 代码粘贴助手</div>
            <textarea id="code-input" aria-label="要粘贴的代码" spellcheck="false" placeholder="请输入要粘贴的代码..."
                      style="width:100%;height:120px;font-size:12px;padding:6px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;"></textarea>
            <button id="paste-btn" type="button" style="margin-top:10px;width:100%;padding:6px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;">→ 粘贴到编辑器</button>
            <div id="helper-status" role="status" aria-live="polite" style="margin-top:6px;font-size:12px;color:red;display:none;"></div>
        `;

        document.body.appendChild(container);

        inputArea = container.querySelector("#code-input");
        statusDiv = container.querySelector("#helper-status");
        container.querySelector("#paste-btn").addEventListener("click", pasteCodeToEditor);
        // 保留输入框原生粘贴，避免触发页面冒泡阶段的粘贴限制。
        inputArea.addEventListener("paste", event => event.stopPropagation());
    }

    // 粘贴函数
    function pasteCodeToEditor() {
        const code = inputArea.value;

        if (!code) {
            showStatus("⚠️ 输入不能为空！", true);
            return;
        }

        // 点击时重新检查，避免动态翻页后向已移除的编辑器写入。
        initEditors();
        if (!currentActiveEditor) {
            showStatus("❌ 当前没有活动的编辑器，请先点击某个代码框", true);
            return;
        }

        insertCode(currentActiveEditor, code);
    }

    // 显示状态信息
    function showStatus(msg, isError = false) {
        clearTimeout(statusTimer);
        statusDiv.textContent = msg;
        statusDiv.style.color = isError ? "red" : "green";
        statusDiv.style.display = "block";

        statusTimer = setTimeout(() => {
            statusDiv.style.display = "none";
        }, 3000);
    }

    // 每个实例仅绑定一次；扫描时清理已移除或被替换的实例。
    function initEditors() {
        clearTimeout(scanTimer);
        const foundEditors = new Set();
        let pendingEditors = false;

        document.querySelectorAll(QUESTION_SELECTOR).forEach(question => {
            const questionId = question.id.replace(/^question/, "");
            const editorBox = Array.from(question.querySelectorAll(".codeEditorBoxDiv"))
                .find(box => box.dataset.businessId === questionId);
            if (!editorBox) return;

            const editor = window.codeEditors?.[questionId];
            const wrapper = editor?.getWrapperElement?.();
            if (!wrapper?.isConnected || !editorBox.contains(wrapper)) {
                pendingEditors = true;
                return;
            }
            foundEditors.add(editor);
            if (editorBindings.has(editor)) return;

            const onFocus = () => { currentActiveEditor = editor; };
            const onPaste = event => {
                if (event.defaultPrevented || editor.getOption("readOnly")) return;
                const clipboard = event.clipboardData;
                if (!clipboard || !Array.from(clipboard.types).includes("text/plain")) return;
                const text = clipboard.getData("text/plain");
                if (!text) return;

                // 在 CodeMirror 处理 paste 前插入；不在 beforeChange 内修改文档。
                event.preventDefault();
                event.stopImmediatePropagation();
                currentActiveEditor = editor;
                insertCode(editor, text);
            };

            editor.on("focus", onFocus);
            wrapper.addEventListener("paste", onPaste, true);
            editorBindings.set(editor, { wrapper, onFocus, onPaste });
        });

        for (const [editor, binding] of editorBindings) {
            if (foundEditors.has(editor)) continue;
            editor.off("focus", binding.onFocus);
            binding.wrapper.removeEventListener("paste", binding.onPaste, true);
            editorBindings.delete(editor);
        }
        if (!foundEditors.has(currentActiveEditor)) {
            currentActiveEditor = foundEditors.values().next().value || null;
        }
        // 注册到 window.codeEditors 不一定产生 DOM 变化，因此仅对待加载项重试。
        if (pendingEditors) scheduleScan(1000);
    }

    function insertCode(editor, text) {
        if (editor.getOption("readOnly")) {
            showStatus("⚠️ 当前编辑器为只读，无法插入代码", true);
            return;
        }
        try {
            // 保留缩进和首尾换行，选中内容时按普通粘贴行为替换，并支持撤销。
            editor.getDoc().replaceSelection(text, "end", "code-helper");
            editor.focus();
            showStatus("✅ 已成功插入代码");
        } catch (error) {
            console.error("粘贴失败:", error);
            showStatus("❌ 插入代码失败：" + error.message, true);
        }
    }

    function scheduleScan(delay = 100) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(initEditors, delay);
    }

    function containsEditor(node) {
        return node.nodeType === Node.ELEMENT_NODE &&
            (node.matches(EDITOR_SELECTOR) || node.querySelector(EDITOR_SELECTOR));
    }

    // 页面加载及DOM变动监听
    function setup() {
        if (document.getElementById(HELPER_ID)) return;
        createFloatingWindow();
        initEditors();

        // 监控后续可能新增的编辑器（比如翻页等情况）
        const observer = new MutationObserver(mutations => {
            // 忽略面板提示和代码逐字渲染，仅合并处理编辑器结构的增删。
            const editorsChanged = mutations.some(mutation =>
                !container.contains(mutation.target) &&
                [...mutation.addedNodes, ...mutation.removedNodes].some(containsEditor));
            if (editorsChanged) scheduleScan();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 等待页面加载完毕后执行
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setup, { once: true });
    } else {
        setup();
    }
})();
