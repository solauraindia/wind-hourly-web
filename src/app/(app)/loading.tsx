/** Shown at once on navigation while the page's data loads (every page here is rendered per request). */
export default function Loading() {
  const bar = "animate-pulse rounded-md bg-line/70";
  return (
    <div aria-busy="true" aria-label="Loading">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-4">
          <div className="space-y-2">
            <div className={`${bar} h-5 w-44`} />
            <div className={`${bar} h-3.5 w-96 max-w-[60vw]`} />
          </div>
          <div className={`${bar} ml-auto h-9 w-40 rounded-lg`} />
        </div>
      </header>
      <div className="mx-auto max-w-[1400px] space-y-6 px-6 py-6">
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card space-y-2.5 px-4 py-3.5">
              <div className={`${bar} h-3 w-24`} />
              <div className={`${bar} h-6 w-32`} />
              <div className={`${bar} h-3 w-20`} />
            </div>
          ))}
        </section>
        <section className="card overflow-hidden">
          <div className="border-b border-line px-5 py-4">
            <div className={`${bar} h-4 w-56`} />
          </div>
          <div className="divide-y divide-line">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-6 px-5 py-3.5">
                <div className={`${bar} h-4 w-40`} />
                <div className={`${bar} h-4 flex-1`} />
                <div className={`${bar} h-4 w-20`} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
