import type { ExchangeBatch } from './exchange-types'

// 批次单独存一份，不走 entries 缓存：多个终端（标签页）并发时必须直读 localStorage，
// 才能用版本号做比较交换（CAS），保证同一批次只落下一个完成标记。
const BATCH_STORAGE_KEY = 'hydrology-monitor-station:rainfall-exchange-batches'
const TERMINAL_KEY = 'hydrology-monitor-station:terminal-id'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readBatches(): ExchangeBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(BATCH_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as ExchangeBatch[]
  } catch {
    return []
  }
}

export function writeBatches(batches: ExchangeBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches))
  }
}

export function findBatch(id: string): ExchangeBatch | undefined {
  return readBatches().find((batch) => batch.id === id)
}

export function findBatchByFingerprint(fingerprint: string): ExchangeBatch | undefined {
  return readBatches().find((batch) => batch.fileFingerprint === fingerprint)
}

export function upsertBatch(next: ExchangeBatch): void {
  const batches = readBatches()
  const index = batches.findIndex((batch) => batch.id === next.id)
  if (index >= 0) {
    batches[index] = clone(next)
  } else {
    batches.unshift(clone(next))
  }
  writeBatches(batches)
}

// 带版本号的比较交换：expectedVersion 与磁盘一致才写入，返回最新批次。
// 多个终端同时确认时，只有第一个的版本能对上，其余拿到失败结果。
export function compareAndSwapBatch(
  id: string,
  expectedVersion: number,
  mutate: (batch: ExchangeBatch) => ExchangeBatch,
): { ok: boolean; batch: ExchangeBatch } {
  const batches = readBatches()
  const index = batches.findIndex((batch) => batch.id === id)
  if (index < 0) {
    return { ok: false, batch: clone(batches[0]) as ExchangeBatch }
  }
  const current = batches[index]
  if (current.confirmVersion !== expectedVersion) {
    return { ok: false, batch: clone(current) }
  }
  const next = mutate(clone(current))
  next.confirmVersion = expectedVersion + 1
  batches[index] = next
  writeBatches(batches)
  return { ok: true, batch: clone(next) }
}

export function currentTerminalId(): string {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return 'TERM-console'
  }
  let id = window.sessionStorage.getItem(TERMINAL_KEY)
  if (!id) {
    id = `TERM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
    window.sessionStorage.setItem(TERMINAL_KEY, id)
  }
  return id
}
