"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

/**
 * React Error Boundary — catches component crashes and shows
 * a recoverable error UI instead of a blank screen.
 */
export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        this.setState({ errorInfo });
        console.error("🔴 [ErrorBoundary] Component crashed:", error, errorInfo);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null, errorInfo: null });
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div
                    className="flex flex-col items-center justify-center gap-4 p-8
                               rounded-lg border border-destructive/50 bg-destructive/10
                               text-foreground"
                    role="alert"
                >
                    <div className="text-4xl">💥</div>
                    <h2 className="text-lg font-semibold">
                        Something went wrong
                    </h2>
                    <p className="text-sm text-muted-foreground max-w-md text-center">
                        {this.state.error?.message || "An unexpected error occurred"}
                    </p>
                    <button
                        onClick={this.handleReset}
                        className="rounded-md bg-primary px-4 py-2 text-sm
                                   text-primary-foreground hover:opacity-90
                                   transition-opacity focus:outline-none
                                   focus:ring-2 focus:ring-ring"
                    >
                        Try Again
                    </button>
                    {this.state.errorInfo && (
                        <details className="mt-2 w-full max-w-lg">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                                Technical Details
                            </summary>
                            <pre className="mt-2 overflow-auto rounded bg-secondary p-3
                                          text-xs text-muted-foreground max-h-40">
                                {this.state.errorInfo.componentStack}
                            </pre>
                        </details>
                    )}
                </div>
            );
        }

        return this.props.children;
    }
}
