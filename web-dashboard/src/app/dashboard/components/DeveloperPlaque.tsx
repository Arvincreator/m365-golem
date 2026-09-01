"use client";

import { cn } from "@/lib/utils";

type DeveloperPlaqueProps = {
    className?: string;
    variant?: "full" | "indicator";
    title?: string;
    subtitle?: string;
    roleLabel?: string;
    developers?: string;
    origin?: string;
};

const etchedTextSoft = "[text-shadow:0_-1px_0_rgba(255,255,255,0.16),0_1px_0_rgba(0,0,0,0.82),0_0_1px_rgba(0,0,0,0.72)]";
const etchedTextDeep = "[text-shadow:0_-1px_0_rgba(255,255,255,0.2),0_1px_0_rgba(0,0,0,0.86),0_2px_8px_rgba(0,0,0,0.55)]";

export default function DeveloperPlaque({
    className,
    variant = "full",
    title = "GOLEM PROTOCOL",
    subtitle = "AUTONOMOUS LOGIC UNIT",
    roleLabel = "LEAD ARCHITECTS",
    developers = "ARVIN CHEN & ALAN WANG",
    origin = "ORIGIN: JAN 2026",
}: DeveloperPlaqueProps) {
    if (variant === "indicator") {
        return (
            <section
                aria-label="Developer Nameplate Indicator"
                className={cn(
                    "enterprise-card h-full relative overflow-hidden rounded-2xl border border-zinc-700/65",
                    "bg-gradient-to-b from-zinc-700/35 via-zinc-800/70 to-zinc-950/95",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.65),0_10px_30px_-18px_rgba(0,0,0,0.75)]",
                    "p-4",
                    className
                )}
            >
                <div
                    className={cn(
                        "pointer-events-none absolute inset-0 opacity-30",
                        "[background-image:repeating-linear-gradient(90deg,rgba(255,255,255,0.08)_0,rgba(255,255,255,0.08)_1px,transparent_1px,transparent_3px)]"
                    )}
                />
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_70%_at_50%_50%,transparent_28%,rgba(0,0,0,0.5)_100%)]" />
                <div className="pointer-events-none absolute inset-[2px] rounded-[0.95rem] border border-white/8" />

                <div className="relative z-10 h-full flex flex-col justify-between items-center text-center">
                    <div className="w-full">
                        <p className={cn("text-[9px] uppercase tracking-[0.28em] text-zinc-400/75", etchedTextSoft)}>
                            {subtitle}
                        </p>
                        <h3 className={cn("mt-2 text-xl font-semibold tracking-[0.07em] text-zinc-100/92", etchedTextDeep)}>
                            {title}
                        </h3>
                    </div>

                    <div className="pt-4 border-t border-zinc-600/35 w-full">
                        <p className={cn("text-[9px] uppercase tracking-[0.22em] text-zinc-400/70", etchedTextSoft)}>
                            {roleLabel}
                        </p>
                        <p className={cn("mt-1 text-xs tracking-[0.08em] text-zinc-100/85", etchedTextDeep)}>
                            {developers}
                        </p>
                        <p className={cn("mt-2 text-[9px] uppercase tracking-[0.18em] text-zinc-500/75", etchedTextSoft)}>
                            {origin}
                        </p>
                    </div>
                </div>

                <span className="absolute left-3 top-3 size-2.5 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
                <span className="absolute right-3 top-3 size-2.5 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
                <span className="absolute left-3 bottom-3 size-2.5 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
                <span className="absolute right-3 bottom-3 size-2.5 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
            </section>
        );
    }

    return (
        <section
            aria-label="Developer Nameplate"
            className={cn(
                "relative overflow-hidden rounded-3xl border border-zinc-700/60",
                "bg-gradient-to-b from-zinc-700/45 via-zinc-800/75 to-zinc-950/95",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.65),0_24px_60px_-40px_rgba(0,0,0,0.9)]",
                "px-5 py-6 sm:px-8 sm:py-8",
                className
            )}
        >
            <div
                className={cn(
                    "pointer-events-none absolute inset-0 opacity-40",
                    "[background-image:repeating-linear-gradient(90deg,rgba(255,255,255,0.08)_0,rgba(255,255,255,0.08)_1px,transparent_1px,transparent_3px)]"
                )}
            />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_70%_at_50%_50%,transparent_35%,rgba(0,0,0,0.45)_100%)]" />
            <div className="pointer-events-none absolute inset-[2px] rounded-[1.3rem] border border-white/8" />

            <div className="relative z-10 text-center">
                <p className={cn("text-[10px] sm:text-xs uppercase tracking-[0.38em] text-zinc-400/80", etchedTextSoft)}>
                    {subtitle}
                </p>
                <h2 className={cn("mt-4 text-3xl sm:text-5xl font-semibold tracking-[0.08em] text-zinc-200/95", etchedTextDeep)}>
                    {title}
                </h2>

                <div className="mx-auto mt-5 h-px w-full max-w-md bg-gradient-to-r from-transparent via-zinc-500/55 to-transparent" />

                <p className={cn("mt-5 text-[10px] sm:text-xs uppercase tracking-[0.32em] text-zinc-400/75", etchedTextSoft)}>
                    {roleLabel}
                </p>
                <p className={cn("mt-3 text-lg sm:text-3xl tracking-[0.06em] text-zinc-100/92", etchedTextDeep)}>
                    {developers}
                </p>
                <p className={cn("mt-5 text-[10px] sm:text-xs uppercase tracking-[0.22em] text-zinc-500/75 text-center", etchedTextSoft)}>
                    {origin}
                </p>
            </div>

            <span className="absolute left-4 top-4 size-3 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
            <span className="absolute right-4 top-4 size-3 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
            <span className="absolute left-4 bottom-4 size-3 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
            <span className="absolute right-4 bottom-4 size-3 rounded-full border border-zinc-800 bg-zinc-950 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" />
        </section>
    );
}
