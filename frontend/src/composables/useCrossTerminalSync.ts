import { onBeforeUnmount, onMounted } from 'vue'

import { invalidateExchangeCache, EXCHANGE_CHANNEL } from '@/data/exchange-store'
import { invalidateCache, storageKey } from '@/data/local-store'

/**
 * 多终端同步：同浏览器其它标签页写了批次/清单/台账后，本终端收到广播或
 * storage 事件，丢掉内存缓存，页面据此重新拉取最新数据。
 */
export function useCrossTerminalSync(onChange: (source: 'batch' | 'checklist' | 'entries' | 'tick') => void) {
  let channel: BroadcastChannel | null = null

  const handleChannel = (event: MessageEvent) => {
    const kind = event.data?.kind
    if (kind === 'batch') {
      invalidateExchangeCache('batch')
      onChange('batch')
    } else if (kind === 'checklist') {
      invalidateExchangeCache('checklist')
      onChange('checklist')
    }
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey()) {
      invalidateCache()
      onChange('entries')
    } else if (event.key === 'hydrology-monitor-station:rainfall-exchange-batches') {
      invalidateExchangeCache('batch')
      onChange('batch')
    } else if (event.key === 'hydrology-monitor-station:waterlevel-checklist') {
      invalidateExchangeCache('checklist')
      onChange('checklist')
    }
  }

  // 租约 60 秒：每秒轻量轮询，锁过期或被别的终端确认时本终端能及时翻牌。
  const timer = window.setInterval(() => onChange('tick'), 1000)

  onMounted(() => {
    try {
      channel = new BroadcastChannel(EXCHANGE_CHANNEL)
      channel.addEventListener('message', handleChannel)
    } catch {
      // 不支持 BroadcastChannel 时靠 storage 事件兜底。
    }
    window.addEventListener('storage', handleStorage)
  })

  onBeforeUnmount(() => {
    channel?.close()
    window.removeEventListener('storage', handleStorage)
    window.clearInterval(timer)
  })
}
