import { ResponsiveBar } from '@nivo/bar';
import { GlassTooltip } from './ChartTooltip';
import { colorFor, nivoDarkTheme } from './chartTheme';

interface Props {
  /** Filas: { [indexBy]: string, [key]: number, ... } */
  data: Array<Record<string, string | number>>;
  /** Eje X / categoría. */
  indexBy: string;
  /** Series apiladas. */
  keys: string[];
  /** Resolver color por key. Default: paleta semántica. */
  colorByKey?: (key: string) => string;
}

export function StackedBarChart({ data, indexBy, keys, colorByKey = colorFor }: Props) {
  return (
    <ResponsiveBar
      data={data}
      theme={nivoDarkTheme}
      keys={keys}
      indexBy={indexBy}
      groupMode="stacked"
      margin={{ top: 10, right: 16, bottom: 48, left: 36 }}
      padding={0.32}
      colors={(bar) => colorByKey(bar.id as string)}
      borderRadius={2}
      enableLabel={false}
      enableGridX={false}
      enableGridY
      axisBottom={{ tickSize: 0, tickPadding: 8 }}
      axisLeft={{ tickSize: 0, tickPadding: 6 }}
      animate
      motionConfig="gentle"
      legends={[
        {
          dataFrom: 'keys',
          anchor: 'bottom',
          direction: 'row',
          translateY: 44,
          itemsSpacing: 8,
          itemWidth: 86,
          itemHeight: 16,
          symbolSize: 8,
          symbolShape: 'circle',
          itemTextColor: '#cbd5e1',
        },
      ]}
      tooltip={({ id, value, indexValue, color }) => (
        <GlassTooltip
          title={String(indexValue)}
          rows={[{ color, label: String(id), value }]}
        />
      )}
    />
  );
}
