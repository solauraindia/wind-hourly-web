/** One cell per day of the quarter, shaded by the share of hours present. */
export function CoverageStrip({ coverage, start, mwh }: { coverage: number[]; start: number; mwh?: number[] }) {
  return (
    <div className="flex h-4 items-stretch gap-px" aria-label="Daily hour coverage">
      {coverage.map((c, i) => {
        const d = new Date(start + i * 86_400_000);
        const label = `${d.toISOString().slice(0, 10)} · ${Math.round(c * 24)}/24 h${mwh ? ` · ${mwh[i].toFixed(2)} MWh` : ""}`;
        const color = c >= 1 ? "bg-accent/80" : c >= 0.75 ? "bg-accent/35" : c > 0 ? "bg-warn/60" : "bg-danger/45";
        return <span key={i} title={label} className={`w-[2px] rounded-[1px] ${color}`} />;
      })}
    </div>
  );
}
