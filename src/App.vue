<template>
  <div class="layout">
    <CommandHeader />
    <div class="body">
      <aside class="left">
        <div class="aside-title">📋 灾情事件</div>
        <EventList />
      </aside>

      <main class="center">
        <MapBoard />
      </main>

      <aside class="right">
        <div class="split-top">
          <div class="aside-title">🛠️ 资源调度</div>
          <DispatchPanel />
        </div>
        <div class="split-bottom">
          <EventDetail />
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { onMounted, watch } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import CommandHeader from '@/components/CommandHeader.vue'
import EventList from '@/components/EventList.vue'
import MapBoard from '@/components/MapBoard.vue'
import DispatchPanel from '@/components/DispatchPanel.vue'
import EventDetail from '@/components/EventDetail.vue'

const store = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
onMounted(() => {
  store.loadScenario(store.scenarioId)
  transfer.load()
})
// 切换灾情场景时重置转移安置与道路阻断数据
watch(() => store.scenarioId, () => { transfer.load(); roadblock.load() })
</script>

<style scoped>
.layout {
  display: flex; flex-direction: column;
  width: 100vw; height: 100vh;
  background: #0a1224;
  overflow: hidden;
}
.body {
  flex: 1; display: flex;
  min-height: 0;
  gap: 10px; padding: 10px;
}
.aside-title {
  font-size: 12px; color: #6f8cb8; font-weight: 700;
  margin-bottom: 6px; padding: 0 2px;
  letter-spacing: 1px;
}
.left {
  width: 300px; flex-shrink: 0;
  display: flex; flex-direction: column;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; padding: 10px;
  min-height: 0;
}
.center { flex: 1; border-radius: 12px; overflow: hidden; min-width: 0; min-height: 0; position: relative; }
.right {
  width: 360px; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 10px;
  min-height: 0;
}
.split-top {
  flex: 5; display: flex; flex-direction: column;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; padding: 10px; min-height: 0;
}
.split-bottom {
  flex: 6;
  background: #0d1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 12px; min-height: 0;
}

@media (max-width: 1280px) {
  .left { width: 260px; }
  .right { width: 320px; }
}
@media (max-width: 1000px) {
  .body { flex-direction: column; overflow-y: auto; }
  .left, .right, .center { width: 100%; }
  .center { height: 60vh; }
}
</style>