import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Only a hash of the bearer cookie is stored. Questions and feedback belong to
// one anonymous browser session; there is no public record-listing endpoint.
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  csrfToken: text("csrf_token").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("sessions_expiry_idx").on(table.expiresAt)]);

export const answers = sqliteTable("answers", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  kind: text("kind").notNull(),
  curatedSlug: text("curated_slug"),
  previousAnswerId: text("previous_answer_id"),
  contentVersion: text("content_version").notNull(),
  responseJson: text("response_json").notNull(),
  elapsedMs: integer("elapsed_ms").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("answers_session_idx").on(table.sessionId, table.createdAt)]);

export const feedback = sqliteTable("feedback", {
  answerId: text("answer_id").primaryKey().references(() => answers.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  helpful: integer("helpful", { mode: "boolean" }),
  reason: text("reason"),
  comment: text("comment").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("feedback_session_idx").on(table.sessionId)]);

// The primary key makes the limit increment atomic even across Worker instances.
export const requestWindows = sqliteTable("request_windows", {
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.scope, table.windowStart] })]);

// Permanent trial accounting. Reservations include failures and unknown usage;
// deleting an anonymous session must never replenish the global trial budget.
export const generationBudget = sqliteTable("generation_budget", {
  id: text("id").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  reservedMicroCny: integer("reserved_micro_cny").notNull().default(0),
  day: text("day").notNull(),
  dayAttempts: integer("day_attempts").notNull().default(0),
});
export const generationJobs = sqliteTable("generation_jobs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  responseJson: text("response_json"),
  // Private, bounded parsed diagnostics. Never included in response/history JSON.
  diagnosticsJson: text("diagnostics_json"),
  reservedMicroCny: integer("reserved_micro_cny").notNull().default(0),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  usageReported: integer("usage_reported", { mode: "boolean" }).notNull().default(false),
  failureCode: text("failure_code"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
}, (table) => [index("generation_jobs_session_idx").on(table.sessionId)]);
