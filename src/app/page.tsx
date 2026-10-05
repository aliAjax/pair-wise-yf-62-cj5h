'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Grid, Group, List, Progress, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, Timeline, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useEffect, useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { SearchMap } from '@/components/SearchMap';
import { CommLedgerCard } from '@/components/CommLedgerCard';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1),
  assetIds: z.array(z.string()).min(1, '至少调派一个单位'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160)
});

interface Notice {
  color: string;
  message: string;
}

export default function CommandPage() {
  const state = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>(['ship-01']);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof missionSchema>>({
    resolver: zodResolver(missionSchema),
    defaultValues: { title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' }
  });
  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: state.lowBandwidth ? false : 60_000
  });

  // 低带宽下每 5 秒刷新时钟（驱动过期倒计时）并巡检过期位置包
  useEffect(() => {
    if (!state.lowBandwidth) return;
    const timer = setInterval(() => {
      setTick(Date.now());
      state.tickExpiry();
    }, 5_000);
    return () => clearInterval(timer);
  }, [state.lowBandwidth]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const flash = (color: string, message: string) => setNotice({ color, message });

  const submitMission = (values: z.infer<typeof missionSchema>) => {
    state.dispatchMission({ ...values, assetIds: selectedAssets });
    if (state.lowBandwidth) {
      // dispatchMission 内部记账，这里从最新事件取结果提示
      flash('cyan', `搜救令“${values.title}”已提交：占不到包位会自动进入待发队列，且优先于例行位置`);
    }
    reset({ title: '', areaId: state.areas[0]?.id, assetIds: selectedAssets, priority: 'urgent', note: '' });
  };

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div><Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge><Title order={1} className="section-title">海上搜救联合指挥</Title><Text c="dimmed">搜索区、力量与任务在同一时间线上协同</Text></div>
          <Group><Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} /><Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} /></Group>
        </Group>

        {notice && <Alert color={notice.color} variant="light" withCloseButton onClose={() => setNotice(null)}>{notice.message}</Alert>}

        {state.lowBandwidth && (
          <Alert color="orange" variant="light" title="低带宽发送账已启用">
            位置与指令回执同样占用通信窗口：容量一满，搜救令先排队且优先于例行位置；位置包 2 分钟未送出即作废。
            任务状态变化后未完成的待发指令立即作废并释放包位，已送回执的留档保留。
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 4 }}>
          {[
            ['活动搜索区', state.areas.filter((item) => item.status === 'active').length],
            ['在线单位', state.assets.filter((item) => item.status !== 'offline').length],
            ['进行中任务', state.missions.filter((item) => item.status === 'in_progress').length],
            ['过期位置', state.assets.filter((item) => Date.now() - new Date(item.lastSeen).getTime() > 10 * 60_000).length]
          ].map(([label, value]) => <Card key={String(label)} withBorder><Text size="sm" c="dimmed">{label}</Text><Title order={2}>{value}</Title></Card>)}
        </SimpleGrid>

        {state.lowBandwidth && <CommLedgerCard now={tick} />}

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}><Card withBorder><Group justify="space-between"><Title order={3}>搜救态势</Title><Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text></Group><SearchMap areas={state.areas} assets={state.assets} /></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}><Card withBorder h="100%"><Title order={3}>单位状态</Title><Stack mt="md">{state.assets.map((asset) => {
            const stale = Date.now() - new Date(asset.lastSeen).getTime() > 10 * 60_000;
            return <Card key={asset.id} withBorder padding="sm"><Group justify="space-between"><b>{asset.name}</b><Badge color={asset.status === 'offline' ? 'red' : asset.status === 'assigned' ? 'blue' : 'teal'}>{asset.status}</Badge></Group><Text size="xs" c={stale ? 'red' : 'dimmed'}>{stale ? '位置已过期 · ' : ''}{formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}</Text><Group mt="xs"><Button size="compact-xs" onClick={() => state.setAssetStatus(asset.id, asset.status === 'offline' ? 'ready' : 'offline')}>{asset.status === 'offline' ? '恢复在线' : '标记失联'}</Button>{state.lowBandwidth && <Button size="compact-xs" variant="light" color="teal" onClick={() => {
              const r = state.reportPosition(asset.id);
              flash(r.result === 'queued' ? 'yellow' : 'cyan', r.message);
            }}>上报位置（占包位）</Button>}</Group></Card>;
          })}</Stack></Card></Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}><Card withBorder><Title order={3}>派发新任务</Title><form onSubmit={handleSubmit(submitMission)}><Stack mt="md"><TextInput label="任务名称" {...register('title')} error={errors.title?.message} /><label>搜索区<select {...register('areaId')} style={{ width: '100%', padding: 8 }}>{state.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>调派单位（可多选）<select multiple value={selectedAssets} onChange={(event) => setSelectedAssets(Array.from(event.currentTarget.selectedOptions, (option) => option.value))} style={{ width: '100%', minHeight: 86 }}>{state.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>优先级<select {...register('priority')} style={{ width: '100%', padding: 8 }}><option value="urgent">紧急</option><option value="normal">常规</option></select></label><Textarea label="任务说明" {...register('note')} /><Button type="submit">派发任务</Button>{state.lowBandwidth && <Text size="xs" c="dimmed">低带宽下任务以“搜救令”包提交：同一任务重复提交只入队一次，已确认的不会重复占包位。</Text>}</Stack></form></Card></Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}><Card withBorder><Title order={3}>任务与搜索区</Title><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th align="left">搜索区</th><th align="left">状态</th><th align="left">覆盖率</th></tr></thead><tbody>{state.areas.map((area) => <tr key={area.id}><td style={{ padding: '8px 0' }}>{area.name}</td><td>{area.status}</td><td style={{ width: '42%' }}><Progress value={area.coverage} /></td></tr>)}</tbody></table><List mt="lg" spacing="sm">{state.missions.map((mission) => <List.Item key={mission.id}><Group justify="space-between"><div><b>{mission.title}</b> {mission.priority === 'urgent' && <Badge size="xs" color="orange">紧急</Badge>}<Text size="xs" c="dimmed">{mission.areaId} · {mission.assetIds.join(' / ')}</Text></div><Group gap={6}><Badge>{mission.status}</Badge>{state.lowBandwidth && <Button size="compact-xs" variant="light" color="red" onClick={() => {
            const r = state.submitRescue(mission.id);
            flash(r.result === 'duplicate' ? 'gray' : r.result === 'queued' ? 'yellow' : 'cyan', r.message);
          }}>提交搜救令</Button>}<Button size="compact-xs" onClick={() => state.setMissionStatus(mission.id, mission.status === 'in_progress' ? 'closed' : 'in_progress')}>{mission.status === 'closed' ? '重开' : '推进/关闭'}</Button></Group></Group></List.Item>)}</List>{state.lowBandwidth && <Text size="xs" c="dimmed" mt="sm">推进/关闭任务会使该任务未完成的待发指令立即作废并释放包位；两名值班员可同时点“提交搜救令”，最后一个包位先提交者得。</Text>}</Card></Grid.Col>
        </Grid>

        <Card withBorder><Title order={3}>联合事件时间线</Title><Timeline mt="lg" active={1} bulletSize={18} lineWidth={2}>{state.events.slice(0, 12).map((event) => <Timeline.Item key={event.id} title={`${event.actor} · ${new Date(event.time).toLocaleTimeString()}`}><Text size="sm">{event.message}</Text></Timeline.Item>)}</Timeline></Card>
      </Stack>
    </main>
  );
}
