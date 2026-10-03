import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
export const ENTRIES_UPDATED_EVENT = 'hydrology-monitor-station:entries-updated'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // 同标签页不触发 storage 事件，主动广播让已打开的清单页（如水位整编）刷新。
    window.dispatchEvent(new CustomEvent(ENTRIES_UPDATED_EVENT, { detail: { key } }))
  }
}

// 其他模块（如资料交换台）直接改了 entries 存储后，通知本模块缓存作废。
export function invalidateCache(): void {
  cache = null
}

if (typeof window !== 'undefined') {
  const dropCache = () => {
    cache = null
  }
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) {
      dropCache()
    }
  })
  window.addEventListener(ENTRIES_UPDATED_EVENT, dropCache)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
