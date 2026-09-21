<template>
  <header class="cmd-header">
    <div class="brand">
      <div class="logo">🛡️</div>
      <div>
        <h1>灾害应急指挥平台</h1>
        <p>Disaster Emergency Command &amp; Dispatch</p>
      </div>
    </div>

    <!-- 场景切换 -->
    <div class="scenarios">
      <button
        v-for="s in scenarios"
        :key="s.id"
        :class="{ active: store.scenarioId === s.id }"
        @click="store.loadScenario(s.id)"
      >{{ s.name }}</button>
    </div>

    <!-- 大屏统计卡片 -->
    <div class="stats">
      <div class="stat">
        <span class="num" :style="{ color: '#4d8dff' }">{{ store.stats.listed }}</span>
        <span class="lab">在报事件</span>
      </div>
      <div class="stat red">
        <span class="num" style="color:#ef5350">{{ store.stats.red }}</span>
        <span class="lab">Ⅰ级特大</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#ff9800">{{ store.stats.orange + store.stats.yellow }}</span>
        <span class="lab">Ⅱ/Ⅲ级</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#4caf50">{{ store.stats.closed }}</span>
        <span class="lab">已结案</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#ffc107">{{ store.stats.dispatchedToday }}</span>
        <span class="lab">今日派发</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#7ef0c9">{{ store.stats.signedToday }}</span>
        <span class="lab">今日签收</span>
      </div>
      <div class="stat" :class="{ blocked: store.stats.shortagePending }">
        <span class="num" style="color:#ff9800">{{ store.stats.shortagePending }}</span>
        <span class="lab">短缺待补</span>
      </div>
      <div class="stat" :class="{ blocked: roadblock.activeBlocks.length }">
        <span class="num" style="color:#ef5350">{{ roadblock.activeBlocks.length }}</span>
        <span class="lab">道路阻断</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#4fc3f7">{{ transfer.stats.inTransit }}</span>
        <span class="lab">在途转移</span>
      </div>
      <div class="stat">
        <span class="num" style="color:#7ef0c9">{{ transfer.stats.housed }}</span>
        <span class="lab">安置中</span>
      </div>
      <div class="stat affected">
        <span class="num" style="color:#ff7043">{{ store.stats.totalAffected.toLocaleString() }}</span>
        <span class="lab">受影响群众</span>
      </div>
    </div>

    <!-- 时钟与实时开关 -->
    <div class="right">
      <div class="clock">{{ now }}</div>
      <button
        class="autoplay"
        :class="{ on: store.autoPlay }"
        @click="store.autoPlay ? store.stopAutoPlay() : store.startAutoPlay()"
      >
        {{ store.autoPlay ? '⏹ 实时模拟' : '▶ 实时模拟' }}
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { SCENARIOS } from '@/mock/data'

const store = useCommandStore()
const transfer = useTransferStore()
const roadblock = useRoadblockStore()
const scenarios = SCENARIOS
const now = ref('')
let timer = null

function tick() {
  now.value = new Date().toLocaleString('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  })
}
onMounted(() => { tick(); timer = setInterval(tick, 1000) })
onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.cmd-header {
  display: flex;
  align-items: center;
  gap: 18px;
  background: linear-gradient(90deg, #0c1730, #13233f);
  border-bottom: 1px solid rgba(120, 160, 220, 0.18);
  padding: 10px 20px;
  flex-wrap: wrap;
  box-shadow: 0 4px 18px rgba(0,0,0,0.3);
}
.brand { display: flex; align-items: center; gap: 10px; }
.logo {
  width: 42px; height: 42px; border-radius: 10px;
  display: grid; place-items: center; font-size: 22px;
  background: linear-gradient(135deg, #2962ff, #4d8dff);
  box-shadow: 0 4px 12px rgba(41,98,255,0.5);
}
.brand h1 { font-size: 17px; color: #fff; margin: 0; letter-spacing: 1px; }
.brand p { font-size: 10px; color: #6f84ab; margin: 0; letter-spacing: 1px; }

.scenarios { display: flex; gap: 6px; }
.scenarios button {
  background: #16263f; border: 1px solid rgba(120,160,220,0.2);
  color: #9db1d4; padding: 6px 12px; border-radius: 7px;
  font-size: 12px; cursor: pointer; transition: all 0.2s;
}
.scenarios button:hover { border-color: #4d8dff; color: #fff; }
.scenarios button.active {
  background: linear-gradient(135deg, #1d3f8f, #2962ff);
  color: #fff; border-color: transparent; box-shadow: 0 3px 10px rgba(41,98,255,0.4);
}

.stats { display: flex; gap: 10px; margin-left: auto; }
.stat {
  min-width: 64px; text-align: center;
  background: rgba(18,30,58,0.7);
  border: 1px solid rgba(120,160,220,0.15);
  border-radius: 9px; padding: 6px 8px;
}
.stat .num { display: block; font-size: 20px; font-weight: 800; line-height: 1.1; }
.stat .lab { font-size: 10px; color: #8ba2c8; }
.stat.affected { border-color: rgba(255,112,67,0.5); background: rgba(60,24,14,0.4); }
.stat.blocked { border-color: rgba(239,83,80,0.55); background: rgba(60,14,14,0.4); }

.right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.clock {
  font-family: 'Consolas', monospace; color: #7ef0c9; font-size: 15px;
  text-shadow: 0 0 8px rgba(126,240,201,0.5);
}
.autoplay {
  background: transparent; border: 1px dashed rgba(120,160,220,0.35);
  color: #8ea1c4; font-size: 11px; border-radius: 6px; padding: 4px 10px; cursor: pointer;
}
.autoplay.on { border-color: #4caf50; color: #7ef0c9; background: rgba(76,175,80,0.12); }

@media (max-width: 1100px) {
  .stats { margin-left: 0; width: 100%; }
  .right { flex-direction: row; align-items: center; }
}
</style>