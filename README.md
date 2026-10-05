# 海上搜救联合指挥

源提示词摘要：按海域划设搜索区，协调船艇、直升机、无人机和岸上观察点，记录任务变更、通信与天气影响；离线单位恢复后合并状态，过期位置必须明确提示，并提供低带宽模式。

## 技术栈

Next.js 15、TypeScript、App Router、Mantine、Zustand、TanStack Query、React Hook Form、Zod、next-intl、date-fns、MapLibre。

## 本地运行

```bash
npm install
npm run dev
```

开发端口：`62027`

## 可用流程

- 搜索区从规划、执行到关闭，支持任务范围变更。
- 船艇、直升机、无人机可调派、转入失联、恢复在线。
- 任务单支持新建议题、分配单位、关闭任务和事件留痕。
- 离线模拟与低带宽模式可切换；本地数据由 Zustand persist 保存。
