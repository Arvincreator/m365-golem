'use strict';

// M365 Golem intentionally exposes only commands that are handled locally by
// the visible Edge transport. Reusable prompts belong in Prompt 指令池 and are
// expanded before the request is wrapped in the M365 workspace envelope.
module.exports = Object.freeze([
    Object.freeze({
        command: '/new',
        description: '重新載入可見的 Microsoft 365 Copilot Chat 工作階段；是否建立新對話仍以 Edge 畫面為準。',
    }),
]);
