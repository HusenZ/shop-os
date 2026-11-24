import type { BackupHeader, HealthCheck, ShopApi, SyncReport } from '@shopos/core';

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Special {
  init(): { mode: 'opfs' | 'memory'; schemaVersion: number; appVersion: string; deviceId: string };
  exportBackup(passphrase?: string): Uint8Array;
  inspectBackup(file: Uint8Array): BackupHeader;
  restoreBackup(file: Uint8Array, passphrase?: string): { header: BackupHeader; health: { ok: boolean; checks: HealthCheck[] } };
  resetShop(): boolean;
  sync(): SyncReport;
  applyEnrolment(info: { url: string; orgId: string; deviceToken: string; seriesCode: string; email: string; jwt?: string }): boolean;
  disconnectHub(): boolean;
  storageEstimate(): { mode: string; usage: number | null; quota: number | null };
}

type All = ShopApi & Special;
export type Method = keyof All;
export type ArgsOf<M extends Method> = Parameters<All[M]>;
export type ResultOf<M extends Method> = Awaited<ReturnType<All[M]>>;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

export function startWorker() {
  if (worker) return;
  worker = new Worker(new URL('../db/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, ok, result, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new AppError(error.message, error.code));
  };
}

export function stopWorker() {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new AppError('ShopOS was opened in another tab', 'stopped'));
  pending.clear();
}

export function call<M extends Method>(method: M, ...args: ArgsOf<M>): Promise<ResultOf<M>> {
  if (!worker) startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const transfer = (args as unknown[]).filter((a): a is Uint8Array => a instanceof Uint8Array).map((a) => a.buffer);
    worker!.postMessage({ id, method, args }, transfer as Transferable[]);
  });
}
