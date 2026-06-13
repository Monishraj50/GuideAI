interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
}

export function Sparkline({ data, width = 80, height = 22, className, stroke = 'currentColor' }: SparklineProps) {
  if (data.length === 0) {
    return <svg width={width} height={height} className={className} />;
  }
  const max = Math.max(1, ...data);
  const min = Math.min(0, ...data);
  const range = Math.max(1, max - min);
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = `M ${pts.join(' L ')}`;
  const last = data[data.length - 1] ?? 0;
  const lastY = height - ((last - min) / range) * (height - 2) - 1;
  return (
    <svg width={width} height={height} className={className}>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts.join(' ')}
        opacity={0.85}
      />
      <circle cx={(data.length - 1) * step} cy={lastY} r={2} fill={stroke} />
    </svg>
  );
}
