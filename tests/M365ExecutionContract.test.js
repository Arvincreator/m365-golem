'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const {
    buildExecutionProgressText,
    classifyExecutionExpectation,
    classifyUnverifiedStop,
    describeAction,
    extractArtifactRequirements,
    inferActionProgressLabel,
    findRecentValidArtifacts,
    inferVerification,
    validatePlanCompletion,
} = require('../src/services/M365ExecutionContract');

describe('M365 execution contract', () => {
    test('describes the current step in a non-technical progress message within 50 characters', () => {
        const message = buildExecutionProgressText({
            action: 'command',
            parameter: 'python make_report.py',
            progress: '建立指定 Word 文件並確認內容寫入',
        });
        expect(message).toBe('建立指定 Word 文件並確認內容寫入，正在執行並確認中…');
        expect(Array.from(message).length).toBeLessThanOrEqual(50);

        const bounded = buildExecutionProgressText({
            action: 'command',
            progress: `檢查${'很長的實際操作'.repeat(20)}`,
        });
        expect(Array.from(bounded).length).toBeLessThanOrEqual(50);
        expect(bounded).toMatch(/，正在執行並確認中…$/);
    });

    test('falls back to the real action payload when progress text is missing or unsafe', () => {
        expect(inferActionProgressLabel({
            action: 'command',
            parameter: 'python -c "from docx import Document; assert path.exists(); assert zipfile.ZipFile(path).testzip() is None"',
        })).toBe('驗證Word 文件的存在、格式與內容');
        expect(inferActionProgressLabel({
            action: 'command',
            parameter: 'dir /b',
            progress: '執行 PowerShell C:\\secret\\run.ps1',
        })).toBe('讀取工作區並核對實際檔案清單');
    });

    test('requires action for an explicit local document task', () => {
        const route = { commandLane: { recommended: true, reason: 'local_project_artifact_authoring' }, skills: [], mcpTools: [] };
        expect(classifyExecutionExpectation('在工作區建立一份 Word 報告', route, '我可以協助')).toEqual(expect.objectContaining({ required: true, local: true }));
        expect(inferVerification('在工作區建立一份 Word 報告', route)).toContain('.docx');
    });

    test('does not turn explanations into an execution obligation', () => {
        const route = { commandLane: { recommended: true }, skills: [], mcpTools: [] };
        expect(classifyExecutionExpectation('請解釋 Word 文件是怎麼產生的', route, '說明')).toEqual(expect.objectContaining({ required: false }));
    });

    test('keeps an explicit workspace operation actionable when route metadata is unavailable', () => {
        expect(classifyExecutionExpectation(
            '請在這個工作區建立一份 Word 文件',
            null,
            '已經完成'
        )).toEqual(expect.objectContaining({ required: true, local: true }));
    });

    test('describes an action without persisting its arguments', () => {
        expect(describeAction({ action: 'command', parameter: 'python secret-script.py --token hidden' })).toEqual({
            kind: 'command', executable: 'python',
        });
    });

    test('finds only recent structurally valid Word files', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-contract-'));
        try {
            const docx = path.join(root, 'report.docx');
            const zip = new AdmZip();
            zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
            zip.addFile('word/document.xml', Buffer.from('<w:document/>'));
            zip.writeZip(docx);
            fs.writeFileSync(path.join(root, 'fake.docx'), 'plain text', 'utf8');
            expect(findRecentValidArtifacts(root, '.docx', new Date(Date.now() - 1000).toISOString())).toEqual(['report.docx']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('extracts an explicit file name, title, and requested list items', () => {
        expect(extractArtifactRequirements(
            '檔名為 Golem_自主執行_UAT.docx，內容包含標題「Golem 自主執行驗證」及三點：資源檢查、建立文件、驗證格式。',
            '.docx'
        )).toEqual({
            fileName: 'Golem_自主執行_UAT.docx',
            phrases: ['Golem 自主執行驗證', '資源檢查', '建立文件', '驗證格式'],
        });
    });

    test('independently rejects a Word completion with the wrong file name or content', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-contract-content-'));
        try {
            const docx = path.join(root, 'other.docx');
            const zip = new AdmZip();
            zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
            zip.addFile('word/document.xml', Buffer.from('<w:document><w:p><w:t>unrelated</w:t></w:p></w:document>'));
            zip.writeZip(docx);
            const result = validatePlanCompletion({
                plan: {
                    goal: '建立 Word 文件',
                    completionCriteria: '檔案完成',
                    steps: [{ id: 's1', status: 'completed' }],
                },
                run: {
                    objective: '檔名為 report.docx，標題「核對完成」及三點：甲、乙、丙。',
                    startedAt: new Date(Date.now() - 1000).toISOString(),
                },
                events: [{ eventType: 'autonomous_observation_recorded', payload: { status: 'succeeded', planStepId: 's1', actionId: 'a1' } }],
                workspaceRoot: root,
            });
            expect(result.issues).toContain('requested_artifact_filename_not_found:.docx');
            expect(result.issues).toContain('requested_artifact_content_not_found:.docx');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('rejects completion when a declared step lacks a host observation', () => {
        const plan = {
            goal: 'Inspect project', completionCriteria: 'Two checks',
            steps: [
                { id: 'step_1', status: 'completed' },
                { id: 'step_2', status: 'completed' },
            ],
        };
        const result = validatePlanCompletion({
            plan,
            run: { startedAt: new Date().toISOString() },
            events: [{ eventType: 'autonomous_observation_recorded', payload: { status: 'succeeded', planStepId: 'step_1', actionId: 'a1' } }],
        });
        expect(result.ok).toBe(false);
        expect(result.issues).toContain('step_without_host_observation:step_2');
    });

    test('a reference lookup does not prove that local workspace files were listed', () => {
        const result = validatePlanCompletion({
            plan: { goal: '列出工作區有什麼檔案', completionCriteria: '回報檔案清單', steps: [{ id: 's1', status: 'completed' }] },
            run: { startedAt: new Date().toISOString() },
            events: [
                { eventType: 'autonomous_action_planned', payload: { actionId: 'a1', planStepId: 's1', actionDescriptor: { kind: 'skill', action: 'reference-files' } } },
                { eventType: 'autonomous_observation_recorded', payload: { actionId: 'a1', planStepId: 's1', status: 'succeeded' } },
            ],
        });
        expect(result.issues).toContain('workspace_listing_not_observed');
    });

    test('rejects capability guesses and repeated permission as plan blockers', () => {
        expect(classifyUnverifiedStop({ status: 'blocked', question: '我尚未取得可建立 Word 的已驗證能力。' }, []))
            .toBe('unverified_capability_blocker');
        expect(classifyUnverifiedStop({ status: 'wait_user', question: '你是否同意我嘗試建立文件？' }, []))
            .toBe('repeated_permission_request');
        expect(classifyUnverifiedStop({ status: 'wait_user', question: '請提供確切的 SharePoint 資料夾網址。' }, []))
            .toBeNull();
    });
});
