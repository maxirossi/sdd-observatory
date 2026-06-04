import { ResponsivePie } from '@nivo/pie';
import { GlassTooltip } from './ChartTooltip';
import { nivoDarkTheme } from './chartTheme';

export interface DonutDatum {
  id: string;
  label: string;
  value: number;
  color: string;
}

interface Props {
  data: DonutDatum[];
  /** Texto grande del centro (ej "80%"). */
  centervalue?: string;
  /** Texto chico debajo del centro (ej "270 / 338"). */
  centerSub?: string;
  centerValueClass?: string;
  /** Grosor del anillo 0..1 (mayor = más fino). */
  innerRadius?: number;
  padAngle?: number;
}

export function DonutChart({
  data,
  centervalue,
  centerSub,
  centerValueClass = 'text-slate-50',
  innerRadius = 0.72,
  padAngle = 1.5,
}: Props) {
  const total = data.reduce((acc, d) => acc + d.value, 0);

  // Layer custom para el texto del centro (técnica recomendada por Nivo).
  const CenterLayer = ({ centerX, centerY }: { centerX: number; centerY: number }) => {
    if (!centervalue && !centerSub) return null;
    return (
      <g>
        {centervalue && (
          <text
            x={centerX}
            y={centerY - (centerSub ? 7 : 0)}
            textAnchor="middle"
            dominantBaseline="central"
            className={centerValueClass}
            style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em' }}
            fill="currentColor"
          >
            {centervalue}
          </text>
        )}
        {centerSub && (
          <text
            x={centerX}
            y={centerY + 13}
            textAnchor="middle"
            dominantBaseline="central"
            style={{ fontSize: 11 }}
            fill="#64748b"
          >
            {centerSub}
          </text>
        )}
      </g>
    );
  };

  return (
    <ResponsivePie
      data={data}
      theme={nivoDarkTheme}
      colors={{ datum: 'data.color' }}
      innerRadius={innerRadius}
      padAngle={padAngle}
      cornerRadius={3}
      activeOuterRadiusOffset={6}
      borderWidth={0}
      enableArcLabels={false}
      enableArcLinkLabels={false}
      animate
      motionConfig="gentle"
      layers={['arcs', CenterLayer]}
      margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
      tooltip={({ datum }) => (
        <GlassTooltip
          rows={[
            {
              color: datum.color,
              label: datum.label as string,
              value: `${datum.value}${total > 0 ? `  (${Math.round((datum.value / total) * 100)}%)` : ''}`,
            },
          ]}
        />
      )}
    />
  );
}
