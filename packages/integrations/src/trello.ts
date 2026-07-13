import type { AiTask } from "@atlas/shared";

import { IntegrationError } from "./errors.js";

const TRELLO_API_BASE_URL = "https://api.trello.com/1";
const TRELLO_AUTHORIZE_URL = "https://trello.com/1/authorize";
const CONTROLLED_LABEL_PREFIX = "Atlas: ";

export const ATLAS_MANAGED_BLOCK_START = "<!-- ATLAS:BEGIN -->";
export const ATLAS_MANAGED_BLOCK_END = "<!-- ATLAS:END -->";

export interface TrelloAuthorizationOptions {
  apiKey: string;
  applicationName?: string;
  returnUrl: string;
  state: string;
  expiration?: "1hour" | "1day" | "2days" | "never";
  scope?: readonly ("read" | "write" | "account")[];
}

export function buildTrelloAuthorizationUrl(options: TrelloAuthorizationOptions): string {
  const url = new URL(TRELLO_AUTHORIZE_URL);
  url.searchParams.set("expiration", options.expiration ?? "never");
  url.searchParams.set("name", options.applicationName ?? "Atlas");
  url.searchParams.set("scope", (options.scope ?? ["read", "write"]).join(","));
  url.searchParams.set("response_type", "token");
  url.searchParams.set("key", options.apiKey);
  url.searchParams.set("return_url", options.returnUrl);
  url.searchParams.set("callback_method", "fragment");
  url.searchParams.set("state", options.state);
  return url.toString();
}

export interface TrelloMember { id: string; username: string; fullName: string }
export interface TrelloBoard { id: string; name: string; closed: boolean; url: string }
export interface TrelloList { id: string; name: string; closed: boolean }
export interface TrelloLabel { id: string; name: string; color: string | null }
export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  due: string | null;
  dueComplete?: boolean;
  closed: boolean;
  url: string;
  idLabels?: string[];
  labels?: TrelloLabel[];
  idMembers?: string[];
  dateLastActivity?: string;
}
export interface TrelloChecklistItem {
  id: string;
  name: string;
  state: "complete" | "incomplete";
}
export interface TrelloChecklist {
  id: string;
  name: string;
  checkItems?: TrelloChecklistItem[];
}

export interface TrelloClientConfig {
  apiKey: string;
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TrelloClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: TrelloClientConfig) {
    this.baseUrl = config.baseUrl ?? TRELLO_API_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("key", this.config.apiKey);
    url.searchParams.set("token", this.config.token);
    const response = await this.fetchImpl(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new IntegrationError(
        `Trello ${method} ${path} failed (${response.status}): ${detail.slice(0, 300)}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    return (await response.json()) as T;
  }

  getCurrentMember(): Promise<TrelloMember> {
    return this.request("GET", "/members/me?fields=id,username,fullName");
  }
  getOpenBoards(): Promise<TrelloBoard[]> {
    return this.request("GET", "/members/me/boards?filter=open&fields=id,name,closed,url");
  }
  getOpenLists(boardId: string): Promise<TrelloList[]> {
    return this.request("GET", `/boards/${encodeURIComponent(boardId)}/lists?filter=open`);
  }
  getOpenCards(boardId: string): Promise<TrelloCard[]> {
    return this.request("GET", `/boards/${encodeURIComponent(boardId)}/cards?filter=open&fields=id,name,desc,idList,due,dueComplete,closed,url,idLabels,idMembers,dateLastActivity&labels=all&label_fields=id,name,color`);
  }
  getCard(cardId: string): Promise<TrelloCard> {
    return this.request("GET", `/cards/${encodeURIComponent(cardId)}?fields=id,name,desc,idList,due,dueComplete,closed,url,idLabels,idMembers,dateLastActivity&labels=all&label_fields=id,name,color`);
  }
  getBoardMembers(boardId: string): Promise<TrelloMember[]> {
    return this.request("GET", `/boards/${encodeURIComponent(boardId)}/members?fields=id,username,fullName`);
  }

  async findCardByAtlasId(boardId: string, idempotencyKey: string): Promise<TrelloCard | null> {
    const atlasMarker = `Atlas-ID: ${idempotencyKey}`;
    const legacyMarker = `Nexo-ID: ${idempotencyKey}`;
    const cards = await this.getOpenCards(boardId);
    return cards.find((card) => card.desc.includes(atlasMarker) || card.desc.includes(legacyMarker)) ?? null;
  }

  async hasCommentWithAtlasId(cardId: string, idempotencyKey: string): Promise<boolean> {
    const actions = await this.request<Array<{ data?: { text?: string } }>>(
      "GET",
      `/cards/${encodeURIComponent(cardId)}/actions?filter=commentCard&limit=1000`,
    );
    return actions.some((action) => action.data?.text?.includes(`Atlas-ID: ${idempotencyKey}`) === true);
  }

  createCard(input: {
    listId: string;
    name: string;
    description: string;
    dueAt: string | null;
    labelIds?: readonly string[];
    memberIds?: readonly string[];
    dueComplete?: boolean;
  }): Promise<TrelloCard> {
    return this.request("POST", "/cards", {
      idList: input.listId,
      name: input.name,
      desc: input.description,
      ...(input.dueAt ? { due: input.dueAt } : {}),
      ...(input.labelIds?.length ? { idLabels: input.labelIds } : {}),
      ...(input.memberIds?.length ? { idMembers: input.memberIds } : {}),
      dueComplete: input.dueComplete ?? false,
    });
  }

  updateCard(cardId: string, input: {
    name?: string;
    description?: string;
    dueAt?: string | null;
    listId?: string;
    labelIds?: readonly string[];
    memberIds?: readonly string[];
    dueComplete?: boolean;
    closed?: boolean;
  }): Promise<TrelloCard> {
    return this.request("PUT", `/cards/${encodeURIComponent(cardId)}`, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { desc: input.description } : {}),
      ...(input.dueAt !== undefined ? { due: input.dueAt } : {}),
      ...(input.listId !== undefined ? { idList: input.listId } : {}),
      ...(input.labelIds !== undefined ? { idLabels: input.labelIds } : {}),
      ...(input.memberIds !== undefined ? { idMembers: input.memberIds } : {}),
      ...(input.dueComplete !== undefined ? { dueComplete: input.dueComplete } : {}),
      ...(input.closed !== undefined ? { closed: input.closed } : {}),
    });
  }

  addComment(cardId: string, text: string): Promise<{ id: string }> {
    return this.request("POST", `/cards/${encodeURIComponent(cardId)}/actions/comments`, { text });
  }
  getLabels(boardId: string): Promise<TrelloLabel[]> {
    return this.request("GET", `/boards/${encodeURIComponent(boardId)}/labels?limit=1000`);
  }
  createLabel(boardId: string, name: string): Promise<TrelloLabel> {
    return this.request("POST", "/labels", { idBoard: boardId, name, color: null });
  }

  async resolveLabelIds(boardId: string, names: readonly string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const existing = await this.getLabels(boardId);
    const byName = new Map(existing.map((label) => [label.name.toLocaleLowerCase("pt-BR"), label.id]));
    const result: string[] = [];
    for (const name of [...new Set(names.map((item) => item.trim()).filter(Boolean))]) {
      const key = name.toLocaleLowerCase("pt-BR");
      let id = byName.get(key);
      if (!id) {
        const created = await this.createLabel(boardId, name);
        id = created.id;
        byName.set(key, id);
      }
      result.push(id);
    }
    return result;
  }

  async resolveControlledLabelIds(
    boardId: string,
    existingLabelIds: readonly string[],
    namesToAdd: readonly string[],
    namesToRemove: readonly string[],
  ): Promise<string[]> {
    const labels = await this.getLabels(boardId);
    const byId = new Map(labels.map((label) => [label.id, label]));
    const remove = new Set(namesToRemove.map((name) => name.trim().toLocaleLowerCase("pt-BR")));
    const preserved = existingLabelIds.filter((id) => {
      const name = byId.get(id)?.name;
      if (!name?.startsWith(CONTROLLED_LABEL_PREFIX)) return true;
      return !remove.has(name.slice(CONTROLLED_LABEL_PREFIX.length).toLocaleLowerCase("pt-BR"));
    });
    const additions = await this.resolveLabelIds(
      boardId,
      namesToAdd.map((name) => `${CONTROLLED_LABEL_PREFIX}${name.trim()}`).filter((name) => name !== CONTROLLED_LABEL_PREFIX),
    );
    return [...new Set([...preserved, ...additions])];
  }

  getChecklists(cardId: string): Promise<TrelloChecklist[]> {
    return this.request("GET", `/cards/${encodeURIComponent(cardId)}/checklists?checkItems=all&checkItem_fields=name,state`);
  }
  createChecklist(cardId: string): Promise<TrelloChecklist> {
    return this.request("POST", `/cards/${encodeURIComponent(cardId)}/checklists`, { name: "Atlas" });
  }
  addChecklistItem(checklistId: string, name: string, done: boolean): Promise<TrelloChecklistItem> {
    return this.request("POST", `/checklists/${encodeURIComponent(checklistId)}/checkItems`, { name, checked: done });
  }
  updateChecklistItem(cardId: string, itemId: string, done: boolean): Promise<TrelloChecklistItem> {
    return this.request("PUT", `/cards/${encodeURIComponent(cardId)}/checkItem/${encodeURIComponent(itemId)}`, { state: done ? "complete" : "incomplete" });
  }

  async syncAtlasChecklist(cardId: string, desired: readonly { text: string; done: boolean }[]): Promise<void> {
    if (desired.length === 0) return;
    const checklists = await this.getChecklists(cardId);
    let checklist = checklists.find((item) => item.name === "Atlas");
    if (!checklist) checklist = await this.createChecklist(cardId);
    const existing = new Map((checklist.checkItems ?? []).map((item) => [item.name.trim().toLocaleLowerCase("pt-BR"), item]));
    for (const item of desired) {
      const current = existing.get(item.text.trim().toLocaleLowerCase("pt-BR"));
      if (!current) await this.addChecklistItem(checklist.id, item.text, item.done);
      else if ((current.state === "complete") !== item.done) await this.updateChecklistItem(cardId, current.id, item.done);
    }
  }
}

export interface TrelloListRoleMap {
  inbox: string;
  inProgress: string;
  paused: string;
  done: string;
}
export interface TrelloExecutionRequest {
  task: AiTask;
  idempotencyKey: string;
  boardId: string;
  listRoles: TrelloListRoleMap;
  allowedCandidateCardIds: ReadonlySet<string>;
  allowedMemberIds: ReadonlySet<string>;
}
export interface TrelloExecutionResult {
  cardId: string;
  cardUrl: string | null;
  operation: AiTask["operation"];
}

export function replaceAtlasManagedBlock(description: string, managedBlock: string): string {
  const withoutPrevious = description
    .replace(/<!-- ATLAS:BEGIN -->[\s\S]*?<!-- ATLAS:END -->/g, "")
    .trimEnd();
  return `${withoutPrevious}${withoutPrevious ? "\n\n" : ""}${managedBlock}`;
}

export function buildAtlasManagedBlock(task: AiTask, idempotencyKey: string): string {
  return [
    ATLAS_MANAGED_BLOCK_START,
    "### Atlas",
    task.description ? `Contexto: ${task.description}` : null,
    task.nextAction ? `Próxima ação: ${task.nextAction}` : null,
    task.waitingOn ? `Aguardando: ${task.waitingOn}` : null,
    task.project ? `Projeto: ${task.project}` : null,
    task.person ? `Pessoa: ${task.person}` : null,
    task.estimateMinutes ? `Estimativa: ${task.estimateMinutes} min` : null,
    task.recurrence ? `Recorrência: ${task.recurrence}` : null,
    `Prioridade: ${task.priority}`,
    `Risco: ${task.risk}`,
    `Atlas-ID: ${idempotencyKey}`,
    ATLAS_MANAGED_BLOCK_END,
  ].filter((line): line is string => line !== null).join("\n");
}

export class DeterministicTrelloExecutor {
  constructor(private readonly client: TrelloClient) {}

  private async syncSecondaryEffects(
    request: TrelloExecutionRequest,
    cardId: string,
    cardUrl: string,
  ): Promise<void> {
    await this.client.syncAtlasChecklist(cardId, request.task.checklist);
    if (request.task.operation !== "merge") return;
    for (const sourceCardId of request.task.mergeSourceCardIds) {
      const sourceKey = `${request.idempotencyKey}:merge-source:${sourceCardId}`;
      if (!await this.client.hasCommentWithAtlasId(sourceCardId, sourceKey)) {
        await this.client.addComment(sourceCardId, `Mesclado em ${cardUrl}\n\nAtlas-ID: ${sourceKey}`);
      }
      await this.client.updateCard(sourceCardId, { closed: true });
    }
  }

  async execute(request: TrelloExecutionRequest): Promise<TrelloExecutionResult> {
    const { task } = request;
    const memberIdsToAdd = task.memberIdsToAdd ?? [];
    const memberIdsToRemove = task.memberIdsToRemove ?? [];
    const allowedMemberIds = request.allowedMemberIds ?? new Set<string>();
    if (task.operation === "ignore") throw new IntegrationError("Ignored task cannot be executed", false);
    if (["complete", "cancel", "merge"].includes(task.operation) && task.authorization === "inferred") {
      throw new IntegrationError("Destructive inferred Trello action requires confirmation", false);
    }
    for (const memberId of [...memberIdsToAdd, ...memberIdsToRemove]) {
      if (!allowedMemberIds.has(memberId)) {
        throw new IntegrationError("AI selected a Trello member outside the supplied members", false);
      }
    }
    const managedBlock = buildAtlasManagedBlock(task, request.idempotencyKey);

    if (task.operation === "create") {
      const recovered = await this.client.findCardByAtlasId(request.boardId, request.idempotencyKey);
      if (recovered) {
        await this.syncSecondaryEffects(request, recovered.id, recovered.url);
        return { cardId: recovered.id, cardUrl: recovered.url, operation: task.operation };
      }
      const labelIds = await this.client.resolveLabelIds(
        request.boardId,
        task.labels.map((name) => `${CONTROLLED_LABEL_PREFIX}${name}`),
      );
      const card = await this.client.createCard({
        listId: request.listRoles[task.targetListRole],
        name: task.title,
        description: managedBlock,
        dueAt: task.dueAt,
        labelIds,
        memberIds: memberIdsToAdd,
      });
      await this.syncSecondaryEffects(request, card.id, card.url);
      return { cardId: card.id, cardUrl: card.url, operation: task.operation };
    }

    const cardId = task.candidateCardId;
    if (!cardId || !request.allowedCandidateCardIds.has(cardId)) {
      throw new IntegrationError("AI selected a Trello card outside the supplied candidates", false);
    }
    if (task.operation === "merge" && task.mergeSourceCardIds.some((id) => id === cardId || !request.allowedCandidateCardIds.has(id))) {
      throw new IntegrationError("AI selected an invalid merge source", false);
    }
    const existing = await this.client.getCard(cardId);
    if (task.operation === "comment") {
      if (!await this.client.hasCommentWithAtlasId(cardId, request.idempotencyKey)) {
        await this.client.addComment(cardId, `${task.description || task.title}\n\nAtlas-ID: ${request.idempotencyKey}`);
      }
      return { cardId, cardUrl: existing.url, operation: task.operation };
    }
    if (existing.desc.includes(`Atlas-ID: ${request.idempotencyKey}`)) {
      await this.syncSecondaryEffects(request, cardId, existing.url);
      return { cardId, cardUrl: existing.url, operation: task.operation };
    }

    const labelIds = await this.client.resolveControlledLabelIds(
      request.boardId,
      existing.idLabels ?? [],
      task.labels,
      task.labelsToRemove,
    );
    const memberIds = memberIdsToAdd.length || memberIdsToRemove.length
      ? [...new Set([
          ...(existing.idMembers ?? []).filter((id) => !memberIdsToRemove.includes(id)),
          ...memberIdsToAdd,
        ])]
      : undefined;
    const card = await this.client.updateCard(cardId, {
      name: task.title,
      description: replaceAtlasManagedBlock(existing.desc, managedBlock),
      dueAt: task.dueAt,
      listId: task.operation === "complete" ? request.listRoles.done : request.listRoles[task.targetListRole],
      labelIds,
      ...(memberIds ? { memberIds } : {}),
      ...(task.operation === "complete" ? { dueComplete: true } : task.operation === "reopen" ? { dueComplete: false } : {}),
      closed: task.operation === "cancel" ? true : task.operation === "reopen" ? false : existing.closed,
    });
    await this.syncSecondaryEffects(request, cardId, card.url);
    return { cardId: card.id, cardUrl: card.url, operation: task.operation };
  }
}
