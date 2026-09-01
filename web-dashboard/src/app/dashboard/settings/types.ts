export type GolemConfig = {
    id: string;
    tgToken?: string;
    role?: string;
    tgAuthMode?: string;
    adminId?: string;
    chatId?: string;
};

export type ConfigData = {
    env: Record<string, string>;
    golems: GolemConfig[];
};

export type SystemStatus = {
    hasGolems?: boolean;
    liveCount?: number;
    configuredCount?: number;
    isSystemConfigured?: boolean;
    runtime?: { node: string; npm: string; platform: string; arch: string; uptime: number; osName: string };
    health?: { node: boolean; env: boolean; keys: boolean; deps: boolean; core: boolean; dashboard: boolean };
    system?: { totalMem: string; freeMem: string; diskAvail: string };
    allowRemote?: boolean;
    localIp?: string;
    dashboardPort?: string | number;
};

export type UpdateInfo = {
    currentVersion: string;
    remoteVersion?: string;
    isOutdated?: boolean;
    installMode: string;
    gitInfo?: {
        currentBranch: string;
        currentCommit: string;
        latestCommit: string;
        behindCount: number;
    };
};

export type LogInfo = { size: string; bytes: number };
