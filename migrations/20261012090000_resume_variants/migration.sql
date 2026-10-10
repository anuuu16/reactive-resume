ALTER TABLE "resume" ADD COLUMN "base_resume_id" text;--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "base_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "base_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resume" ADD CONSTRAINT "resume_base_resume_id_resume_id_fkey" FOREIGN KEY ("base_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "resume_base_resume_id_index" ON "resume" ("base_resume_id");
