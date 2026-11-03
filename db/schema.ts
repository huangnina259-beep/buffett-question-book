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
