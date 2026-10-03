// 交换台核心逻辑的 node 自测：用最小 localStorage 桩跑一遍完整链路。
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  sessionStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
}
globalThis.CustomEvent = class {
  constructor(name, init) {
    this.type = name
    this.detail = init?.detail
  }
}

const exchange = await import('../src/api/exchange-service.ts')
const localStore = await import('../src/data/local-store.ts')

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

// 清掉播种数据
localStore.saveRows('rainfall', [])
localStore.saveRows('compilation', [])

const csv = [
  '台站编号,起止时间,时段降水量,观测员',
  'STAT-0001,2026-09-01 08:00,2.5,张三',
  'STAT-0001,2026-09-01 09:00,5.0,张三',
  'STAT-0002,2026-09-01 20:00-21:00,12.0,李四',
  'STAT-0001,not-a-date,3.0,张三',
  'STAT-0001,2026-09-01 10:00,abc,张三',
  ',2026-09-01 11:00,1.0,张三',
  'STAT-0001,2026-09-01 12:00,1.5,张三',
  'STAT-0001,2026-09-01 13:00,0.5,张三',
  'STAT-0001,2026-09-01 14:00,2.0,张三',
  'STAT-0001,2026-09-01 15:00,1.0,张三',
  'STAT-0002,2026-09-01 21:00,3.0,',
].join('\n')

console.log('1) 上传与字段映射')
const created = exchange.createBatchFromFile('exchange.csv', csv.length, csv)
check('批次创建成功', !!created.batch && !created.reused, created.error)
const batchId = created.batch.id
exchange.processNextChunk(batchId) // 与页面一致：上传后自动推进首段
check('11 条数据行', created.batch.rows.length === 11)
check('坏日期行预校验失败并带原因', created.batch.rows[3].status === 'failed' && created.batch.rows[3].reason.includes('观测时段'))
check('雨量非数值行失败', created.batch.rows[4].status === 'failed' && created.batch.rows[4].reason.includes('时段雨量'))
check('空站号行失败', created.batch.rows[5].status === 'failed' && created.batch.rows[5].reason.includes('站点编号'))
check('首批处理 5 行后仍有待处理行（断点可见）', exchange.listBatches()[0].rows.filter((r) => r.status === 'pending').length === 3)

console.log('2) 从未完成处继续导入')
let guard = 0
while (exchange.listBatches().find((b) => b.id === batchId).state !== 'awaiting' && guard < 10) {
  exchange.processNextChunk(batchId)
  guard += 1
}
const done = exchange.listBatches().find((b) => b.id === batchId)
check('续导后进入待确认', done.state === 'awaiting')
check('成功 8 行', done.rows.filter((r) => r.status === 'success').length === 8)
check('失败 3 行原因保留', done.rows.filter((r) => r.status === 'failed').length === 3)
check('观测时段归一为起始时刻', localStore.listRows('rainfall').some((e) => e['观测时段'] === '2026-09-01 20:00'))
check('缺观测员时记为资料交换', localStore.listRows('rainfall').some((e) => e['观测人'] === '资料交换'))
check('数据来源标记为资料交换', localStore.listRows('rainfall').every((e) => e['数据来源'] === '资料交换'))

console.log('3) 日累计回填')
const r1 = localStore.listRows('rainfall').filter((e) => e['站点编号'] === 'STAT-0001')
check('STAT-0001 日累计=2.5+5+1.5+0.5+2+1=12.5', r1.every((e) => e['日累计雨量'] === '12.5'), r1[0]?.['日累计雨量'])
const r2 = localStore.listRows('rainfall').filter((e) => e['站点编号'] === 'STAT-0002')
check('STAT-0002 日累计=15', r2.every((e) => e['日累计雨量'] === '15'), r2[0]?.['日累计雨量'])

console.log('4) 同一文件重复上传只形成一个批次')
const again = exchange.createBatchFromFile('exchange.csv', csv.length, csv)
check('复用旧批次', again.reused && again.batch.id === batchId)
check('批次总数仍为 1', exchange.listBatches().length === 1)

console.log('5) 旧资料按观测时段回填（更新而非新增）')
const csv2 = ['台站编号,起止时间,时段降水量', 'STAT-0001,2026-09-01 08:00,9.9'].join('\n')
const b2 = exchange.createBatchFromFile('exchange2.csv', csv2.length, csv2)
while (exchange.listBatches().find((b) => b.id === b2.batch.id).state !== 'awaiting') {
  exchange.processNextChunk(b2.batch.id)
}
const updated = localStore.listRows('rainfall').filter((e) => e['观测时段'] === '2026-09-01 08:00')
check('同时段仍只有一条记录', updated.length === 1, `实际 ${updated.length}`)
check('时段雨量更新为 9.9', updated[0]['时段雨量'] === '9.9', updated[0]['时段雨量'])
check('日累计重算=9.9+5+1.5+0.5+2+1=19.9', updated[0]['日累计雨量'] === '19.9', updated[0]['日累计雨量'])
const b2stored = exchange.listBatches().find((b) => b.id === b2.batch.id)
check('回填说明为更新旧资料', b2stored.rows.find((r) => r.line === 2).reason.includes('更新旧资料'))

console.log('6) 批次确认 + 水位整编清单待核对成果')
const compBefore = localStore.listRows('compilation').length
const confirm1 = exchange.confirmBatch(batchId, '值班管理员')
check('首次确认成功', confirm1.ok, confirm1.message)
const comp = localStore.listRows('compilation')
check('整编清单新增 1 份成果', comp.length === compBefore + 1)
check('成果状态为待核对', comp[0].status === '待核对' && comp[0]['整编状态'] === '待核对')
check('成果编号关联批次', comp[0]['成果编号'] === `CHK-${batchId}`)
check('整编类型为日累计核对', String(comp[0]['整编类型']).includes('日累计核对'))

console.log('7) 多终端并发：同批只接受一个完成标记')
const confirm2 = exchange.confirmBatch(batchId, '另一终端用户')
check('重复确认被拒', !confirm2.ok && confirm2.message.includes('完成标记唯一'))
check('整编成果没有重复写入', localStore.listRows('compilation').length === compBefore + 1)

// 模拟另一终端会话抢占第二个批次
const originalGet = globalThis.window.sessionStorage.getItem
globalThis.window.sessionStorage.getItem = (k) =>
  String(k).includes('terminal') ? 'TERM-OTHER' : originalGet(k)
const raceA = exchange.confirmBatch(b2.batch.id, '终端A')
const raceB = exchange.confirmBatch(b2.batch.id, '终端B')
check('并发同版本只有一个成功', raceA.ok !== raceB.ok, `A=${raceA.ok} B=${raceB.ok}`)
check('并发后成果仍只新增一份', localStore.listRows('compilation').length === compBefore + 2)
globalThis.window.sessionStorage.getItem = originalGet

console.log('8) 日累计核对报告')
const report = exchange.buildDailyReport(batchId)
check('报告含站点日汇总', report.content.includes('STAT-0001,2026-09-01'))
check('报告附失败行清单', report.content.includes('失败原因'))

console.log('9) 模板下载与 CSV 引号转义')
const parsed = exchange.parseCsv('"站,号","时段"\n"S01","2026-09-01 08:00"')
check('引号内逗号不拆列', parsed.headers.length === 2 && parsed.records[0]['站,号'] === 'S01')

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
