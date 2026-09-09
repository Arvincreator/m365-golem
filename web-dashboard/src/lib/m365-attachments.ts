export const MAX_M365_ATTACHMENTS = 10;
export const MAX_M365_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_M365_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

export const M365_ATTACHMENT_ACCEPT = [
    ".pdf", ".docx", ".pptx", ".xlsx", ".txt", ".md", ".csv", ".tsv",
    ".json", ".xml", ".yaml", ".yml", ".html", ".htm", ".rtf", ".log",
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cs", ".cpp", ".c",
    ".h", ".php", ".css", ".sql", ".sh", ".png", ".jpg", ".jpeg", ".gif",
    ".bmp", ".tiff", ".tif",
].join(",");

const ALLOWED_EXTENSIONS = new Set(M365_ATTACHMENT_ACCEPT.split(","));
const IGNORED_PATH_PARTS = new Set([
    ".git", ".next", ".cache", "node_modules", "coverage", "dist", "build",
]);

export type PendingM365Attachment = {
    id: string;
    file: File;
    displayPath: string;
};

export type AttachmentCandidate = {
    file: File;
    displayPath?: string;
};

const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
};

type FileSystemEntryLike = {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
};

type FileSystemFileEntryLike = FileSystemEntryLike & {
    file: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
};

function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function pathIsIgnored(value: string): boolean {
    return value.split(/[\\/]/).some((part) => part.startsWith(".") || IGNORED_PATH_PARTS.has(part));
}

function attachmentId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function mergeAttachmentCandidates(
    current: PendingM365Attachment[],
    candidates: AttachmentCandidate[]
): { attachments: PendingM365Attachment[]; warnings: string[] } {
    const attachments = [...current];
    const warnings: string[] = [];
    const names = new Set(attachments.map((item) => item.file.name.toLowerCase()));
    let totalBytes = attachments.reduce((sum, item) => sum + item.file.size, 0);

    for (const candidate of candidates) {
        const file = candidate.file;
        const displayPath = String(candidate.displayPath || file.webkitRelativePath || file.name);
        if (attachments.length >= MAX_M365_ATTACHMENTS) {
            warnings.push(`每輪最多 ${MAX_M365_ATTACHMENTS} 個附件，其餘檔案未加入。`);
            break;
        }
        if (!file || pathIsIgnored(displayPath)) {
            warnings.push(`${displayPath || "未知檔案"} 位於隱藏、依賴或建置資料夾，已略過。`);
            continue;
        }
        const extension = extensionOf(file.name);
        if (!ALLOWED_EXTENSIONS.has(extension)) {
            warnings.push(`${file.name} 的格式目前不支援。`);
            continue;
        }
        if (file.size <= 0 || file.size > MAX_M365_ATTACHMENT_BYTES) {
            warnings.push(`${file.name} 必須小於 ${formatMiB(MAX_M365_ATTACHMENT_BYTES)}。`);
            continue;
        }
        if (names.has(file.name.toLowerCase())) {
            warnings.push(`${file.name} 與另一個附件同名，已略過。`);
            continue;
        }
        if (totalBytes + file.size > MAX_M365_ATTACHMENT_TOTAL_BYTES) {
            warnings.push(`本輪附件總量不可超過 ${formatMiB(MAX_M365_ATTACHMENT_TOTAL_BYTES)}。`);
            break;
        }
        attachments.push({ id: attachmentId(), file, displayPath });
        names.add(file.name.toLowerCase());
        totalBytes += file.size;
    }
    return { attachments, warnings: [...new Set(warnings)] };
}

function entryFile(entry: FileSystemFileEntryLike): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

export async function collectDroppedAttachmentCandidates(dataTransfer: DataTransfer): Promise<AttachmentCandidate[]> {
    const candidates: AttachmentCandidate[] = [];
    const items = Array.from(dataTransfer.items || []);
    for (const item of items) {
        const getEntry = (item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntryLike | null;
        }).webkitGetAsEntry;
        const entry = typeof getEntry === "function" ? getEntry.call(item) : null;
        if (entry?.isDirectory) {
            throw new Error("資料夾不會整批上傳。請使用＋選單的「選擇本機資料夾」，讓 Golem 按需讀取。");
        }
        if (entry?.isFile) {
            const file = await entryFile(entry as FileSystemFileEntryLike);
            candidates.push({ file, displayPath: file.name });
        }
    }
    if (candidates.length > 0) return candidates;
    const files = Array.from(dataTransfer.files || []);
    if (files.some((file) => Boolean(file.webkitRelativePath))) {
        throw new Error("資料夾不會整批上傳。請使用＋選單的「選擇本機資料夾」，讓 Golem 按需讀取。");
    }
    return files.map((file) => ({ file, displayPath: file.name }));
}

function clipboardImageName(timestamp: number, index: number, extension: string): string {
    const stamp = new Date(timestamp).toISOString().replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
    return `screenshot-${stamp}${index > 0 ? `-${index + 1}` : ""}${extension}`;
}

export function collectClipboardImageCandidates(
    dataTransfer: DataTransfer,
    timestamp = Date.now()
): AttachmentCandidate[] {
    const imageFiles = Array.from(dataTransfer.items || []).flatMap((item) => {
        const type = item.type.toLowerCase();
        if (item.kind !== "file" || !CLIPBOARD_IMAGE_EXTENSIONS[type]) return [];
        const file = item.getAsFile();
        return file ? [{ file, type }] : [];
    });

    return imageFiles.map(({ file, type }, index) => {
        const name = clipboardImageName(timestamp, index, CLIPBOARD_IMAGE_EXTENSIONS[type]);
        const renamed = new File([file], name, { type, lastModified: timestamp + index });
        return { file: renamed, displayPath: name };
    });
}

export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error(`無法讀取 ${file.name}`));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
    });
}

export function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return formatMiB(bytes);
}
