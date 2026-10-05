import type { Mission, RescueAsset, SendPacket } from './types';

// 单位位置有效期：超过此时长的位置作废，不进通信窗口
export const POSITION_TTL_MS = 5 * 60_000;
// 通信窗口容量（同时在途、占用包位的包数）
export const WINDOW_CAPACITY_LOW = 3;
export const WINDOW_CAPACITY_NORMAL = 12;

export function windowCapacity(lowBandwidth: boolean): number {
  return lowBandwidth ? WINDOW_CAPACITY_LOW : WINDOW_CAPACITY_NORMAL;
}

const PRIORITY_RANK: Record<SendPacket['priority'], number> = { urgent: 0, normal: 1, routine: 2 };

export function isPositionExpired(lastSeen: string, now: number, ttl: number = POSITION_TTL_MS): boolean {
  return now - new Date(lastSeen).getTime() > ttl;
}

/** 生成位置报告包；位置已过期则返回 null（作废，不占包位）。 */
export function buildPositionPacket(asset: RescueAsset, now: number): SendPacket | null {
  if (isPositionExpired(asset.lastSeen, now)) return null;
  const lastSeenMs = new Date(asset.lastSeen).getTime();
  return {
    id: crypto.randomUUID(),
    kind: 'position',
    priority: 'routine',
    status: 'queued',
    dedupeKey: `position:${asset.id}:${asset.lastSeen}`,
    title: `${asset.name} 位置报告`,
    assetId: asset.id,
    enqueuedAt: new Date(now).toISOString(),
    attempts: 0,
    expiresAt: new Date(lastSeenMs + POSITION_TTL_MS).toISOString()
  };
}

export function buildCommandPacket(mission: Mission, now: number): SendPacket {
  return {
    id: crypto.randomUUID(),
    kind: 'command',
    priority: mission.priority === 'urgent' ? 'urgent' : 'normal',
    status: 'queued',
    dedupeKey: `command:${mission.id}`,
    title: `搜救令：${mission.title}`,
    missionId: mission.id,
    enqueuedAt: new Date(now).toISOString(),
    attempts: 0
  };
}

export function buildReceiptPacket(command: SendPacket, now: number): SendPacket {
  return {
    id: crypto.randomUUID(),
    kind: 'receipt',
    priority: 'routine',
    status: 'queued',
    dedupeKey: `receipt:${command.id}`,
    title: `回执：${command.title}`,
    missionId: command.missionId,
    enqueuedAt: new Date(now).toISOString(),
    attempts: 0,
    receiptOf: command.id
  };
}

/** 同一去重键只入队一次：待发、在途、已送达都不再重复入队。 */
export function isDuplicate(packets: SendPacket[], dedupeKey: string): boolean {
  return packets.some((p) => p.dedupeKey === dedupeKey && p.status !== 'voided' && p.status !== 'expired');
}

/** 排序：紧急 > 常规 > 例行（搜救令先于位置），同级按入队时间 FIFO。 */
export function comparePriority(a: SendPacket, b: SendPacket): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
}

/**
 * 通信窗口调度：先作废过期位置，再按优先级把待发包放入窗口。
 * 整个调用在一次同步 set 内完成，包位占用是原子的——
 * 两名值班员同时抢最后一个包位时，先进入 set 的一方生效。
 */
export function pumpWindow(packets: SendPacket[], capacity: number, now: number): SendPacket[] {
  let next = packets.map((p) => {
    if (p.status === 'queued' && p.kind === 'position' && p.expiresAt && new Date(p.expiresAt).getTime() <= now) {
      return { ...p, status: 'expired' as const };
    }
    return p;
  });
  const inflight = next.filter((p) => p.status === 'inflight').length;
  const free = Math.max(0, capacity - inflight);
  if (free > 0) {
    const queued = next.filter((p) => p.status === 'queued').sort(comparePriority);
    const admit = new Set(queued.slice(0, free).map((p) => p.id));
    next = next.map((p) => (admit.has(p.id) ? { ...p, status: 'inflight' as const, sentAt: new Date(now).toISOString() } : p));
  }
  return next;
}

export interface DeliveryResult {
  packets: SendPacket[];
  delivered: SendPacket[];
  failed: SendPacket[];
}

/** 尝试送达窗口内的包：失败的退回待发队列（仅重试未送到的），成功的留档。 */
export function attemptDelivery(packets: SendPacket[], now: number, rng: () => number = Math.random): DeliveryResult {
  const delivered: SendPacket[] = [];
  const failed: SendPacket[] = [];
  const next = packets.map((p) => {
    if (p.status !== 'inflight') return p;
    if (rng() < 0.25) {
      const retry = { ...p, status: 'queued' as const, attempts: p.attempts + 1, lastError: '链路拥塞，未送达' };
      failed.push(retry);
      return retry;
    }
    const done = { ...p, status: 'delivered' as const, deliveredAt: new Date(now).toISOString(), attempts: p.attempts + 1 };
    delivered.push(done);
    return done;
  });
  return { packets: next, delivered, failed };
}

/** 已送达的指令生成回执（回执同样占通信窗口），去重后入队。 */
export function enqueueReceipts(packets: SendPacket[], delivered: SendPacket[], now: number): SendPacket[] {
  let next = packets;
  for (const cmd of delivered) {
    if (cmd.kind !== 'command') continue;
    const receipt = buildReceiptPacket(cmd, now);
    if (isDuplicate(next, receipt.dedupeKey)) continue;
    next = [...next, receipt];
  }
  return next;
}

/** 任务状态变化：该任务所有待发/在途指令立即作废并释放包位，已送达的留档。 */
export function voidCommandsForMission(packets: SendPacket[], missionId: string): SendPacket[] {
  return packets.map((p) => {
    if (p.missionId === missionId && (p.status === 'queued' || p.status === 'inflight')) {
      return { ...p, status: 'voided' as const };
    }
    return p;
  });
}

export interface EnqueuePositionsResult {
  packets: SendPacket[];
  added: SendPacket[];
  expired: number;
}

/** 批量上报单位位置：过期位置作废，未过期的去重后入队。 */
export function enqueuePositions(packets: SendPacket[], assets: RescueAsset[], now: number): EnqueuePositionsResult {
  let next = packets;
  const added: SendPacket[] = [];
  let expired = 0;
  for (const asset of assets) {
    const pkt = buildPositionPacket(asset, now);
    if (!pkt) { expired += 1; continue; }
    if (isDuplicate(next, pkt.dedupeKey)) continue;
    next = [...next, pkt];
    added.push(pkt);
  }
  return { packets: next, added, expired };
}

export interface EnqueueCommandResult {
  packets: SendPacket[];
  packet: SendPacket | null;
  duplicate: boolean;
}

/** 指令入队：同一指令重复提交只入队一次，已确认的不重复占包位。 */
export function enqueueCommand(packets: SendPacket[], mission: Mission, now: number): EnqueueCommandResult {
  const pkt = buildCommandPacket(mission, now);
  if (isDuplicate(packets, pkt.dedupeKey)) return { packets, packet: null, duplicate: true };
  return { packets: [...packets, pkt], packet: pkt, duplicate: false };
}
