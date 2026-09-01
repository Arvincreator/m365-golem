"use client";

import { AgentChat } from "@/components/AgentChat";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function AgentsPage() {
    return (
        <div className="p-6 h-full flex flex-col space-y-6">
            <div className="flex justify-between items-center">
                <h1 className="text-2xl font-bold text-foreground tracking-tight">Agent War Room</h1>
                <div className="flex space-x-2">
                    <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full border border-primary/20 flex items-center">
                        <span className="w-2 h-2 bg-primary rounded-full mr-2 animate-pulse"></span>
                        Live Session
                    </span>
                </div>
            </div>

            <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-6 min-h-0">
                <div className="lg:col-span-3 flex flex-col min-h-0">
                    <AgentChat />
                </div>

                <div className="space-y-4">
                    <Card className="bg-card border-border shadow-md">
                        <CardHeader>
                            <CardTitle className="text-sm">Active Agents</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            <div className="flex items-center space-x-2 p-2 bg-secondary/50 rounded hover:bg-secondary transition-colors cursor-pointer">
                                <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                                <span className="text-sm text-foreground/80">Planner</span>
                            </div>
                            <div className="flex items-center space-x-2 p-2 bg-secondary/50 rounded hover:bg-secondary transition-colors cursor-pointer">
                                <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                                <span className="text-sm text-foreground/80">Coder</span>
                            </div>
                            <div className="flex items-center space-x-2 p-2 bg-secondary/50 rounded hover:bg-secondary transition-colors cursor-pointer">
                                <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                                <span className="text-sm text-foreground/80">Reviewer</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card className="bg-card border-border shadow-md">
                        <CardHeader>
                            <CardTitle className="text-sm">Session Stats</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="text-xs text-muted-foreground space-y-1">
                                <div className="flex justify-between">
                                    <span>Topic:</span>
                                    <span className="text-foreground">Active</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Tokens:</span>
                                    <span className="text-foreground">--</span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
