<template>
  <section class="exchange-desk">
    <header class="page-head">
      <div>
        <h3>雨量资料交换台</h3>
        <p class="page-desc">
          导入资料交换单位的时段雨量文件，字段按固定口径映射，旧资料按观测时段回填；同一文件只有一个批次，
          失败行保留原因后可从未完成处继续，确认批次后在水位整编清单生成待核对成果。
        </p>
      </div>
      <div class="page-actions wrap">
        <span class="terminal-pill">
          当前终端：<strong>{{ terminal }}</strong>
          <button class="link" type="button" @click="changeTerminal">换一个终端</button>
        </span>
        <button class="btn" type="button" @click="showRules = !showRules">
          {{ showRules ? '收起映射口径' : '查看字段映射口径' }}
        </button>
        <button class="btn" type="button" @click="downloadTemplate">下载交换模板</button>
        <button class="btn" type="button" @click="reload">刷新批次</button>
        <label class="btn primary upload-btn">
          导入时段雨量文件
          <input type="file" accept=".csv,.txt,text/csv" hidden @change="onFilePicked" />
        </label>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">交换批次</span>
        <strong class="stat-value">{{ batches.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">处理中批次</span>
        <strong class="stat-value">{{ processingBatches }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待确认批次</span>
        <strong class="stat-value">{{ toConfirmBatches }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已确认批次</span>
        <strong class="stat-value">{{ confirmedBatches }}</strong>
      </article>
    </div>

    <p v-if="message" :class="['desk-message', messageOk ? 'ok' : 'error']">{{ message }}</p>

    <div v-if="showRules" class="rules-box">
      <p><strong>映射口径：</strong>源文件字段与现有观测记录不一致时，按下表自动识别（不区分大小写、空格、下划线），
        识别不出来可在批次详情里人工指定；旧资料按「站点编号 + 观测时段」回填，日累计按自然日重算。</p>
      <ul class="rules-list">
        <li><b>站点编号</b>：站号、测站编号、站码、站点代码、station、stcd、siteid 等</li>
        <li><b>观测时段</b>：观测时间、时间、日期、datetime、tm 等；也支持「开始时间(start) + 结束时间(end)」两列拼成区间</li>
        <li><b>时段雨量(必填)</b>：时段降水量、雨量、降水量、rainfall、drp、P 等，单位毫米</li>
        <li><b>日累计雨量</b>：日雨量、日降水量、dailyrain、dyp 等；导入后按「时段雨量累加」统一重算</li>
        <li><b>降雨强度 / 观测人</b>：雨强、intensity；观测员、记录人、observer 等</li>
      </ul>
      <p class="muted-text">时段写法支持：<code>2026-09-01</code>、<code>2026/9/1 10:00</code>（按结束时刻）、
        <code>2026-09-01 08:00~10:00</code> 或开始/结束两列；跨日区间按结束时刻归入次日。</p>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>批次编号</th>
          <th>交换文件</th>
          <th>建立时间/终端</th>
          <th>进度（成功/失败/待处理）</th>
          <th>批次状态</th>
          <th>处理锁</th>
          <th>确认终端</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.id" :class="{ 'row-active': selectedId === batch.id }">
          <td>{{ batch.batchNo }}</td>
          <td>
            <div>{{ batch.fileName }}</div>
            <div class="muted-text">{{ (batch.fileSize / 1024).toFixed(1) }} KB · 指纹 {{ batch.fingerprint.slice(-12) }}</div>
          </td>
          <td>
            <div>{{ batch.createdAt }}</div>
            <div class="muted-text">{{ batch.creatorTerminal }}</div>
          </td>
          <td>
            <div class="progress-line">
              <span class="dot success"></span>{{ batch.successCount }}
              <span class="dot fail"></span>{{ batch.failCount }}
              <span class="dot pending"></span>{{ batch.pendingCount }}
              / 共 {{ batch.totalRows }}
            </div>
          </td>
          <td>
            <span :class="['status-pill', batchStateClass(batch.state)]">{{ batch.state }}</span>
          </td>
          <td>
            <span v-if="isLeaseHeldByOther(batch)" class="lease-text">
              终端 {{ batch.lease?.terminalId }} 处理中
            </span>
            <span v-else-if="batch.lease && batch.lease.terminalId === terminal" class="lease-text self">
              本终端持有
            </span>
            <span class="muted-text">空闲</span>
          </td>
          <td>{{ batch.confirmedBy ? `${batch.confirmedBy} · ${batch.confirmedAt}` : '—' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="selectBatch(batch.id)">批次详情</button>
            <button
              class="link"
              type="button"
              :disabled="batch.state === '已确认' || isLeaseHeldByOther(batch)"
              @click="continueBatch(batch.id)"
            >
              从未完成处继续
            </button>
            <button class="link" type="button" @click="downloadReport(batch.id)">下载核对报告</button>
            <button
              v-if="batch.state !== '已确认'"
              class="link strong"
              type="button"
              :disabled="isLeaseHeldByOther(batch)"
              @click="confirmBatch(batch.id)"
            >
              确认批次
            </button>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="8" class="empty-state">还没有交换批次，选择 CSV 文件开始导入时段雨量</td>
        </tr>
      </tbody>
    </table>

    <!-- 批次详情 -->
    <div v-if="selected" class="detail-panel">
      <header class="detail-head">
        <div>
          <h4>批次详情 · {{ selected.batchNo }}</h4>
          <p class="muted-text">{{ selected.fileName }} · 文件指纹 {{ selected.fingerprint }}</p>
        </div>
        <div class="page-actions">
          <button
            class="btn primary"
            type="button"
            :disabled="selected.state === '已确认' || isLeaseHeldByOther(selected) || selected.pendingCount === 0"
            @click="continueBatch(selected.id)"
          >
            从未完成处继续（剩 {{ selected.pendingCount }} 行）
          </button>
          <button class="btn" type="button" @click="downloadReport(selected.id)">下载日累计核对报告</button>
          <button
            v-if="selected.state !== '已确认'"
            class="btn"
            type="button"
            :disabled="isLeaseHeldByOther(selected)"
            @click="confirmBatch(selected.id)"
          >
            确认并生成待核对成果
          </button>
          <button class="btn ghost" type="button" @click="selectedId = null">收起详情</button>
        </div>
      </header>

      <div class="detail-cols">
        <div class="mapping-box">
          <h5>字段映射（口径可人工修正，保存后未成功行重新校验）</h5>
          <table class="data-table inner">
            <thead>
              <tr><th>源文件表头</th><th>映射到</th></tr>
            </thead>
            <tbody>
              <tr v-for="target in mappingTargets(selected.fieldMap)" :key="target.header">
                <td>{{ target.header }}</td>
                <td>
                  <select
                    :value="target.value"
                    :disabled="selected.state === '已确认'"
                    @change="changeMapping(selected.id, target.header, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">（不识别，不入库）</option>
                    <option v-for="opt in mappableOptions" :key="opt" :value="opt">{{ opt }}</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="muted-text">
            必填口径：站点编号、观测时段（或开始+结束两列）、时段雨量；
            当前
            <span :class="mappingMissing(selected).length ? 'error' : 'ok'">
              {{ mappingMissing(selected).length ? `缺：${mappingMissing(selected).join('、')}` : '已齐备' }}
            </span>
          </p>
        </div>

        <div class="rows-box">
          <h5>行处理明细（失败行保留原因，可直接修正后续传）</h5>
          <table class="data-table inner">
            <thead>
              <tr>
                <th>行号</th>
                <th>站点编号</th>
                <th>观测时段</th>
                <th>时段雨量</th>
                <th>状态</th>
                <th>落点/失败原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in selected.rows" :key="row.lineNo" :class="`is-${rowStateKey(row.state)}`">
                <td>{{ row.lineNo }}</td>
                <td>
                  <input
                    v-if="row.state !== '成功' && selected.state !== '已确认'"
                    :value="rowCell(row, '站点编号')"
                    @change="fixRow(selected.id, row.lineNo, '站点编号', ($event.target as HTMLInputElement).value)"
                  />
                  <template v-else>{{ rowCell(row, '站点编号') }}</template>
                </td>
                <td>
                  <input
                    v-if="row.state !== '成功' && selected.state !== '已确认'"
                    class="period-input"
                    :value="rowCell(row, '观测时段')"
                    @change="fixRow(selected.id, row.lineNo, '观测时段', ($event.target as HTMLInputElement).value)"
                  />
                  <template v-else>{{ rowCell(row, '观测时段') }}</template>
                </td>
                <td>
                  <input
                    v-if="row.state !== '成功' && selected.state !== '已确认'"
                    :value="rowCell(row, '时段雨量')"
                    @change="fixRow(selected.id, row.lineNo, '时段雨量', ($event.target as HTMLInputElement).value)"
                  />
                  <template v-else>{{ rowCell(row, '时段雨量') }}</template>
                </td>
                <td><span :class="['state-dot', row.state]">{{ row.state }}</span></td>
                <td>
                  <template v-if="row.state === '成功'">
                    <span class="ok-text">{{ row.action }} → {{ row.recordNo }}</span>
                  </template>
                  <template v-else-if="row.state === '失败'">
                    <span class="error-text">{{ row.failReason }}</span>
                  </template>
                  <template v-else>
                    <span class="muted-text">等待「从未完成处继续」</span>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { useCrossTerminalSync } from '@/composables/useCrossTerminalSync'
import { useTerminal } from '@/stores/terminal'
import {
  STANDARD_FIELDS,
  continueBatch as continueBatchApi,
  confirmRainfallBatch,
  downloadRainfallTemplate,
  downloadReconciliationReport,
  fixFailedRow,
  mappingSummary,
  registerRainfallFile,
  updateFieldMapping,
} from '@/api/rainfall-exchange'
import { listBatches } from '@/data/exchange-store'
import type { BatchState, ExchangeBatch, ImportRow } from '@/data/exchange-types'
import type { StandardField } from '@/api/rainfall-exchange'

const { terminalId: terminal, regenerate: regenerateTerminal } = useTerminal()
const batches = ref<ExchangeBatch[]>([])
const selectedId = ref<number | null>(null)
const message = ref('')
const messageOk = ref(true)
const showRules = ref(false)

const mappableOptions = [...STANDARD_FIELDS, '时段开始', '时段结束']

const selected = computed(() => batches.value.find((batch) => batch.id === selectedId.value) ?? null)

const processingBatches = computed(() => batches.value.filter((b) => b.state === '处理中').length)
const toConfirmBatches = computed(() => batches.value.filter((b) => b.state === '待确认').length)
const confirmedBatches = computed(() => batches.value.filter((b) => b.state === '已确认').length)

function flash(text: string, ok = true) {
  message.value = text
  messageOk.value = ok
}

function reload() {
  batches.value = [...listBatches()].sort((a, b) => b.id - a.id)
  if (selectedId.value !== null && !batches.value.some((batch) => batch.id === selectedId.value)) {
    selectedId.value = null
  }
}

function selectBatch(id: number) {
  selectedId.value = selectedId.value === id ? null : id
}

function changeTerminal() {
  regenerateTerminal()
  flash(`已切换为终端 ${terminal.value}，可模拟另一终端并发处理同批`)
  reload()
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  try {
    const text = await file.text()
    const result = registerRainfallFile(file.name, file.size, text, terminal.value)
    flash(result.message, true)
    reload()
    if (!result.reused) {
      selectedId.value = result.batch.id
      // 新批次且必填字段齐备，直接跑第一轮，体现「从未完成处继续」的起点。
      if (result.missing.length === 0) {
        const run = continueBatchApi(result.batch.id, terminal.value)
        flash(run.message, true)
        reload()
      }
    } else {
      selectedId.value = result.batch.id
    }
  } catch (error) {
    flash(error instanceof Error ? error.message : '文件读取失败', false)
  }
}

function continueBatch(id: number) {
  try {
    const result = continueBatchApi(id, terminal.value)
    flash(result.message, result.acquired || result.processed === 0)
    reload()
  } catch (error) {
    flash(error instanceof Error ? error.message : '继续处理失败', false)
  }
}

function confirmBatch(id: number) {
  const batch = batches.value.find((item) => item.id === id)
  if (!batch) {
    return
  }
  if (batch.pendingCount > 0) {
    flash(`批次还有 ${batch.pendingCount} 行待处理，请先「从未完成处继续」`, false)
    return
  }
  const hint = batch.failCount > 0
    ? `批次保留 ${batch.failCount} 行失败（原因已写入核对报告），仍要确认并生成待核对成果？`
    : '确认后水位整编清单将新增一份待核对成果，且多终端只有一个确认标记生效。是否确认？'
  if (!window.confirm(hint)) {
    return
  }
  const result = confirmRainfallBatch(id, terminal.value)
  flash(result.message, result.ok)
  reload()
}

function downloadReport(id: number) {
  try {
    downloadReconciliationReport(id)
  } catch (error) {
    flash(error instanceof Error ? error.message : '报告生成失败', false)
  }
}

function downloadTemplate() {
  downloadRainfallTemplate()
}

function changeMapping(id: number, header: string, target: string) {
  try {
    updateFieldMapping(id, header, target)
    flash(`表头「${header}」的映射口径已改为「${target || '不识别'}」，未成功行将在下一轮重新校验`)
    reload()
  } catch (error) {
    flash(error instanceof Error ? error.message : '映射修改失败', false)
  }
}

function fixRow(id: number, lineNo: number, field: StandardField, value: string) {
  try {
    fixFailedRow(id, lineNo, field, value)
    flash(`第 ${lineNo} 行的「${field}」已修正为「${value}」，该行回到待处理，可继续导入`)
    reload()
  } catch (error) {
    flash(error instanceof Error ? error.message : '行修正失败', false)
  }
}

function mappingTargets(fieldMap: Record<string, string>) {
  return Object.entries(fieldMap).map(([header, value]) => ({ header, value }))
}

function mappingMissing(batch: ExchangeBatch): StandardField[] {
  return mappingSummary(batch.fieldMap).missing
}

function isLeaseHeldByOther(batch: ExchangeBatch): boolean {
  return !!batch.lease && batch.lease.until > Date.now() && batch.lease.terminalId !== terminal.value
}

function batchStateClass(state: BatchState): string {
  if (state === '已确认') return 'is-passed'
  if (state === '待确认') return 'is-warn'
  return 'is-info'
}

function rowStateKey(state: ImportRow['state']): string {
  if (state === '成功') return 'success'
  if (state === '失败') return 'fail'
  return 'pending'
}

/** 行内显示/编辑用值：人工修正优先，其次按当前映射取原始单元格。 */
function rowCell(row: ImportRow, standard: StandardField): string {
  if (row.fixes && standard in row.fixes) {
    return row.fixes[standard]
  }
  const batch = selected.value
  if (!batch) {
    return ''
  }
  for (const [header, target] of Object.entries(batch.fieldMap)) {
    if (target === standard) {
      return row.raw[header] ?? ''
    }
  }
  return ''
}

// 其它终端动了批次/清单/台账时，本终端立刻翻到最新状态（锁释放、确认标记等）。
useCrossTerminalSync((source) => {
  if (source === 'batch' || source === 'entries' || source === 'tick') {
    reload()
  }
})

reload()
</script>

<style scoped>
.exchange-desk {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.page-actions.wrap {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.terminal-pill {
  font-size: 12px;
  color: var(--muted);
  background: #eef2f7;
  border-radius: 999px;
  padding: 4px 10px;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.upload-btn {
  cursor: pointer;
}
.desk-message {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  margin: 0 0 10px;
}
.desk-message.ok {
  background: #ecfdf3;
  color: #166534;
  border: 1px solid #abefc6;
}
.desk-message.error {
  background: #fef3f2;
  color: #b42318;
  border: 1px solid #fecdca;
}
.rules-box {
  background: #f8fafc;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 12px;
}
.rules-list {
  margin: 6px 0;
  padding-left: 18px;
}
.rules-list li {
  margin: 2px 0;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.ok-text {
  color: #166534;
}
.row-active {
  background: #f5f9ff;
}
.progress-line {
  display: flex;
  gap: 4px;
  align-items: center;
  white-space: nowrap;
  font-size: 13px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  margin-left: 8px;
}
.dot.success { background: #12b76a; }
.dot.fail { background: #f04438; }
.dot.pending { background: #fdb022; }
.status-pill {
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.status-pill.is-info { background: #e0efff; color: #1849a9; }
.status-pill.is-warn { background: #fef3c7; color: #92400e; }
.status-pill.is-passed { background: #dcfce7; color: #166534; }
.lease-text {
  font-size: 12px;
  color: #92400e;
}
.lease-text.self {
  color: #1849a9;
}
.link.strong {
  font-weight: 600;
}
.link:disabled {
  color: #98a2b3;
  cursor: not-allowed;
}
.detail-panel {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  background: #fcfdff;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}
.detail-head h4 {
  margin: 0 0 4px;
}
.detail-cols {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 12px;
}
.data-table.inner {
  font-size: 12px;
}
.data-table.inner th, .data-table.inner td {
  padding: 6px 8px;
}
.mapping-box select,
.rows-box input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 12px;
}
.rows-box .period-input {
  min-width: 150px;
}
.mapping-box h5, .rows-box h5 {
  margin: 0 0 8px;
  font-size: 13px;
}
tr.is-fail {
  background: #fff7f6;
}
tr.is-pending {
  background: #fffaeb;
}
.state-dot {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
}
.state-dot.成功 { background: #dcfce7; color: #166534; }
.state-dot.失败 { background: #fee2e2; color: #991b1b; }
.state-dot.待处理 { background: #fef3c7; color: #92400e; }
</style>
