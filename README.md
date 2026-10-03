# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。

## 雨量资料交换台

雨量观测页内可切换到「资料交换台」（`src/components/ExchangeDesk.vue`，业务在
`src/api/rainfall-exchange.ts`），用于导入资料交换单位的时段雨量文件并形成交换批次：

- **字段映射口径**：源文件字段与现有观测记录不一致时，按内置别名表自动映射（如 站号/STCD→站点编号、
  时段降水量/DRP→时段雨量、日降水量→日累计雨量），支持「开始时间+结束时间」两列拼区间；
  识别不出的表头可在批次详情里人工指定，口径随批次固化。
- **旧资料回填**：按「站点编号 + 观测时段」匹配旧资料（支持结束时刻、`08:00~10:00` 区间、跨日区间
  归次日、纯日期等写法），命中回填时段雨量，未命中新登记；导入后按自然日重算日累计雨量。
- **一个文件一个批次**：指纹 = 文件名+大小+内容哈希，重复上传只返回原批次。
- **失败行留因、断点续传**：失败行保留文件行号与原因，可在页面直接修正（或改字段映射），
  「从未完成处继续」只跑待处理行。
- **批次确认与待核对成果**：批次待确认时原子 CAS 提交，多终端（多标签页）并发只接受一个完成标记，
  成功后在「水位整编清单」生成一份待核对成果；水位监测、数据整编两个模块挂的是同一份清单
  （`src/components/WaterlevelChecklist.vue`），可核对通过/驳回。
- **日累计核对报告**：按批次下载 CSV，包含日累计核对（时段累加 vs 文件填报 vs 台账值）、
  字段映射口径、失败行及原因三段。
- 交换批次与整编清单的 localStorage 键：`hydrology-monitor-station:rainfall-exchange-batches`、
  `hydrology-monitor-station:waterlevel-checklist`；多终端同步用 BroadcastChannel + storage 事件。
