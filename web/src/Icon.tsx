const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  chart: "M4 4v16h16 M7 14l4-5 4 3 5-7",
  layers: "m12 3 9 5-9 5-9-5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-1L20 9 M4 15l2.3 3A7 7 0 0 0 18 17",
  clock: "M12 8v4l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  arrow: "M7 17 17 7 M7 7h10v10",
  check: "m5 12 4 4L19 6",
  alert: "M12 9v4 M12 17h.01 M10 4 2 18a1 1 0 0 0 1 2h18a1 1 0 0 0 1-2L14 4a2 2 0 0 0-4 0",
} as const

export function Icon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg className={`icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}
