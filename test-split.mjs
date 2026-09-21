import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'

// 批次拆分回归：按人员分组拆分未完成批次 → 分别安排车辆/安置点 → 登记历史保留
// → 床位/车辆/路线联动重分配 → 原批次办结条件与事件转移进度同步
setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
cmd.loadScenario('s1')
tr.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev = cmd.events[0]
const rb1 = cmd.bases.find((b) => b.id === 'rb-1') // 车辆 200
const rb2 = cmd.bases.find((b) => b.id === 'rb-2') // 车辆 40

console.log('— 建批 + 三环节登记准备 —')
const r1 = tr.createBatch({ eventId: ev.id, name: '一批', headcount: 100, vehicleBaseId: 'rb-1', vehicleCount: 3, shelterId: 'sh-1' })
assert(r1.ok, '创建批次（100人/3车 → sh-1）')
const b1 = r1.batch
assert(rb1.stock.vehicle === 197, `rb-1 车辆占用 200->${rb1.stock.vehicle}`)
assert(tr.bedMap['sh-1'].reserved === 100, 'sh-1 床位预占 100')
tr.register(b1.id, 'pickup', { count: 60 })
tr.register(b1.id, 'checkin', { count: 30 })
tr.register(b1.id, 'checkout', { count: 1 })
assert(b1.members.length === 60, '接运 60 人')
assert(tr.bedMap['sh-1'].inHouse === 29 && tr.bedMap['sh-1'].reserved === 70, `sh-1 在住 29 · 预占 70（实际 ${tr.bedMap['sh-1'].inHouse}/${tr.bedMap['sh-1'].reserved}）`)

console.log('— 拆分校验 —')
assert(!tr.splitBatch('tb-x', { groups: [{}] }).ok, '批次不存在被拒绝')
assert(!tr.splitBatch(b1.id, { groups: [] }).ok, '空分组被拒绝')
assert(!tr.splitBatch(b1.id, { groups: [{ quota: 41, shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '未登记名额超限（需41/余40）被拒绝')
const outMember = b1.members.find((x) => x.checkoutAt)
assert(!tr.splitBatch(b1.id, { groups: [{ memberIds: [outMember.id], shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '已转出人员不参与拆分')
const pendIds = b1.members.filter((x) => x.pickupAt && !x.checkinAt).map((x) => x.id)
const dupG = { shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }
assert(!tr.splitBatch(b1.id, { groups: [{ ...dupG, memberIds: [pendIds[0]] }, { ...dupG, memberIds: [pendIds[0]] }] }).ok,
  '同一人员被重复选择被拒绝')
assert(!tr.splitBatch(b1.id, { groups: [{ memberIds: ['p-x'], shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '非本批次人员被拒绝')
assert(!tr.splitBatch(b1.id, { groups: [{ quota: 10, shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 999 }] }).ok,
  '车辆不足被拒绝')
assert(!tr.splitBatch(b1.id, { groups: [{ quota: 601, shelterId: 'sh-3', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '目标安置点床位不足被拒绝')
tr.holdBatch(b1.id, 'blk-x')
assert(!tr.splitBatch(b1.id, { groups: [{ quota: 1, shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '挂起中批次拆分被拒绝')
tr.resumeBatch(b1.id)
assert(!b1.held, '续派解除挂起')

console.log('— 三分组拆分：在住 / 未入住 / 未登记名额 —')
const inHouseIds = b1.members.filter((x) => x.checkinAt && !x.checkoutAt).slice(0, 20).map((x) => x.id)
const rs = tr.splitBatch(b1.id, {
  keepVehicleCount: 1, // 原批次 3 车 → 保留 1 车，释放 2 辆回 rb-1
  groups: [
    { name: '老人儿童分流', memberIds: inHouseIds, shelterId: 'sh-3', vehicleBaseId: 'rb-2', vehicleCount: 1 },
    { memberIds: pendIds, shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 },
    { quota: 40, shelterId: 'sh-2', vehicleBaseId: 'rb-1', vehicleCount: 1 }
  ]
})
assert(rs.ok, '拆分成功: ' + (rs.msg || ''))
const [g1, g2, g3] = rs.created
assert(rs.created.length === 3, '生成 3 个分流批次')
assert(b1.headcount === 10 && b1.members.length === 10, `原批次计划核减为 ${b1.headcount}，剩 ${b1.members.length} 人`)
assert(b1.status === 'settled', `原批次办结条件同步：剩余人员全部入住 → ${b1.status}`)
assert(b1.vehicleCount === 1, '原批次车辆核减为 1 辆')
assert(rb1.stock.vehicle === 197, `rb-1 车辆联动：197+2释放-2占用 = ${rb1.stock.vehicle}`)
assert(rb2.stock.vehicle === 39, `rb-2 车辆占用 40->${rb2.stock.vehicle}`)
assert(g1.status === 'settled' && g1.headcount === 20 && g1.shelterId === 'sh-3', '分流1（在住20人）→ 已安置 · sh-3')
assert(g2.status === 'transporting' && g2.headcount === 30 && g2.shelterId === 'sh-2', '分流2（未入住30人）→ 接运中 · sh-2')
assert(g3.status === 'pending' && g3.headcount === 40 && g3.members.length === 0, '分流3（名额40人）→ 待接运')
assert(g1.splitFrom?.id === b1.id && g1.name === '老人儿童分流', '分流批次记录拆分来源')
assert(b1.splitLogs.length === 3, '原批次保留 3 条分流日志')
assert(g1.eta && g1.eta.minutes > 0, '分流批次路线 ETA 已重算')

console.log('— 床位联动重分配 —')
assert(tr.bedMap['sh-1'].inHouse === 9 && tr.bedMap['sh-1'].reserved === 0,
  `sh-1 在住 9 · 预占 0（实际 ${tr.bedMap['sh-1'].inHouse}/${tr.bedMap['sh-1'].reserved}）`)
assert(tr.bedMap['sh-3'].inHouse === 20 && tr.bedMap['sh-3'].reserved === 0, 'sh-3 在住 +20（随人员迁入）')
assert(tr.bedMap['sh-2'].reserved === 70, `sh-2 预占 70（分流2的30 + 分流3的40，实际 ${tr.bedMap['sh-2'].reserved}）`)

console.log('— 登记历史保留 —')
const moved = g1.members[0]
assert(moved.pickupAt && moved.checkinAt && !moved.checkoutAt, '迁入人员接运/入住时间完整保留')
assert(inHouseIds.includes(moved.id), '人员记录为同一对象（id 不变）')
assert(g2.members.every((x) => x.pickupAt && !x.checkinAt), '分流2 人员保持待入住状态')

console.log('— 事件转移进度同步（总量守恒） —')
const prog = tr.progressByEvent[ev.id]
assert(prog.batches === 4 && prog.planned === 100, `计划总量守恒 100（实际 ${prog.planned}，${prog.batches} 批）`)
assert(prog.picked === 60 && prog.checkedIn === 30 && prog.out === 1,
  `接运60/入住30/转出1 不变（实际 ${prog.picked}/${prog.checkedIn}/${prog.out}）`)

console.log('— 名额批次继续登记 —')
assert(tr.register(g3.id, 'pickup', { count: 40 }).ok, '分流3 批量接运 40')
assert(g3.status === 'transporting', '分流3 → 接运中')
assert(!tr.register(g3.id, 'pickup', { count: 1 }).ok, '分流3 满员后接运被拒绝')
assert(tr.register(g3.id, 'checkin', { count: 40 }).ok, '分流3 批量入住 40')
assert(g3.status === 'settled', '分流3 → 已安置')
assert(tr.bedMap['sh-2'].inHouse === 40 && tr.bedMap['sh-2'].reserved === 30, 'sh-2 在住 40 · 预占 30')

console.log('— 全量拆分 → 原批次自动办结 —')
const r2 = tr.createBatch({ eventId: ev.id, name: '二批', headcount: 10, vehicleBaseId: 'rb-1', vehicleCount: 1, shelterId: 'sh-1' })
const b2 = r2.batch
tr.register(b2.id, 'pickup', { count: 10 })
tr.register(b2.id, 'checkin', { count: 10 })
assert(b2.status === 'settled', '二批已安置')
const rs2 = tr.splitBatch(b2.id, {
  groups: [{ memberIds: b2.members.map((x) => x.id), shelterId: 'sh-1', vehicleBaseId: 'rb-1', vehicleCount: 1 }]
})
assert(rs2.ok, '同安置点全量拆分成功')
assert(b2.status === 'closed' && b2.headcount === 0 && b2.members.length === 0, '原批次人员全量分出 → 自动办结')
assert(rb1.stock.vehicle === 196, `rb-1 车辆回收（余 ${rb1.stock.vehicle}）`)
assert(rs2.created[0].status === 'settled' && rs2.created[0].shelterId === 'sh-1', '分流批次承继已安置状态（同安置点床位不变）')
assert(!tr.splitBatch(b2.id, { groups: [{ quota: 1, shelterId: 'sh-1', vehicleBaseId: 'rb-1', vehicleCount: 1 }] }).ok,
  '已办结批次拆分被拒绝')

console.log('— 分流批次转出 → 自动办结 + 车辆回收 —')
assert(tr.register(g1.id, 'checkout', { count: 20 }).ok, '分流1 全部转出')
assert(g1.status === 'closed', '分流1 自动办结')
assert(rb2.stock.vehicle === 40, `rb-2 车辆回收（余 ${rb2.stock.vehicle}）`)
assert(tr.bedMap['sh-3'].inHouse === 0, 'sh-3 床位释放')
assert(tr.register(b1.id, 'checkout', { count: 9 }).ok, '原批次剩余 9 人转出')
assert(b1.status === 'closed', '原批次全员转出 → 自动办结')
assert(rb1.stock.vehicle === 197, `rb-1 车辆回收（余 ${rb1.stock.vehicle}）`)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
