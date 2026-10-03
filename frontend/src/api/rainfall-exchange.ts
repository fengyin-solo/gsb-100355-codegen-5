import { listRows, mergeRows } from '@/data/local-store'
import {
  confirmBatchCas,
  listBatches,
  listChecklist,
  saveBatches,
  setChecklistStatus,
} from '@/data/exchange-store'
import type {
  BatchState,
  ChecklistResult,
  ChecklistStatus,
  ExchangeBatch,
  ImportRow,
} from '@/data/exchange-types'
import type { EntryRow } from '@/data/types'

// ---------------------------------------------------------------------------
// 字段映射口径（导入文件字段与现有观测记录不一致时，按这张别名表决定怎么对应）
// ---------------------------------------------------------------------------

export const STANDARD_FIELDS = ['站点编号', '观测时段', '时段雨量', '日累计雨量', '降雨强度', '观测人'] as const
export type StandardField = (typeof STANDARD_FIELDS)[number]
export const REQUIRED_FIELDS: StandardField[] = ['站点编号', '观测时段', '时段雨量']

// 「观测时段」支持直接一列，也支持「开始时间 + 结束时间」两列拼出区间。
const FIELD_ALIASES: Array<{ key: StandardField | '时段开始' | '时段结束'; names: string[] }> = [
  { key: '站点编号', names: ['站点编号', '站号', '测站编号', '站码', '站点代码', 'station', 'stcd', 'st_id', 'stationid', 'siteid', 'site_id', '站编'] },
  { key: '观测时段', names: ['观测时段', '时段', '观测时间', '时间', '日期时间', '观测日期', '日期', 'date', 'time', 'datetime', 'tm', 'recordtime', 'obs_time'] },
  { key: '时段开始', names: ['开始时间', '时段开始', '起始时间', '起始时刻', '开始时刻', 'start', 'starttime', 'start_time', 'begin', 'begtm'] },
  { key: '时段结束', names: ['结束时间', '时段结束', '截止时间', '终止时间', '结束时刻', 'end', 'endtime', 'end_time', 'endtm'] },
  { key: '时段雨量', names: ['时段雨量', '时段降水量', '雨量', '降水量', '降雨量', 'rain', 'rainfall', 'p', 'drp', 'rainvalue', 'rain_value', 'amount'] },
  { key: '日累计雨量', names: ['日累计雨量', '日雨量', '日降水量', '日降雨量', '当日累计', 'daily', 'dailyrain', 'daily_rain', 'daytotal', 'day_total', 'dyp'] },
  { key: '降雨强度', names: ['降雨强度', '雨强', '降水强度', '强度', 'intensity', 'rainintensity', 'rain_intensity'] },
  { key: '观测人', names: ['观测人', '观测员', '记录人', '录入人', '值班员', 'observer', 'operator', 'recorder'] },
]

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '')
}

/** 源表头 -> 标准字段的自动映射；识别不出的表头返回 ''，由人工在批次里改。 */
export function autoMapField(header: string): string {
  const target = normalizeHeader(header)
  if (!target) {
    return ''
  }
  let best: string = ''
  let bestLength = 0
  for (const { key, names } of FIELD_ALIASES) {
    for (const name of names) {
      const alias = normalizeHeader(name)
      if ((target === alias || target.includes(alias)) && alias.length > bestLength) {
        best = key
        bestLength = alias.length
      }
    }
  }
  return best
}

export function mappingSummary(fieldMap: Record<string, string>): { mapped: string[]; missing: StandardField[] } {
  const mappedTargets = new Set(Object.values(fieldMap).filter(Boolean))
  const hasPeriod =
    mappedTargets.has('观测时段') || (mappedTargets.has('时段开始') && mappedTargets.has('时段结束'))
  const missing: StandardField[] = []
  if (!mappedTargets.has('站点编号')) missing.push('站点编号')
  if (!hasPeriod) missing.push('观测时段')
  if (!mappedTargets.has('时段雨量')) missing.push('时段雨量')
  return { mapped: [...mappedTargets], missing }
}

// ---------------------------------------------------------------------------
// CSV 解析：支持引号转义、CRLF、BOM；自动识别逗号/分号/Tab 分隔。
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const content = text.replace(/^﻿/, '')
  const delimSample = content.slice(0, 4000)
  const delimCounts = [',', ';', '\t'].map((d) => ({ d, n: delimSample.split(d).length }))
  const delimiter = delimCounts.sort((a, b) => b.n - a.n)[0].d

  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

function csvEscape(value: string | number): string {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

// ---------------------------------------------------------------------------
// 文件指纹：同一文件重复上传只认一个批次。
// ---------------------------------------------------------------------------

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function fileFingerprint(fileName: string, fileSize: number, text: string): string {
  return `${fileName}::${fileSize}::${fnv1a(text).toString(16)}`
}

// ---------------------------------------------------------------------------
// 时段归一化：支持「2026-09-01 08:00~10:00」区间、「2026-09-01 10:00」结束
// 时刻、「2026/9/1 10:00」等写法；旧资料回填用归一化后的口径匹配。
// ---------------------------------------------------------------------------

interface ParsedClock {
  hour: number
  minute: number
}

interface ParsedDate {
  year: number
  month: number
  day: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function parseDateOnly(text: string): ParsedDate | null {
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return { year, month, day }
}

function parseDateClock(text: string): (ParsedDate & ParsedClock) | null {
  const match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null
  }
  return { year, month, day, hour, minute }
}

function parseClockOnly(text: string): ParsedClock | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!match) {
    return null
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    return null
  }
  return { hour, minute }
}

function clockMinutes(clock: ParsedClock): number {
  return clock.hour * 60 + clock.minute
}

function isFullClock(value: ParsedClock): value is ParsedDate & ParsedClock {
  return 'year' in value
}

function shiftDay(date: ParsedDate, delta: number): ParsedDate {
  const next = new Date(date.year, date.month - 1, date.day + delta)
  return { year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate() }
}

export interface NormalizedPeriod {
  /** 落入台账「观测时段」的文本。 */
  text: string
  /** 雨量归属的自然日（日累计按它分组）。 */
  day: string
  /** 区间（分钟），算降雨强度用；只有日期或单时刻为 null。 */
  durationMinutes: number | null
}

export function normalizePeriod(period: string, start: string, end: string): NormalizedPeriod | null {
  const periodText = period.trim()
  const startText = start.trim()
  const endText = end.trim()

  // 口径 1：开始时间 + 结束时间两列拼区间。
  if (startText || endText) {
    if (!startText || !endText) {
      return null
    }
    const s = parseDateClock(startText) ?? parseClockOnly(startText)
    const e = parseDateClock(endText) ?? parseClockOnly(endText)
    if (!s || !e) {
      return null
    }
    if (isFullClock(s) && isFullClock(e)) {
      let { year, month, day } = e
      let duration = clockMinutes(e) - clockMinutes(s)
      if (duration < 0) {
        // 跨日区间：结束时刻在次日，降雨仍按结束时刻所在的自然日归组。
        duration += 24 * 60
        const startDay = shiftDay(e, -1)
        if (startDay.year !== s.year || startDay.month !== s.month || startDay.day !== s.day) {
          return null
        }
      }
      const text = `${s.year}-${pad2(s.month)}-${pad2(s.day)} ${pad2(s.hour)}:${pad2(s.minute)}~${year}-${pad2(month)}-${pad2(day)} ${pad2(e.hour)}:${pad2(e.minute)}`
      return { text, day: `${year}-${pad2(month)}-${pad2(day)}`, durationMinutes: duration }
    }
    return null
  }

  // 口径 2：单元格自带「日期 起始~结束」。
  const range = /^(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)[ T]?(\d{1,2}:\d{2})\s*[~\-—至到]\s*(\d{1,2}:\d{2})$/.exec(periodText)
  if (range) {
    const datePart = parseDateOnly(range[1])
    const s = parseClockOnly(range[2])
    const e = parseClockOnly(range[3])
    if (!datePart || !s || !e) {
      return null
    }
    let endDay: ParsedDate = datePart
    let duration = clockMinutes(e) - clockMinutes(s)
    if (duration < 0) {
      duration += 24 * 60
      endDay = shiftDay(datePart, 1)
    }
    const startText2 = `${datePart.year}-${pad2(datePart.month)}-${pad2(datePart.day)} ${pad2(s.hour)}:${pad2(s.minute)}`
    const finish = `${endDay.year}-${pad2(endDay.month)}-${pad2(endDay.day)} ${pad2(e.hour)}:${pad2(e.minute)}`
    return { text: `${startText2}~${finish}`, day: `${endDay.year}-${pad2(endDay.month)}-${pad2(endDay.day)}`, durationMinutes: duration }
  }

  // 口径 3：完整日期 + 结束时刻。
  const clock = parseDateClock(periodText)
  if (clock) {
    return {
      text: `${clock.year}-${pad2(clock.month)}-${pad2(clock.day)} ${pad2(clock.hour)}:${pad2(clock.minute)}`,
      day: `${clock.year}-${pad2(clock.month)}-${pad2(clock.day)}`,
      durationMinutes: null,
    }
  }

  // 口径 4：只有日期的旧资料，回填时按整日匹配。
  const date = parseDateOnly(periodText)
  if (date) {
    return {
      text: `${date.year}-${pad2(date.month)}-${pad2(date.day)}`,
      day: `${date.year}-${pad2(date.month)}-${pad2(date.day)}`,
      durationMinutes: null,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 数值口径
// ---------------------------------------------------------------------------

function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(/[毫米m\s]/gi, '')
  if (trimmed === '') {
    return null
  }
  // 允许「<0.1」「约0.5」这类带前缀的观测写法。
  const cleaned = trimmed.replace(/^[<>≈约]/, '')
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function formatAmount(value: number): string {
  return String(Math.round(value * 10) / 10)
}

// ---------------------------------------------------------------------------
// 批次登记 / 续传
// ---------------------------------------------------------------------------

function nextBatchId(): number {
  return listBatches().reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function buildBatchNo(): string {
  const now = new Date()
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  return `RB-${stamp}-${String(nextBatchId()).padStart(3, '0')}`
}

function recount(batch: ExchangeBatch): ExchangeBatch {
  const successCount = batch.rows.filter((row) => row.state === '成功').length
  const failCount = batch.rows.filter((row) => row.state === '失败').length
  const pendingCount = batch.rows.filter((row) => row.state === '待处理').length
  const state: BatchState = batch.state === '已确认'
    ? '已确认'
    : pendingCount > 0
      ? '处理中'
      : '待确认'
  return { ...batch, successCount, failCount, pendingCount, state }
}

export type UploadResult =
  | { reused: true; batch: ExchangeBatch; message: string }
  | { reused: false; batch: ExchangeBatch; missing: StandardField[]; message: string }

/**
 * 导入交换文件：
 * - 同一指纹（文件名+大小+内容哈希）重复上传，直接返回原批次，不另建批次；
 * - 新文件按映射口径建批次，行处于「待处理」，等待「从未完成处继续」。
 */
export function registerRainfallFile(
  fileName: string,
  fileSize: number,
  text: string,
  terminalId: string,
): UploadResult {
  const fingerprint = fileFingerprint(fileName, fileSize, text)
  const existing = listBatches().find((batch) => batch.fingerprint === fingerprint)
  if (existing) {
    return {
      reused: true,
      batch: existing,
      message: `该文件已登记为批次 ${existing.batchNo}（状态：${existing.state}），不重复建批，可在原批次从未完成处继续`,
    }
  }

  const grid = parseCsv(text)
  if (grid.length < 2) {
    throw new Error('文件只有表头或没有有效数据行，无法建立交换批次')
  }
  const headers = grid[0].map((cell) => cell.trim())
  const fieldMap: Record<string, string> = {}
  for (const header of headers) {
    fieldMap[header] = autoMapField(header)
  }
  const { missing } = mappingSummary(fieldMap)

  const rows: ImportRow[] = []
  for (let i = 1; i < grid.length; i += 1) {
    const raw: Record<string, string> = {}
    headers.forEach((header, col) => {
      if (header) {
        raw[header] = (grid[i][col] ?? '').trim()
      }
    })
    rows.push({ lineNo: i + 1, raw, state: '待处理', failReason: '', recordId: null, recordNo: '', action: '' })
  }

  const batch: ExchangeBatch = {
    id: nextBatchId(),
    batchNo: buildBatchNo(),
    fileName,
    fileSize,
    fileHash: fnv1a(text),
    fingerprint,
    createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    state: '处理中',
    creatorTerminal: terminalId,
    lease: null,
    fieldMap,
    totalRows: rows.length,
    successCount: 0,
    failCount: 0,
    pendingCount: rows.length,
    rows,
    confirmedAt: null,
    confirmedBy: null,
    checklistId: null,
  }
  saveBatches([...listBatches(), batch])
  const message = missing.length > 0
    ? `批次 ${batch.batchNo} 已建立，${rows.length} 行待处理；必填字段未识别：${missing.join('、')}，请先调整字段映射`
    : `批次 ${batch.batchNo} 已建立，${rows.length} 行待处理`
  return { reused: false, batch, missing, message }
}

/** 人工调整某列表头的映射口径；修正后失败/待处理行会在下一轮继续时重新校验。 */
export function updateFieldMapping(batchId: number, header: string, target: string): ExchangeBatch {
  const batches = listBatches()
  const index = batches.findIndex((item) => item.id === batchId)
  if (index < 0) {
    throw new Error(`批次 ${batchId} 不存在`)
  }
  const batch = batches[index]
  if (batch.state === '已确认') {
    throw new Error('批次已确认，映射口径不能再改')
  }
  const fieldMap = { ...batch.fieldMap, [header]: target }
  // 映射变了：已成功的落点保留，未成功的回到待处理重跑。
  const rows = batch.rows.map((row) =>
    row.state === '成功'
      ? row
      : { ...row, state: '待处理' as const, failReason: '', recordId: null, recordNo: '', action: '' as const },
  )
  const updated = recount({ ...batch, fieldMap, rows })
  const next = [...batches]
  next[index] = updated
  saveBatches(next)
  return updated
}

/** 人工修正失败行的某个标准字段值，修正后该行回到待处理，下一轮续传时重试。 */
export function fixFailedRow(batchId: number, lineNo: number, field: StandardField, value: string): ExchangeBatch {
  const batches = listBatches()
  const index = batches.findIndex((item) => item.id === batchId)
  if (index < 0) {
    throw new Error(`批次 ${batchId} 不存在`)
  }
  const batch = batches[index]
  if (batch.state === '已确认') {
    throw new Error('批次已确认，失败行不能再改')
  }
  const rows = batch.rows.map((row) => {
    if (row.lineNo !== lineNo || row.state === '成功') {
      return row
    }
    const fixes = { ...(row.fixes ?? {}), [field]: value }
    return { ...row, fixes, state: '待处理' as const, failReason: '' }
  })
  const updated = recount({ ...batch, rows })
  const next = [...batches]
  next[index] = updated
  saveBatches(next)
  return updated
}

// ---------------------------------------------------------------------------
// 从未完成处继续：失败行保留原因，只处理待处理行；处理锁防多终端抢同一批。
// ---------------------------------------------------------------------------

const LEASE_MS = 60_000

function leaseValid(lease: ExchangeBatch['lease']): boolean {
  return !!lease && lease.until > Date.now()
}

function rowValue(row: ImportRow, batch: ExchangeBatch, standard: StandardField | '时段开始' | '时段结束'): string {
  if (row.fixes && standard in row.fixes) {
    return row.fixes[standard]
  }
  for (const [header, target] of Object.entries(batch.fieldMap)) {
    if (target === standard) {
      return row.raw[header] ?? ''
    }
  }
  return ''
}

function nextRainfallId(ledger: EntryRow[]): number {
  return ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextRainfallNo(ledger: EntryRow[]): string {
  let max = 0
  for (const row of ledger) {
    const match = /^RAIN-(\d+)$/.exec(String(row['记录编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `RAIN-${String(max + 1).padStart(4, '0')}`
}

function periodMatch(rowPeriod: string, normalized: ReturnType<typeof normalizePeriod>): boolean {
  if (!normalized) {
    return false
  }
  if (rowPeriod === normalized.text || rowPeriod === normalized.day) {
    return true
  }
  // 旧资料只记了结束时刻（如 2026-09-01 10:00）：
  // - 导入行是区间：旧时刻等于区间起点或结束点都视为同一观测时段，按结束点优先的顺序命中；
  // - 导入行是单时刻：旧时刻一致即回填。
  if (normalized.durationMinutes === null) {
    return rowPeriod.endsWith(normalized.text)
  }
  const [startText, endText] = normalized.text.split('~')
  return rowPeriod.endsWith(startText) || rowPeriod.endsWith(endText)
}

/** 一条观测时段是否归属于某自然日（区间按结束时刻归属）。 */
function periodBelongsToDay(period: string, day: string): boolean {
  return period === day || period.startsWith(`${day} `) || period.includes(`~${day} `)
}

function recomputeDayTotal(ledger: EntryRow[], station: string, day: string): void {
  const sameDay = ledger.filter((row) => {
    if (String(row['站点编号'] ?? '') !== station) {
      return false
    }
    return periodBelongsToDay(String(row['观测时段'] ?? ''), day)
  })
  let sum = 0
  for (const row of sameDay) {
    const value = parseAmount(String(row['时段雨量'] ?? ''))
    if (value !== null) {
      sum += value
    }
  }
  const totalText = formatAmount(sum)
  for (const row of sameDay) {
    row['日累计雨量'] = totalText
  }
}

export interface ContinueResult {
  batch: ExchangeBatch
  acquired: boolean
  processed: number
  succeeded: number
  failed: number
  message: string
}

/** 从未完成处继续处理：只跑「待处理」行，失败行带原因留在批次里。 */
export function continueBatch(batchId: number, terminalId: string): ContinueResult {
  const batches = listBatches()
  const index = batches.findIndex((item) => item.id === batchId)
  if (index < 0) {
    throw new Error(`批次 ${batchId} 不存在`)
  }
  const found = batches[index]
  if (found.state === '已确认') {
    return { batch: found, acquired: false, processed: 0, succeeded: 0, failed: 0, message: '批次已确认，无需继续处理' }
  }
  if (leaseValid(found.lease) && found.lease!.terminalId !== terminalId) {
    return {
      batch: found,
      acquired: false,
      processed: 0,
      succeeded: 0,
      failed: 0,
      message: `批次正由终端 ${found.lease!.terminalId} 处理中，本终端需等其处理结束`,
    }
  }
  if (found.pendingCount === 0) {
    return { batch: found, acquired: false, processed: 0, succeeded: 0, failed: 0, message: '没有待处理行，可直接确认批次' }
  }

  // 抢处理锁，先落盘，让其它终端的「继续」读到锁。
  let working = recount({ ...found, lease: { terminalId, until: Date.now() + LEASE_MS } })
  const staged = [...batches]
  staged[index] = working
  saveBatches(staged)

  let processed = 0
  let succeeded = 0
  let failed = 0
  const ledger = listRows('rainfall').map((row) => ({ ...row }))
  const touchedDays = new Set<string>()
  // 批内去重：已成功行按「站点 + 归一化时段」占坑，后面重复行直接失败留因。
  const batchKeys = new Set<string>()
  // 一条旧资料在同一批次里只能被回填一次，避免区间改写后相邻时段误命中同一条。
  const claimedRecordIds = new Set<number>()
  for (const row of working.rows.filter((item) => item.state === '成功')) {
    const normalized = normalizePeriod(
      rowValue(row, working, '观测时段'),
      rowValue(row, working, '时段开始'),
      rowValue(row, working, '时段结束'),
    )
    const station = rowValue(row, working, '站点编号').trim()
    if (normalized && station) {
      batchKeys.add(`${station}|${normalized.text}`)
    }
    if (row.action === '回填旧资料' && row.recordId !== null) {
      claimedRecordIds.add(row.recordId)
    }
  }

  const rows = working.rows.map((current) => {
    if (current.state !== '待处理') {
      return current
    }
    processed += 1
    const station = rowValue(current, working, '站点编号').trim()
    const periodRaw = rowValue(current, working, '观测时段').trim()
    const start = rowValue(current, working, '时段开始').trim()
    const end = rowValue(current, working, '时段结束').trim()
    const rainText = rowValue(current, working, '时段雨量').trim()
    const observer = rowValue(current, working, '观测人').trim()
    const intensityText = rowValue(current, working, '降雨强度').trim()
    const dailyText = rowValue(current, working, '日累计雨量').trim()

    const fail = (reason: string): ImportRow => {
      failed += 1
      return { ...current, state: '失败' as const, failReason: reason, recordId: null, recordNo: '', action: '' }
    }

    if (!station) {
      return fail('站点编号为空')
    }
    const normalized = normalizePeriod(periodRaw, start, end)
    if (!normalized) {
      return fail(`观测时段「${periodRaw || `${start}~${end}`}」无法识别，请用 YYYY-MM-DD HH:mm 或 HH:mm~HH:mm 口径`)
    }
    const rain = parseAmount(rainText)
    if (rain === null) {
      return fail(`时段雨量「${rainText}」不是有效数值`)
    }

    const dedupeKey = `${station}|${normalized.text}`
    if (batchKeys.has(dedupeKey)) {
      return fail(`批内重复：站点 ${station} 的观测时段 ${normalized.text} 在本文件中已出现过`)
    }
    batchKeys.add(dedupeKey)

    const existingIndex = ledger.findIndex(
      (rowEntry) =>
        !claimedRecordIds.has(Number(rowEntry.id)) &&
        String(rowEntry['站点编号'] ?? '') === station &&
        periodMatch(String(rowEntry['观测时段'] ?? ''), normalized),
    )

    if (existingIndex >= 0) {
      // 旧资料按观测时段回填：时段雨量以交换文件为准，其余列补上。
      const target = ledger[existingIndex]
      target['观测时段'] = normalized.text
      target['时段雨量'] = formatAmount(rain)
      if (dailyText.trim() !== '') {
        target['日累计雨量'] = dailyText
      }
      if (intensityText.trim() !== '') {
        target['降雨强度'] = intensityText
      } else if (normalized.durationMinutes !== null) {
        target['降雨强度'] = `${formatAmount((rain / normalized.durationMinutes) * 60)} mm/h`
      }
      if (observer) {
        target['观测人'] = observer
      }
      target.status = '已采集'
      touchedDays.add(`${station}|${normalized.day}`)
      claimedRecordIds.add(Number(target.id))
      succeeded += 1
      return {
        ...current,
        state: '成功' as const,
        failReason: '',
        recordId: Number(target.id),
        recordNo: String(target['记录编号'] ?? ''),
        action: '回填旧资料' as const,
      }
    }

    const id = nextRainfallId(ledger)
    const recordNo = nextRainfallNo(ledger)
    const entry: EntryRow = {
      id,
      status: '已采集',
      pending: true,
      abnormal: false,
      '记录编号': recordNo,
      '站点编号': station,
      '观测时段': normalized.text,
      '时段雨量': formatAmount(rain),
      '日累计雨量': dailyText || '',
      '降雨强度':
        intensityText ||
        (normalized.durationMinutes !== null
          ? `${formatAmount((rain / normalized.durationMinutes) * 60)} mm/h`
          : ''),
      '观测人': observer,
      '记录状态': '交换导入',
    }
    ledger.push(entry)
    touchedDays.add(`${station}|${normalized.day}`)
    succeeded += 1
    return {
      ...current,
      state: '成功' as const,
      failReason: '',
      recordId: id,
      recordNo,
      action: '新登记' as const,
    }
  })

  // 受影响的站点-自然日重算日累计，保证核对报告口径一致。
  for (const key of touchedDays) {
    const [station, day] = key.split('|')
    recomputeDayTotal(ledger, station, day)
  }

  working = recount({ ...working, rows, lease: null })
  const next = [...listBatches()]
  const nextIndex = next.findIndex((item) => item.id === batchId)
  if (nextIndex >= 0) {
    // 若锁被别的终端强行接管（演示场景下不会发生），不覆盖它的状态。
    next[nextIndex] = working
    saveBatches(next)
  }
  mergeRows({ rainfall: ledger })

  const message =
    processed === 0
      ? '没有待处理行'
      : `本轮处理 ${processed} 行：成功 ${succeeded} 行，失败 ${failed} 行${working.pendingCount > 0 ? `，仍剩 ${working.pendingCount} 行` : ''}`
  return { batch: working, acquired: true, processed, succeeded, failed, message }
}

// ---------------------------------------------------------------------------
// 批次确认：原子 CAS，多终端并发只接受一个完成标记，并产出待核对成果。
// ---------------------------------------------------------------------------

function collectPeriod(rows: ImportRow[], batch: ExchangeBatch): { stations: string[]; periodStart: string; periodEnd: string } {
  const stations = new Set<string>()
  let min = ''
  let max = ''
  for (const row of rows) {
    const station = rowValue(row, batch, '站点编号').trim()
    if (station) {
      stations.add(station)
    }
    const day = normalizePeriod(
      rowValue(row, batch, '观测时段'),
      rowValue(row, batch, '时段开始'),
      rowValue(row, batch, '时段结束'),
    )?.day
    if (day) {
      if (!min || day < min) min = day
      if (!max || day > max) max = day
    }
  }
  return { stations: [...stations], periodStart: min, periodEnd: max }
}

export function confirmRainfallBatch(
  batchId: number,
  terminalId: string,
): { ok: boolean; batch: ExchangeBatch | null; result: ChecklistResult | null; message: string } {
  return confirmBatchCas(batchId, terminalId, (batch, nextResultId) => {
    const { stations, periodStart, periodEnd } = collectPeriod(batch.rows, batch)
    const resultNo = `WCOM-${String(nextResultId).padStart(6, '0')}`
    return {
      id: nextResultId,
      resultNo,
      batchNo: batch.batchNo,
      fileName: batch.fileName,
      title: `雨量资料交换日累计核对（${batch.batchNo}）`,
      stations,
      periodStart,
      periodEnd,
      recordCount: batch.successCount,
      failCount: batch.failCount,
      status: '待核对',
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      createdBy: terminalId,
      checkedAt: null,
      checkNote: '',
    }
  })
}

// ---------------------------------------------------------------------------
// 日累计核对报告：导入日累计 vs 时段雨量累加 vs 回填后台账日累计
// ---------------------------------------------------------------------------

interface DailyCheckLine {
  station: string
  day: string
  periodCount: number
  periodSum: number
  fileDaily: string
  ledgerDaily: string
  consistent: boolean
}

function buildDailyCheck(batch: ExchangeBatch): DailyCheckLine[] {
  const groups = new Map<string, { count: number; sum: number; fileDaily: string }>()
  for (const row of batch.rows) {
    if (row.state !== '成功') {
      continue
    }
    const normalized = normalizePeriod(
      rowValue(row, batch, '观测时段'),
      rowValue(row, batch, '时段开始'),
      rowValue(row, batch, '时段结束'),
    )
    const station = rowValue(row, batch, '站点编号').trim()
    if (!normalized || !station) {
      continue
    }
    const key = `${station}|${normalized.day}`
    const group = groups.get(key) ?? { count: 0, sum: 0, fileDaily: '' }
    const amount = parseAmount(rowValue(row, batch, '时段雨量'))
    if (amount !== null) {
      group.sum += amount
      group.count += 1
    }
    const daily = rowValue(row, batch, '日累计雨量').trim()
    if (daily && !group.fileDaily) {
      group.fileDaily = daily
    }
    groups.set(key, group)
  }

  const ledger = listRows('rainfall')
  return [...groups.entries()]
    .map(([key, group]) => {
      const [station, day] = key.split('|')
      const ledgerRow = ledger.find(
        (row) =>
          String(row['站点编号'] ?? '') === station &&
          periodBelongsToDay(String(row['观测时段'] ?? ''), day),
      )
      const ledgerDaily = String(ledgerRow?.['日累计雨量'] ?? '').trim()
      const fileValue = parseAmount(group.fileDaily)
      const ledgerValue = parseAmount(ledgerDaily)
      const consistent =
        Math.abs(group.sum - (ledgerValue ?? group.sum)) <= 0.05 &&
        (fileValue === null || Math.abs(group.sum - fileValue) <= 0.05)
      return {
        station,
        day,
        periodCount: group.count,
        periodSum: Math.round(group.sum * 10) / 10,
        fileDaily: group.fileDaily || '—',
        ledgerDaily: ledgerDaily || '—',
        consistent,
      }
    })
    .sort((a, b) => (a.station === b.station ? a.day.localeCompare(b.day) : a.station.localeCompare(b.station)))
}

export function buildReconciliationReport(batchId: number): { filename: string; content: string } {
  const batch = listBatches().find((item) => item.id === batchId)
  if (!batch) {
    throw new Error(`批次 ${batchId} 不存在`)
  }
  const lines: string[] = []
  lines.push(`# 雨量资料交换·日累计核对报告`)
  lines.push(`批次编号,${csvEscape(batch.batchNo)}`)
  lines.push(`交换文件,${csvEscape(batch.fileName)}`)
  lines.push(`建立时间,${csvEscape(batch.createdAt)}`)
  if (batch.confirmedAt) {
    lines.push(`确认时间,${csvEscape(batch.confirmedAt)},确认终端,${csvEscape(batch.confirmedBy ?? '')}`)
  }
  lines.push(`处理结果,总行数 ${batch.totalRows},成功 ${batch.successCount},失败 ${batch.failCount}`)
  lines.push('')
  lines.push('【一、日累计核对】')
  lines.push(['站点编号', '日期', '时段记录数', '时段雨量累加(mm)', '文件填报日累计(mm)', '台账日累计(mm)', '核对结论'].map(csvEscape).join(','))
  const daily = buildDailyCheck(batch)
  if (daily.length === 0) {
    lines.push('—,—,0,0,—,—,无成功行')
  } else {
    for (const line of daily) {
      lines.push(
        [line.station, line.day, line.periodCount, line.periodSum, line.fileDaily, line.ledgerDaily, line.consistent ? '一致' : '不一致']
          .map(csvEscape)
          .join(','),
      )
    }
  }

  lines.push('')
  lines.push('【二、字段映射口径】')
  lines.push(['源文件表头', '映射到标准字段'].map(csvEscape).join(','))
  for (const [header, target] of Object.entries(batch.fieldMap)) {
    lines.push([header, target || '（未识别，不入库）'].map(csvEscape).join(','))
  }

  lines.push('')
  lines.push('【三、失败行及原因（保留待修正后续传）】')
  lines.push(['文件行号', '站点编号', '原始内容', '失败原因'].map(csvEscape).join(','))
  const failures = batch.rows.filter((row) => row.state === '失败')
  if (failures.length === 0) {
    lines.push('—,—,—,无')
  } else {
    for (const row of failures) {
      lines.push(
        [
          row.lineNo,
          rowValue(row, batch, '站点编号') || '—',
          Object.entries(row.raw).map(([k, v]) => `${k}=${v}`).join('；') || '—',
          row.failReason,
        ].map(csvEscape).join(','),
      )
    }
  }

  return {
    filename: `日累计核对报告-${batch.batchNo}.csv`,
    content: `﻿${lines.join('\r\n')}`,
  }
}

export function downloadReconciliationReport(batchId: number): void {
  const { filename, content } = buildReconciliationReport(batchId)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 交换台导入模板：把映射口径直接写在表头第二行，供资料交换单位照表填报。 */
export function downloadRainfallTemplate(): void {
  const header = ['站号(必填)', '观测日期时间(必填)', '时段开始', '时段结束', '时段雨量mm(必填)', '日累计雨量mm', '降雨强度', '观测员']
  const sample = ['STAT-0001', '2026-09-01', '08:00', '10:00', '2.4', '6.8', '1.2 mm/h', '张三']
  const content = `﻿${header.join(',')}\n${sample.join(',')}\n`
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '雨量资料交换模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// 水位整编清单（待核对成果）：水位监测、数据整编两个模块挂同一份数据。
// ---------------------------------------------------------------------------

export function listWaterlevelChecklist(): ChecklistResult[] {
  return listChecklist().sort((a, b) => b.id - a.id)
}

export function reviewChecklistResult(id: number, status: ChecklistStatus, note: string): ChecklistResult | null {
  return setChecklistStatus(id, status, note)
}
