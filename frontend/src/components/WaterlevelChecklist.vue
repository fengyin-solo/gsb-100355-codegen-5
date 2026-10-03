<template>
  <section class="checklist-block">
    <header class="checklist-head">
      <div>
        <h3>水位整编清单 · 待核对成果</h3>
        <p class="page-desc">雨量资料交换批次确认后在此形成一份待核对成果；多终端并发确认只接受一个完成标记。</p>
      </div>
      <div class="checklist-tools">
        <label class="filter-item compact">
          <span>核对状态</span>
          <select v-model="statusFilter">
            <option value="">全部</option>
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="reload">刷新清单</button>
      </div>
    </header>

    <table class="data-table">
      <thead>
        <tr>
          <th>成果编号</th>
          <th>成果名称</th>
          <th>来源批次/文件</th>
          <th>站点</th>
          <th>覆盖日期</th>
          <th>成功/失败行</th>
          <th>生成终端/时间</th>
          <th>核对状态</th>
          <th>核对操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in visibleItems" :key="item.id">
          <td>{{ item.resultNo }}</td>
          <td>{{ item.title }}</td>
          <td>
            <div>{{ item.batchNo }}</div>
            <div class="muted-text">{{ item.fileName }}</div>
          </td>
          <td>{{ item.stations.join('、') || '—' }}</td>
          <td>{{ item.periodStart || '—' }} ~ {{ item.periodEnd || '—' }}</td>
          <td>{{ item.recordCount }} / {{ item.failCount }}</td>
          <td>
            <div>{{ item.createdBy }}</div>
            <div class="muted-text">{{ item.createdAt }}</div>
          </td>
          <td>
            <span :class="['status-pill', item.status === '待核对' ? 'is-pending' : item.status === '已通过' ? 'is-passed' : 'is-rejected']">
              {{ item.status }}
            </span>
            <div v-if="item.checkedAt" class="muted-text">{{ item.checkedAt }}</div>
            <div v-if="item.checkNote" class="muted-text">意见：{{ item.checkNote }}</div>
          </td>
          <td class="row-actions">
            <template v-if="item.status === '待核对'">
              <button class="link" type="button" @click="review(item.id, '已通过')">核对通过</button>
              <button class="link danger" type="button" @click="review(item.id, '已驳回')">驳回</button>
            </template>
            <span v-else class="muted-text">已闭环</span>
          </td>
        </tr>
        <tr v-if="!visibleItems.length">
          <td colspan="9" class="empty-state">暂无待核对成果，雨量资料交换批次确认后会自动登记到这里</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>共 {{ items.length }} 份整编成果，其中待核对 {{ pendingCount }} 份</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { listWaterlevelChecklist, reviewChecklistResult } from '@/api/rainfall-exchange'
import { useCrossTerminalSync } from '@/composables/useCrossTerminalSync'
import type { ChecklistResult, ChecklistStatus } from '@/data/exchange-types'

const statuses: ChecklistStatus[] = ['待核对', '已通过', '已驳回']
const items = ref<ChecklistResult[]>([])
const statusFilter = ref('')
const message = ref('')
const messageOk = ref(true)

const visibleItems = computed(() =>
  statusFilter.value ? items.value.filter((item) => item.status === statusFilter.value) : items.value,
)
const pendingCount = computed(() => items.value.filter((item) => item.status === '待核对').length)

function reload() {
  items.value = listWaterlevelChecklist()
}

function review(id: number, status: ChecklistStatus) {
  const note = window.prompt(status === '已通过' ? '请填写核对意见（可留空）' : '请填写驳回原因', '')
  if (note === null) {
    return
  }
  const updated = reviewChecklistResult(id, status, note)
  if (!updated) {
    messageOk.value = false
    message.value = '成果已被其它终端处理或不存在'
  } else {
    messageOk.value = true
    message.value = `成果 ${updated.resultNo} 已标记为「${status}」`
  }
  reload()
}

useCrossTerminalSync((source) => {
  if (source === 'checklist' || source === 'tick') {
    reload()
  }
})

reload()
</script>

<style scoped>
.checklist-block {
  margin-top: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.checklist-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.checklist-head h3 {
  margin: 0;
  font-size: 15px;
}
.checklist-tools {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}
.filter-item.compact span {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.filter-item.compact select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.status-pill.is-pending {
  background: #fef3c7;
  color: #92400e;
}
.status-pill.is-passed {
  background: #dcfce7;
  color: #166534;
}
.status-pill.is-rejected {
  background: #fee2e2;
  color: #991b1b;
}
.link.danger {
  color: #b42318;
}
</style>
