'use client';

import { useEffect } from 'react';
import { Badge, Box, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useCommandStore } from '@/lib/store';
import { comparePriority, windowCapacity } from '@/lib/ledger';
import type { PacketKind, PacketPriority, PacketStatus, SendPacket } from '@/lib/types';

const kindLabel: Record<PacketKind, string> = { position: '位置', command: '搜救令', receipt: '回执' };
const priorityColor: Record<PacketPriority, string> = { urgent: 'red', normal: 'orange', routine: 'gray' };
const priorityLabel: Record<PacketPriority, string> = { urgent: '紧急', normal: '常规', routine: '例行' };
const statusColor: Record<PacketStatus, string> = { queued: 'yellow', inflight: 'blue', delivered: 'teal', voided: 'dark', expired: 'dark' };
const statusLabel: Record<PacketStatus, string> = { queued: '待发', inflight: '发送中', delivered: '已送达', voided: '已作废', expired: '已过期' };

function PacketRow({ p }: { p: SendPacket }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="xs">
      <div style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" truncate>{p.title}</Text>
        <Group gap={6} mt={2}>
          <Badge size="xs" variant="light">{kindLabel[p.kind]}</Badge>
          <Badge size="xs" color={priorityColor[p.priority]} variant="light">{priorityLabel[p.priority]}</Badge>
          {p.attempts > 0 && p.status === 'queued' && <Badge size="xs" color="yellow" variant="light">重试 {p.attempts} 次</Badge>}
          {p.kind === 'position' && p.status === 'queued' && p.expiresAt && (
            <Text size="xs" c="dimmed">有效期 {formatDistanceToNow(new Date(p.expiresAt), { addSuffix: true, locale: zhCN })}</Text>
          )}
          {p.status === 'expired' && <Text size="xs" c="red">已过期作废</Text>}
          {p.status === 'voided' && <Text size="xs" c="dimmed">任务变更作废</Text>}
        </Group>
      </div>
      <Badge size="xs" color={statusColor[p.status]} variant="light">{statusLabel[p.status]}</Badge>
    </Group>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <Group justify="space-between" mb={4}><Text size="xs" c="dimmed" fw={600}>{title}</Text><Text size="xs" c="dimmed">{count}</Text></Group>
      {count === 0 ? <Text size="xs" c="dimmed">— 空 —</Text> : <Stack gap={6}>{children}</Stack>}
    </div>
  );
}

export function CommunicationWindow() {
  const packets = useCommandStore((s) => s.packets);
  const lowBandwidth = useCommandStore((s) => s.lowBandwidth);
  const tickWindow = useCommandStore((s) => s.tickWindow);
  const enqueuePositionReports = useCommandStore((s) => s.enqueuePositionReports);
  const capacity = windowCapacity(lowBandwidth);
  const inflight = packets.filter((p) => p.status === 'inflight');
  const queued = packets.filter((p) => p.status === 'queued').sort(comparePriority);
  const archive = packets.filter((p) => p.status === 'delivered' || p.status === 'voided' || p.status === 'expired');

  // 低带宽时自动推进通信窗口
  useEffect(() => {
    if (!lowBandwidth) return;
    const id = setInterval(() => tickWindow(), 4000);
    return () => clearInterval(id);
  }, [lowBandwidth, tickWindow]);

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Group gap="xs"><Title order={3}>通信窗口 · 发送账</Title><Badge color={lowBandwidth ? 'orange' : 'teal'} variant="light">{lowBandwidth ? '低带宽' : '正常带宽'}</Badge></Group>
        <Group gap="xs">
          <Button size="compact-sm" variant="light" onClick={enqueuePositionReports}>上报单位位置</Button>
          <Button size="compact-sm" onClick={tickWindow}>推送一帧</Button>
        </Group>
      </Group>

      <Group gap={6} mb="md">
        {Array.from({ length: capacity }).map((_, i) => (
          <Box key={i} w={26} h={26} style={{ borderRadius: 6, border: '1px solid #bed1d7', background: i < inflight.length ? '#0e7490' : 'transparent' }} />
        ))}
        <Text size="sm" c="dimmed" ml={4}>包位 {inflight.length}/{capacity}</Text>
      </Group>

      <Stack gap="md">
        <Section title="发送中（占用包位）" count={inflight.length}>{inflight.map((p) => <PacketRow key={p.id} p={p} />)}</Section>
        <Section title="待发队列（搜救令先于例行位置）" count={queued.length}>{queued.map((p) => <PacketRow key={p.id} p={p} />)}</Section>
        <Section title="留档（已送达 / 已作废 / 已过期）" count={archive.length}>{archive.slice(0, 8).map((p) => <PacketRow key={p.id} p={p} />)}</Section>
      </Stack>
    </Card>
  );
}
