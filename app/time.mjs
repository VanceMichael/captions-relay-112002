// 区间与时码工具：所有区间均为左闭右开的毫秒区间 [from, to)。

export function isRange([from, to]) {
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

// 两个区间的重叠长度；不重叠返回 0。
export function overlapLength(a, b) {
  const left = Math.max(a[0], b[0]);
  const right = Math.min(a[1], b[1]);
  return Math.max(0, right - left);
}

// b 是否完整落在 a 内（边界可以重合）。
export function containsRange(outer, inner) {
  return outer[0] <= inner[0] && inner[1] <= outer[1];
}

// 取两区间交集，不相交返回 null。
export function intersect(a, b) {
  const range = [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
  return range[0] < range[1] ? range : null;
}

// 把若干切分点（含两端）转成连续的左闭右开子区间。
export function splitIntoRanges(from, to, boundaries) {
  const points = [from, ...boundaries.filter((point) => point > from && point < to), to]
    .sort((a, b) => a - b)
    .filter((point, index, all) => index === 0 || point !== all[index - 1]);
  const ranges = [];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1] < points[index]) ranges.push([points[index - 1], points[index]]);
  }
  return ranges;
}
