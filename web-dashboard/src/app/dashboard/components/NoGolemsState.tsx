"use client";

import Link from "next/link";
import { BrainCircuit, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NoGolemsState() {
    return (
        <div className="h-full flex items-center justify-center p-6 bg-background">
            <div className="max-w-md w-full text-center space-y-6 animate-in fade-in zoom-in-95 duration-500">
                <div className="inline-flex items-center justify-center w-24 h-24 bg-primary/10 border border-primary/20 rounded-[2rem] shadow-[0_0_40px_-10px_rgba(var(--primary),0.3)] mb-2">
                    <BrainCircuit className="w-12 h-12 text-primary" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-foreground mb-3 tracking-tight">系統已就緒</h1>
                    <p className="text-muted-foreground text-base leading-relaxed">
                        目前尚未部署任何 Golem 實體。<br />請建立你的第一個 AI 代理人來開始使用。
                    </p>
                </div>
                <Link href="/dashboard/agents/create" className="inline-block w-full pt-4">
                    <Button className="w-full h-14 bg-primary hover:bg-primary/90 text-primary-foreground text-base font-semibold border-0 shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] hover:shadow-primary/25">
                        <UserPlus className="w-5 h-5 mr-2" />
                        建立第一個 Golem
                    </Button>
                </Link>
                <div className="pt-2 p-3 rounded-xl bg-muted border border-border text-muted-foreground text-[10px] text-left">
                    <p>💡 提示：系統向導將協助您快速設定 <code>.env</code> 文件。</p>
                </div>
            </div>
        </div>
    );
}
