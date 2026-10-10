ALTER TABLE "calls" ADD COLUMN "call_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_call_ref_uq" ON "calls" USING btree ("call_ref");