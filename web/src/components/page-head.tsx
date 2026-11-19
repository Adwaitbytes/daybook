import type { ReactNode } from "react";

export function PageHead({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="wrap flex flex-col gap-6 pb-8 pt-10 md:flex-row md:items-end md:justify-between md:pb-10 md:pt-16">
      <div className="max-w-[40em]">
        <h1 className="t-section m-0">{title}</h1>
        {children === undefined ? null : <div className="mt-3 text-[17px] leading-7 text-ink-2">{children}</div>}
      </div>
      {aside === undefined ? null : <div className="no-print flex shrink-0 flex-wrap gap-3">{aside}</div>}
    </div>
  );
}
