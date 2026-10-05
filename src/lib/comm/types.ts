// 低带宽模式下的发送账：通信窗口、待发队列、包位账本与指令留档

/** 包类型：搜救令 / 指令回执 / 单位位置（例行位置） */
export type PacketKind = 'rescue' | 'receipt' | 'position';

/** 任务优先级 */
export type RescuePriority = 'urgent' | 'normal';

/**
 * 包状态
 * - waiting   待发队列中，尚未占用包位
 * - sending   已排进通信窗口，占用一个包位（发送中/失败后原位重试）
 * - delivered 已送达。搜救令此时只是送达，等待对端回执确认
 * - confirmed 搜救令对应的回执已送达，指令留档；回执包本身送达即留档
 * - void      作废（任务状态变化 / 过期位置 / 手动作废），不占包位
 */
export type PacketStatus = 'waiting' | 'sending' | 'delivered' | 'confirmed' | 'void';

export type VoidReason = 'mission_changed' | 'position_expired' | 'manual' | 'dedup';

export interface Packet {
  id: string;
  /** 全局提交序号，单调递增，用于同优先级先到先得（含两人抢最后包位的裁决） */
  seq: number;
  kind: PacketKind;
  /** 关联任务：搜救令与其回执共用 missionId，也是去重键 */
  missionId?: string;
  /** 关联单位（位置包） */
  assetId?: string;
  title: string;
  rescuePriority?: RescuePriority;
  status: PacketStatus;
  /** 进入待发队列的时间 */
  enqueuedAt: number;
  /** 最近一次进入窗口的时间 */
  sentAt?: number;
  /** 送达时间 */
  deliveredAt?: number;
  /** 确认（回执归档）时间 */
  confirmedAt?: number;
  attempts: number;
  /** 发送失败时所在的窗口代数：本窗口内不再参与补位，下一窗口才可重试 */
  failedInWindow?: number;
  /** 最后一次失败原因 */
  lastError?: string;
  voidReason?: VoidReason;
  voidedAt?: number;
}

export interface LedgerEvent {
  id: string;
  time: number;
  message: string;
}

export interface LedgerState {
  /** 通信窗口容量（包位数） */
  capacity: number;
  /** 位置包有效期（毫秒），过期作废 */
  positionTtlMs: number;
  /** 下一个包的提交序号 */
  nextSeq: number;
  /** 当前通信窗口代数：每开启一个新发送窗口 +1，发送失败的包本窗口内不参与补位，下窗口才重试 */
  window: number;
  /** 全部包：waiting / sending / delivered 活跃项 + confirmed / void 留档项 */
  packets: Packet[];
  /** 发送账事件流水 */
  events: LedgerEvent[];
}

/** 提交结果：active=已占包位（在窗口中发送），queued=容量已满先排队，duplicate=重复指令被拒 */
export type SubmitResultType = 'active' | 'queued' | 'duplicate';

export interface SubmitResult {
  result: SubmitResultType;
  packetId?: string;
  /** duplicate 时给出已存在的包，便于界面提示 */
  existingId?: string;
  message: string;
}
