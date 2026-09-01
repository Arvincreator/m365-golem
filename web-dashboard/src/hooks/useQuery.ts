"use client";

import { DependencyList, useCallback, useEffect, useRef, useState } from "react";

type UseQueryOptions = {
    enabled?: boolean;
};

export function useQuery<T>(
    queryFn: () => Promise<T>,
    deps: DependencyList = [],
    options: UseQueryOptions = {}
) {
    const enabled = options.enabled ?? true;
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(enabled);
    const inFlightRef = useRef(false);

    const execute = useCallback(async () => {
        if (!enabled || inFlightRef.current) return;
        inFlightRef.current = true;
        setIsLoading(true);
        setError(null);
        try {
            const result = await queryFn();
            setData(result);
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            setError(err);
        } finally {
            inFlightRef.current = false;
            setIsLoading(false);
        }
    }, [enabled, queryFn]);

    useEffect(() => {
        void execute();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [execute, ...deps]);

    return {
        data,
        error,
        isLoading,
        refetch: execute,
    };
}
