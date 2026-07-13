import { describe, expect, it, vi } from "vitest";

import type { AiTask } from "@atlas/shared";

import {
  buildTrelloAuthorizationUrl,
  DeterministicTrelloExecutor,
  replaceAtlasManagedBlock,
  TrelloClient,
} from "../src/index.js";

const task: AiTask = {
  clientRef: "task-1",
  operation: "create",
  authorization: "inferred",
  authorizationMessageId: null,
  canonicalTaskId: null,
  candidateCardId: null,
  mergeSourceCardIds: [],
  title: "Enviar orçamento",
  description: "Versão atualizada",
  priority: "high",
  targetListRole: "inbox",
  nextAction: "Revisar valores",
  waitingOn: null,
  risk: "medium",
  checklist: [{ text: "Conferir impostos", done: false }],
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
  confidence: 0.9,
  evidenceMessageIds: ["m1"],
  missingInformation: [],
};

describe("Trello integration", () => {
  it("replaces only the Atlas managed section and preserves manual content", () => {
    const existing = "Texto manual do usuário\n\n<!-- ATLAS:BEGIN -->\nversão antiga\n<!-- ATLAS:END -->\n\nAnotação manual final";
    const updated = replaceAtlasManagedBlock(existing, "<!-- ATLAS:BEGIN -->\nnovo\n<!-- ATLAS:END -->");
    expect(updated).toContain("Texto manual do usuário");
    expect(updated).toContain("Anotação manual final");
    expect(updated).not.toContain("versão antiga");
    expect(updated.match(/ATLAS:BEGIN/g)).toHaveLength(1);
  });
  it("builds delegated authorization for Atlas", () => {
    const url = new URL(
      buildTrelloAuthorizationUrl({
        apiKey: "key",
        returnUrl: "https://atlas.example/trello/callback",
        state: "state-token",
      }),
    );
    expect(url.hostname).toBe("trello.com");
    expect(url.searchParams.get("name")).toBe("Atlas");
    expect(url.searchParams.get("scope")).toBe("read,write");
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("executes a create deterministically in the mapped role", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.includes("/boards/")) {
        return Response.json([]);
      }
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/checklists")) {
        return Response.json([]);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname === "/1/cards") requestBody = body;
      return new Response(
        JSON.stringify({
          id: "card-1",
          name: task.title,
          desc: "",
          idList: "list-inbox",
          due: null,
          closed: false,
          url: "https://trello.com/c/card-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const executor = new DeterministicTrelloExecutor(
      new TrelloClient({ apiKey: "key", token: "token", fetchImpl }),
    );
    await executor.execute({
      task,
      idempotencyKey: "idem-1",
      boardId: "board-1",
      listRoles: {
        inbox: "list-inbox",
        inProgress: "list-progress",
        paused: "list-paused",
        done: "list-done",
      },
      allowedCandidateCardIds: new Set(),
      allowedMemberIds: new Set(),
    });
    expect(requestBody).toMatchObject({ idList: "list-inbox", name: task.title });
    expect(String(requestBody?.desc)).toContain("Atlas-ID: idem-1");
  });

  it("recovers a previously created card by Atlas-ID instead of creating a duplicate", async () => {
    let postCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname.includes("/boards/")) {
        return Response.json([
          {
            id: "card-recovered",
            name: task.title,
            desc: "conteúdo\n\n---\nAtlas-ID: idem-recovery",
            idList: "list-inbox",
            due: null,
            closed: false,
            url: "https://trello.com/c/card-recovered",
          },
        ]);
      }
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/checklists")) {
        return Response.json([{ id: "atlas-checklist", name: "Atlas", checkItems: [{ id: "item-1", name: "Conferir impostos", state: "incomplete" }] }]);
      }
      postCount += 1;
      return Response.json({}, { status: 500 });
    };
    const executor = new DeterministicTrelloExecutor(
      new TrelloClient({ apiKey: "key", token: "token", fetchImpl }),
    );
    await expect(
      executor.execute({
        task,
        idempotencyKey: "idem-recovery",
        boardId: "board-1",
        listRoles: {
          inbox: "list-inbox",
          inProgress: "list-progress",
          paused: "list-paused",
          done: "list-done",
        },
        allowedCandidateCardIds: new Set(),
        allowedMemberIds: new Set(),
      }),
    ).resolves.toEqual({
      cardId: "card-recovered",
      cardUrl: "https://trello.com/c/card-recovered",
      operation: "create",
    });
    expect(postCount).toBe(0);
  });

  it("reads legacy Nexo-ID markers but only writes Atlas-ID", async () => {
    const client = new TrelloClient({
      apiKey: "key",
      token: "token",
      fetchImpl: async () => Response.json([{ id: "legacy", name: "Antigo", desc: "Nexo-ID: old-key", idList: "in", due: null, closed: false, url: "https://trello/legacy" }]),
    });
    await expect(client.findCardByAtlasId("board", "old-key")).resolves.toMatchObject({ id: "legacy" });
  });

  it("refuses destructive inferred operations even if called outside the worker policy", async () => {
    const executor = new DeterministicTrelloExecutor(
      new TrelloClient({ apiKey: "key", token: "token", fetchImpl: async () => { throw new Error("network must not be reached"); } }),
    );
    await expect(executor.execute({
      task: { ...task, operation: "complete", candidateCardId: "card-1", authorization: "inferred" },
      idempotencyKey: "destructive",
      boardId: "board-1",
      listRoles: { inbox: "in", inProgress: "doing", paused: "paused", done: "done" },
      allowedCandidateCardIds: new Set(["card-1"]),
      allowedMemberIds: new Set(),
    })).rejects.toThrow("requires confirmation");
  });

  it("retries checklist effects after the card update already wrote Atlas-ID", async () => {
    let description = "Texto manual";
    let checklistAttempts = 0;
    const fakeClient = {
      getCard: vi.fn(async () => ({
        id: "card-1", name: "Antigo", desc: description, idList: "in", due: null,
        closed: false, url: "https://trello/card-1", idLabels: [], idMembers: ["manual-member"],
      })),
      resolveControlledLabelIds: vi.fn(async () => []),
      updateCard: vi.fn(async (_cardId: string, input: { description?: string }) => {
        description = input.description ?? description;
        return { id: "card-1", name: task.title, desc: description, idList: "in", due: null, closed: false, url: "https://trello/card-1" };
      }),
      syncAtlasChecklist: vi.fn(async () => {
        checklistAttempts += 1;
        if (checklistAttempts === 1) throw new Error("temporary checklist failure");
      }),
    } as unknown as TrelloClient;
    const executor = new DeterministicTrelloExecutor(fakeClient);
    const request = {
      task: { ...task, operation: "patch" as const, candidateCardId: "card-1" },
      idempotencyKey: "partial-1", boardId: "board-1",
      listRoles: { inbox: "in", inProgress: "doing", paused: "paused", done: "done" },
      allowedCandidateCardIds: new Set(["card-1"]), allowedMemberIds: new Set<string>(),
    };
    await expect(executor.execute(request)).rejects.toThrow("temporary checklist failure");
    await expect(executor.execute(request)).resolves.toMatchObject({ cardId: "card-1" });
    expect(fakeClient.updateCard).toHaveBeenCalledTimes(1);
    expect(fakeClient.syncAtlasChecklist).toHaveBeenCalledTimes(2);
  });

  it("replays merge sources with per-source markers after a partial failure", async () => {
    const comments = new Set<string>();
    let sourceTwoAttempts = 0;
    const mergeTask: AiTask = {
      ...task,
      operation: "merge",
      authorization: "confirmed_proposal",
      candidateCardId: "target",
      mergeSourceCardIds: ["source-1", "source-2"],
    };
    const fakeClient = {
      getCard: vi.fn(async () => ({
        id: "target", name: task.title, desc: "Atlas-ID: merge-1", idList: "in", due: null,
        closed: false, url: "https://trello/target", idLabels: [], idMembers: [],
      })),
      syncAtlasChecklist: vi.fn(async () => undefined),
      hasCommentWithAtlasId: vi.fn(async (cardId: string) => comments.has(cardId)),
      addComment: vi.fn(async (cardId: string) => {
        if (cardId === "source-2" && sourceTwoAttempts++ === 0) throw new Error("partial merge failure");
        comments.add(cardId);
        return { id: `comment-${cardId}` };
      }),
      updateCard: vi.fn(async (cardId: string) => ({ id: cardId, url: `https://trello/${cardId}` })),
    } as unknown as TrelloClient;
    const executor = new DeterministicTrelloExecutor(fakeClient);
    const request = {
      task: mergeTask, idempotencyKey: "merge-1", boardId: "board-1",
      listRoles: { inbox: "in", inProgress: "doing", paused: "paused", done: "done" },
      allowedCandidateCardIds: new Set(["target", "source-1", "source-2"]), allowedMemberIds: new Set<string>(),
    };
    await expect(executor.execute(request)).rejects.toThrow("partial merge failure");
    await expect(executor.execute(request)).resolves.toMatchObject({ cardId: "target" });
    expect(fakeClient.addComment).toHaveBeenCalledTimes(3);
    expect(comments).toEqual(new Set(["source-1", "source-2"]));
  });

  it("preserves manual members while applying only allowed member deltas", async () => {
    let projectedMembers: readonly string[] | undefined;
    const fakeClient = {
      getCard: vi.fn(async () => ({
        id: "card-1", name: "Tarefa", desc: "manual", idList: "in", due: null,
        closed: false, url: "https://trello/card-1", idLabels: [], idMembers: ["manual", "remove-me"],
      })),
      resolveControlledLabelIds: vi.fn(async () => []),
      updateCard: vi.fn(async (_cardId: string, input: { memberIds?: readonly string[]; description?: string }) => {
        projectedMembers = input.memberIds;
        return { id: "card-1", url: "https://trello/card-1", desc: input.description ?? "" };
      }),
      syncAtlasChecklist: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    const executor = new DeterministicTrelloExecutor(fakeClient);
    await executor.execute({
      task: { ...task, operation: "patch", candidateCardId: "card-1", memberIdsToAdd: ["atlas"], memberIdsToRemove: ["remove-me"] },
      idempotencyKey: "members-1", boardId: "board-1",
      listRoles: { inbox: "in", inProgress: "doing", paused: "paused", done: "done" },
      allowedCandidateCardIds: new Set(["card-1"]), allowedMemberIds: new Set(["atlas", "remove-me"]),
    });
    expect(projectedMembers).toEqual(["manual", "atlas"]);
  });

  it("reopens a completed card into an active list", async () => {
    let update: Record<string, unknown> | undefined;
    const fakeClient = {
      getCard: vi.fn(async () => ({
        id: "card-1", name: "Tarefa", desc: "manual", idList: "done", due: null,
        dueComplete: true, closed: true, url: "https://trello/card-1", idLabels: [], idMembers: [],
      })),
      resolveControlledLabelIds: vi.fn(async () => []),
      updateCard: vi.fn(async (_cardId: string, input: Record<string, unknown>) => {
        update = input;
        return { id: "card-1", url: "https://trello/card-1" };
      }),
      syncAtlasChecklist: vi.fn(async () => undefined),
    } as unknown as TrelloClient;
    await new DeterministicTrelloExecutor(fakeClient).execute({
      task: { ...task, operation: "reopen", candidateCardId: "card-1", targetListRole: "inbox" },
      idempotencyKey: "reopen-1", boardId: "board-1",
      listRoles: { inbox: "inbox", inProgress: "doing", paused: "paused", done: "done" },
      allowedCandidateCardIds: new Set(["card-1"]), allowedMemberIds: new Set(),
    });
    expect(update).toMatchObject({ listId: "inbox", dueComplete: false, closed: false });
  });
});
