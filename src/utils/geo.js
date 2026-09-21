// 演示用平面几何与球面里程工具：道路阻断影响判定 / 绕行路径生成
const R = 6371
const rad = (d) => (d * Math.PI) / 180

// 两点球面距离（km），点格式 [lng, lat]
export function haversineKm(a, b) {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 折线总长（km）
export function pathKm(points) {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1], points[i])
  return sum
}

// 射线法：点是否在多边形内
export function pointInPolygon(pt, poly) {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// 线段相交判定（平行/共线按不相交处理，演示精度足够）
function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  if (d === 0) return false
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

// 折线是否穿越多边形（任一顶点落入内部，或任一线段与边界相交）
export function pathBlocked(points, poly) {
  for (const pt of points) if (pointInPolygon(pt, poly)) return true
  for (let i = 1; i < points.length; i++) {
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      if (segIntersect(points[i - 1], points[i], poly[k], poly[j])) return true
    }
  }
  return false
}

// 联合判定：折线是否穿越任一多边形，返回首个命中的多边形索引（无命中返回 -1）
export function firstBlocker(points, polys) {
  for (let i = 0; i < polys.length; i++) {
    if (pathBlocked(points, polys[i])) return i
  }
  return -1
}

// 外接矩形四侧绕行候选角点（每侧两个行进方向），margin 为外扩经纬度
function detourCandidates(poly, margin) {
  const lngs = poly.map((p) => p[0])
  const lats = poly.map((p) => p[1])
  const w = Math.min(...lngs) - margin
  const e = Math.max(...lngs) + margin
  const s = Math.min(...lats) - margin
  const n = Math.max(...lats) + margin
  const nw = [w, n], ne = [e, n], sw = [w, s], se = [e, s]
  return [
    [nw, ne], [ne, nw], // 北侧绕行
    [sw, se], [se, sw], // 南侧绕行
    [nw, sw], [sw, nw], // 西侧绕行
    [ne, se], [se, ne]  // 东侧绕行
  ]
}

// 生成绕行途经点：沿封闭区外接矩形四侧绕行（每侧两个方向），取最短可行方案；无解返回 null
// 兼容旧调用：单封闭区 = 联合避障只有一个多边形的特例
export function detourPath(a, b, poly) {
  const det = detourPathMulti(a, b, [poly])
  if (!det) return null
  return { via: det.via, km: det.km }
}

// 联合避障：一次绕行必须同时避开所有生效封闭区。
// 思路：DFS 在首个被穿越的封闭区处插入四侧途经点，再次校验剩余全部封闭区，
// 直到整条折线无穿越；任一起终点落入封闭区则无解（应改派/挂起）。
const DETOUR_MARGINS = [0.035, 0.07, 0.14]
export function detourPathMulti(a, b, polys, opts = {}) {
  const list = (polys || []).filter(Boolean)
  if (!list.length) return { via: [], km: pathKm([a, b]) }
  if (list.some((p) => pointInPolygon(a, p) || pointInPolygon(b, p))) return null
  if (firstBlocker([a, b], list) < 0) return { via: [], km: pathKm([a, b]) }

  const maxNodes = opts.maxNodes || 5000
  let nodes = 0
  let best = null
  const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7

  const dfs = (pts, depth) => {
    if (++nodes > maxNodes || depth > list.length + 2) return
    const hit = firstBlocker(pts, list)
    if (hit < 0) {
      const km = pathKm(pts)
      if (!best || km < best.km) best = { via: pts.slice(1, -1), km }
      return
    }
    const lower = pathKm(pts)
    if (best && lower >= best.km) return // 下界剪枝：当前折线已不短于最优解
    // 找第一条穿越该封闭区的线段，仅在该处插入途经点
    let segIdx = -1
    for (let i = 1; i < pts.length; i++) {
      if (pathBlocked([pts[i - 1], pts[i]], list[hit])) { segIdx = i; break }
    }
    if (segIdx < 0) return
    const seen = new Set()
    for (const margin of DETOUR_MARGINS) {
      for (const via of detourCandidates(list[hit], margin)) {
        if (same(via[0], pts[segIdx - 1]) || same(via[1], pts[segIdx]) || same(via[0], via[1])) continue
        const key = via[0].join(',') + '>' + via[1].join(',')
        if (seen.has(key)) continue
        seen.add(key)
        const next = [...pts.slice(0, segIdx), ...via, ...pts.slice(segIdx)]
        dfs(next, depth + 1)
      }
    }
  }

  dfs([a, b], 0)
  return best
}
