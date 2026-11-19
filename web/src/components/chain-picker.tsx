"use client";

import { useId } from "react";
import { chainName } from "@/lib/chains";

/** One choice, so native radio buttons drawn as a single ruled control: arrow keys and forms work for free. */
export function ChainPicker({
  chains,
  value,
  onChange,
  label,
}: {
  chains: readonly number[];
  value: number;
  onChange: (id: number) => void;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="chains m-0 min-w-0 p-0">
      <legend className="t-label float-left mb-2 w-full p-0">{label}</legend>
      <div className="chains-row">
        {chains.map((id) => (
          <label key={id} className="chain-option">
            <input
              type="radio"
              name={name}
              value={id}
              checked={id === value}
              onChange={() => onChange(id)}
              className="sr-only"
            />
            <span>{chainName(id)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
