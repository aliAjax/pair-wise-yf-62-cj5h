'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AreaStatus, AssetStatus, EventLog, Mission, MissionStatus, RescueAsset, SearchArea, SendPacket } from './types';
import {
  attemptDelivery,
  buildPositionPacket,
  enqueueCommand,
  enqueuePositions,
  enqueueReceipts,
  isDuplicate,
  pumpWindow,
  voidCommandsForMission,
  windowCapacity
} from './ledger';

const now = Date.now();
const initialAreas: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32 }
];
const initialAssets: RescueAsset[] = [
  { id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned', lat: 30.75, lng: 121.55, lastSeen: new Date(now - 35_000).toISOString() },
  { id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready', lat: 30.82, lng: 121.73, lastSeen: new Date(now - 7 * 60_000).toISOString() },
  { id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline', lat: 30.69, lng: 121.61, lastSeen: new Date(now - 18 * 60_000).toISOString() }
];
const initialMissions: Mission[] = [
  { id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'], status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: new Date(now - 6 * 60_000).toISOString() }
];
const initialEvents: EventLog[] = [
  { id: 'event-1', time: new Date(now - 15 * 60_000).toISOString(), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: new Date(now - 6 * 60_000).toISOString(), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' }
];

const newId = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  packets: SendPacket[];
  offline: boolean;
  lowBandwidth: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  enqueuePositionReports: () => void;
  tickWindow: () => void;
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set) => ({
      areas: initialAreas,
      assets: initialAssets,
      missions: initialMissions,
      events: initialEvents,
      packets: [],
      offline: false,
      lowBandwidth: false,
      setAreaStatus: (id, status) => set((state) => ({
        areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
        events: [{ id: newId(), time: nowIso(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
      })),
      setAssetStatus: (id, status) => set((state) => {
        const nowMs = Date.now();
        const asset = state.assets.find((a) => a.id === id);
        const lastSeen = new Date(nowMs).toISOString();
        const updated = state.assets.map((a) => (a.id === id ? { ...a, status, lastSeen } : a));
        let packets = state.packets;
        let posEvent: EventLog | null = null;
        if (asset) {
          const pkt = buildPositionPacket({ ...asset, status, lastSeen }, nowMs);
          if (!pkt) {
            posEvent = { id: newId(), time: nowIso(), actor: '通信员', message: `${asset.name} 位置已过期，作废处理，不占包位` };
          } else if (!isDuplicate(packets, pkt.dedupeKey)) {
            packets = [...packets, pkt];
            posEvent = { id: newId(), time: nowIso(), actor: '通信员', message: `${asset.name} 位置报告已入待发队列` };
          }
        }
        return {
          assets: updated,
          packets,
          events: [
            { id: newId(), time: nowIso(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` },
            ...(posEvent ? [posEvent] : []),
            ...state.events
          ]
        };
      }),
      setMissionStatus: (id, status) => set((state) => {
        const nowMs = Date.now();
        const pending = state.packets.filter((p) => p.missionId === id && (p.status === 'queued' || p.status === 'inflight'));
        const released = pending.filter((p) => p.status === 'inflight').length;
        const packets = pumpWindow(voidCommandsForMission(state.packets, id), windowCapacity(state.lowBandwidth), nowMs);
        return {
          missions: state.missions.map((mission) => (mission.id === id ? { ...mission, status, updatedAt: nowIso() } : mission)),
          packets,
          events: [
            { id: newId(), time: nowIso(), actor: '指挥员', message: `任务 ${id} 状态改为 ${status}` },
            ...(pending.length > 0 ? [{ id: newId(), time: nowIso(), actor: '通信员', message: `任务状态变化，${pending.length} 条待发指令立即作废，释放 ${released} 个包位` }] : []),
            ...state.events
          ]
        };
      }),
      dispatchMission: (input) => set((state) => {
        const nowMs = Date.now();
        const mission: Mission = { id: newId(), ...input, status: 'dispatched', updatedAt: nowIso() };
        const { packets, packet, duplicate } = enqueueCommand(state.packets, mission, nowMs);
        return {
          missions: [mission, ...state.missions],
          assets: state.assets.map((asset) => (input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset)),
          packets,
          events: [
            { id: newId(), time: nowIso(), actor: '指挥员', message: `任务“${input.title}”已派发` },
            ...(packet ? [{ id: newId(), time: nowIso(), actor: '通信员', message: `搜救令已入待发队列（${input.priority === 'urgent' ? '紧急' : '常规'}）` }] : []),
            ...(duplicate ? [{ id: newId(), time: nowIso(), actor: '通信员', message: '同一指令重复提交，仅入队一次，不重复占包位' }] : []),
            ...state.events
          ]
        };
      }),
      toggleOffline: () => set((state) => ({ offline: !state.offline })),
      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
      enqueuePositionReports: () => set((state) => {
        const nowMs = Date.now();
        const { packets, added, expired } = enqueuePositions(state.packets, state.assets, nowMs);
        const events: EventLog[] = [];
        if (expired > 0) events.push({ id: newId(), time: nowIso(), actor: '通信员', message: `${expired} 条过期位置已作废，不进通信窗口` });
        if (added.length > 0) events.push({ id: newId(), time: nowIso(), actor: '通信员', message: `${added.length} 条单位位置进入待发队列` });
        return { packets, events: [...events, ...state.events] };
      }),
      tickWindow: () => set((state) => {
        const nowMs = Date.now();
        const capacity = windowCapacity(state.lowBandwidth);
        let packets = pumpWindow(state.packets, capacity, nowMs);
        const attempt = attemptDelivery(packets, nowMs);
        packets = attempt.packets;
        packets = enqueueReceipts(packets, attempt.delivered, nowMs);
        packets = pumpWindow(packets, capacity, nowMs);
        const events: EventLog[] = [];
        if (attempt.delivered.length > 0) events.push({ id: newId(), time: nowIso(), actor: '通信员', message: `本帧送达 ${attempt.delivered.length} 条，指令回执已留档` });
        if (attempt.failed.length > 0) events.push({ id: newId(), time: nowIso(), actor: '通信员', message: `${attempt.failed.length} 条未送达，仅重试未送到的包` });
        return { packets, events: [...events, ...state.events] };
      })
    }),
    {
      name: 'maritime-command-v1',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // 重载后窗口内未送达的包退回待发，避免卡死包位
        state.packets = state.packets.map((p) => (p.status === 'inflight' ? { ...p, status: 'queued' as const, sentAt: undefined } : p));
      }
    }
  )
);
