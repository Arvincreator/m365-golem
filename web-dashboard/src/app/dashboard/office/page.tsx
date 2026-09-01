"use client";

import { useEffect, useState, useRef } from "react";
import { socket } from "@/lib/socket";
import { ChatBubble } from "@/components/ChatBubble";

interface ChatMessage {
    id: string;
    role: "user" | "brain" | "memory" | "action" | "system" | string;
    text: string;
    timestamp: number;
}

type TeamType = "default" | "tech";

interface OfficeItem {
    id: string;
    type: "character" | "prop";
    name: string;
    src: string;
    x: number; // percentage
    y: number; // percentage
    zIndex: number;
    team: TeamType | "all";
    width: number; // px or string class? let's stick to standard w/h or classes
    height: number;
    label?: string;
    labelColor?: string;
    labelBorder?: string;
}

type Message = ChatMessage; // Alias for clarity with the snippet

type OfficeLogPayload = {
    msg?: string;
    raw?: string;
    cleanMsg?: string;
};

function isOfficeLogPayload(payload: unknown): payload is OfficeLogPayload {
    if (!payload || typeof payload !== "object") return false;
    const data = payload as Record<string, unknown>;
    return typeof data.msg === "string" || typeof data.raw === "string" || typeof data.cleanMsg === "string";
}

function extractGolemReplyOnly(rawText: string): string {
    const text = String(rawText || "").trim();
    if (!text) return "";

    const cleaned = text.replace(/^🤖\s*\[Golem\]\s*說:\s*/i, "").trim();
    const hasTitanTags = /\[GOLEM_(MEMORY|ACTION|REPLY)\]/i.test(cleaned);
    const replyMatch = cleaned.match(/\[GOLEM_REPLY\]([\s\S]*?)(?=\[\/?GOLEM_[A-Z]+\]|$)/i);

    if (replyMatch && replyMatch[1]) {
        return replyMatch[1].trim();
    }
    if (hasTitanTags) {
        return "";
    }
    return cleaned;
}

const DEFAULT_LAYOUT: OfficeItem[] = [
    // Characters
    { id: 'user', type: 'character', name: 'user', src: '/characters/user.png', x: 8, y: 75, zIndex: 40, team: 'all', width: 192, height: 192 },
    { id: 'alex', type: 'character', name: 'alex', src: '/characters/alex.png', x: 28, y: 65, zIndex: 30, team: 'tech', width: 176, height: 176, label: 'ALEX (FE)', labelColor: 'text-cyan-400', labelBorder: 'border-cyan-800' },
    { id: 'bob', type: 'character', name: 'bob', src: '/characters/bob.png', x: 50, y: 75, zIndex: 20, team: 'tech', width: 128, height: 128, label: 'BOB (BE)', labelColor: 'text-orange-400', labelBorder: 'border-orange-800' },
    { id: 'carol', type: 'character', name: 'carol', src: '/characters/carol.png', x: 72, y: 75, zIndex: 20, team: 'tech', width: 128, height: 128, label: 'CAROL (PM)', labelColor: 'text-pink-400', labelBorder: 'border-pink-800' },

    // Props
    { id: 'bookshelf', type: 'prop', name: 'bookshelf', src: '/props/bookshelf.png', x: 85, y: 25, zIndex: 0, team: 'default', width: 96, height: 128 },
    { id: 'bean_bag', type: 'prop', name: 'bean_bag', src: '/props/bean_bag.png', x: 60, y: 60, zIndex: 20, team: 'default', width: 96, height: 96 },
    { id: 'meeting_group', type: 'prop', name: 'meeting_group', src: '/props/meeting_group.png', x: 55, y: 35, zIndex: 20, team: 'default', width: 400, height: 300 },

    { id: 'tech_rack_l', type: 'prop', name: 'server_rack', src: '/props/server_rack.png', x: 8, y: 42, zIndex: 10, team: 'tech', width: 96, height: 192 },
    { id: 'tech_rack_r', type: 'prop', name: 'server_rack', src: '/props/server_rack.png', x: 84, y: 34, zIndex: 10, team: 'tech', width: 96, height: 192 },
    { id: 'drone_dock', type: 'prop', name: 'drone_dock', src: '/office-assets/tech/drone_dock.png', x: 65, y: 27, zIndex: 20, team: 'tech', width: 150, height: 150 },
    { id: 'arcade', type: 'prop', name: 'arcade', src: '/office-assets/tech/arcade.png', x: 84, y: 58, zIndex: 20, team: 'tech', width: 128, height: 128 },

    // New Decorations
];

export default function OfficePage() {
    const [messageHistory, setMessageHistory] = useState<ChatMessage[]>([]);
    const [selectedTeam, setSelectedTeam] = useState<TeamType>('default');
    const [isLogExpanded, setIsLogExpanded] = useState(true);
    const [activeMessages, setActiveMessages] = useState<Record<string, Message | null>>({
        user: null, brain: null, memory: null, action: null,
        alex: null, bob: null, carol: null
    });
    const [isTeamDropdownOpen, setIsTeamDropdownOpen] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const logConsoleRef = useRef<HTMLDivElement>(null);
    const timersRef = useRef<Record<string, NodeJS.Timeout | null>>({});

    // Handle outside clicks for the dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsTeamDropdownOpen(false);
            }
        };

        if (isTeamDropdownOpen) {
            document.addEventListener("mousedown", handleClickOutside);
        } else {
            document.removeEventListener("mousedown", handleClickOutside);
        }

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [isTeamDropdownOpen]);

    // Auto-scroll the log console to bottom when messageHistory changes
    useEffect(() => {
        if (logConsoleRef.current) {
            logConsoleRef.current.scrollTop = logConsoleRef.current.scrollHeight;
        }
    }, [messageHistory]);

    useEffect(() => {
        const handleLog = (payload: unknown) => {
            if (!isOfficeLogPayload(payload)) return;
            const logData = payload;
            if (!logData || (!logData.msg && !logData.raw)) return;
            const text = logData.cleanMsg || logData.msg || logData.raw;
            if (!text) return;

            let role: string = "system";
            const lowerText = text.toLowerCase();

            const multiAgentMatch = text.match(/\[MultiAgent\]\s*\[(.*?)\]/i);
            if (multiAgentMatch) {
                const name = multiAgentMatch[1].trim().toLowerCase();
                role = name;
                if (['alex', 'bob', 'carol'].includes(name)) setSelectedTeam('tech');
            } else if (text.includes('🤖 [Golem] 說:') || /\[GOLEM_(MEMORY|ACTION|REPLY)\]/i.test(text)) {
                role = "brain";
            } else if (text.includes('🗣️ [User] 說:') || lowerText.includes('[user]') || lowerText.includes('you:') || lowerText.includes('使用者:')) {
                role = "user";
            }

            if (role === 'system') return;

            let displayText = text;
            if (multiAgentMatch) {
                displayText = text.replace(/\[MultiAgent\]\s*\[.*?\]\s*/i, '').trim();
            } else {
                if (role === "brain") {
                    displayText = extractGolemReplyOnly(text);
                    if (!displayText) return;
                }
                if (role === "user") displayText = text.replace(/🗣️ \[User\] 說:\s*/i, '').trim();
            }

            const newMsg: ChatMessage = {
                id: Math.random().toString(36).substring(7),
                role,
                text: displayText,
                timestamp: Date.now()
            };

            setActiveMessages(prev => ({ ...prev, [role]: newMsg }));
            setMessageHistory(prev => [...prev, newMsg].slice(-100));

            if (timersRef.current[role]) clearTimeout(timersRef.current[role]!);
            timersRef.current[role] = setTimeout(() => {
                setActiveMessages(prev => ({ ...prev, [role]: null }));
            }, role === "user" ? 5000 : 8000);
        };

        socket.on("log", handleLog);
        const timers = timersRef.current;
        return () => {
            socket.off("log", handleLog);
            Object.values(timers).forEach((timer) => timer && clearTimeout(timer));
        };
    }, []);

    return (
        <div className="h-full w-full bg-background p-0 flex flex-col items-center justify-center antialiased">
            <div className="relative w-full h-full bg-card border-8 border-border p-1 shadow-2xl overflow-hidden flex flex-col">
                {/* Top HUD Bar */}
                <div className="w-full bg-secondary border-4 border-border rounded-sm p-2 mb-1 flex justify-between items-center text-foreground text-[10px] z-30">
                    <div className="flex items-center gap-2">
                        <span className="text-primary font-bold drop-shadow-sm whitespace-nowrap hidden md:inline">GOLEM DEV STORY</span>

                        <div className="relative ml-2" ref={dropdownRef}>
                            <button
                                onClick={() => setIsTeamDropdownOpen(!isTeamDropdownOpen)}
                                className="px-3 py-1 border-2 border-border bg-background text-[8px] font-bold text-foreground hover:bg-accent transition-all flex items-center gap-2"
                            >
                                👥 {selectedTeam === 'default' ? 'MAIN OFFICE' : selectedTeam.toUpperCase() + ' SESSION'} <span className="text-[6px]">▼</span>
                            </button>
                            {isTeamDropdownOpen && (
                                <div className="absolute top-full left-0 mt-1 w-48 bg-card border-4 border-border flex flex-col z-[60] shadow-xl">
                                    <button onClick={() => { setSelectedTeam("default"); setIsTeamDropdownOpen(false); }} className="p-2 text-[8px] text-left hover:bg-accent hover:text-accent-foreground border-b-2 border-border/20">🏠 MAIN OFFICE</button>
                                    <button onClick={() => { setSelectedTeam("tech"); setIsTeamDropdownOpen(false); }} className="p-2 text-[8px] text-left hover:bg-primary/20 hover:text-primary">💻 TECH TEAM</button>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex gap-1 md:gap-2 ml-auto">
                        {/* No filters */}
                    </div>
                </div>

                {/* Inner Room Area */}
                <div
                    ref={containerRef}
                    className="flex-1 relative bg-center bg-no-repeat border-4 border-border rounded-sm overflow-hidden z-0 shadow-[inset_0_20px_50px_rgba(0,0,0,0.5)] transition-all duration-700"
                    style={{
                        backgroundImage: selectedTeam === 'tech' ? "url('/pixel_bg_tech.png')" : "url('/office_bg.png')",
                        backgroundColor: selectedTeam === 'tech' ? '#0a0a2a' : '#3B5B8C',
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        imageRendering: 'pixelated'
                    }}
                >
                    {DEFAULT_LAYOUT.filter(item => item.team === 'all' || item.team === selectedTeam).map((item) => (
                        <div
                            key={item.id}
                            className="absolute flex flex-col items-center group transition-all duration-300"
                            style={{
                                left: `${item.x}%`,
                                top: `${item.y}%`,
                                transform: 'translate(-50%, -50%)',
                                zIndex: item.zIndex,
                                width: item.width,
                                height: item.height,
                            }}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={item.src}
                                alt={item.name}
                                className={`w-full h-full object-contain ${item.name === 'user' ? 'drop-shadow-[-5px_5px_8px_rgba(0,0,0,0.6)]' : 'drop-shadow-[0px_10px_15px_rgba(0,0,0,0.5)]'} transition-transform`}
                            />

                            {item.label && (
                                <span className={`absolute bottom-[-10px] text-[7px] font-bold p-1 bg-black/80 rounded uppercase border whitespace-nowrap ${item.labelColor} ${item.labelBorder}`}>
                                    {item.label}
                                </span>
                            )}

                            {activeMessages[item.name] && (
                                <div className={`absolute z-50 ${item.name === 'user' ? 'top-[-115px] left-[60px] min-w-[200px]' : 'top-[-115px] w-[240px]'}`}>
                                    <ChatBubble role={item.name} text={activeMessages[item.name]!.text} />
                                </div>
                            )}

                            {item.id === 'meeting_group' && selectedTeam === 'default' && (
                                <>
                                    {activeMessages.action && <div className="absolute top-[10px] left-[-170px] min-w-[200px] z-50"><ChatBubble role="action" text={activeMessages.action.text} /></div>}
                                    {activeMessages.brain && <div className="absolute top-[-135px] left-[-50px] min-w-[240px] z-50"><ChatBubble role="brain" text={activeMessages.brain.text} /></div>}
                                    {activeMessages.memory && <div className="absolute top-[-65px] left-[320px] min-w-[200px] z-50"><ChatBubble role="memory" text={activeMessages.memory.text} /></div>}
                                </>
                            )}
                        </div>
                    ))}
                </div>

                {/* Bottom HUD bar */}
                <div className="w-full bg-secondary border-4 border-border border-t-0 p-2 flex justify-between items-center text-[8px] md:text-[10px] text-foreground z-40">
                    <div className="flex items-center gap-4">
                        <span className="text-primary font-bold">PROJECT: <span className="text-foreground font-normal ml-2">Multi-Agent System v2.0</span></span>
                        <span className="text-muted-foreground">|</span>
                    </div>

                    <div className="flex items-center gap-4">
                        <span className="text-primary font-bold">CURRENT SCENE: <span className="text-accent-foreground ml-2 uppercase">{selectedTeam} {selectedTeam !== 'default' ? 'STUDIO' : 'OFFICE'}</span></span>
                        <button
                            onClick={() => setIsLogExpanded(!isLogExpanded)}
                            className="bg-card/60 border-2 border-primary px-2 py-0.5 text-primary hover:bg-card transition-colors transform active:scale-95 flex items-center gap-1 font-bold"
                        >
                            {isLogExpanded ? 'CLOSE LOG ▲' : 'OPEN LOG ▼'}
                        </button>
                    </div>
                </div>

                <div
                    ref={logConsoleRef}
                    className={`w-full bg-card/90 border-4 border-border border-t-0 p-2 overflow-y-auto font-mono text-[10px] text-primary custom-scrollbar flex flex-col gap-1 z-40 shrink-0 shadow-[inset_0_2px_10px_rgba(0,0,0,0.3)] transition-all duration-500 origin-bottom ${isLogExpanded ? 'h-32 opacity-100' : 'h-0 opacity-0 py-0 border-b-0'}`}
                >
                    {messageHistory.length === 0 ? (
                        <div className="text-gray-500 italic">Waiting for system logs...</div>
                    ) : (
                        messageHistory.map((msg) => (
                            <div key={msg.id} className="border-b border-green-900/40 pb-1 mb-1">
                                <span className={
                                    msg.role === 'user' ? 'text-cyan-400 font-bold' :
                                        msg.role === 'brain' ? 'text-yellow-400 font-bold' :
                                            msg.role === 'memory' ? 'text-purple-400 font-bold' :
                                                'text-red-400 font-bold'
                                }>[{msg.role.toUpperCase()}]</span>
                                <span className="text-gray-500 ml-1">{(new Date(msg.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                <div className="mt-1 text-white/90 whitespace-pre-wrap pl-2 border-l-2 border-gray-700 ml-1">{msg.text}</div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
