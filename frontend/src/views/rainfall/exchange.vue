<template>
  <section class="page" data-module="rainfall-exchange">
    <header class="page-head">
      <div>
        <h2>雨量资料交换台</h2>
        <p class="page-desc">
          导入交换台时段雨量，按观测时段回填旧资料；失败行保留原因、可从未完成处继续；
          确认后向水位整编清单追加一份待核对成果。当前终端：{{ terminalId }}
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/rainfall">返回雨量观测</RouterLink>
      </div>
    </header>

    <article class="stat-card upload-card">
      <div class="upload-line">
        <label class="btn primary file-btn">
          选择交换文件（CSV）
          <input ref="fileInput" type="file" accept=".csv,text/csv" @change="onFileSelected" />
        </label>
        <button class="btn" type="button" @click="downloadTemplate">下载交换模板</button>
        <button class="btn ghost" type="button" @click="reload">刷新批次</button>
        <span class="upload-hint">每次继续导入推进 {{ chunkSize }} 行；同名同内容文件只形成一个批次</span>
      </div>
      <p v-if="uploadMessage" :class="uploadOk ? 'ok-text' : 'error-text'">{{ uploadMessage }}</p>
      <details class="mapping-rule">
        <summary>字段映射口径（文件表头与现有观测记录不一致时）</summary>
        <ul>
          <li>站点编号 ← 台站编号 / 站号 / 站码 / 站点代码 / STCD</li>
          <li>观测时段 ← 起止时间 / 观测时间 / 时段 / 时间（归一为起始时刻 YYYY-MM-DD HH:mm）</li>
          <li>时段雨量 ← 时段降水量 / 降水量 / 降雨量 / DRP（单位 mm）</li>
          <li>降雨强度 ← 雨强 / 降水强度（缺省时按时段雨量估算）</li>
          <li>观测人 ← 观测员 / 录入人 / 报送人（缺省记为「资料交换」）</li>
          <li>回填口径：同站点+同观测时段命中旧资料则更新并保留原记录号，否则新增；日累计按自然日重算回填。</li>
        </ul>
      </details>
    </article>

    <h3 class="section-title">交换批次</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>文件</th>
          <th>进度</th>
          <th>状态</th>
          <th>上传终端/时间</th>
          <th>确认终端/时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id">
          <td>{{ batch.id }}</td>
          <td>{{ batch.fileName }}</td>
          <td>
            {{ countBy(batch, 'success') }} 成功 /
            {{ countBy(batch, 'failed') }} 失败 /
            {{ countBy(batch, 'pending') }} 待处理
          </td>
          <td>
            <span :class="['state-tag', batch.state]">{{ stateLabel(batch.state) }}</span>
          </td>
          <td>
            {{ batch.terminalId }}<br />
            <span class="muted">{{ formatTime(batch.uploadedAt) }}</span>
          </td>
          <td>
            <template v-if="batch.confirmedAt">
              {{ batch.confirmedTerminal }}<br />
              <span class="muted">{{ formatTime(batch.confirmedAt) }}</span>
            </template>
            <span v-else class="muted">—</span>
          </td>
          <td class="row-actions">
            <button
              v-if="hasPending(batch) || batch.state === 'processing' || batch.state === 'queued'"
              class="link"
              type="button"
              @click="continueImport(batch.id)"
            >
              继续导入
            </button>
            <button
              v-if="batch.state === 'awaiting'"
              class="link"
              type="button"
              @click="confirm(batch.id)"
            >
              批次确认
            </button>
            <button class="link" type="button" @click="toggleDetail(batch.id)">
              {{ expanded === batch.id ? '收起明细' : '查看明细' }}
            </button>
            <button
              class="link"
              type="button"
              :disabled="batch.state === 'queued'"
              @click="downloadReport(batch.id)"
            >
              日累计核对报告
            </button>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="7" class="empty-state">尚无交换批次，请选择交换文件导入</td>
        </tr>
      </tbody>
    </table>

    <template v-for="batch in batches" :key="`detail-${batch.id}`">
      <div v-if="expanded === batch.id" class="batch-detail">
        <h4 class="section-title">
          {{ batch.id }} 逐行明细
          <span class="muted">（同一文件重复上传会回到本批次；失败行原因保留）</span>
        </h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>行号</th>
              <th v-for="field in mappedFields(batch)" :key="field">{{ field }}</th>
              <th>处理状态</th>
              <th>原因/说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in batch.rows" :key="row.line" :class="{ 'row-failed': row.status === 'failed' }">
              <td>{{ row.line }}</td>
              <td v-for="field in mappedFields(batch)" :key="field">{{ row.mapped[field] ?? '—' }}</td>
              <td>{{ rowStatusLabel(row.status) }}</td>
              <td>{{ row.reason || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import {
  CHUNK_SIZE,
  RAINFALL_FIELDS,
  confirmBatch,
  createBatchFromFile,
  downloadReport,
  downloadTemplate,
  listBatches,
  processNextChunk,
} from '@/api/exchange-service'
import { currentTerminalId } from '@/data/exchange-store'
import { useSessionStore } from '@/stores/session'
import type { ExchangeBatch, ExchangeRow, RowStatus } from '@/data/exchange-types'

const session = useSessionStore()
const terminalId = currentTerminalId()
const chunkSize = CHUNK_SIZE

const batches = ref<ExchangeBatch[]>([])
const expanded = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const uploadMessage = ref('')
const uploadOk = ref(true)

function reload() {
  batches.value = listBatches()
}

function countBy(batch: ExchangeBatch, status: RowStatus): number {
  return batch.rows.filter((row) => row.status === status).length
}

function hasPending(batch: ExchangeBatch): boolean {
  return batch.rows.some((row) => row.status === 'pending')
}

function stateLabel(state: ExchangeBatch['state']): string {
  return { queued: '待处理', processing: '导入中', awaiting: '待确认', confirmed: '已确认' }[state]
}

function rowStatusLabel(status: RowStatus): string {
  return { pending: '待处理', success: '已回填', failed: '失败' }[status]
}

function mappedFields(batch: ExchangeBatch): string[] {
  return RAINFALL_FIELDS.filter((field) =>
    batch.rows.some((row: ExchangeRow) => row.mapped[field] !== undefined),
  )
}

function formatTime(value?: string): string {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function toggleDetail(id: string) {
  expanded.value = expanded.value === id ? '' : id
}

function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const text = String(reader.result ?? '')
    const result = createBatchFromFile(file.name, file.size, text)
    if (result.error) {
      uploadOk.value = false
      uploadMessage.value = `导入未开始：${result.error}`
    } else if (result.reused && result.batch) {
      uploadOk.value = true
      uploadMessage.value = `文件已上传过，直接回到既有批次 ${result.batch.id}，可从未完成处继续`
      // 回到旧批次时自动再推一段，体现「继续」语义
      processNextChunk(result.batch.id)
    } else if (result.batch) {
      uploadOk.value = true
      const first = processNextChunk(result.batch.id)
      uploadMessage.value =
        `已建立批次 ${result.batch.id}，首批处理 ${first.processed} 行，可继续导入直至完成`
    }
    input.value = ''
    reload()
  }
  reader.onerror = () => {
    uploadOk.value = false
    uploadMessage.value = '文件读取失败，请重试'
  }
  reader.readAsText(file, 'utf-8')
}

function continueImport(batchId: string) {
  uploadOk.value = true
  const result = processNextChunk(batchId)
  const fresh = result.batch
  uploadMessage.value =
    result.processed > 0
      ? `${batchId} 本次推进 ${result.processed} 行`
      : `${batchId} 已无待处理行，可进行批次确认`
  if (fresh.state === 'awaiting') {
    uploadMessage.value = `${batchId} 全部处理完成（含失败行），请批次确认`
  }
  reload()
}

function confirm(batchId: string) {
  const result = confirmBatch(batchId, session.operator)
  uploadOk.value = result.ok
  uploadMessage.value = result.message
  reload()
}

// 多终端并发：其他标签页落盘后本页立即刷新，让抢占结果可见。
function onStorage(event: StorageEvent) {
  if (event.key && (event.key.includes('rainfall-exchange') || event.key.endsWith(':entries'))) {
    reload()
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})
onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>

<style scoped>
.upload-card {
  margin-bottom: 16px;
}
.upload-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.file-btn {
  position: relative;
  overflow: hidden;
}
.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.upload-hint {
  color: var(--muted);
  font-size: 12px;
}
.mapping-rule {
  margin-top: 10px;
  font-size: 13px;
  color: var(--muted);
}
.mapping-rule summary {
  cursor: pointer;
}
.section-title {
  margin: 18px 0 8px;
  font-size: 15px;
}
.state-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: #eef2f7;
}
.state-tag.awaiting {
  background: #fef3c7;
  color: #92400e;
}
.state-tag.confirmed {
  background: #dcfce7;
  color: #166534;
}
.state-tag.failed {
  background: #fee2e2;
  color: #991b1b;
}
.batch-detail {
  margin-top: 8px;
}
.row-failed {
  background: #fef2f2;
}
.muted {
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #166534;
}
button:disabled.link {
  color: #9ca3af;
  cursor: not-allowed;
}
</style>
