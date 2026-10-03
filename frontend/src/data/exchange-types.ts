/** 雨量资料交换台与水位整编清单（待核对成果）的数据结构。 */

// 交换文件内一行的处理状态：失败行要保留原因，并能在修正后从未完成处继续。
export type RowState = '待处理' | '成功' | '失败'

export type BatchState = '处理中' | '待确认' | '已确认'

export type ChecklistStatus = '待核对' | '已通过' | '已驳回'

export interface ImportRow {
  /** 文件中的物理行号（含表头，从 2 开始），方便定位失败行。 */
  lineNo: number
  /** 原始单元格：源表头 -> 原始值，核对报告里要能回溯。 */
  raw: Record<string, string>
  /** 人工修正值：标准字段 -> 修正后的值，优先于原始映射取值。 */
  fixes?: Record<string, string>
  state: RowState
  failReason: string
  /** 处理成功后落点：回填到哪条旧资料，或新登记了哪条雨量记录。 */
  recordId: number | null
  recordNo: string
  action: '' | '回填旧资料' | '新登记'
}

export interface BatchLease {
  terminalId: string
  until: number
}

export interface ExchangeBatch {
  id: number
  batchNo: string
  fileName: string
  fileSize: number
  fileHash: number
  /** 文件名 + 大小 + 内容哈希：同一文件重复上传只认这一个批次。 */
  fingerprint: string
  createdAt: string
  state: BatchState
  creatorTerminal: string
  /** 处理占用锁：别的终端在锁定期内只能等，不能抢处理。 */
  lease: BatchLease | null
  /** 源表头 -> 标准字段的映射口径，随批次固化，报告里可追溯。 */
  fieldMap: Record<string, string>
  totalRows: number
  successCount: number
  failCount: number
  pendingCount: number
  rows: ImportRow[]
  confirmedAt: string | null
  confirmedBy: string | null
  checklistId: number | null
}

export interface ChecklistResult {
  id: number
  resultNo: string
  batchNo: string
  fileName: string
  title: string
  stations: string[]
  periodStart: string
  periodEnd: string
  recordCount: number
  failCount: number
  status: ChecklistStatus
  createdAt: string
  createdBy: string
  checkedAt: string | null
  checkNote: string
}
