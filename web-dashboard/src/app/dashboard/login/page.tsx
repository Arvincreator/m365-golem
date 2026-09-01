"use client";

import React, { useState } from "react";
import { Lock, ArrowRight, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api-client";

export default function LoginPage() {
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setIsLoading(true);

        try {
            const data = await apiPost<{ success?: boolean; message?: string }>("/api/system/login", { password });

            if (data.success) {
                // Redirect back to dashboard root
                window.location.href = "/dashboard";
            } else {
                setError(data.message || "登入失敗");
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "網路錯誤";
            setError(message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950 p-4">
            <div className="max-w-md w-full bg-gray-900/80 border border-gray-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-600 to-teal-400 rounded-t-3xl" />
                
                <div className="flex flex-col items-center mb-8">
                    <div className="w-16 h-16 bg-gray-950 border border-gray-800 rounded-2xl flex items-center justify-center mb-4 shadow-inner">
                        <Lock className="w-8 h-8 text-emerald-400" />
                    </div>
                    <h1 className="text-2xl font-bold text-white mb-2">遠端存取驗證</h1>
                    <p className="text-sm text-gray-400 text-center">
                        主機已開啟遠端存取密碼保護。<br />
                        請輸入授權密碼以進入 Golem 控制台。
                    </p>
                </div>

                <form onSubmit={handleLogin} className="space-y-6">
                    {error && (
                        <div className="flex items-start gap-3 p-3 bg-red-950/30 border border-red-900/40 rounded-xl text-red-400 animate-in fade-in slide-in-from-top-2">
                            <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
                            <p className="text-sm">{error}</p>
                        </div>
                    )}
                    
                    <div>
                        <div className="relative">
                            <input
                                type="password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="請輸入密碼..."
                                className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-3.5 text-white font-mono text-base focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 transition-all text-center tracking-widest"
                                autoFocus
                            />
                        </div>
                    </div>

                    <Button
                        type="submit"
                        disabled={isLoading || !password}
                        className="w-full h-12 text-sm font-bold bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 border-none shadow-xl shadow-emerald-900/20 transition-all hover:scale-[1.02] active:scale-95 rounded-xl group"
                    >
                        {isLoading ? (
                            <span className="flex items-center gap-2">
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                驗證中...
                            </span>
                        ) : (
                            <span className="flex items-center gap-2">
                                解鎖控制台
                                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </span>
                        )}
                    </Button>
                </form>
            </div>
        </div>
    );
}
