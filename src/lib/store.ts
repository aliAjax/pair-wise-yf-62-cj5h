'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AreaStatus, AssetStatus, EventLog, Mission, MissionStatus, RescueAsset, SearchArea } from './types';
import type { LedgerState, SubmitResult } from './comm/types';
import {
  createLedger,
  expirePositions,
  fillWindow,
  markDelivered,
  markSendFailed,
  retryUnsent,
  submitPacket,
  submitReceipt,
  voidMissionPackets,
  voidPacket,
  freeSlots,
  usedSlots,
  waitingQueue
} from './comm/ledger';

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

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  offline: boolean;
  lowBandwidth: boolean;
  /** 低带宽发送账：通信窗口、待发队列、包位与留档 */
  ledger: LedgerState;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: { title: string; areaId: string; assetIds: string[]; priority: 'normal' | 'urgent'; note: string }) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  // —— 发送账动作（低带宽下生效）——
  /** 例行位置上报：占不到包位就排队，位置包超时自动作废 */
  reportPosition: (assetId: string) => SubmitResult;
  /** 手动提交已有任务的搜救令（两名值班员可同时提交，先提交者得最后包位；重复指令只入队一次） */
  submitRescue: (missionId: string) => SubmitResult;
  /** 模拟送达：发送中的包送达；搜救令进入待回执，回执送达则留档 */
  deliverPacket: (packetId: string) => void;
  /** 模拟发送失败：释放包位，只在下一窗口重试未送达的包 */
  failPacket: (packetId: string, error?: string) => void;
  /** 模拟对端回执到达：回执包本身同样要占窗口 */
  receiveReceipt: (missionId: string) => SubmitResult;
  /** 开启下一个通信窗口：仅重试没送到的包 */
  nextWindow: () => void;
  /** 手动作废待发包 */
  discardPacket: (packetId: string) => void;
  /** 定时巡检：作废过期位置包（只在实际发生变化时写状态） */
  tickExpiry: () => void;
}

/** 把发送账新产生的流水镜像到联合事件时间线（按 ledgerEventId 去重） */
function mirrorLedgerEvents(events: EventLog[], ledger: LedgerState): EventLog[] {
  const known = new Set(events.map((e) => e.ledgerEventId).filter(Boolean));
  const fresh = ledger.events
    .filter((e) => !known.has(e.id))
    .map((e) => ({ id: crypto.randomUUID(), ledgerEventId: e.id, time: new Date(e.time).toISOString(), actor: '发送账', message: e.message }));
  return [...fresh, ...events].slice(0, 100);
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => ({
      areas: initialAreas,
      assets: initialAssets,
      missions: initialMissions,
      events: initialEvents,
      offline: false,
      lowBandwidth: false,
      ledger: createLedger(now),

      setAreaStatus: (id, status) => set((state) => ({
        areas: state.areas.map((area) => area.id === id ? { ...area, status } : area),
        events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `搜索区 ${id} 状态改为 ${status}` }, ...state.events]
      })),

      setAssetStatus: (id, status) => set((state) => ({
        assets: state.assets.map((asset) => asset.id === id ? { ...asset, status, lastSeen: new Date().toISOString() } : asset),
        events: [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '值班员', message: `${id} 状态改为 ${status}，已生成恢复记录` }, ...state.events]
      })),

      // 任务状态变化：低带宽下该任务所有未完成待发指令立即作废、释放包位；已送回执的留档不动
      setMissionStatus: (id, status) => set((state) => {
        const mission = state.missions.find((m) => m.id === id);
        let ledger = state.ledger;
        if (state.lowBandwidth && mission) {
          ledger = voidMissionPackets(state.ledger, id, `状态改为 ${status}`, Date.now());
        }
        return {
          missions: state.missions.map((m) => m.id === id ? { ...m, status, updatedAt: new Date().toISOString() } : m),
          ledger,
          events: mirrorLedgerEvents(
            [{ id: crypto.randomUUID(), time: new Date().toISOString(), actor: '指挥员', message: `任务“${mission?.title ?? id}”状态改为 ${status}` }, ...state.events],
            ledger
          )
        };
      }),

      // 派发任务：低带宽下搜救令作为一个包进发送账，占不到包位就排队，搜救令先于例行位置
      dispatchMission: (input) => {
        const mission: Mission = { id: crypto.randomUUID(), ...input, status: 'dispatched', updatedAt: new Date().toISOString() };
        set((state) => {
          let ledger = state.ledger;
          let submit: SubmitResult | undefined;
          if (state.lowBandwidth) {
            const r = submitPacket(state.ledger, {
              kind: 'rescue',
              title: input.title,
              missionId: mission.id,
              rescuePriority: input.priority
            });
            ledger = r.state;
            submit = r.result;
          }
          const baseEvents: EventLog[] = [
            {
              id: crypto.randomUUID(),
              time: new Date().toISOString(),
              actor: '指挥员',
              message: state.lowBandwidth && submit
                ? `任务“${input.title}”已生成，搜救令${submit.result === 'queued' ? '容量已满进入待发队列' : '已进入通信窗口'}`
                : `任务“${input.title}”已派发`
            },
            ...state.events
          ];
          return {
            missions: [mission, ...state.missions],
            assets: state.assets.map((asset) => input.assetIds.includes(asset.id) ? { ...asset, status: 'assigned' } : asset),
            ledger,
            events: mirrorLedgerEvents(baseEvents, ledger)
          };
        });
      },

      toggleOffline: () => set((state) => ({ offline: !state.offline })),

      toggleBandwidth: () => set((state) => ({
        lowBandwidth: !state.lowBandwidth,
        events: [{
          id: crypto.randomUUID(),
          time: new Date().toISOString(),
          actor: '值班员',
          message: state.lowBandwidth ? '低带宽模式关闭，通信窗口账暂停记账' : '低带宽模式开启：位置、回执与搜救令共用通信窗口，统一记入发送账'
        }, ...state.events]
      })),

      reportPosition: (assetId) => {
        const state = get();
        const asset = state.assets.find((a) => a.id === assetId);
        const r = submitPacket(state.ledger, {
          kind: 'position',
          title: asset?.name ?? assetId,
          assetId
        });
        set({ ledger: r.state, events: mirrorLedgerEvents(state.events, r.state) });
        return r.result;
      },

      submitRescue: (missionId) => {
        const state = get();
        const mission = state.missions.find((m) => m.id === missionId);
        const r = submitPacket(state.ledger, {
          kind: 'rescue',
          title: mission?.title ?? missionId,
          missionId,
          rescuePriority: mission?.priority
        });
        set({ ledger: r.state, events: mirrorLedgerEvents(state.events, r.state) });
        return r.result;
      },

      deliverPacket: (packetId) => set((state) => {
        let ledger = markDelivered(state.ledger, packetId);
        const packet = state.ledger.packets.find((p) => p.id === packetId);
        // 位置包送达后刷新单位位置时间
        let assets = state.assets;
        if (packet?.kind === 'position' && packet.assetId) {
          const ts = new Date().toISOString();
          assets = state.assets.map((a) => a.id === packet.assetId ? { ...a, lastSeen: ts } : a);
        }
        return { ledger, assets, events: mirrorLedgerEvents(state.events, ledger) };
      }),

      failPacket: (packetId, error = '链路超时') => set((state) => {
        const ledger = markSendFailed(state.ledger, packetId, error);
        return { ledger, events: mirrorLedgerEvents(state.events, ledger) };
      }),

      receiveReceipt: (missionId) => {
        const state = get();
        const r = submitReceipt(state.ledger, missionId);
        set({ ledger: r.state, events: mirrorLedgerEvents(state.events, r.state) });
        return r.result;
      },

      nextWindow: () => set((state) => {
        // 先清理过期位置，再开新窗口：过期位置作废让出的包位优先补搜救令
        const cleaned = expirePositions(state.ledger, Date.now());
        const ledger = retryUnsent(cleaned, Date.now());
        return { ledger, events: mirrorLedgerEvents(state.events, ledger) };
      }),

      discardPacket: (packetId) => set((state) => {
        const ledger = voidPacket(state.ledger, packetId);
        return { ledger, events: mirrorLedgerEvents(state.events, ledger) };
      }),

      tickExpiry: () => {
        const state = get();
        if (!state.lowBandwidth) return;
        const ledger = expirePositions(state.ledger, Date.now());
        if (ledger !== state.ledger) {
          set({ ledger, events: mirrorLedgerEvents(state.events, ledger) });
        }
      }
    }),
    {
      name: 'maritime-command-v2',
      version: 2,
      partialize: (state) => ({
        areas: state.areas,
        assets: state.assets,
        missions: state.missions,
        events: state.events,
        offline: state.offline,
        lowBandwidth: state.lowBandwidth,
        ledger: state.ledger
      })
    }
  )
);

// 供界面直接使用的选择器辅助
export { fillWindow, freeSlots, usedSlots, waitingQueue, expirePositions };
