// 发送账纯逻辑引擎：不依赖 React / Zustand，状态不可变地传入传出，便于验证全部规则
import type {
  LedgerState,
  Packet,
  PacketKind,
  RescuePriority,
  SubmitResult,
  VoidReason
} from './types';

export const WINDOW_CAPACITY = 5;
export const POSITION_TTL_MS = 2 * 60_000;

let uidCounter = 0;
export function uid(prefix = 'pkt'): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

export function createLedger(now: number = Date.now()): LedgerState {
  return {
    capacity: WINDOW_CAPACITY,
    positionTtlMs: POSITION_TTL_MS,
    nextSeq: 1,
    window: 1,
    packets: [],
    events: [{ id: uid('evt'), time: now, message: '低带宽发送账建立，通信窗口容量 5 个包位' }]
  };
}

/** 占用窗口的包：已排进窗口、发送中或已送达待回执（confirmed / void 均不占包位） */
export function isOccupying(p: Packet): boolean {
  return p.status === 'sending' || p.status === 'delivered';
}

/** 活跃（未留档、未作废）的包：waiting 也算活跃，仍受去重约束 */
function isActive(p: Packet): boolean {
  return p.status === 'waiting' || p.status === 'sending' || p.status === 'delivered';
}

export function usedSlots(state: LedgerState): number {
  return state.packets.filter(isOccupying).length;
}

export function freeSlots(state: LedgerState): number {
  return state.capacity - usedSlots(state);
}

export function waitingQueue(state: LedgerState): Packet[] {
  return state.packets
    .filter((p) => p.status === 'waiting')
    .sort(queueOrder);
}

/** 队列优先级：搜救令先于例行位置；同级先提交先排（seq 小者优先） */
function queueOrder(a: Packet, b: Packet): number {
  if (a.kind !== b.kind) return a.kind === 'rescue' ? -1 : 1;
  return a.seq - b.seq;
}

type LedgerEventLike = { id: string; time: number; message: string };

function log(state: LedgerState, now: number, message: string): LedgerEventLike {
  return { id: uid('evt'), time: now, message };
}

/**
 * 提交一个包。
 * - 同一指令（missionId 相同的搜救令）只要还活跃（排队/发送中/待回执），只入队一次
 * - 已确认的指令不会重复占包位：confirmed 后再提交视为重复（指令已留档，无需重发）
 * - 容量满先排队；队列内搜救令先于位置
 * 返回新状态与提交结果。两名值班员同时抢最后一个包位时，调用顺序（seq）裁决：先提交者生效。
 */
export function submitPacket(
  state: LedgerState,
  input: {
    kind: PacketKind;
    title: string;
    missionId?: string;
    assetId?: string;
    rescuePriority?: RescuePriority;
  },
  now: number = Date.now()
): { state: LedgerState; result: SubmitResult } {
  // 同一搜救指令去重：活跃包或已确认留档的包存在时，拒绝重复入队
  if (input.kind === 'rescue' && input.missionId) {
    const existing = state.packets.find(
      (p) => p.kind === 'rescue' && p.missionId === input.missionId && (isActive(p) || p.status === 'confirmed')
    );
    if (existing) {
      const message = `搜救令“${input.title}”重复提交，${existing.status === 'confirmed' ? '指令已确认留档，不再占包位' : '已在队列中，只保留一份'}`;
      return {
        state: { ...state, events: [log(state, now, message), ...state.events].slice(0, 200) },
        result: { result: 'duplicate', existingId: existing.id, message }
      };
    }
  }

  const seq = state.nextSeq;
  const packet: Packet = {
    id: uid(),
    seq,
    kind: input.kind,
    missionId: input.missionId,
    assetId: input.assetId,
    title: input.title,
    rescuePriority: input.rescuePriority,
    status: 'waiting',
    enqueuedAt: now,
    attempts: 0
  };

  const withPacket: LedgerState = {
    ...state,
    nextSeq: seq + 1,
    packets: [...state.packets, packet]
  };

  // 立即尝试入窗（若有空包位）
  const filled = fillWindow(withPacket, now);
  const finalPacket = filled.state.packets.find((p) => p.id === packet.id)!;
  const entered = finalPacket.status === 'sending';
  const message = entered
    ? `已占通信窗口包位：${labelOf(packet)}（提交序号 #${seq}）`
    : `窗口容量已满，${labelOf(packet)} 进入待发队列（提交序号 #${seq}）`;

  return {
    state: { ...filled.state, events: [log(state, now, message), ...filled.state.events].slice(0, 200) },
    result: { result: entered ? 'active' : 'queued', packetId: packet.id, message }
  };
}

export function labelOf(p: Packet): string {
  if (p.kind === 'rescue') return `搜救令·${p.title}`;
  if (p.kind === 'receipt') return `指令回执·${p.title}`;
  return `单位位置·${p.title}`;
}

/** 某等待包当前窗口是否可补位：本窗口发送失败的包只在下一窗口重试 */
function canPromote(p: Packet, window: number): boolean {
  return p.status === 'waiting' && p.failedInWindow !== window;
}

/**
 * 窗口补位：按队列优先级（搜救令先于例行位置，同级 seq 先者优先）从待发队列填入空包位。
 * 本窗口发送失败回到队列的包不参与本轮补位，要等下一窗口（retryUnsent）才重发。
 * 释放包位、重试后都应调用。
 */
export function fillWindow(state: LedgerState, now: number = Date.now()): { state: LedgerState; promoted: Packet[] } {
  let packets = state.packets;
  const promoted: Packet[] = [];
  const events: LedgerEventLike[] = [];

  for (;;) {
    const occupying = packets.filter(isOccupying).length;
    if (occupying >= state.capacity) break;
    const next = packets
      .filter((p) => canPromote(p, state.window))
      .sort(queueOrder)[0];
    if (!next) break;
    packets = packets.map((p) =>
      p.id === next.id ? { ...p, status: 'sending' as const, sentAt: now, attempts: p.attempts + 1, failedInWindow: undefined } : p
    );
    promoted.push(packets.find((p) => p.id === next.id)!);
    events.push(log(state, now, `包位空出，${labelOf(next)} 由队列进入窗口发送`));
  }

  return { state: { ...state, packets, events: [...events, ...state.events].slice(0, 200) }, promoted };
}

/** 发送失败：只把没送到的（sending）标记失败并退出窗口，随后按队列优先级补位；下个窗口原位/队首选重试 */
export function markSendFailed(
  state: LedgerState,
  packetId: string,
  error: string,
  now: number = Date.now()
): LedgerState {
  const target = state.packets.find((p) => p.id === packetId);
  if (!target || target.status !== 'sending') return state;

  const released: LedgerState = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === packetId
        ? { ...p, status: 'waiting' as const, failedInWindow: state.window, lastError: error, sentAt: undefined }
        : p
    ),
    events: [
      log(state, now, `${labelOf(target)}发送失败（${error}），释放包位退回待发队列；本窗口不再重发，下一窗口仅重试未送达的包`),
      ...state.events
    ].slice(0, 200)
  };
  return fillWindow(released, now).state;
}

/**
 * 送达：搜救令送达后等待回执；回执包送达即留档（confirmed），并确认同 missionId 的搜救令。
 * 送达后触发窗口补位（搜救令待回执期间仍占包位，回执送达后才释放）。
 */
export function markDelivered(state: LedgerState, packetId: string, now: number = Date.now()): LedgerState {
  const target = state.packets.find((p) => p.id === packetId);
  if (!target || target.status !== 'sending') return state;

  let packets = state.packets.map((p) =>
    p.id === packetId ? { ...p, status: 'delivered' as const, deliveredAt: now, lastError: undefined } : p
  );
  const events: LedgerEventLike[] = [];

  if (target.kind === 'position') {
    // 例行位置没有回执环节：送达即留档并释放包位
    packets = packets.map((p) =>
      p.id === packetId ? { ...p, status: 'confirmed' as const, confirmedAt: now } : p
    );
    events.push(log(state, now, `${labelOf(target)}已送达留档，包位释放`));
  } else {
    events.push(log(state, now, `${labelOf(target)}已送达${target.kind === 'rescue' ? '，等待对端指令回执' : ''}`));
  }

  if (target.kind === 'receipt' && target.missionId) {
    // 回执送达即留档，并确认对应搜救令：两者均不占包位
    packets = packets.map((p) => {
      if (p.id === packetId) return { ...p, status: 'confirmed' as const, confirmedAt: now };
      if (p.kind === 'rescue' && p.missionId === target.missionId && isActive(p)) {
        return { ...p, status: 'confirmed' as const, confirmedAt: now };
      }
      return p;
    });
    events.unshift(log(state, now, `回执已送达留档，搜救令“${target.title}”确认完成，相关包位全部释放`));
  }

  const filled = fillWindow({ ...state, packets, events: [...events, ...state.events].slice(0, 200) }, now);
  return filled.state;
}

/** 对端回执生成：为已送达待回执的搜救令提交一个回执包（回执同样占通信窗口，满则排队） */
export function submitReceipt(state: LedgerState, missionId: string, now: number = Date.now()): { state: LedgerState; result: SubmitResult } {
  const rescue = state.packets.find((p) => p.kind === 'rescue' && p.missionId === missionId);
  if (!rescue) {
    return { state, result: { result: 'duplicate', message: '没有对应的搜救令，无法生成回执' } };
  }
  return submitPacket(state, { kind: 'receipt', title: rescue.title, missionId }, now);
}

/**
 * 任务状态变化：该任务所有未完成的待发指令（排队/发送中/已送达未回执）立即作废并释放包位，
 * 已送达回执的（confirmed）留档不动。作废后窗口按队列优先级补位。
 */
export function voidMissionPackets(
  state: LedgerState,
  missionId: string,
  reasonText: string,
  now: number = Date.now()
): LedgerState {
  const targets = state.packets.filter(
    (p) => p.missionId === missionId && (p.status === 'waiting' || p.status === 'sending' || p.status === 'delivered')
  );
  if (targets.length === 0) return state;

  const ids = new Set(targets.map((t) => t.id));
  const packets = state.packets.map((p) =>
    ids.has(p.id)
      ? { ...p, status: 'void' as const, voidReason: 'mission_changed' as VoidReason, voidedAt: now, sentAt: undefined }
      : p
  );
  const events = [
    log(state, now, `任务${reasonText}：${targets.map(labelOf).join('、')}立即作废并释放包位；已送回执的留档保留`),
    ...state.events
  ];
  return fillWindow({ ...state, packets, events: events.slice(0, 200) }, now).state;
}

/** 过期位置作废：超过 TTL 仍在排队或发送中的位置包作废并释放包位，已送达的位置包直接归档不占包位 */
export function expirePositions(state: LedgerState, now: number = Date.now()): LedgerState {
  const stale = state.packets.filter(
    (p) =>
      p.kind === 'position' &&
      (p.status === 'waiting' || p.status === 'sending') &&
      now - p.enqueuedAt > state.positionTtlMs
  );
  if (stale.length === 0) return state;
  const ids = new Set(stale.map((t) => t.id));
  const packets = state.packets.map((p) =>
    ids.has(p.id)
      ? { ...p, status: 'void' as const, voidReason: 'position_expired' as VoidReason, voidedAt: now, sentAt: undefined }
      : p
  );
  const events = [
    log(state, now, `${stale.map(labelOf).join('、')}超过 ${Math.round(state.positionTtlMs / 1000)} 秒有效期，作废并释放包位`),
    ...state.events
  ];
  return fillWindow({ ...state, packets, events: events.slice(0, 200) }, now).state;
}

/** 手动作废任意未完成包（用于演练/干预） */
export function voidPacket(state: LedgerState, packetId: string, now: number = Date.now()): LedgerState {
  const target = state.packets.find((p) => p.id === packetId);
  if (!target || !isActive(target)) return state;
  const packets = state.packets.map((p) =>
    p.id === packetId ? { ...p, status: 'void' as const, voidReason: 'manual' as VoidReason, voidedAt: now, sentAt: undefined } : p
  );
  const events = [log(state, now, `${labelOf(target)}被手动作废，包位释放`), ...state.events].slice(0, 200);
  return fillWindow({ ...state, packets, events }, now).state;
}

/** 新窗口开启：窗口代数 +1，仅尚未送达（waiting）的包可重发；已送达/已确认的不重发 */
export function retryUnsent(state: LedgerState, now: number = Date.now()): LedgerState {
  const advanced: LedgerState = {
    ...state,
    window: state.window + 1,
    events: [log(state, now, `第 ${state.window + 1} 号通信窗口开启：仅重试尚未送达的包，已送达/已确认的不重发`), ...state.events].slice(0, 200)
  };
  return fillWindow(advanced, now).state;
}
