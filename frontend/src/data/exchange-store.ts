import type { BatchState, ChecklistResult, ChecklistStatus, ExchangeBatch } from './exchange-types'

// 交换台与水位整编清单各自独立存一个 key：回填雨量台账走 ENTRIES，互不干扰。
const BATCH_KEY = 'hydrology-monitor-station:rainfall-exchange-batches'
const CHECKLIST_KEY = 'hydrology-monitor-station:waterlevel-checklist'

// 同浏览器里多个终端 = 多个标签页：广播变更让其它终端立刻刷新批次视图。
export const EXCHANGE_CHANNEL = 'hydrology-monitor-station:rainfall-exchange'

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(key, JSON.stringify(value))
}

function notify(kind: 'batch' | 'checklist'): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const channel = new BroadcastChannel(EXCHANGE_CHANNEL)
    channel.postMessage({ kind, at: Date.now() })
    channel.close()
  } catch {
    // 老浏览器没有 BroadcastChannel 时，storage 事件仍能跨标签页通知。
  }
}

let batchCache: ExchangeBatch[] | null = null
let checklistCache: ChecklistResult[] | null = null

export function listBatches(): ExchangeBatch[] {
  if (batchCache === null) {
    batchCache = readJson<ExchangeBatch[]>(BATCH_KEY, [])
  }
  return batchCache
}

export function saveBatches(batches: ExchangeBatch[]): void {
  batchCache = batches
  writeJson(BATCH_KEY, batches)
  notify('batch')
}

export function listChecklist(): ChecklistResult[] {
  if (checklistCache === null) {
    checklistCache = readJson<ChecklistResult[]>(CHECKLIST_KEY, [])
  }
  return checklistCache
}

export function saveChecklist(items: ChecklistResult[]): void {
  checklistCache = items
  writeJson(CHECKLIST_KEY, items)
  notify('checklist')
}

/** 丢弃内存缓存：收到别的终端的 storage/广播通知后调用。 */
export function invalidateExchangeCache(kind?: 'batch' | 'checklist'): void {
  if (!kind || kind === 'batch') {
    batchCache = null
  }
  if (!kind || kind === 'checklist') {
    checklistCache = null
  }
}

/**
 * 批次确认的原子提交：在「读取最新存储 -> CAS 写回」一次同步过程内完成
 * 「检查是否已有完成标记 + 生成待核对成果」。JS 单线程，多个标签页的
 * 确认动作各自是一次同步事务，因此只有第一个终端能写入成果，后到的终端
 * 重新读取时发现批次已被确认，只能拿到「已被终端 X 完成」的结果。
 */
export function confirmBatchCas(
  batchId: number,
  terminalId: string,
  buildResult: (batch: ExchangeBatch, nextResultId: number) => ChecklistResult,
): { ok: boolean; batch: ExchangeBatch | null; result: ChecklistResult | null; message: string } {
  const batches = readJson<ExchangeBatch[]>(BATCH_KEY, [])
  const index = batches.findIndex((item) => item.id === batchId)
  if (index < 0) {
    return { ok: false, batch: null, result: null, message: `批次 ${batchId} 不存在，可能已被其它终端清理` }
  }
  const batch = batches[index]
  if (batch.state === '已确认') {
    return {
      ok: false,
      batch,
      result: null,
      message: `批次 ${batch.batchNo} 已由终端 ${batch.confirmedBy ?? '未知'} 完成确认，本终端的完成标记未被接受`,
    }
  }
  if (batch.pendingCount > 0) {
    return { ok: false, batch, result: null, message: `批次还有 ${batch.pendingCount} 行未处理完，不能确认` }
  }

  const checklist = readJson<ChecklistResult[]>(CHECKLIST_KEY, [])
  // 双保险：即使批次状态异常，同批次也绝不重复产出成果。
  if (checklist.some((item) => item.batchNo === batch.batchNo)) {
    return {
      ok: false,
      batch,
      result: null,
      message: `水位整编清单里已存在批次 ${batch.batchNo} 的待核对成果，只接受一个完成标记`,
    }
  }

  const nextId = checklist.reduce((max, item) => Math.max(max, item.id), 0) + 1
  const result = buildResult(batch, nextId)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const confirmed: ExchangeBatch = {
    ...batch,
    state: '已确认' as BatchState,
    lease: null,
    confirmedAt: now,
    confirmedBy: terminalId,
    checklistId: result.id,
  }
  const nextBatches = [...batches]
  nextBatches[index] = confirmed

  batchCache = nextBatches
  checklistCache = [...checklist, result]
  writeJson(BATCH_KEY, nextBatches)
  writeJson(CHECKLIST_KEY, checklistCache)
  notify('batch')
  notify('checklist')
  return { ok: true, batch: confirmed, result, message: `批次已确认，水位整编清单新增待核对成果 ${result.resultNo}` }
}

export function setChecklistStatus(id: number, status: ChecklistStatus, note: string): ChecklistResult | null {
  const items = listChecklist()
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) {
    return null
  }
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const updated: ChecklistResult = {
    ...items[index],
    status,
    checkedAt: now,
    checkNote: note,
  }
  const next = [...items]
  next[index] = updated
  saveChecklist(next)
  return updated
}
