import type { Database } from "@atlas/database";
import {
  AI_PROMPT_VERSION,
  AI_SCHEMA_VERSION,
  type AiDecision,
  type AiTask,
} from "@atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { mapTrelloCardState, WorkerRepository, type TrelloRuntimeConfig } from "../src/repository.js";

const config: TrelloRuntimeConfig = {
  apiKey: "key",
  token: "token",
  boardId: "board-1",
  boardConfigId: "config-1",
  connectionId: "connection-1",
  listRoles: {
    inbox: "list-inbox",
    inProgress: "list-progress",
    paused: "list-paused",
    done: "list-done",
  },
};

const task: AiTask = {
  clientRef: "task-1",
  operation: "complete",
  authorization: "confirmed_proposal",
  authorizationMessageId: "message-1",
  canonicalTaskId: null,
  candidateCardId: "card-1",
  mergeSourceCardIds: [],
  title: "Concluir contrato",
  description: "Contrato finalizado",
  priority: "high",
  targetListRole: "done",
  nextAction: null,
  waitingOn: null,
  risk: "low",
  checklist: [],
  dueAt: null,
  dueBasis: "none",
  labels: [],
  labelsToRemove: [],
  memberIdsToAdd: [],
  memberIdsToRemove: [],
  project: null,
  person: null,
  estimateMinutes: null,
  recurrence: null,
  confidence: 0.95,
  evidenceMessageIds: ["message-1"],
  missingInformation: [],
};

function decision(overrides: Partial<AiDecision> = {}): AiDecision {
  return {
    schemaVersion: AI_SCHEMA_VERSION,
    promptVersion: AI_PROMPT_VERSION,
    conversationIntent: "informational",
    tasks: [], reminders: [], commitments: [], learnings: [], actionProposals: [], memories: [],
    reply: { needed: false, recipientName: null, recipientJid: null, objective: "none", draft: null, tone: null, confidence: 1 },
    conversationSummary: "Sem alterações.",
    briefReason: "Nenhuma ação.",
    ...overrides,
  };
}

describe("WorkerRepository reliability", () => {
  it("loads a completed external result so downstream effects can be replayed", async () => {
    const response = {
      cardId: "card-1",
      cardUrl: "https://trello.com/c/card-1",
      operation: "create" as const,
    };
    const query = vi.fn(async () => ({ rows: [{ response_body: response }], rowCount: 1 }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await expect(repository.getCompletedExecution("user-1", "execution-1")).resolves.toEqual(response);
  });

  it("does not overwrite a succeeded AI run when a downstream effect fails", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await repository.failAiRun("user-1", "run-1", new Error("outbox unavailable"));
    expect(String(query.mock.calls[0]?.[0])).toContain("status = 'running'");
  });

  it("persists completed Trello tasks as due-complete without archiving them", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await repository.recordTrelloCard(
      "user-1",
      config,
      task,
      "card-1",
      "https://trello.com/c/card-1",
    );
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(parameters[11]).toBe(true);
    expect(parameters[12]).toBe(false);
  });

  it("marks cards in the mapped done list as completed during synchronization", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = {
      query,
      userTransaction: async (_userId: string, callback: (client: { query: typeof query }) => Promise<void>) =>
        callback({ query }),
    } as unknown as Database;
    const repository = new WorkerRepository(database);
    await repository.replaceTrelloCardSnapshot(
      "user-1",
      config,
      [
        {
          id: "card-1",
          name: "Contrato",
          desc: "Finalizado",
          idList: "list-done",
          due: null,
          closed: false,
          url: "https://trello.com/c/card-1",
        },
      ],
      [{ id: "list-done", name: "Concluído", closed: false }],
    );
    const insertCall = query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO trello_cards"));
    const insertParameters = insertCall?.[1] as unknown[];
    expect(insertParameters[11]).toBe(true);
    expect(insertParameters[12]).toBe(false);
  });

  it("maps Trello completion and archive states without conflating cancel with done", () => {
    expect(mapTrelloCardState({ idList: "list-inbox", dueComplete: true, closed: false }, config.listRoles).canonicalStatus).toBe("done");
    expect(mapTrelloCardState({ idList: "list-done", dueComplete: false, closed: false }, config.listRoles).canonicalStatus).toBe("done");
    expect(mapTrelloCardState({ idList: "list-inbox", dueComplete: false, closed: true }, config.listRoles).canonicalStatus).toBe("cancelled");
  });

  it("marks a simultaneous external Trello edit as conflict without touching canonical content", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = {
      query,
      userTransaction: async (_userId: string, callback: (client: { query: typeof query }) => Promise<void>) => callback({ query }),
    } as unknown as Database;
    const repository = new WorkerRepository(database);
    await repository.replaceTrelloCardSnapshot("user-1", config, [{
      id: "card-1", name: "Título externo", desc: "Manual externo", idList: "list-inbox",
      due: null, closed: false, url: "https://trello.com/c/card-1",
      dateLastActivity: "2026-07-13T18:00:00.000Z",
    }], [{ id: "list-inbox", name: "Entrada", closed: false }]);
    const conflictSql = String(query.mock.calls.find((call) => String(call[0]).includes("simultaneous_external_edit"))?.[0]);
    expect(conflictSql).toContain("link.sync_status='pending'");
    expect(conflictSql).toContain("simultaneous_external_edit");
    expect(conflictSql).toContain("trello_sync_conflict");
    expect(conflictSql).not.toContain("UPDATE canonical_tasks");
    expect(query.mock.calls.some((call) => String(call[0]).includes("link.sync_status='synced'"))).toBe(true);
  });

  it("imports non-conflicting human Trello fields into the canonical task without replacing manual description", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = {
      query,
      userTransaction: async (_userId: string, callback: (client: { query: typeof query }) => Promise<void>) => callback({ query }),
    } as unknown as Database;
    const repository = new WorkerRepository(database);
    await repository.replaceTrelloCardSnapshot("user-1", config, [{
      id: "card-1", name: "Título humano", desc: "Descrição manual preservada", idList: "list-progress",
      due: "2026-07-15T15:00:00.000Z", dueComplete: false, closed: false,
      url: "https://trello.com/c/card-1", dateLastActivity: "2026-07-13T19:00:00.000Z",
      idMembers: ["member-1"], labels: [{ id: "label-1", name: "Cliente", color: "blue" }],
    }], [{ id: "list-progress", name: "Em andamento", closed: false }], [{ id: "member-1", username: "maria", fullName: "Maria" }]);
    const importCall = query.mock.calls.find((call) => String(call[0]).includes("trello_external_change_imported"));
    const importSql = String(importCall?.[0]);
    expect(importSql).toContain("link.sync_status='synced'");
    expect(importSql).toContain("trello_external_sync");
    expect(importSql).toContain("assistant_action_outcomes");
    expect(importSql).toContain("'trelloLabels'");
    expect(importSql).toContain("'trelloMemberIds'");
    expect(importSql).not.toContain("description=$");
    expect((importCall?.[1] as unknown[])[8]).toBe("in_progress");
    const snapshotInsert = query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO trello_cards"));
    expect(JSON.parse(String((snapshotInsert?.[1] as unknown[])[13]))).toEqual([{ id: "label-1", name: "Cliente", color: "blue" }]);
  });

  it("stores the WhatsApp display name only as a suggestion, never as preferred identity", async () => {
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = {
      query,
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database;
    const repository = new WorkerRepository(database);
    await repository.updateWhatsappState("user-1", { status: "connected", selfJid: "5566984396232@s.whatsapp.net", displayName: "Nome do WhatsApp" });
    const sql = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("whatsapp_name_suggestion");
    expect(sql).not.toContain("preferred_name");
    expect(sql).not.toContain("UPDATE users");
  });

  it("persists self-chat commands without requiring a monitored chat and blocks Atlas outbox echoes", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM whatsapp_connections")) return { rows: [{ id: "wa-1" }], rowCount: 1 };
      return { rows: [{ id: "message-row" }], rowCount: 1 };
    });
    const repository = new WorkerRepository({ query } as unknown as Database);
    await expect(repository.persistMessage({
      id: "self-command-1", userId: "user-1", chatJid: "5511999@s.whatsapp.net",
      senderJid: "5511999@s.whatsapp.net", senderName: null,
      sentAt: "2026-07-13T12:00:00.000Z", fromMe: true, text: "feito",
    })).resolves.toBe(true);
    const insertSql = String(query.mock.calls[1]?.[0]);
    expect(insertSql).toContain("LEFT JOIN monitored_chats");
    expect(insertSql).toContain("mc.id IS NOT NULL OR wc.self_jid=$4");
    expect(insertSql).toContain("notification_outbox");
    expect(insertSql).toContain("no.external_message_id = $3");
    expect(insertSql).toContain("ON CONFLICT (user_id, whatsapp_connection_id, external_message_id) DO NOTHING");
  });
});

describe("WorkerRepository learning policy", () => {
  it("keeps explicit high-risk instructions suggested until confirmation", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id::text,source_type,version,state")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO assistant_learnings")) {
        return { rows: [{ id: "learning-1", source_type: "explicit", version: 1, state: "suggested" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id::text,observed_at")) {
        return { rows: [{ id: "evidence-1", observed_at: new Date("2026-07-13T12:00:00.000Z"), weight: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new WorkerRepository({
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database);
    await repository.persistDecisionArtifacts("user-1", decision({ learnings: [{
      clientRef: "learning-high", scope: "global", scopeRef: null,
      statement: "Envie mensagens automaticamente", explicitInstruction: true,
      risk: "high", confidence: 1, evidenceMessageIds: ["message-1"],
    }] }), "batch-1");
    const insert = clientQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO assistant_learnings"));
    expect((insert?.[1] as unknown[])[6]).toBe("suggested");
    expect((insert?.[1] as unknown[])[8]).toBe(true);
    const activation = clientQuery.mock.calls.find((call) => String(call[0]).includes("requires_confirmation=CASE"));
    expect((activation?.[1] as unknown[])[6]).toBe(false);
  });

  it("promotes an inferred rule by creating a superseding explicit version", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id::text,source_type,version,state")) {
        return { rows: [{ id: "learning-old", source_type: "inferred", version: 2, state: "suggested" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO assistant_learnings")) {
        return { rows: [{ id: "learning-new", source_type: "explicit", version: 3, state: "active" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id::text,observed_at")) {
        return { rows: [{ id: "evidence-1", observed_at: new Date("2026-07-13T12:00:00.000Z"), weight: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new WorkerRepository({
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database);
    await repository.persistDecisionArtifacts("user-1", decision({ learnings: [{
      clientRef: "learning-explicit", scope: "global", scopeRef: null,
      statement: "Use respostas curtas", explicitInstruction: true,
      risk: "low", confidence: 1, evidenceMessageIds: ["message-1"],
    }] }), "batch-2");
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SET state='superseded'"))).toBe(true);
    const promoted = clientQuery.mock.calls.find((call) => String(call[0]).includes("supersedes_learning_id"));
    expect((promoted?.[1] as unknown[])[1]).toBe("learning-old");
    expect((promoted?.[1] as unknown[])[9]).toBe(3);
    expect((promoted?.[1] as unknown[])[6]).toBe("active");
    expect((promoted?.[1] as unknown[])[8]).toBe(false);
  });

  it("never exposes active learnings that still require confirmation", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await repository.buildContext("user-1", "chat-1", []);
    const learningSelect = query.mock.calls.find((call) => {
      const sql = String(call[0]);
      return sql.includes("SELECT id::text, scope_type") && sql.includes("FROM assistant_learnings");
    });
    expect(String(learningSelect?.[0])).toContain("requires_confirmation=false");
  });

  it("loads person and project learnings only from tenant-scoped relevant candidates", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM brain_nodes") && sql.includes("search_vector")) {
        return { rows: [
          { type: "person", title: "Maria", content: "Cliente", aliases: [], tags: [] },
          { type: "project", title: "Projeto Sol", content: "Projeto", aliases: [], tags: [] },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM trello_cards tc")) {
        return { rows: [{ trello_card_id: "card-1", canonical_task_id: "task-1", title: "Ligar para Maria", description: "", list_name: "Entrada", due_at: null, url: null }], rowCount: 1 };
      }
      if (sql.includes("FROM canonical_tasks") && sql.includes("project_node_id::text")) {
        return { rows: [{ project_node_id: "project-node-1", person_node_id: "person-node-1", project_name: "Projeto Sol", person_name: "Maria" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id::text, scope_type")) {
        return { rows: [
          { id: "learning-person", scope_type: "person", scope_id: "Maria", statement: "Maria prefere áudio", confidence: 1, source_type: "explicit" },
          { id: "learning-project", scope_type: "project", scope_id: "project-node-1", statement: "Priorizar Projeto Sol", confidence: 1, source_type: "explicit" },
        ], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    const repository = new WorkerRepository({ query } as unknown as Database);
    const context = await repository.buildContext("user-1", "chat-1", [{
      id: "message-1", userId: "user-1", chatJid: "chat-1", senderJid: "contact-1",
      senderName: "Maria", sentAt: "2026-07-13T12:00:00.000Z", fromMe: false, text: "Projeto Sol",
    }]);
    expect(context.activeLearnings.map((item) => item.id)).toEqual(["learning-person", "learning-project"]);
    const learningSelect = query.mock.calls.find((call) => String(call[0]).includes("SELECT id::text, scope_type"));
    expect(String(learningSelect?.[0])).toContain("scope_type = 'person'");
    expect(String(learningSelect?.[0])).toContain("scope_type = 'project'");
    expect(learningSelect?.[1]).toEqual([
      "user-1", "chat-1", ["person-node-1", "Maria"], ["project-node-1", "Projeto Sol"],
    ]);
  });

  it("auto-confirms only a reversible proposal covered by the same tenant's always rule", async () => {
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      const userId = params?.[0];
      if (sql.includes("SELECT id::text FROM assistant_learnings")) {
        return { rows: userId === "user-1" ? [{ id: "always-1" }] : [], rowCount: userId === "user-1" ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO action_proposals")) {
        return { rows: [{ id: `proposal-${userId}`, status: params?.[3] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new WorkerRepository({
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database);
    const proposalDecision = decision({ actionProposals: [{
      clientRef: "complete-1", kind: "complete_task", title: "Concluir tarefa",
      targetIds: [], reversible: true, evidenceMessageIds: ["message-1"], confidence: 1,
    }] });
    await repository.persistDecisionArtifacts("user-1", proposalDecision, "batch-user-1");
    await repository.persistDecisionArtifacts("user-2", proposalDecision, "batch-user-2");
    const proposalInserts = clientQuery.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO action_proposals"));
    expect((proposalInserts[0]?.[1] as unknown[])[3]).toBe("confirmed");
    expect((proposalInserts[1]?.[1] as unknown[])[3]).toBe("pending");
    const jobs = clientQuery.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO job_attempts"));
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.[1] as unknown[])[0]).toBe("user-1");
    const ruleQuery = clientQuery.mock.calls.find((call) => String(call[0]).includes("learning_key=$2"));
    expect((ruleQuery?.[1] as unknown[])[1]).toBe("proposal:complete_task:always");
  });

  it("never applies an always rule to profile changes", async () => {
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO action_proposals")) return { rows: [{ id: "proposal-profile", status: params?.[3] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const repository = new WorkerRepository({
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database);
    await repository.persistDecisionArtifacts("user-1", decision({ actionProposals: [{
      clientRef: "profile-1", kind: "profile_change", title: "Trocar fuso",
      targetIds: [], reversible: true, evidenceMessageIds: ["message-1"], confidence: 1,
    }] }), "batch-profile");
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SELECT id::text FROM assistant_learnings"))).toBe(false);
    const insert = clientQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO action_proposals"));
    expect((insert?.[1] as unknown[])[3]).toBe("pending");
    expect((insert?.[1] as unknown[])[4]).toBe("high");
  });
});

describe("WorkerRepository control and automation contracts", () => {
  it("dispatches a chat task_mutation 'mescle' proposal as a two-card merge", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE action_proposals SET status='executing'")) {
        return { rows: [{
          proposal_type: "task_mutation",
          proposed_payload: { requestedAction: "mescle" },
          edited_payload: { targetIds: ["task-1", "task-2"] },
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT task.id::text AS id FROM canonical_tasks")) {
        return { rows: [{ id: params?.[1] }], rowCount: 1 };
      }
      if (sql.includes("SELECT t.id::text,t.title")) {
        const id = String(params?.[1]);
        return { rows: [{
          id, title: id === "task-1" ? "Destino" : "Origem", description: "",
          status: "open", priority: "medium", risk: "low", next_action: null,
          due_at: null, estimated_minutes: null, recurrence: null, expected_owner: null,
          confidence: 1, metadata: {}, trello_card_id: id === "task-1" ? "card-target" : "card-source",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const repository = new WorkerRepository({ query } as unknown as Database);
    const dispatch = await repository.dispatchConfirmedProposal("user-1", "proposal-1");
    expect(dispatch).toMatchObject({
      kind: "trello",
      prepared: {
        task: {
          operation: "merge",
          canonicalTaskId: "task-1",
          candidateCardId: "card-target",
          mergeSourceCardIds: ["card-source"],
          authorization: "confirmed_proposal",
        },
        allowedCandidateCardIds: ["card-target", "card-source"],
      },
    });
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='edited'"))).toBe(false);
  });

  it("claims reminder occurrences only for connected users and keeps the lease tenant-safe", async () => {
    const clientQuery = vi.fn(async (sql: string) => ({
      rows: sql.includes("WITH due AS") ? [{ id: "occ-1", user_id: "user-1", title: "Enviar contrato" }] : [],
      rowCount: 1,
    }));
    const transaction = vi.fn(async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) => callback({ query: clientQuery }));
    const repository = new WorkerRepository({ transaction } as unknown as Database);
    await expect(repository.claimDueReminderOccurrences("worker-1")).resolves.toEqual([{ id: "occ-1", userId: "user-1", title: "Enviar contrato" }]);
    const quietSql = String(clientQuery.mock.calls[0]?.[0]);
    const claimSql = String(clientQuery.mock.calls[1]?.[0]);
    expect(quietSql).toContain("r.respect_quiet_hours=true");
    expect(quietSql).toContain("us.quiet_start");
    expect(quietSql).toContain("us.quiet_end");
    expect(claimSql).toContain("wc.status='connected'");
    expect(claimSql).toContain("notifySelf");
    expect(claimSql).toContain("FOR UPDATE OF ro SKIP LOCKED");
  });

  it("materializes one next recurring occurrence and remains idempotent on replay", async () => {
    let occurrenceUpdated = false;
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE notification_outbox")) return { rows: occurrenceUpdated ? [] : [{ user_id: "user-1" }], rowCount: occurrenceUpdated ? 0 : 1 };
      if (sql.includes("UPDATE reminder_occurrences") && sql.includes("RETURNING")) {
        if (occurrenceUpdated) return { rows: [], rowCount: 0 };
        occurrenceUpdated = true;
        return { rows: [{ user_id: "user-1", reminder_id: "reminder-1", scheduled_at: new Date("2026-07-13T12:00:00Z") }], rowCount: 1 };
      }
      if (sql.includes("SELECT r.recurrence")) return { rows: [{ recurrence: { intervalMinutes: 60 }, timezone: "America/Sao_Paulo" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const transaction = vi.fn(async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) => callback({ query: clientQuery }));
    const repository = new WorkerRepository({ query, transaction } as unknown as Database);
    await repository.markOutboxSent(1, "wa-1", "lease-1");
    await repository.markOutboxSent(1, "wa-1", "lease-1");
    const inserts = clientQuery.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO reminder_occurrences"));
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.[1] as unknown[])[2]).toEqual(new Date("2026-07-13T13:00:00Z"));
    expect(String(inserts[0]?.[0])).toContain("ON CONFLICT (user_id,reminder_id,scheduled_at)");
  });

  it("cancels older occurrences before snoozing a reminder", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("SELECT id::text,title FROM reminders") ? [{ id: "reminder-1", title: "Contrato" }] : [],
      rowCount: 1,
    }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await repository.handleSelfCommand("user-1", { kind: "snooze", raw: "adiar 1h", reference: null, durationMinutes: 60, localTime: null }, "message-1");
    const scheduleSql = String(query.mock.calls[1]?.[0]);
    expect(scheduleSql).toContain("status IN ('pending','failed','snoozed')");
    expect(scheduleSql).toContain("status='cancelled'");
    expect(scheduleSql).toContain("ON CONFLICT (user_id,reminder_id,scheduled_at) DO UPDATE");
  });

  it("claims an outbox atomically and only reclaims an expired sending lease", async () => {
    let claimed = false;
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows: [{ id: "1", user_id: "user-1", subject: "Atlas", body: "Resumo", payload: { kind: "brief" } }], rowCount: 1 };
    });
    const repository = new WorkerRepository({ query } as unknown as Database);
    const first = await repository.getOutbox(1);
    const concurrent = await repository.getOutbox(1);
    expect(first?.lockToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(concurrent).toBeNull();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("status IN ('pending','failed')");
    expect(sql).toContain("status='sending' AND locked_at<now()-interval '10 minutes'");
    expect(sql).toContain("locked_by=$2");
    expect(sql).toContain("attempt_count<max_attempts");
    expect((query.mock.calls[0]?.[1] as unknown[])[0]).toBe(1);
    expect((query.mock.calls[0]?.[1] as unknown[])[1]).toBe(first?.lockToken);
  });

  it("handles daytime and overnight quiet windows when creating due reminders", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({
      query,
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
    } as unknown as Database);
    await repository.recordCanonicalTaskExecution("user-1", "task-1", {
      ...task, operation: "patch", dueAt: "2026-07-15T15:00:00.000Z", dueBasis: "explicit",
    }, "card-1", "execution-due", "node-1");
    const quietSql = String(query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO reminder_occurrences"))?.[0]);
    expect(quietSql).toContain("quiet_start < quiet_end");
    expect(quietSql).toContain("local_at::time >= quiet_start AND local_at::time < quiet_end");
    expect(quietSql).toContain("quiet_start > quiet_end AND local_at::time >= quiet_start");
    expect(quietSql).toContain("quiet_start > quiet_end AND local_at::time < quiet_end");
    expect(quietSql).toContain("ELSE scheduled_for");
  });

  it("claims due queued or retrying jobs and expired running leases with a locked default limit", async () => {
    const clientQuery = vi.fn(async () => ({
      rows: [
        {
          id: "job-1",
          user_id: "user-1",
          job_type: "automation:message_ingestion",
          attempt: 2,
          input: { automationId: "automation-1" },
        },
      ],
      rowCount: 1,
    }));
    const transaction = vi.fn(async (callback: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
      callback({ query: clientQuery }),
    );
    const repository = new WorkerRepository({ transaction } as unknown as Database);

    await expect(repository.claimControlJobs("worker-1")).resolves.toEqual([
      {
        id: "job-1",
        userId: "user-1",
        jobType: "automation:message_ingestion",
        attempt: 2,
        input: { automationId: "automation-1" },
      },
    ]);

    const sql = String(clientQuery.mock.calls[0]?.[0]);
    expect(sql).toContain("status IN ('queued','retrying')");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("interval '10 minutes'");
    expect(sql).toContain("task:sync_trello");
    expect(sql).toContain("action_proposal:execute");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(clientQuery.mock.calls[0]?.[1]).toEqual(["worker-1", 1]);
  });

  it("only completes or fails a running control job owned by the same worker", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({ query } as unknown as Database);

    await expect(
      repository.completeControlJob("job-1", "user-1", "worker-1", { handled: true }),
    ).resolves.toBe(true);
    await expect(
      repository.failControlJob("job-2", "user-1", "worker-2", 2, new Error("temporary")),
    ).resolves.toBe(true);

    const completionSql = String(query.mock.calls[0]?.[0]);
    expect(completionSql).toContain("status='running'");
    expect(completionSql).toContain("worker_id=$4");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "job-1",
      "user-1",
      { handled: true },
      "worker-1",
    ]);

    const failureSql = String(query.mock.calls[1]?.[0]);
    expect(failureSql).toContain("status='running'");
    expect(failureSql).toContain("worker_id=$3");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "job-2",
      "user-1",
      "worker-2",
      "retrying",
      "temporary",
    ]);
  });

  it("finds briefing recipients only through an active reminder automation with self notification enabled", async () => {
    const query = vi.fn(async () => ({
      rows: [{ user_id: "user-1", reminder_time: "08:00" }],
      rowCount: 1,
    }));
    const repository = new WorkerRepository({ query } as unknown as Database);

    await expect(repository.findDueBriefUsers()).resolves.toEqual([
      { userId: "user-1", time: "08:00" },
    ]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("a.kind = 'pending_reminder'");
    expect(sql).toContain("a.enabled = true");
    expect(sql).toContain("wc.self_jid IS NOT NULL");
    expect(sql).toContain("registered_whatsapp ON true");
    expect(sql).toContain("platform_whatsapp_connection");
    expect(sql).toContain("pw.status='connected'");
    expect(sql).toContain("feature_flags->>'notifySelf'");
    expect(sql).toContain("= true");
  });

  it("recovers messages only when message ingestion is active for the owning user", async () => {
    const sentAt = new Date("2026-07-13T12:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [
        {
          external_message_id: "message-1",
          user_id: "user-1",
          chat_jid: "5511999999999@s.whatsapp.net",
          sender_jid: "5511888888888@s.whatsapp.net",
          display_name: "Cliente",
          sent_at: sentAt,
          from_me: false,
          body: "Enviar o contrato hoje",
        },
      ],
      rowCount: 1,
    }));
    const repository = new WorkerRepository({ query } as unknown as Database);

    const messages = await repository.loadRecoverableMessages("user-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "message-1", userId: "user-1" });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("a.user_id = wm.user_id");
    expect(sql).toContain("a.kind = 'message_ingestion'");
    expect(sql).toContain("a.enabled = true");
    expect(query.mock.calls[0]?.[1]).toEqual(["user-1"]);
  });

  it("persists completed task nodes as done with their evidence message ids", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("RETURNING id") ? [{ id: "node-1" }] : [],
      rowCount: 1,
    }));
    const repository = new WorkerRepository({ query } as unknown as Database);

    await expect(repository.upsertTaskNode(
      "user-1",
      task,
      "card-1",
      "https://trello.com/c/card-1",
    )).resolves.toBe("node-1");

    const sql = String(query.mock.calls[0]?.[0]);
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain("status = EXCLUDED.status");
    expect(parameters[3]).toBe("done");
    expect(JSON.parse(String(parameters[7]))).toMatchObject({
      cardId: "card-1",
      sourceMessageIds: ["message-1"],
    });
  });

  it("links the canonical task to the returned brain node during Trello finalization", async () => {
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const database = {
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as Database;
    const repository = new WorkerRepository(database);
    await repository.recordCanonicalTaskExecution("user-1", "task-1", task, "card-1", "execution-1", "node-1");
    const update = clientQuery.mock.calls.find((call) => String(call[0]).includes("UPDATE canonical_tasks SET"));
    expect(String(update?.[0])).toContain("brain_node_id=COALESCE(brain_node_id,$15::uuid)");
    expect((update?.[1] as unknown[])[14]).toBe("node-1");
  });

  it("links reminders from the same AI batch to their canonical task tenant-safely", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({ query } as unknown as Database);
    await expect(repository.linkBatchRemindersToTask("user-1", "batch-1", "task-ref-1", "task-1")).resolves.toBe(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("metadata->>'batchKey'=$2");
    expect(String(query.mock.calls[0]?.[0])).toContain("metadata->>'taskClientRef'=$3");
    expect(query.mock.calls[0]?.[1]).toEqual(["user-1", "batch-1", "task-ref-1", "task-1"]);
  });

  it("moves reminder and commitment ownership and archives source brain nodes during merge", async () => {
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const repository = new WorkerRepository({
      userTransaction: async (_userId: string, callback: (client: { query: typeof clientQuery }) => Promise<void>) => callback({ query: clientQuery }),
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as Database);
    await repository.recordCanonicalTaskExecution("user-1", "target-task", {
      ...task, operation: "merge", candidateCardId: "target-card", mergeSourceCardIds: ["source-card"],
    }, "target-card", "merge-execution", "target-node");
    const sql = clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("UPDATE reminders SET task_id=$2");
    expect(sql).toContain("UPDATE commitments SET task_id=$2");
    expect(sql).toContain("UPDATE brain_nodes node SET status='archived'");
    expect(sql).toContain("sync_status='detached'");
    expect(sql).toContain("status='merged'");
  });
});
