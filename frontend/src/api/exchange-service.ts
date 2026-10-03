import {
  compareAndSwapBatch,
  currentTerminalId,
  findBatch,
  findBatchByFingerprint,
  readBatches,
  upsertBatch,
} from '@/data/exchange-store'
import type {
  ConfirmResult,
  ExchangeBatch,
  ExchangeRow,
  FieldMapping,
  ProcessingResult,
} from '@/data/exchange-types'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// ─────────────────────────────────────────────
// 字段映射口径（交换台站名/表头不一致时按此归一到现有雨量观测字段）
// 标准字段：站点编号 / 观测时段 / 时段雨量 / 降雨强度 / 观测人
// 规则：表头去空白、全角转半角后精确匹配别名表；匹配不上的列原样保留但不入库。
// ─────────────────────────────────────────────
const HEADER_ALIASES: Record<string, string[]> = {
  站点编号: ['站点编号', '站号', '站点代码', '台站编号', '测站编号', '站码', 'stationid', 'stcd'],
  观测时段: ['观测时段', '时段', '观测时间', '起止时间', '时间', '观测日期', 'date', 'tm'],
  时段雨量: ['时段雨量', '时段降水量', '降水量', '雨量', '降雨量', 'rainfall', 'drp', 'p'],
  降雨强度: ['降雨强度', '雨强', '降水强度', '强度', 'intensity'],
  观测人: ['观测人', '观测员', '录入人', '报送人', 'operator', 'observer'],
}

const RAINFALL_FIELDS = ['站点编号', '观测时段', '时段雨量', '降雨强度', '观测人']
const REQUIRED_FIELDS = ['站点编号', '观测时段', '时段雨量']
const CHUNK_SIZE = 5 // 演示用：每次「继续导入」推进 5 行，断点效果可见

function normalizeHeader(header: string): string {
  return header
    .trim()
    .replace(/　/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
}

const ALIAS_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [standard, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      map.set(normalizeHeader(alias), standard)
    }
  }
  return map
})()

// ─────────────────────────────────────────────
// CSV 解析：支持引号包裹与逗号转义，首行为表头，与现有「导出清单」格式互通。
// ─────────────────────────────────────────────
export function parseCsv(text: string): { headers: string[]; records: Record<string, string>[] } {
  const rows: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i]
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      record.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && src[i + 1] === '\n') {
        i += 1
      }
      record.push(field)
      field = ''
      if (record.some((cell) => cell.trim() !== '')) {
        rows.push(record)
      }
      record = []
    } else {
      field += char
    }
  }
  record.push(field)
  if (record.some((cell) => cell.trim() !== '')) {
    rows.push(record)
  }
  if (rows.length === 0) {
    return { headers: [], records: [] }
  }
  const headers = rows[0].map((cell) => cell.trim())
  const records = rows.slice(1).map((cells) => {
    const item: Record<string, string> = {}
    headers.forEach((header, index) => {
      item[header] = (cells[index] ?? '').trim()
    })
    return item
  })
  return { headers, records }
}

export function resolveMappings(headers: string[]): FieldMapping[] {
  const mappings: FieldMapping[] = []
  for (const header of headers) {
    const standard = ALIAS_LOOKUP.get(normalizeHeader(header))
    if (standard && !mappings.some((item) => item.standardField === standard)) {
      mappings.push({ fileHeader: header, standardField: standard })
    }
  }
  return mappings
}

export function missingRequiredHeaders(mappings: FieldMapping[]): string[] {
  const mapped = new Set(mappings.map((item) => item.standardField))
  return REQUIRED_FIELDS.filter((field) => !mapped.has(field))
}

// 简易内容摘要：同一文件（同名、同大小、同内容）重复上传只认同一批次。
export function fingerprint(fileName: string, fileSize: number, text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `${fileName}|${fileSize}|${(hash >>> 0).toString(16)}`
}

// ─────────────────────────────────────────────
// 时段口径：旧资料按观测时段回填。
// 支持「2026-09-01 08:00-09:00」「2026-09-01」「01/09/2026 08」等写法，
// 归一为起始时刻「YYYY-MM-DD HH:mm」；日累计按起始时刻所在自然日归集。
// ─────────────────────────────────────────────
export function normalizePeriod(raw: string): { period: string; day: string } | null {
  const text = raw.trim().replace(/[～~—–]/g, '-')
  // 先定位日期部分，不能直接按 '-' 拆，否则 YYYY-MM-DD 本身会被拆碎。
  const dateMatch =
    text.match(/(\d{4})[/.年-](\d{1,2})[/.月-](\d{1,2})日?/)
    || text.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/)
  if (!dateMatch) {
    return null
  }
  let year: string
  let month: string
  let day: string
  if (/^\d{4}/.test(dateMatch[0])) {
    [, year, month, day] = dateMatch
  } else {
    year = dateMatch[3]
    month = dateMatch[1]
    day = dateMatch[2]
  }
  // 日期之后的片段里识别「起始时刻-结束时刻」，只取起始时刻。
  const tail = text.slice((dateMatch.index ?? 0) + dateMatch[0].length)
  const timeMatch = tail.match(/(\d{1,2})(?::(\d{2}))?/)
  const hh = (timeMatch?.[1] ?? '08').padStart(2, '0')
  const mi = timeMatch?.[2] ?? '00'
  const mm = month.padStart(2, '0')
  const dd = day.padStart(2, '0')
  return { period: `${year}-${mm}-${dd} ${hh}:${mi}`, day: `${year}-${mm}-${dd}` }
}

function numericRain(raw: string): number | null {
  if (raw === '') {
    return null
  }
  const value = Number(raw.replace(/[毫米mm\s]/gi, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function deriveIntensity(amount: number, mapped: Record<string, string>): string {
  const given = mapped['降雨强度']
  if (given) {
    return given
  }
  // 交换文件按固定观测时段报送，缺雨强时按 1 小时段估算（mm/h）。
  return String(Math.round(amount * 10) / 10)
}

let batchSequence = 0
function nextBatchId(): string {
  batchSequence += 1
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `EX-${stamp}-${String(batchSequence).padStart(3, '0')}`
}

// ─────────────────────────────────────────────
// 上传：解析 + 字段映射 + 逐行预校验，失败行保留原因。同一文件直接返回旧批次。
// ─────────────────────────────────────────────
export function createBatchFromFile(fileName: string, fileSize: number, text: string): {
  batch?: ExchangeBatch
  error?: string
  reused: boolean
} {
  const fp = fingerprint(fileName, fileSize, text)
  const existing = findBatchByFingerprint(fp)
  if (existing) {
    return { batch: existing, reused: true }
  }
  const { headers, records } = parseCsv(text)
  if (records.length === 0) {
    return { reused: false, error: '文件没有可导入的数据行' }
  }
  const mappings = resolveMappings(headers)
  const missing = missingRequiredHeaders(mappings)
  if (missing.length > 0) {
    return { reused: false, error: `缺少必需列：${missing.join('、')}（可识别表头见映射口径说明）` }
  }
  const rows: ExchangeRow[] = records.map((rawRecord, index) => {
    const mapped: Record<string, string> = {}
    for (const mapping of mappings) {
      mapped[mapping.standardField] = rawRecord[mapping.fileHeader] ?? ''
    }
    const line = index + 2
    const reason = validateMappedRow(mapped)
    return {
      line,
      raw: rawRecord,
      mapped,
      status: reason ? 'failed' : 'pending',
      reason: reason ?? '',
    }
  })
  const batch: ExchangeBatch = {
    id: nextBatchId(),
    fileName,
    fileSize,
    fileFingerprint: fp,
    uploadedAt: new Date().toISOString(),
    terminalId: currentTerminalId(),
    state: 'queued',
    rows,
    chunkSize: CHUNK_SIZE,
    confirmVersion: 0,
    touchedDays: [],
  }
  upsertBatch(batch)
  return { batch, reused: false }
}

function validateMappedRow(mapped: Record<string, string>): string | null {
  if (!mapped['站点编号']) {
    return '站点编号为空'
  }
  const period = normalizePeriod(mapped['观测时段'] ?? '')
  if (!period) {
    return `观测时段无法识别：${mapped['观测时段'] ?? ''}`
  }
  if (numericRain(mapped['时段雨量'] ?? '') === null) {
    return `时段雨量不是非负数值：${mapped['时段雨量'] ?? ''}`
  }
  return null
}

// ─────────────────────────────────────────────
// 继续导入：从未完成处接着处理一小段。失败行已带原因，不阻塞后面的行。
// 回填口径：同站点+同观测时段命中旧资料则更新（保留原记录号），否则新增。
// ─────────────────────────────────────────────
export function processNextChunk(batchId: string): ProcessingResult {
  const stored = findBatch(batchId)
  if (!stored) {
    throw new Error('批次不存在或已被其他终端清理')
  }
  const batch: ExchangeBatch = JSON.parse(JSON.stringify(stored)) as ExchangeBatch
  if (batch.state === 'confirmed') {
    return { batch, processed: 0 }
  }
  const targets = batch.rows.filter((row) => row.status === 'pending')
  const slice = targets.slice(0, batch.chunkSize)
  if (slice.length === 0) {
    batch.state = 'awaiting'
    upsertBatch(batch)
    return { batch, processed: 0 }
  }
  batch.state = 'processing'

  const entries = listRows('rainfall')
  let nextId = entries.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  let processed = 0

  for (const row of slice) {
    const reason = validateMappedRow(row.mapped)
    if (reason) {
      row.status = 'failed'
      row.reason = reason
      continue
    }
    const periodInfo = normalizePeriod(row.mapped['观测时段'] ?? '') as NonNullable<
      ReturnType<typeof normalizePeriod>
    >
    const amount = numericRain(row.mapped['时段雨量'] ?? '') as number
    const station = row.mapped['站点编号']
    const fields: Record<string, string> = {
      站点编号: station,
      观测时段: periodInfo.period,
      时段雨量: String(amount),
      降雨强度: deriveIntensity(amount, row.mapped),
      观测人: row.mapped['观测人'] || '资料交换',
    }
    const hitIndex = entries.findIndex(
      (entry) => entry['站点编号'] === station && entry['观测时段'] === periodInfo.period,
    )
    if (hitIndex >= 0) {
      entries[hitIndex] = { ...entries[hitIndex], ...fields, 数据来源: '资料交换' }
      row.entryId = Number(entries[hitIndex].id)
      row.reason = `更新旧资料（记录 ${entries[hitIndex]['记录编号']}）`
    } else {
      nextId += 1
      const entry: EntryRow = {
        id: nextId,
        status: '已采集',
        pending: true,
        abnormal: false,
        记录编号: `${batch.id}-R${String(row.line).padStart(3, '0')}`,
        日累计雨量: '',
        记录状态: '已采集',
        数据来源: '资料交换',
        ...fields,
      }
      entries.push(entry)
      row.entryId = nextId
      row.reason = '新增观测记录'
    }
    const dayKey = `${station}|${periodInfo.day}`
    if (!batch.touchedDays.includes(dayKey)) {
      batch.touchedDays.push(dayKey)
    }
    row.status = 'success'
    processed += 1
  }

  backfillDailyTotals(entries, new Set(batch.touchedDays))
  saveRows('rainfall', entries)

  if (!batch.rows.some((row) => row.status === 'pending')) {
    batch.state = 'awaiting'
  }
  upsertBatch(batch)
  return { batch, processed }
}

// 旧资料按观测时段回填日累计：同站点、同自然日的时段雨量求和，写回「日累计雨量」。
// 只重算本批碰到的站点日，避免动到其他日期。
function backfillDailyTotals(entries: EntryRow[], touched: Set<string>): void {
  const groups = new Map<string, EntryRow[]>()
  for (const entry of entries) {
    const day = String(entry['观测时段'] ?? '').slice(0, 10)
    const key = `${entry['站点编号']}|${day}`
    if (!touched.has(key)) {
      continue
    }
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const total = group.reduce((sum, entry) => {
      const value = Number(entry['时段雨量'])
      return sum + (Number.isFinite(value) ? value : 0)
    }, 0)
    const rounded = Math.round(total * 10) / 10
    for (const entry of group) {
      entry['日累计雨量'] = String(rounded)
    }
  }
}

// ─────────────────────────────────────────────
// 批次确认：CAS 抢占完成标记；成功后向水位整编清单追加一份「待核对」成果。
// ─────────────────────────────────────────────
export function confirmBatch(batchId: string, operator: string): ConfirmResult {
  const stored = findBatch(batchId)
  if (!stored) {
    return { ok: false, message: '批次不存在，可能已被其他终端处理' }
  }
  if (stored.state === 'confirmed') {
    return {
      ok: false,
      message: `该批次已由终端 ${stored.confirmedTerminal ?? '—'} 于 ${stored.confirmedAt ?? '—'} 确认，完成标记唯一`,
      batch: stored,
    }
  }
  if (stored.rows.some((row) => row.status === 'pending')) {
    return { ok: false, message: '尚有未处理行，请先「继续导入」从未完成处走完', batch: stored }
  }
  if (!stored.rows.some((row) => row.status === 'success')) {
    return { ok: false, message: '没有任何成功回填的行，无法形成待核对成果', batch: stored }
  }
  const terminalId = currentTerminalId()
  const expectedVersion = stored.confirmVersion
  const result = compareAndSwapBatch(batchId, expectedVersion, (draft) => {
    const compilation = listRows('compilation')
    const compId =
      compilation.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const successRows = draft.rows.filter((row) => row.status === 'success')
    const stations = new Set(successRows.map((row) => row.mapped['站点编号']))
    const days = new Set(draft.touchedDays.map((key) => key.split('|')[1]))
    const year = [...days].sort()[0]?.slice(0, 4) ?? new Date().getFullYear().toString()
    compilation.push({
      id: compId,
      status: '待核对',
      pending: true,
      abnormal: false,
      成果编号: `CHK-${draft.id}`,
      整编年份: year,
      站点编号: stations.size === 1 ? [...stations][0] : `共${stations.size}站`,
      整编类型: '雨量资料交换·日累计核对',
      原始记录数: String(successRows.length),
      整编人: operator,
      审核人: '待核对',
      整编状态: '待核对',
    })
    saveRows('compilation', compilation)

    draft.state = 'confirmed'
    draft.confirmedAt = new Date().toISOString()
    draft.confirmedBy = operator
    draft.confirmedTerminal = terminalId
    draft.compilationEntryId = compId
    return draft
  })
  if (!result.ok) {
    return {
      ok: false,
      message: `完成标记已被终端 ${result.batch.confirmedTerminal ?? '—'} 抢先确认，本次并发操作未生效`,
      batch: result.batch,
    }
  }
  return { ok: true, message: '批次已确认，水位整编清单新增一份待核对成果', batch: result.batch }
}

// ─────────────────────────────────────────────
// 日累计核对报告：逐站点日汇总文件/回填值与雨量观测现值，标记差异。
// ─────────────────────────────────────────────
export function buildDailyReport(batchId: string): { filename: string; content: string } {
  const batch = findBatch(batchId)
  if (!batch) {
    throw new Error('批次不存在')
  }
  const entries = listRows('rainfall')
  const header = ['站点编号', '日期', '导入时段数', '时段雨量合计(mm)', '观测表日累计(mm)', '核对结果']
  const lines = [header.join(',')]
  for (const dayKey of batch.touchedDays) {
    const [station, day] = dayKey.split('|')
    const dayEntries = entries.filter(
      (entry) => entry['站点编号'] === station && String(entry['观测时段'] ?? '').slice(0, 10) === day,
    )
    const sum = dayEntries.reduce((acc, entry) => {
      const value = Number(entry['时段雨量'])
      return acc + (Number.isFinite(value) ? value : 0)
    }, 0)
    const storedValues = dayEntries.map((entry) => Number(entry['日累计雨量']))
    const stored = storedValues.length ? storedValues[0] : NaN
    const rounded = Math.round(sum * 10) / 10
    const matched = Number.isFinite(stored) && Math.abs(stored - rounded) < 0.05
    lines.push(
      [
        station,
        day,
        dayEntries.length,
        rounded,
        Number.isFinite(stored) ? stored : '',
        matched ? '一致' : `不一致(差${Math.round((stored - rounded) * 10) / 10})`,
      ].join(','),
    )
  }
  const failed = batch.rows.filter((row) => row.status === 'failed')
  if (failed.length > 0) {
    lines.push('')
    lines.push(['行号', '失败原因'].join(','))
    for (const row of failed) {
      lines.push([row.line, row.reason].join(','))
    }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '')
  return {
    filename: `日累计核对报告-${batch.id}-${stamp}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

export function downloadReport(batchId: string): void {
  const { filename, content } = buildDailyReport(batchId)
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

export function downloadTemplate(): void {
  const header = ['台站编号,起止时间,时段降水量,观测员']
  const sample = [
    'STAT-0001,2026-09-01 08:00,2.5,张三',
    'STAT-0001,2026-09-01 09:00,5.0,张三',
    'STAT-0002,2026-09-01 20:00-21:00,12.0,李四',
  ]
  const blob = new Blob([`﻿${[...header, ...sample].join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '时段雨量交换模板.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function listBatches(): ExchangeBatch[] {
  return readBatches()
}

export function batchMappings(batch: ExchangeBatch): FieldMapping[] {
  const headers = Object.keys(batch.rows[0]?.raw ?? {})
  return resolveMappings(headers)
}

export { CHUNK_SIZE, RAINFALL_FIELDS }
