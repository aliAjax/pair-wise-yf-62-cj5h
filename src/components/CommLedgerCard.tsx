'use client';

import { Badge, Button, Card, Group, Progress, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import type { Packet } from '@/lib/comm/types';
import { useCommandStore, usedSlots, waitingQueue } from '@/lib/store';

const KIND_LABEL: Record<Packet['kind'], string> = {
  rescue: '搜救令',
  receipt: '指令回执',
  position: '单位位置'
};

const KIND_COLOR: Record<Packet['kind'], string> = {
  rescue: 'red',
  receipt: 'violet',
  position: 'teal'
};

const STATUS_META: Record<Packet['status'], { label: string; color: string }> = {
  waiting: { label: '待发队列', color: 'yellow' },
  sending: { label: '窗口发送中', color: 'blue' },
  delivered: { label: '已送达·待回执', color: 'cyan' },
  confirmed: { label: '已留档', color: 'gray' },
  void: { label: '已作废', color: 'dark' }
};

const VOID_REASON: Record<string, string> = {
  mission_changed: '任务状态变化',
  position_expired: '位置过期',
  manual: '手动作废',
  dedup: '重复去重'
};

function PacketRow({ packet, now }: { packet: Packet; now: number }) {
  const store = useCommandStore();
  const status = STATUS_META[packet.status];
  const ttlLeft = packet.kind === 'position' && (packet.status === 'waiting' || packet.status === 'sending')
    ? Math.max(0, store.ledger.positionTtlMs - (now - packet.enqueuedAt))
    : null;

  return (
    <tr>
      <td style={{ padding: '6px 8px' }}>
        <Group gap={6} wrap="nowrap">
          <Badge size="xs" color={KIND_COLOR[packet.kind]} variant={packet.kind === 'rescue' ? 'filled' : 'light'}>{KIND_LABEL[packet.kind]}</Badge>
          <Text size="sm" fw={packet.kind === 'rescue' ? 600 : 400} span>{packet.title}</Text>
          {packet.kind === 'rescue' && packet.rescuePriority === 'urgent' && <Badge size="xs" color="orange">紧急</Badge>}
        </Group>
      </td>
      <td><Text size="xs" c="dimmed">#{packet.seq}{packet.attempts > 1 ? ` · 第${packet.attempts}次` : ''}</Text></td>
      <td>
        <Badge size="sm" color={status.color} variant={packet.status === 'void' ? 'outline' : 'light'}>
          {status.label}
        </Badge>
        {packet.status === 'void' && packet.voidReason && <Text size="xs" c="dimmed" span> · {VOID_REASON[packet.voidReason] ?? packet.voidReason}</Text>}
        {packet.status === 'waiting' && packet.lastError && <Text size="xs" c="red" span> · 待重试（{packet.lastError}）</Text>}
        {ttlLeft !== null && <Text size="xs" c={ttlLeft < 20_000 ? 'red' : 'dimmed'} span> · {Math.ceil(ttlLeft / 1000)}秒后过期作废</Text>}
      </td>
      <td align="right">
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {packet.status === 'sending' && <>
            <Button size="compact-xs" color="teal" onClick={() => store.deliverPacket(packet.id)}>送达</Button>
            <Button size="compact-xs" color="red" variant="light" onClick={() => store.failPacket(packet.id)}>模拟失败</Button>
          </>}
          {packet.status === 'delivered' && packet.kind === 'rescue' &&
            <Tooltip label="对端回执同样要占一个包位，容量满时先排队">
              <Button size="compact-xs" color="violet" variant="light" onClick={() => store.receiveReceipt(packet.missionId!)}>收到回执</Button>
            </Tooltip>}
          {(packet.status === 'waiting' || packet.status === 'sending') &&
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => store.discardPacket(packet.id)}>作废</Button>}
        </Group>
      </td>
    </tr>
  );
}

export function CommLedgerCard({ now }: { now: number }) {
  const ledger = useCommandStore((s) => s.ledger);
  const nextWindow = useCommandStore((s) => s.nextWindow);
  const used = useCommandStore((s) => usedSlots(s.ledger));
  const queue = waitingQueue(ledger);
  const inWindow = ledger.packets.filter((p) => p.status === 'sending' || p.status === 'delivered');
  const archived = ledger.packets.filter((p) => p.status === 'confirmed').slice(0, 6);
  const voided = ledger.packets.filter((p) => p.status === 'void').slice(0, 6);

  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={3}>低带宽发送账</Title>
          <Text size="sm" c="dimmed">搜救令、指令回执与例行位置共用通信窗口；容量满先排队，搜救令先于例行位置</Text>
        </div>
        <Button size="xs" variant="light" onClick={nextWindow}>开启下一窗口（重试未送达）</Button>
      </Group>

      <Stack gap={4} mt="md">
        <Group justify="space-between">
          <Text size="sm" fw={600}>通信窗口包位</Text>
          <Text size="sm" c={used >= ledger.capacity ? 'red' : 'dimmed'}>{used} / {ledger.capacity} 占用{used >= ledger.capacity ? ' · 已满，新包排队' : ''}</Text>
        </Group>
        <Progress value={(used / ledger.capacity) * 100} color={used >= ledger.capacity ? 'red' : 'cyan'} size="lg" radius="sm" aria-label="窗口占用率" />
        <Text size="xs" c="dimmed">当前第 {ledger.window} 号窗口 · 位置包有效期 {Math.round(ledger.positionTtlMs / 1000)} 秒，过期作废并释放包位</Text>
      </Stack>

      <Table mt="sm" horizontalSpacing={0} verticalSpacing={2} withRowBorders={false}>
        <thead>
          <tr><th style={{ fontSize: 12 }} align="left">窗口内（发送中/待回执）</th><th style={{ fontSize: 12 }}></th><th style={{ fontSize: 12 }} align="left">状态</th><th></th></tr>
        </thead>
        <tbody>
          {inWindow.length === 0 && <tr><td colSpan={4}><Text size="xs" c="dimmed" py={4}>窗口空闲，等待队列补位</Text></td></tr>}
          {inWindow.map((p) => <PacketRow key={p.id} packet={p} now={now} />)}
        </tbody>
      </Table>

      <Table mt="xs" horizontalSpacing={0} verticalSpacing={2} withRowBorders={false}>
        <thead>
          <tr><th style={{ fontSize: 12 }} align="left">待发队列（搜救令优先，同级先到先得）</th><th style={{ fontSize: 12 }}></th><th style={{ fontSize: 12 }} align="left">状态</th><th></th></tr>
        </thead>
        <tbody>
          {queue.length === 0 && <tr><td colSpan={4}><Text size="xs" c="dimmed" py={4}>队列为空</Text></td></tr>}
          {queue.map((p) => <PacketRow key={p.id} packet={p} now={now} />)}
        </tbody>
      </Table>

      {(archived.length > 0 || voided.length > 0) && (
        <Group mt="sm" gap="xl" align="flex-start">
          <div style={{ flex: 1 }}>
            <Text size="xs" fw={700} c="dimmed">送达留档（不占包位）</Text>
            {archived.length === 0
              ? <Text size="xs" c="dimmed">暂无</Text>
              : archived.map((p) => <Text key={p.id} size="xs">{KIND_LABEL[p.kind]}·{p.title} <span className="text-dim">已确认，不占包位</span></Text>)}
          </div>
          <div style={{ flex: 1 }}>
            <Text size="xs" fw={700} c="dimmed">作废记录</Text>
            {voided.length === 0
              ? <Text size="xs" c="dimmed">暂无</Text>
              : voided.map((p) => <Text key={p.id} size="xs" c="dimmed">{KIND_LABEL[p.kind]}·{p.title}（{p.voidReason ? VOID_REASON[p.voidReason] : ''}，已释放包位）</Text>)}
          </div>
        </Group>
      )}
    </Card>
  );
}
