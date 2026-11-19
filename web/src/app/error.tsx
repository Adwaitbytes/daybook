"use client";

import { EmptyRecord } from "@/components/states";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="wrap max-w-[760px] pt-12">
      <EmptyRecord
        title="This page failed to load"
        action={
          <button type="button" className="btn" onClick={reset}>
            Try again
          </button>
        }
      >
        <p className="m-0">
          Something went wrong while reading chain data. Nothing on chain was changed. Try again in a moment.
        </p>
      </EmptyRecord>
    </div>
  );
}
