import Link from "next/link";
import { EmptyRecord } from "@/components/states";

export default function NotFound() {
  return (
    <div className="wrap max-w-[760px] pt-12">
      <EmptyRecord
        title="No page at this address"
        action={
          <Link className="btn" href="/">
            Go to Daybook
          </Link>
        }
      >
        <p className="m-0">The link may be mistyped. Invoice links look like /pay/12.</p>
      </EmptyRecord>
    </div>
  );
}
