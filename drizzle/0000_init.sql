CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"call_id" uuid,
	"designer_id" uuid,
	"slot_id" uuid,
	"start_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"error" text,
	"customer_confirmation_quote" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"designer_id" uuid,
	"calendly_event_uri" text NOT NULL,
	"calendly_invitee_uri" text,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"customer_timezone" text NOT NULL,
	"designer_timezone" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"cancel_url" text,
	"reschedule_url" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_transcripts" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"text" text,
	"redacted" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vaani_call_id" text NOT NULL,
	"enquiry_id" uuid,
	"contact_id" uuid,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"from_number" text,
	"to_number" text,
	"agent_id" text,
	"state" text DEFAULT 'call_received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"end_reason" text,
	"after_hours" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"related_call_id" uuid,
	"summary" text,
	"vaani_cost_credits" numeric(12, 4),
	"post_processed_at" timestamp with time zone,
	"compliance_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text,
	"email" text,
	"name" text,
	"hubspot_contact_id" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"from_disposition" text NOT NULL,
	"to_disposition" text NOT NULL,
	"reason" text NOT NULL,
	"overridden_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"facts" jsonb NOT NULL,
	"disposition" text DEFAULT 'clarification_required' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"handoff_note" text,
	"assigned_designer_id" uuid,
	"overridden" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid,
	"call_id" uuid,
	"kind" text NOT NULL,
	"urgency" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"requested_response" text,
	"assigned_to_id" uuid,
	"dedupe_key" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"monthly_inr" numeric(12, 2) NOT NULL,
	"active_from" text NOT NULL,
	"active_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubspot_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"hubspot_contact_id" text,
	"hubspot_deal_id" text,
	"note_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"payload_hash" text,
	"synced_at" timestamp with time zone,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration" text NOT NULL,
	"direction" text NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text,
	"status" text NOT NULL,
	"http_status" integer,
	"error" text,
	"payload" jsonb,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"enquiry_id" uuid,
	"call_id" uuid,
	"escalation_id" uuid,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offered_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"call_id" uuid NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"designer_id" uuid NOT NULL,
	"event_type_uri" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"customer_timezone" text NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualification_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"result_id" uuid NOT NULL,
	"criterion" text NOT NULL,
	"status" text NOT NULL,
	"weight" integer NOT NULL,
	"points" integer NOT NULL,
	"evidence" text NOT NULL,
	"hard_exclusion" boolean DEFAULT false NOT NULL,
	"reason_code" text,
	"caveat" text
);
--> statement-breakpoint
CREATE TABLE "qualification_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"call_id" uuid,
	"version" integer NOT NULL,
	"disposition" text NOT NULL,
	"score" integer NOT NULL,
	"can_book" boolean DEFAULT false NOT NULL,
	"next_question" text,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts_snapshot" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"rules_version" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"calendly_event_type_uri" text,
	"handles" text[] DEFAULT ARRAY['residential','commercial']::text[] NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"routing_weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid,
	"action" text NOT NULL,
	"request_key" text NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"status" text DEFAULT 'running' NOT NULL,
	"duration_ms" integer,
	"error" text,
	"mode" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"metric" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit" text NOT NULL,
	"cost_inr" numeric(14, 4),
	"cost_basis" text NOT NULL,
	"call_id" uuid,
	"mode" text DEFAULT 'live' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_designer_id_team_members_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_slot_id_offered_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."offered_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_attempt_id_booking_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."booking_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_designer_id_team_members_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_overrides" ADD CONSTRAINT "decision_overrides_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_assigned_designer_id_team_members_id_fk" FOREIGN KEY ("assigned_designer_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_assigned_to_id_team_members_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubspot_syncs" ADD CONSTRAINT "hubspot_syncs_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_escalation_id_escalations_id_fk" FOREIGN KEY ("escalation_id") REFERENCES "public"."escalations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offered_slots" ADD CONSTRAINT "offered_slots_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offered_slots" ADD CONSTRAINT "offered_slots_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offered_slots" ADD CONSTRAINT "offered_slots_designer_id_team_members_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."team_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_criteria" ADD CONSTRAINT "qualification_criteria_result_id_qualification_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."qualification_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_results" ADD CONSTRAINT "qualification_results_enquiry_id_enquiries_id_fk" FOREIGN KEY ("enquiry_id") REFERENCES "public"."enquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_results" ADD CONSTRAINT "qualification_results_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_uq" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_attempts_idem_uq" ON "booking_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "booking_attempts_enquiry_idx" ON "booking_attempts" USING btree ("enquiry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_event_uq" ON "bookings" USING btree ("calendly_event_uri");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_attempt_uq" ON "bookings" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "call_events_call_idx" ON "call_events" USING btree ("call_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_vaani_call_mode_uq" ON "calls" USING btree ("vaani_call_id","mode");--> statement-breakpoint
CREATE INDEX "calls_received_idx" ON "calls" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "calls_enquiry_idx" ON "calls" USING btree ("enquiry_id");--> statement-breakpoint
CREATE INDEX "calls_from_idx" ON "calls" USING btree ("from_number","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_mode_uq" ON "contacts" USING btree ("phone_e164","mode");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "enquiries_contact_idx" ON "enquiries" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "enquiries_disposition_idx" ON "enquiries" USING btree ("disposition","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_dedupe_uq" ON "escalations" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "escalations_status_idx" ON "escalations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hubspot_syncs_enquiry_uq" ON "hubspot_syncs" USING btree ("enquiry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_events_dedupe_uq" ON "integration_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "integration_events_integration_idx" ON "integration_events" USING btree ("integration","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_idem_uq" ON "notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "offered_slots_token_uq" ON "offered_slots" USING btree ("token");--> statement-breakpoint
CREATE INDEX "offered_slots_call_idx" ON "offered_slots" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_idem_uq" ON "outbox_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qual_criteria_uq" ON "qualification_criteria" USING btree ("result_id","criterion");--> statement-breakpoint
CREATE UNIQUE INDEX "qual_enquiry_version_uq" ON "qualification_results" USING btree ("enquiry_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_email_uq" ON "team_members" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_invocations_key_uq" ON "tool_invocations" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "tool_invocations_call_idx" ON "tool_invocations" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_dedupe_uq" ON "usage_records" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "usage_provider_idx" ON "usage_records" USING btree ("provider","occurred_at");