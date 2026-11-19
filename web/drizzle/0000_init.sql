CREATE SCHEMA IF NOT EXISTS "daybook";
--> statement-breakpoint
CREATE TABLE "daybook"."demo_rate" (
	"bucket" text NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "demo_rate_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
CREATE TABLE "daybook"."invoice_details" (
	"reactive" text NOT NULL,
	"invoice_id" bigint NOT NULL,
	"client_name" text NOT NULL,
	"notes" text,
	"pdf_name" text,
	"pdf_sha256" text,
	"details_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_details_reactive_invoice_id_pk" PRIMARY KEY("reactive","invoice_id")
);
--> statement-breakpoint
CREATE TABLE "daybook"."traced_callback" (
	"reactive" text NOT NULL,
	"seq" bigint NOT NULL,
	"chain_id" integer NOT NULL,
	"tx" text NOT NULL,
	"at_ms" bigint,
	"clock" text NOT NULL,
	"receipt_uid" text NOT NULL,
	"traced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traced_callback_reactive_seq_pk" PRIMARY KEY("reactive","seq")
);
