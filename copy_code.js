// ==UserScript==
// @name         超星作业代码助手 - 悬浮粘贴工具
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  解除超星作业粘贴限制，在页面添加悬浮输入框方便粘贴代码,目前仅通过湖南农业大学的高级算法设计课的作业复制粘贴的测试
// @author       lanshi
// @supportURL  https://github.com/lanshi17/Study_Pass_Remove_copy-paste_restriction_for_code_questions/issues
// @updateURL   https://api.staticj.top/script/update/copy.user.js
// @downloadURL https://api.staticj.top/script/update/copy.user.js
// @license     MIT
// @match        *://mooc1-api.chaoxing.com/mooc-ans/mooc2/work/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let currentActiveEditor = null;

    // 创建悬浮窗元素
    function createFloatingWindow() {
        const container = document.createElement("div");
        container.id = "floating-code-helper";
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 300px;
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
            <textarea id="code-input" placeholder="请输入要粘贴的代码..." 
                      style="width:100%;height:120px;font-size:12px;padding:6px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;"></textarea>
            <button id="paste-btn" style="margin-top:10px;width:100%;padding:6px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;">→ 粘贴到编辑器</button>
            <div id="helper-status" style="margin-top:6px;font-size:12px;color:red;display:none;"></div>
        `;

        document.body.appendChild(container);

        // 绑定粘贴按钮事件
        document.getElementById("paste-btn").addEventListener("click", pasteCodeToEditor);
    }

    // 粘贴函数
    function pasteCodeToEditor() {
        const inputArea = document.getElementById("code-input");
        const statusDiv = document.getElementById("helper-status");
        const code = inputArea.value.trim();

        if (!code) {
            showStatus("⚠️ 输入不能为空！", true);
            return;
        }

        if (!currentActiveEditor) {
            showStatus("❌ 当前没有活动的编辑器，请先点击某个代码框", true);
            return;
        }

        try {
            const doc = currentActiveEditor.getDoc();
            const cursor = doc.getCursor();
            doc.replaceRange(code, cursor);
            showStatus("✅ 已成功插入代码", false);
        } catch (e) {
            console.error("粘贴失败:", e);
            showStatus("❌ 插入代码失败：" + e.message, true);
        }
    }

    // 显示状态信息
    function showStatus(msg, isError = false) {
        const statusDiv = document.getElementById("helper-status");
        statusDiv.textContent = msg;
        statusDiv.style.color = isError ? "red" : "green";
        statusDiv.style.display = "block";

        setTimeout(() => {
            statusDiv.style.display = "none";
        }, 3000);
    }

    // 初始化编辑器事件绑定
    function initEditors() {
        const questions = document.querySelectorAll(".questionLi[typename='程序题']");

        questions.forEach(qEl => {
            const qId = qEl.id.replace("question", "");
            const editorBox = qEl.querySelector(`.codeEditorBoxDiv[data-business-id="${qId}"]`);
            if (!editorBox || !window.codeEditors || !window.codeEditors[qId]) return;

            const editorInstance = window.codeEditors[qId];

            // 解除粘贴限制
            editorInstance.off("beforeChange");
            editorInstance.on("beforeChange", function (cm, change) {
                if (change.origin === "paste") {
                    change.cancel();
                    const pastedText = change.text.join("\n");
                    insertTextAtCursor(cm, pastedText);
                }
            });

            // 记录当前活跃编辑器（当获取焦点时）
            editorInstance.on("focus", () => {
                currentActiveEditor = editorInstance;
            });

            // 初始设置当前编辑器
            if (!currentActiveEditor) {
                currentActiveEditor = editorInstance;
            }
        });
    }

    // 手动插入文字至光标处
    function insertTextAtCursor(cm, text) {
        const doc = cm.getDoc();
        const cursor = doc.getCursor();
        doc.replaceRange(text, cursor);
    }

    // 页面加载及DOM变动监听
    function setup() {
        createFloatingWindow();
        initEditors();

        // 监控后续可能新增的编辑器（比如翻页等情况）
        const observer = new MutationObserver(() => {
            initEditors();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // 等待页面加载完毕后执行
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setup);
    } else {
        setup();
    }
})();
