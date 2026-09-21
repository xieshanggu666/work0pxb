import { defineStore } from 'pinia'
import { useCommandStore, roughPath, pathMetrics, dispatchParts } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'
import { SHELTERS, SUPPLY_PER_CAPITA } from '@/mock/data'

let batchSeq = 0
let personSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 人员查重键：优先证件号，无证件号用姓名
const personKey = (p) => (p.idNo && p.idNo.trim()) ? 'id:' + p.idNo.trim() : 'nm:' + (p.name || '').trim()

export const useTransferStore = defineStore('transfer', {
  state: () => ({
    shelters: [],   // 安置点（床位容量）
    batches: []     // 转移批次
  }),

  getters: {
    /* ---------- 安置点床位 ---------- */
    // shelterId -> { inHouse 在住, reserved 批次计划余量预占, left 剩余可登记 }
    bedMap(state) {
      const m = {}
      state.shelters.forEach((s) => { m[s.id] = { inHouse: 0, reserved: 0, left: s.capacity } })
      state.batches.forEach((b) => {
        if (!b.shelterId || !m[b.shelterId]) return
        const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const out = b.members.filter((x) => x.checkoutAt).length
        m[b.shelterId].inHouse += inHouse
        if (b.status !== 'closed') {
          // 计划转移中尚未入住/转出的部分视为床位预占
          m[b.shelterId].reserved += Math.max(0, b.headcount - inHouse - out)
        }
      })
      Object.values(m).forEach((v) => { v.left = Math.max(0, v.left - v.inHouse - v.reserved) })
      return m
    },
    /* ---------- 安置点物资需求（在住人数 × 人均系数 - 已补给） ---------- */
    shelterNeeds(state) {
      const cmd = useCommandStore()
      return state.shelters.map((s) => {
        const occ = this.bedMap[s.id]?.inHouse || 0
        const need = {}
        Object.entries(SUPPLY_PER_CAPITA).forEach(([t, coef]) => { need[t] = Math.ceil(occ * coef) })
        const sent = {}
        const received = {}
        cmd.dispatches.forEach((d) => {
          if (d.shelterId !== s.id) return
          const p = dispatchParts(d)
          const cover = p.received + p.inTransit
          if (cover > 0) sent[d.type] = (sent[d.type] || 0) + cover
          if (p.received > 0) received[d.type] = (received[d.type] || 0) + p.received
        })
        const gap = {}
        Object.entries(need).forEach(([t, n]) => {
          const g = n - (sent[t] || 0)
          if (g > 0) gap[t] = g
        })
        return { shelter: s, occ, need, sent, received, gap }
      })
    },
    /* ---------- 事件转移进度（回写事件详情） ---------- */
    // eventId -> { batches, planned, picked, checkedIn, out }
    progressByEvent(state) {
      const m = {}
      state.batches.forEach((b) => {
        const p = (m[b.eventId] = m[b.eventId] || { batches: 0, planned: 0, picked: 0, checkedIn: 0, out: 0 })
        p.batches++
        p.planned += b.headcount
        b.members.forEach((x) => {
          if (x.pickupAt) p.picked++
          if (x.checkinAt) p.checkedIn++
          if (x.checkoutAt) p.out++
        })
      })
      return m
    },
    /* ---------- 大屏统计 ---------- */
    stats(state) {
      let inTransit = 0, housed = 0, out = 0, registered = 0
      state.batches.forEach((b) => {
        b.members.forEach((x) => {
          if (x.pickupAt) registered++
          if (x.checkoutAt) out++
          else if (x.checkinAt) housed++
          else if (x.pickupAt) inTransit++
        })
      })
      return {
        activeBatches: state.batches.filter((b) => b.status !== 'closed').length,
        inTransit, housed, out, registered
      }
    }
  },

  actions: {
    load() {
      this.shelters = SHELTERS.map((s) => ({ ...s }))
      this.batches = []
    },

    _cmd() { return useCommandStore() },
    _event(eventId) { return this._cmd().events.find((e) => e.id === eventId) },
    _log(eventId, text) {
      const ev = this._event(eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },
    _batch(id) { return this.batches.find((b) => b.id === id) },

    /* ---------- 道路阻断处置：挂起 / 绕行 / 续派 ---------- */

    // 重算批次路线 ETA（受灾点 → 途经点 → 安置点）
    _syncEta(b) {
      const ev = this._event(b.eventId)
      const sh = this.shelters.find((s) => s.id === b.shelterId)
      if (!ev || !sh) return
      const pts = [[ev.location.lng, ev.location.lat], ...(b.via || []), [sh.lng, sh.lat]]
      b.eta = pathMetrics(pts)
    },
    // 挂起：车辆与床位预占保留，接运/入住登记暂停，恢复通行后续派
    holdBatch(batchId, blockId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed' || b.held) return
      b.held = true
      b.holdBy = blockId
      b.via = []
      b.detourBy = null
      this._log(b.eventId, `⏸ 批次「${b.name}」因道路阻断挂起（车辆/床位预占保留，待续派）`)
    },
    // 续派：解除挂起并恢复直线 ETA
    resumeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || !b.held) return
      b.held = false
      b.holdBy = null
      b.via = []
      b.detourBy = null
      this._syncEta(b)
      this._log(b.eventId, `▶️ 批次「${b.name}」恢复通行续派，预计 ${b.eta?.minutes}min 抵达安置点`)
    },
    // 绕行改道：写入途经点并重算 ETA（地图转移路线联动更新）
    rerouteBatch(batchId, via, blockId = null, silent = false) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return null
      b.via = via
      b.detourBy = blockId
      this._syncEta(b)
      if (!silent) this._log(b.eventId, `🔀 批次「${b.name}」绕行改道，约 ${b.eta?.distance}km·${b.eta?.minutes}min`)
      return b
    },
    // 阻断解除后恢复直线（由道路阻断模块判定后调用）
    resetBatchRoute(batchId) {
      const b = this._batch(batchId)
      if (!b) return
      b.via = []
      b.detourBy = null
      this._syncEta(b)
    },

    /* ---------- 批次生命周期 ---------- */

    // 指挥员建批：分配车辆（占用资源库车辆库存）与安置点（预占床位）
    createBatch({ eventId, name, headcount, vehicleBaseId, vehicleCount, shelterId }) {
      const cmd = this._cmd()
      const ev = this._event(eventId)
      const base = cmd.bases.find((b) => b.id === vehicleBaseId)
      const shelter = this.shelters.find((s) => s.id === shelterId)
      headcount = Math.max(1, Math.round(headcount || 0))
      vehicleCount = Math.max(1, Math.round(vehicleCount || 0))
      if (!ev || !base || !shelter) return { ok: false, msg: '参数不完整，请检查事件、车辆来源与安置点' }
      if ((base.stock.vehicle || 0) < vehicleCount) {
        return { ok: false, msg: `${base.name} 车辆不足（余 ${base.stock.vehicle || 0} 辆）` }
      }
      const beds = this.bedMap[shelterId]
      if (beds.left < headcount) {
        return { ok: false, msg: `${shelter.name} 剩余床位 ${beds.left}，不足 ${headcount} 人，请减少人数或更换安置点` }
      }
      base.stock.vehicle -= vehicleCount // 占用车辆
      const batch = {
        id: 'tb-' + Date.now() + '-' + ++batchSeq,
        eventId,
        name: name?.trim() || `第${this.batches.filter((b) => b.eventId === eventId).length + 1}批`,
        headcount,
        vehicleBaseId, vehicleCount,
        shelterId,
        vehicleReleased: false,
        status: 'pending',
        members: [],
        createdAt: nowStr(),
        // 道路阻断处置：挂起状态、绕行途经点与预计到达
        held: false, holdBy: null, via: [], detourBy: null, eta: null
      }
      this._syncEta(batch)
      this.batches.unshift(batch)
      // 回写事件：时间线 + 状态联动
      this._log(eventId, `🚌 创建转移批次「${batch.name}」：计划 ${headcount} 人，${base.name} 出车 ${vehicleCount} 辆 → ${shelter.name}`)
      if (ev.status === 'reported' || ev.status === 'assessing') ev.status = 'dispatching'
      // 联动：新建批次立即接受生效阻断复核
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, batch }
    },

    // 改派：更换安置点 / 调整车辆（释放旧占用、校验新库存与床位）
    reassignBatch(batchId, { shelterId, vehicleBaseId, vehicleCount }) {
      const cmd = this._cmd()
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return { ok: false, msg: '批次不存在或已办结' }
      const changes = []
      // 换安置点：已有入住登记后不允许（人员已落床位）
      if (shelterId && shelterId !== b.shelterId) {
        if (b.members.some((x) => x.checkinAt)) return { ok: false, msg: '已有群众入住，不能再改派安置点' }
        const target = this.shelters.find((s) => s.id === shelterId)
        if (!target) return { ok: false, msg: '安置点不存在' }
        if (this.bedMap[shelterId].left < b.headcount) {
          return { ok: false, msg: `${target.name} 剩余床位 ${this.bedMap[shelterId].left}，不足 ${b.headcount} 人` }
        }
        changes.push(`安置点改派：${this.shelters.find((s) => s.id === b.shelterId)?.name} → ${target.name}`)
        b.shelterId = shelterId
        b.via = [] // 安置点变更后路线重算
        b.detourBy = null
        this._syncEta(b)
      }
      // 调整车辆：先释放旧占用，再占用新配置
      if (vehicleBaseId && vehicleCount != null) {
        vehicleCount = Math.max(1, Math.round(vehicleCount))
        const oldBase = cmd.bases.find((x) => x.id === b.vehicleBaseId)
        const newBase = cmd.bases.find((x) => x.id === vehicleBaseId)
        if (!newBase) return { ok: false, msg: '车辆来源不存在' }
        const avail = (newBase.stock.vehicle || 0) + (newBase.id === b.vehicleBaseId && !b.vehicleReleased ? b.vehicleCount : 0)
        if (avail < vehicleCount) return { ok: false, msg: `${newBase.name} 车辆不足（可调 ${avail} 辆）` }
        if (oldBase && !b.vehicleReleased) oldBase.stock.vehicle += b.vehicleCount
        newBase.stock.vehicle -= vehicleCount
        b.vehicleReleased = false
        if (vehicleBaseId !== b.vehicleBaseId || vehicleCount !== b.vehicleCount) {
          changes.push(`车辆改派：${newBase.name} ${vehicleCount} 辆`)
        }
        b.vehicleBaseId = vehicleBaseId
        b.vehicleCount = vehicleCount
      }
      if (changes.length) this._log(b.eventId, `🔀 批次「${b.name}」${changes.join('；')}`)
      return { ok: true, msg: changes.length ? changes.join('；') : '配置未变化' }
    },

    // 办结：全部转出或提前办结，回收车辆
    closeBatch(batchId) {
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      if (inHouse > 0) return { ok: false, msg: `仍有 ${inHouse} 人在住，请先办理转出登记` }
      this._close(b)
      return { ok: true }
    },
    _close(b) {
      b.status = 'closed'
      this._releaseVehicles(b)
      this._log(b.eventId, `✅ 批次「${b.name}」办结：累计转移 ${b.members.length} 人，车辆已回收`)
    },
    _releaseVehicles(b) {
      if (b.vehicleReleased) return
      const base = this._cmd().bases.find((x) => x.id === b.vehicleBaseId)
      if (base) base.stock.vehicle += b.vehicleCount
      b.vehicleReleased = true
    },
    // 取消（仅未开始接运的批次）
    cancelBatch(batchId) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.members.length > 0) return { ok: false, msg: '已有登记记录，不能取消，请走办结流程' }
      this._releaseVehicles(b)
      this.batches = this.batches.filter((x) => x.id !== batchId)
      this._log(b.eventId, `🗑 批次「${b.name}」已取消，车辆已释放`)
      return { ok: true }
    },

    /* ---------- 批次拆分：按人员分组分流 ---------- */

    // 拆分未完成批次：按人员分组（已登记成员 + 未登记名额）分出子批次，
    // 各子批次独立安排车辆与安置点；登记历史随人员整体迁移，床位/车辆/路线联动重算，
    // 原批次计划人数同步核减，并按剩余人员重算状态与办结条件（事件转移进度总量守恒）
    splitBatch(batchId, { keepVehicleCount, groups = [] } = {}) {
      const cmd = this._cmd()
      const b = this._batch(batchId)
      if (!b || b.status === 'closed') return { ok: false, msg: '批次不存在或已办结' }
      if (b.held) return { ok: false, msg: '批次因道路阻断挂起中，待恢复续派后再拆分' }
      if (!Array.isArray(groups) || !groups.length) return { ok: false, msg: '请至少添加一个拆分分组' }

      // 原批次保留车辆数（缺省不调整；差额释放回车辆来源基地，可供子批次重新占用）
      const keepV = keepVehicleCount == null ? b.vehicleCount : Math.max(0, Math.round(keepVehicleCount))
      if (keepV > b.vehicleCount) return { ok: false, msg: `原批次保留车辆不能超过现有 ${b.vehicleCount} 辆` }

      // 规范化分组并逐项校验（已转出人员脱离批次管理，不参与拆分）
      const room = b.headcount - b.members.length // 未登记名额
      const used = new Set()
      let quotaSum = 0
      const plans = []
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]
        const shelter = this.shelters.find((s) => s.id === g.shelterId)
        const vBase = cmd.bases.find((x) => x.id === g.vehicleBaseId)
        const vehicleCount = Math.max(1, Math.round(g.vehicleCount || 0))
        const quota = Math.max(0, Math.round(g.quota || 0))
        if (!shelter || !vBase) return { ok: false, msg: `分组${gi + 1}：请检查车辆来源与安置点` }
        const members = []
        for (const id of [...new Set(g.memberIds || [])]) {
          const m = b.members.find((x) => x.id === id)
          if (!m) return { ok: false, msg: `分组${gi + 1}：人员不在原批次或已被其他分组选走` }
          if (m.checkoutAt) return { ok: false, msg: `分组${gi + 1}：「${m.name}」已转出，不参与拆分` }
          if (used.has(id)) return { ok: false, msg: `分组${gi + 1}：「${m.name}」被重复选择` }
          used.add(id)
          members.push(m)
        }
        quotaSum += quota
        if (members.length + quota < 1) return { ok: false, msg: `分组${gi + 1}：分流人数至少 1 人` }
        plans.push({ g, shelter, vBase, vehicleCount, quota, members, size: members.length + quota })
      }
      if (quotaSum > room) return { ok: false, msg: `未登记名额不足：剩余 ${room} 人，各分组合计需 ${quotaSum} 人` }

      // 床位预检：跨安置点分流累计需求（同安置点分流不改变该点床位占用，无需校验）
      const bedNeed = {}
      plans.forEach((p) => {
        if (p.shelter.id !== b.shelterId) bedNeed[p.shelter.id] = (bedNeed[p.shelter.id] || 0) + p.size
      })
      for (const [sid, n] of Object.entries(bedNeed)) {
        const left = this.bedMap[sid]?.left || 0
        if (left < n) {
          return { ok: false, msg: `${this.shelters.find((s) => s.id === sid)?.name} 剩余床位 ${left}，不足分流 ${n} 人，请调整分组或更换安置点` }
        }
      }
      // 车辆预检：原批次释放回补后，各基地累计占用不超库存
      const vehAvail = {}
      cmd.bases.forEach((x) => { vehAvail[x.id] = x.stock.vehicle || 0 })
      if (!b.vehicleReleased && keepV < b.vehicleCount) vehAvail[b.vehicleBaseId] += b.vehicleCount - keepV
      for (const p of plans) {
        if ((vehAvail[p.vBase.id] || 0) < p.vehicleCount) {
          return { ok: false, msg: `${p.vBase.name} 车辆不足（含原批次释放可调 ${vehAvail[p.vBase.id] || 0} 辆，该分组需 ${p.vehicleCount} 辆）` }
        }
        vehAvail[p.vBase.id] -= p.vehicleCount
      }

      // —— 执行：先释放原批次车辆差额，再逐组落库 ——
      if (!b.vehicleReleased && keepV < b.vehicleCount) {
        const ob = cmd.bases.find((x) => x.id === b.vehicleBaseId)
        if (ob) ob.stock.vehicle += b.vehicleCount - keepV
        this._log(b.eventId, `🚒 批次「${b.name}」车辆拆分联动：${b.vehicleCount}→${keepV} 辆，释放 ${b.vehicleCount - keepV} 辆回 ${ob?.name}`)
        b.vehicleCount = keepV
      }
      const created = []
      plans.forEach((p, i) => {
        p.vBase.stock.vehicle -= p.vehicleCount // 占用子批次车辆
        const ids = new Set(p.members.map((m) => m.id))
        b.members = b.members.filter((x) => !ids.has(x.id))
        const nb = {
          id: 'tb-' + Date.now() + '-' + ++batchSeq,
          eventId: b.eventId,
          name: p.g.name?.trim() || `${b.name}·分流${i + 1}`,
          headcount: p.size,
          vehicleBaseId: p.vBase.id, vehicleCount: p.vehicleCount,
          shelterId: p.shelter.id,
          vehicleReleased: false,
          status: 'pending',
          members: p.members, // 登记历史（接运/入住时间）随人员整体迁移
          createdAt: nowStr(),
          held: false, holdBy: null, via: [], detourBy: null, eta: null,
          splitFrom: { id: b.id, name: b.name }
        }
        // 状态随迁入人员进度推导：全员已入住且无未登记名额 → 已安置
        if (nb.members.length) {
          nb.status = (p.quota === 0 && nb.members.every((x) => x.checkinAt)) ? 'settled' : 'transporting'
        }
        this._syncEta(nb)
        this.batches.unshift(nb)
        created.push(nb)
        b.headcount -= p.size // 原批次计划人数同步核减
        b.splitLogs = b.splitLogs || []
        b.splitLogs.push({ at: nowStr(), toBatchId: nb.id, toName: nb.name, members: p.members.length, quota: p.quota })
        this._log(b.eventId, `✂️ 批次拆分：「${b.name}」分出 ${p.size} 人（已登记 ${p.members.length}${p.quota ? `＋未登记名额 ${p.quota}` : ''}）→「${nb.name}」：${p.vBase.name} 出车 ${p.vehicleCount} 辆 → ${p.shelter.name}`)
      })
      // 原批次办结条件同步：按计划核减后的剩余人员重算状态，空置/全员转出自动办结
      this._syncAfterSplit(b)
      // 联动：子批次立即接受生效阻断复核（路线/ETA 由响应式同步地图）
      try { useRoadblockStore().assessActive() } catch { /* 道路阻断模块未初始化 */ }
      return { ok: true, created, remainder: b, msg: `已拆分出 ${created.length} 个分流批次` }
    },

    // 拆分后原批次状态重算：人员清空则办结或回到待接运；剩余人员满足安置/转出条件则推进
    _syncAfterSplit(b) {
      if (b.status === 'closed') return
      const inDone = b.members.filter((x) => x.checkinAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      if (b.members.length === 0) {
        if (b.headcount === 0) {
          b.status = 'closed'
          this._releaseVehicles(b)
          this._log(b.eventId, `✂️ 批次「${b.name}」人员已全量拆分，车辆回收办结`)
        } else {
          b.status = 'pending' // 仅剩未登记名额，回到待接运
        }
        return
      }
      if (b.status === 'pending' && b.members.some((x) => x.pickupAt)) b.status = 'transporting'
      if (b.status === 'transporting' && inDone >= b.headcount) b.status = 'settled'
      if (b.status === 'settled' && out === b.members.length) this._close(b)
    },

    /* ---------- 现场登记：接运 / 入住 / 转出 ---------- */

    // 单人登记（带查重）；批量登记传 { count }
    register(batchId, stage, payload) {
      const b = this._batch(batchId)
      if (!b) return { ok: false, msg: '批次不存在' }
      if (b.status === 'closed') return { ok: false, msg: '批次已办结' }
      // 道路阻断挂起中：接运/入住暂停（转出不受影响，在住群众可正常疏解）
      if (b.held && stage !== 'checkout') {
        return { ok: false, msg: '批次因道路阻断挂起中，待恢复通行续派后再登记' }
      }
      if (payload.count != null) return this._registerBulk(b, stage, payload.count)
      const name = (payload.name || '').trim()
      const idNo = (payload.idNo || '').trim()
      if (!name && !idNo) return { ok: false, msg: '请填写姓名或证件号' }
      const person = { name: name || '（未留姓名）', idNo }
      if (stage === 'pickup') return this._pickup(b, person)
      // 入住 / 转出：需先在本批次完成上一环节登记
      const m = b.members.find((x) => personKey(x) === personKey(person))
      if (!m) return { ok: false, msg: stage === 'checkin' ? '该人员未登记接运，请先接运登记' : '该人员未入住，无法转出' }
      if (stage === 'checkin') {
        if (m.checkinAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理入住，请勿重复登记` }
        return this._checkin(b, [m])
      }
      if (m.checkoutAt) return { ok: false, dup: 'self', msg: `「${person.name}」已办理转出，请勿重复登记` }
      if (!m.checkinAt) return { ok: false, msg: '该人员尚未入住，无法转出' }
      return this._checkout(b, [m])
    },

    _pickup(b, person) {
      const key = personKey(person)
      // 重复登记：本批次已存在
      if (b.members.some((x) => personKey(x) === key)) {
        return { ok: false, dup: 'self', msg: `「${person.name}」已在本批次登记，请勿重复登记` }
      }
      // 重复登记：其他批次已存在 → 提示改派
      for (const ob of this.batches) {
        if (ob.id === b.id || ob.status === 'closed') continue
        const hit = ob.members.find((x) => personKey(x) === key)
        if (hit) {
          return {
            ok: false, dup: 'other',
            fromBatchId: ob.id, fromBatchName: ob.name, personId: hit.id,
            msg: `「${person.name}」已在批次「${ob.name}」登记，可改派至本批次`
          }
        }
      }
      if (b.members.length >= b.headcount) {
        return { ok: false, msg: `已达计划人数 ${b.headcount} 人，请新建批次或调整计划` }
      }
      b.members.push({ id: 'p-' + ++personSeq, ...person, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
      this._afterRegister(b, 'pickup', `🚌「${person.name}」接运登记`)
      return { ok: true }
    },

    _registerBulk(b, stage, count) {
      count = Math.max(1, Math.round(count || 0))
      if (stage === 'pickup') {
        const room = b.headcount - b.members.length
        const n = Math.min(count, room)
        if (n <= 0) return { ok: false, msg: `已达计划人数 ${b.headcount} 人` }
        for (let i = 0; i < n; i++) {
          b.members.push({ id: 'p-' + ++personSeq, name: `群众${personSeq}号`, idNo: '', anon: true, pickupAt: nowStr(), checkinAt: null, checkoutAt: null })
        }
        this._afterRegister(b, 'pickup', `🚌 批量接运登记 ${n} 人`)
        return { ok: true, msg: n < count ? `仅登记 ${n} 人（受计划人数限制）` : `已登记 ${n} 人` }
      }
      // 批量入住 / 转出：取本批次中处于上一环节的成员
      const pool = stage === 'checkin'
        ? b.members.filter((x) => x.pickupAt && !x.checkinAt)
        : b.members.filter((x) => x.checkinAt && !x.checkoutAt)
      const targets = pool.slice(0, count)
      if (!targets.length) return { ok: false, msg: stage === 'checkin' ? '暂无待入住人员' : '暂无在住人员' }
      return stage === 'checkin' ? this._checkin(b, targets) : this._checkout(b, targets)
    },

    _checkin(b, members) {
      // 可用床位 = 全局剩余 + 本批次自身预占（本批次的待入住人员已计入预占，不能重复扣减）
      const bed = this.bedMap[b.shelterId]
      const inHouse = b.members.filter((x) => x.checkinAt && !x.checkoutAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      const ownReserved = b.status === 'closed' ? 0 : Math.max(0, b.headcount - inHouse - out)
      const avail = bed.left + ownReserved
      if (avail < members.length) {
        return { ok: false, msg: `${this.shelters.find((s) => s.id === b.shelterId)?.name} 剩余床位 ${avail}，不足 ${members.length} 人，请改派安置点` }
      }
      members.forEach((m) => { m.checkinAt = nowStr() })
      this._afterRegister(b, 'checkin', `🏕️ 入住登记 ${members.length} 人 → ${this.shelters.find((s) => s.id === b.shelterId)?.name}`)
      return { ok: true, msg: `已入住 ${members.length} 人` }
    },

    _checkout(b, members) {
      members.forEach((m) => { m.checkoutAt = nowStr() })
      this._afterRegister(b, 'checkout', `🚪 转出登记 ${members.length} 人（返乡/投亲/转院）`)
      return { ok: true, msg: `已转出 ${members.length} 人` }
    },

    // 登记后：推进批次状态、回写事件时间线
    _afterRegister(b, stage, text) {
      const picked = b.members.filter((x) => x.pickupAt).length
      const inDone = b.members.filter((x) => x.checkinAt).length
      const out = b.members.filter((x) => x.checkoutAt).length
      if (b.status === 'pending' && picked > 0) b.status = 'transporting'
      if (b.status === 'transporting' && inDone >= b.headcount) b.status = 'settled'
      this._log(b.eventId, `${text}（批次「${b.name}」${picked}/${b.headcount}）`)
      // 已安置批次的在册人员全部转出 → 自动办结（未满员的批次需手动办结）
      if (b.status === 'settled' && b.members.length > 0 && out === b.members.length) this._close(b)
    },

    // 单成员快捷推进：未入住 → 入住；在住 → 转出（列表行内操作）
    advanceMember(batchId, memberId) {
      const b = this._batch(batchId)
      const m = b?.members.find((x) => x.id === memberId)
      if (!b || !m || b.status === 'closed') return { ok: false, msg: '不可操作' }
      if (!m.checkinAt) return this._checkin(b, [m])
      if (!m.checkoutAt) return this._checkout(b, [m])
      return { ok: false, msg: '该人员已转出' }
    },

    // 人员改派：从原批次移动到目标批次（保留登记进度，校验目标批次计划与床位）
    movePerson(personId, toBatchId) {
      const to = this._batch(toBatchId)
      if (!to || to.status === 'closed') return { ok: false, msg: '目标批次不可用' }
      let from = null, person = null
      for (const b of this.batches) {
        const i = b.members.findIndex((x) => x.id === personId)
        if (i >= 0) { from = b; person = b.members[i]; break }
      }
      if (!from || !person) return { ok: false, msg: '未找到该人员登记记录' }
      if (from.id === to.id) return { ok: false, msg: '人员已在本批次' }
      if (to.members.length >= to.headcount) return { ok: false, msg: `目标批次「${to.name}」已达计划人数` }
      // 已入住人员跨安置点改派：可用床位 = 目标点剩余 + 目标批次自身预占
      if (person.checkinAt && !person.checkoutAt && from.shelterId !== to.shelterId) {
        const inHouse = to.members.filter((x) => x.checkinAt && !x.checkoutAt).length
        const outN = to.members.filter((x) => x.checkoutAt).length
        const ownReserved = Math.max(0, to.headcount - inHouse - outN)
        if (this.bedMap[to.shelterId].left + ownReserved < 1) {
          return { ok: false, msg: `目标安置点剩余床位不足，无法改派` }
        }
      }
      from.members = from.members.filter((x) => x.id !== personId)
      to.members.push(person)
      this._log(from.eventId, `🔀「${person.name}」由批次「${from.name}」改派至「${to.name}」`)
      return { ok: true, msg: `已改派至「${to.name}」` }
    },

    /* ---------- 安置点物资联动 ---------- */

    // 一键补给：按缺口就近调拨（预占式演算，直接生成补给派发记录）
    autoSupply(shelterId) {
      const cmd = this._cmd()
      const item = this.shelterNeeds.find((x) => x.shelter.id === shelterId)
      if (!item) return { ok: false, msg: '安置点不存在' }
      const gaps = Object.entries(item.gap)
      if (!gaps.length) return { ok: false, msg: '当前无物资缺口' }
      const sent = []
      const unmet = []
      gaps.forEach(([type, g]) => {
        let need = g
        const cands = cmd.bases
          .filter((b) => (b.stock[type] || 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, item.shelter.lng, item.shelter.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, c.b.stock[type])
          const rec = cmd.dispatchToShelter({
            baseId: c.b.id, shelterId, shelterName: item.shelter.name,
            lng: item.shelter.lng, lat: item.shelter.lat, type, qty: take
          })
          if (rec) { sent.push(rec); need -= take }
        }
        if (need > 0) unmet.push({ type, qty: need })
      })
      // 补给量回写关联事件时间线（该安置点服务的未办结批次所属事件）
      const evIds = [...new Set(this.batches.filter((b) => b.shelterId === shelterId && b.status !== 'closed').map((b) => b.eventId))]
      evIds.forEach((id) => this._log(id, `📦 安置点「${item.shelter.name}」一键补给 ${sent.length} 批物资`))
      return { ok: true, sent, unmet }
    }
  }
})
