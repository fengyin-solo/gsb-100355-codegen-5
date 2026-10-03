/** 资料交换台的领域模型：时段雨量导入批次、逐行处理结果、并发标记。 */

// 一行交换文件的处理状态：待处理可「继续」，失败原因保留，成功即已回填观测记录。
export type RowStatus = 'pending' | 'success' | 'failed'

export interface ExchangeRow {
  line: number // 文件内行号（含表头，首条数据为 2）
  raw: Record<string, string> // 按文件原表头保留的原始值，便于追溯
  mapped: Record<string, string> // 映射到雨量观测标准字段后的值
  status: RowStatus
  reason: string // 失败原因；成功时为回填说明（如「更新旧资料」）
  entryId?: number // 成功回填后的雨量记录 id
}

// 批次生命周期：解析入队 -> 逐段处理 -> 待确认 -> 已确认（只会被确认一次）
export type BatchState = 'queued' | 'processing' | 'awaiting' | 'confirmed'

export interface ExchangeBatch {
  id: string
  fileName: string
  fileSize: number
  fileFingerprint: string // 文件名+大小+内容摘要，同一文件重复上传只认这一个批次
  uploadedAt: string
  terminalId: string // 首个上传终端
  state: BatchState
  rows: ExchangeRow[]
  chunkSize: number // 每点一次「继续导入」处理多少行
  confirmedAt?: string
  confirmedBy?: string
  confirmedTerminal?: string
  confirmVersion: number // CAS 版本号，并发确认只接受一个完成标记
  compilationEntryId?: number // 确认后写入水位整编清单的待核对成果 id
  touchedDays: string[] // 本批涉及到的「站点编号|日期」，日累计报告只核对这些
}

export interface FieldMapping {
  fileHeader: string
  standardField: string
}

export interface ProcessingResult {
  batch: ExchangeBatch
  processed: number // 本次继续处理实际推进的行数
}

export interface ConfirmResult {
  ok: boolean
  message: string
  batch?: ExchangeBatch
}
