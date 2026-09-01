"use client";

import { type ReactNode } from "react";
import { LucideIcon } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { cn } from "@/lib/utils";
export type DashboardMetricCard = {
    id: string;
    title: string;
    value: string | number;
    icon: LucideIcon;
    data?: Record<string, number | string>[];
    dataKey?: string;
    color?: string;
};

type DashboardMetricsGridProps = {
    cards: DashboardMetricCard[];
    fixedIndicator?: {
        node: ReactNode;
        className?: string;
    };
};

export default function DashboardMetricsGrid({ cards, fixedIndicator }: DashboardMetricsGridProps) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {fixedIndicator && (
                <div className={cn("h-full", fixedIndicator.className)}>
                    {fixedIndicator.node}
                </div>
            )}
            {cards.map((card) => (
                <MetricCard
                    key={card.id}
                    title={card.title}
                    value={card.value}
                    icon={card.icon}
                    data={card.data}
                    dataKey={card.dataKey}
                    color={card.color}
                />
            ))}
        </div>
    );
}
