// 纯函数 SVG 生成:sparkline(卡片迷你走势)与 lineChart(详情页多源走势)。
// 不引前端依赖,全部服务端渲染。

export interface SparkOptions {
  width?: number;
  height?: number;
  stroke?: string;
  jumpIdx?: number[]; // 突变点(values 下标),画成小圆点
  emptyLabel?: string;
}

export function sparkline(values: number[], options: SparkOptions = {}): string {
  const width = options.width ?? 200;
  const height = options.height ?? 34;
  const stroke = options.stroke ?? "var(--blue)";
  if (values.length < 2) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><text x="4" y="${height / 2 + 4}" fill="var(--dim)" font-size="11">${options.emptyLabel ?? "Trend pending"}</text></svg>`;
  }

  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.01); // 平盘也给 1pp 纵深,避免直线贴边
  const x = (i: number): number => pad + (i / (values.length - 1)) * (width - pad * 2 - 34);
  const y = (v: number): number => pad + (1 - (v - min) / span) * (height - pad * 2);

  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const deltaPp = (last - first) * 100;
  const deltaColor = deltaPp >= 0.5 ? "var(--green)" : deltaPp <= -0.5 ? "var(--red)" : "var(--dim)";

  const jumps = (options.jumpIdx ?? [])
    .filter((i) => i > 0 && i < values.length)
    .map((i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(values[i]).toFixed(1)}" r="2.5" fill="var(--amber)"/>`)
    .join("");

  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5"/>` +
    jumps +
    `<circle cx="${x(values.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5" fill="${stroke}"/>` +
    `<text x="${width - 32}" y="${height / 2 + 4}" fill="${deltaColor}" font-size="11">${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(1)}</text>` +
    `</svg>`
  );
}

export interface ChartSeries {
  name: string;
  color: string;
  dash?: string; // 如 "4 3"
  points: { t: number; v: number }[]; // t = epoch ms, v = 0..1 概率
  markersOnly?: boolean; // 稀疏源(体彩)只画点不连线
}

export interface ChartOptions {
  width?: number;
  height?: number;
  tMin: number;
  tMax: number;
}

export function lineChart(series: ChartSeries[], options: ChartOptions): string {
  const width = options.width ?? 340;
  const height = options.height ?? 150;
  const padL = 30;
  const padR = 8;
  const padT = 8;
  const padB = 16;

  const drawn = series.filter((s) => s.points.length > 0);
  if (drawn.length === 0) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><text x="${padL}" y="${height / 2}" fill="var(--dim)" font-size="12">暂无走势数据</text></svg>`;
  }

  const vs = drawn.flatMap((s) => s.points.map((p) => p.v));
  let vMin = Math.min(...vs);
  let vMax = Math.max(...vs);
  const vPad = Math.max((vMax - vMin) * 0.15, 0.01);
  vMin = Math.max(0, vMin - vPad);
  vMax = Math.min(1, vMax + vPad);

  const tSpan = Math.max(options.tMax - options.tMin, 1);
  const x = (t: number): number => padL + ((t - options.tMin) / tSpan) * (width - padL - padR);
  const y = (v: number): number => padT + (1 - (v - vMin) / (vMax - vMin)) * (height - padT - padB);

  // y 轴只标整 5% 网格,最多 4 条
  const gridLines: string[] = [];
  const stepPct = Math.max(5, Math.ceil(((vMax - vMin) * 100) / 4 / 5) * 5);
  for (let pct = Math.ceil((vMin * 100) / stepPct) * stepPct; pct <= vMax * 100; pct += stepPct) {
    const gy = y(pct / 100);
    gridLines.push(
      `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${width - padR}" y2="${gy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>` +
        `<text x="${padL - 4}" y="${(gy + 3.5).toFixed(1)}" fill="var(--dim)" font-size="10" text-anchor="end">${pct}%</text>`
    );
  }

  const paths = drawn
    .map((s) => {
      const pts = [...s.points].sort((a, b) => a.t - b.t);
      if (s.markersOnly || pts.length === 1) {
        return pts
          .map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" fill="${s.color}"/>`)
          .join("");
      }
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
    })
    .join("");

  // x 轴两端时刻(北京时间 HH:mm)
  const fmt = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  const xLabels =
    `<text x="${padL}" y="${height - 3}" fill="var(--dim)" font-size="10">${fmt.format(new Date(options.tMin))}</text>` +
    `<text x="${width - padR}" y="${height - 3}" fill="var(--dim)" font-size="10" text-anchor="end">${fmt.format(new Date(options.tMax))}</text>`;

  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    gridLines.join("") +
    paths +
    xLabels +
    `</svg>`
  );
}
