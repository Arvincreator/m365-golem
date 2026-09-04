"use client";

import { useMemo, useState } from "react";
import {
    Check,
    ChevronDown,
    Code2,
    Copy,
    Download,
    Eye,
    FileCode2,
    Maximize2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { parseM365MessageContent } from "@/lib/m365-message-rendering";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

type MessageSegment =
    | { kind: "markdown"; content: string }
    | { kind: "code"; language: string; code: string; sourceWasCollapsed: boolean };

const CODE_FILE_NAMES: Record<string, string> = {
    html: "index.html",
    css: "styles.css",
    javascript: "script.js",
    typescript: "script.ts",
    json: "response.json",
    xml: "document.xml",
    yaml: "document.yaml",
    markdown: "document.md",
    python: "script.py",
    powershell: "script.ps1",
    shell: "script.sh",
    sql: "query.sql",
    java: "Main.java",
    csharp: "Program.cs",
    cpp: "main.cpp",
    text: "code.txt",
};

function safeHtmlPreview(code: string): string {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`;
    if (/<head(?:\s[^>]*)?>/i.test(code)) {
        return code.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${csp}`);
    }
    return `<!doctype html><html><head>${csp}</head><body>${code}</body></html>`;
}

function CodeArtifactCard({ language, code, sourceWasCollapsed }: Extract<MessageSegment, { kind: "code" }>) {
    const isHtml = language === "html" || /^\s*(?:<!doctype\s+html|<html\b)/i.test(code);
    const [viewMode, setViewMode] = useState<"preview" | "code">(isHtml ? "preview" : "code");
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const [largePreviewOpen, setLargePreviewOpen] = useState(false);
    const lines = useMemo(() => code.split("\n"), [code]);
    const previewDocument = useMemo(() => safeHtmlPreview(code), [code]);
    const fileName = CODE_FILE_NAMES[language] || `code.${language || "txt"}`;
    const longCode = lines.length > 18;

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            setCopied(false);
        }
    };

    const downloadCode = () => {
        const blob = new Blob([code], { type: isHtml ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <section className="not-prose w-full min-w-0 max-w-[760px] overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-secondary/55 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <FileCode2 className="h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-300" />
                    <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">{fileName}</p>
                        <p className="text-[10px] text-muted-foreground">
                            {language.toUpperCase()} · {lines.length} 行{sourceWasCollapsed ? " · 已整理 M365 程式碼檢視" : ""}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    {isHtml && (
                        <div className="mr-1 flex rounded-lg border border-border bg-background p-0.5">
                            <button
                                type="button"
                                onClick={() => setViewMode("preview")}
                                className={cn("rounded-md px-2 py-1 text-[11px]", viewMode === "preview" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                                預覽
                            </button>
                            <button
                                type="button"
                                onClick={() => setViewMode("code")}
                                className={cn("rounded-md px-2 py-1 text-[11px]", viewMode === "code" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                            >
                                程式碼
                            </button>
                        </div>
                    )}
                    <button type="button" onClick={() => void copyCode()} aria-label={`複製 ${fileName}`} title="複製程式碼" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={downloadCode} aria-label={`下載 ${fileName}`} title="下載檔案" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                        <Download className="h-3.5 w-3.5" />
                    </button>
                    {isHtml && (
                        <button type="button" onClick={() => setLargePreviewOpen(true)} aria-label={`放大預覽 ${fileName}`} title="放大預覽" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                            <Maximize2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {isHtml && viewMode === "preview" ? (
                <div className="relative h-80 bg-white">
                    <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md bg-slate-950/75 px-2 py-1 text-[10px] text-white">
                        <Eye className="h-3 w-3" /> 安全預覽
                    </div>
                    <iframe
                        title={`安全預覽 ${fileName}`}
                        sandbox=""
                        srcDoc={previewDocument}
                        className="h-full w-full border-0 bg-white"
                    />
                </div>
            ) : (
                <>
                    <div className={cn("custom-scrollbar overflow-auto bg-slate-950 text-slate-100", expanded ? "max-h-[65vh]" : "max-h-72")}>
                        <ol className="min-w-max py-2 font-mono text-xs leading-5">
                            {lines.map((line, index) => (
                                <li key={index} className="grid grid-cols-[3rem_1fr] px-3 hover:bg-white/5">
                                    <span aria-hidden className="select-none pr-3 text-right text-slate-500">{index + 1}</span>
                                    <code className="whitespace-pre pr-4">{line || " "}</code>
                                </li>
                            ))}
                        </ol>
                    </div>
                    {longCode && (
                        <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center justify-center gap-1.5 border-t border-border bg-secondary/35 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                            <Code2 className="h-3.5 w-3.5" />
                            {expanded ? "收合程式碼" : `展開完整程式碼（${lines.length} 行）`}
                            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                        </button>
                    )}
                </>
            )}

            {isHtml && (
                <Dialog open={largePreviewOpen} onOpenChange={setLargePreviewOpen}>
                    <DialogContent className="flex h-[90vh] w-[min(94vw,1200px)] max-w-none flex-col gap-0 overflow-hidden p-0">
                        <DialogHeader className="border-b border-border px-5 py-4">
                            <DialogTitle>{fileName}</DialogTitle>
                            <DialogDescription>HTML 只在隔離預覽中顯示；外部連線與程式碼執行均已封鎖。</DialogDescription>
                        </DialogHeader>
                        <iframe title={`放大安全預覽 ${fileName}`} sandbox="" srcDoc={previewDocument} className="min-h-0 flex-1 border-0 bg-white" />
                    </DialogContent>
                </Dialog>
            )}
        </section>
    );
}

export default function M365MessageContent({ content }: { content: string }) {
    const segments = useMemo(
        () => parseM365MessageContent(content) as MessageSegment[],
        [content]
    );

    return (
        <div className="space-y-3">
            {segments.map((segment, index) => segment.kind === "code" ? (
                <CodeArtifactCard key={`code-${index}`} {...segment} />
            ) : (
                <div key={`markdown-${index}`} className="prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-p:my-2 prose-pre:overflow-x-auto">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.content}</ReactMarkdown>
                </div>
            ))}
        </div>
    );
}
