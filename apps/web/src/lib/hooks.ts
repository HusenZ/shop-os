import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { call, type ArgsOf, type Method, type ResultOf } from './rpc';

/** Reads from the local database. Every write invalidates all queries (the DB is local and fast). */
export function useQ<M extends Method>(method: M, args: ArgsOf<M>, opts: Partial<UseQueryOptions<ResultOf<M>>> = {}) {
  return useQuery<ResultOf<M>>({
    queryKey: [method, ...(args as unknown[])],
    queryFn: () => (call as any)(method, ...(args as unknown[])),
    ...opts,
  });
}

export function useAct() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ method, args }: { method: Method; args: unknown[]; success?: string }) => (call as any)(method, ...args),
    onSuccess: (_d, v) => {
      qc.invalidateQueries();
      if (v.success) toast.success(v.success);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
  return {
    pending: m.isPending,
    /** Runs a write; resolves with the result, or rejects after showing a toast. */
    run<M extends Method>(method: M, args: ArgsOf<M>, success?: string): Promise<ResultOf<M>> {
      return m.mutateAsync({ method, args: args as unknown[], success });
    },
  };
}

export function useSession() {
  return useQ('session', [], { staleTime: 5000 });
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useDebounced<T>(value: T, ms = 150) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useHotkey(key: string, fn: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === key) fn(e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
