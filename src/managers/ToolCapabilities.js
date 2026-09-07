'use strict';

// These describe existing execution lanes; retrieval never grants permission or installs a tool.
module.exports = [
    {
        id: 'capability/local-authoring', kind: 'capability', name: '本機文件與成果製作',
        description: '把已取得的內容整理成可開啟的實體檔案，放在電腦、桌面或專案資料夾。製作 Word DOCX 報告、Excel XLSX 表格、PDF、簡報與網頁。先檢查本機程式與函式庫，再建立並驗證成果。Local document and artifact authoring from available content; inspect runtime, create and verify a real file. Remote source retrieval is a separate dependency.',
        triggers: ['整理成可交付的成品', '做成一份可以帶走的文件', '存一份在電腦裡', 'turn this into a document on my computer'],
    },
    {
        id: 'capability/local-inspection', kind: 'capability', name: '本機檔案與執行環境檢查',
        description: '透過既有 command 工具檢查電腦上的資料夾、檔案、程式版本、文件函式庫與專案測試結果。Inspect local files, directory contents, installed runtimes and project tests. This does not retrieve cloud files or authorize changes.',
        triggers: ['看看電腦裡有哪些檔案', '確認成品能開啟', '檢查環境能不能製作文件'],
    },
    {
        id: 'capability/native-m365', kind: 'capability', name: 'Copilot 原生內容查找與整理',
        description: '由目前 Copilot 工作階段提供的原生能力搜尋 Microsoft 365 資料、閱讀可見來源、推理與摘要。Native Copilot content grounding and synthesis; availability depends on the current session. This is not a Golem tool call and does not prove a local file was created.',
        triggers: ['找公司裡相關文件', '整理已看到的資料', 'Microsoft 365 搜尋'],
    },
];
