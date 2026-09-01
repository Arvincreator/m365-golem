"use client";

import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface TypewriterProps {
    content: string;
    speed?: number; // ms per char
    onComplete?: () => void;
}

export function Typewriter({ content, speed = 20, onComplete }: TypewriterProps) {
    const [displayedContent, setDisplayedContent] = useState("");
    const indexRef = useRef(0);
    const onCompleteRef = useRef(onComplete);

    useEffect(() => {
        onCompleteRef.current = onComplete;
    }, [onComplete]);

    useEffect(() => {
        // Reset when content changes completely (e.g., new message)
        // If content is just appending, we don't want to reset
        // For our use case, `content` is a static string passed in, and we animate it
        let interval: ReturnType<typeof setInterval> | null = null;

        const startTyping = () => {
            setDisplayedContent("");
            indexRef.current = 0;
            const chars = Array.from(content);

            interval = setInterval(() => {
                if (indexRef.current < chars.length) {
                    const char = chars[indexRef.current];
                    setDisplayedContent((prev) => prev + char);
                    indexRef.current += 1;
                } else if (interval) {
                    clearInterval(interval);
                    interval = null;
                    if (onCompleteRef.current) onCompleteRef.current();
                }
            }, speed);
        };

        const rafId = requestAnimationFrame(startTyping);

        return () => {
            cancelAnimationFrame(rafId);
            if (interval) clearInterval(interval);
        };
    }, [content, speed]);

    return (
        <div className="prose dark:prose-invert prose-sm max-w-none prose-p:m-0 prose-headings:my-1 prose-pre:my-1 prose-pre:bg-zinc-950 dark:prose-pre:bg-gray-950 prose-pre:border prose-pre:border-border dark:prose-pre:border-gray-800 prose-ul:list-disc prose-ul:ml-4 prose-ol:list-decimal prose-ol:ml-4 prose-li:m-0 leading-snug [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayedContent}
            </ReactMarkdown>
        </div>
    );
}
