<template>
  <section class="page" data-module="rainfall">
    <header class="page-head">
      <div>
        <h2>雨量观测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转；资料交换台支持时段雨量导入与日累计核对。</p>
      </div>
      <div class="page-actions">
        <div class="view-switch" role="tablist">
          <button
            type="button"
            :class="['switch-btn', { active: view === 'records' }]"
            @click="view = 'records'"
          >
            观测记录
          </button>
          <button
            type="button"
            :class="['switch-btn', { active: view === 'exchange' }]"
            @click="view = 'exchange'"
          >
            资料交换台
          </button>
        </div>
        <button v-if="view === 'records'" class="btn" type="button" @click="exportRows">导出雨量观测清单</button>
      </div>
    </header>

    <template v-if="view === 'records'">
      <div class="stat-row">
        <article v-for="item in stats" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无雨量观测数据，可在「资料交换台」导入时段雨量</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ total }} 条雨量观测记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <ExchangeDesk v-else />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import ExchangeDesk from '@/components/ExchangeDesk.vue'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useCrossTerminalSync } from '@/composables/useCrossTerminalSync'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('rainfall')
const columns = ["记录编号", "站点编号", "观测时段", "时段雨量", "日累计雨量", "降雨强度", "观测人", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日观测站次", "value": 0}, {"label": "暴雨站点数", "value": 0}, {"label": "待审核记录", "value": 0}]

const view = ref<'records' | 'exchange'>('records')
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量观测列表读取失败'
  }
}

// 交换台在别的终端回填台账后，切回记录视图也要看到最新雨量记录。
useCrossTerminalSync((source) => {
  if (source === 'entries' && view.value === 'records') {
    reload()
  }
})

onMounted(reload)
</script>

<style scoped>
.view-switch {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  margin-right: 8px;
}
.switch-btn {
  border: none;
  background: #fff;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--muted);
}
.switch-btn.active {
  background: var(--brand);
  color: #fff;
}
</style>
