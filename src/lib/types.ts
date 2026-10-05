export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  coverage: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  lastSeen: string;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  updatedAt: string;
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}

// 通信窗口 · 发送账
export type PacketKind = 'position' | 'command' | 'receipt';
export type PacketStatus = 'queued' | 'inflight' | 'delivered' | 'voided' | 'expired';
export type PacketPriority = 'urgent' | 'normal' | 'routine';

export interface SendPacket {
  id: string;
  kind: PacketKind;
  priority: PacketPriority;
  status: PacketStatus;
  dedupeKey: string;
  title: string;
  assetId?: string;
  missionId?: string;
  enqueuedAt: string;
  sentAt?: string;
  deliveredAt?: string;
  attempts: number;
  lastError?: string;
  expiresAt?: string;
  receiptOf?: string;
}
