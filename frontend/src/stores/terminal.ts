import { ref } from 'vue'

// 「多个终端」在纯前端演示里就是同一浏览器的多个标签页：终端号放在
// sessionStorage，每个标签页独立；也可以用页面上的按钮手工换一个终端。
const TERMINAL_KEY = 'hydrology-monitor-station:terminal-id'

function randomTerminalId(): string {
  return `T-${Math.floor(1000 + Math.random() * 9000)}`
}

function readTerminalId(): string {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return randomTerminalId()
  }
  const existing = window.sessionStorage.getItem(TERMINAL_KEY)
  if (existing) {
    return existing
  }
  const created = randomTerminalId()
  window.sessionStorage.setItem(TERMINAL_KEY, created)
  return created
}

const terminalId = ref(readTerminalId())

export function useTerminal() {
  return {
    terminalId,
    regenerate() {
      terminalId.value = randomTerminalId()
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(TERMINAL_KEY, terminalId.value)
      }
    },
  }
}
