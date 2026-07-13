export interface WhatsAppPairingResult {
  status: 'pairing' | 'connected' | 'error';
  qrDataUrl?: string | null;
  expiresAt?: Date | null;
  phoneNumber?: string | null;
  error?: string | null;
}

export interface WhatsAppChat {
  jid: string;
  name: string;
  isGroup: boolean;
  lastMessageAt?: string | null;
}

export interface WhatsAppAdapter {
  beginPairing(input: { userId: string; connectionId: string }): Promise<WhatsAppPairingResult>;
  readSession(input: { userId: string; connectionId: string }): Promise<WhatsAppPairingResult | null>;
  disconnect(input: { userId: string; connectionId: string }): Promise<void>;
  listChats(input: { userId: string; connectionId: string }): Promise<WhatsAppChat[]>;
}

export class QueuedWhatsAppAdapter implements WhatsAppAdapter {
  async beginPairing(): Promise<WhatsAppPairingResult> {
    return { status: 'pairing', qrDataUrl: null, expiresAt: null };
  }

  async readSession(): Promise<WhatsAppPairingResult | null> {
    return null;
  }

  async disconnect(): Promise<void> {}

  async listChats(): Promise<WhatsAppChat[]> {
    return [];
  }
}

export class HttpWhatsAppAdapter implements WhatsAppAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers: { ...this.headers(), ...init.headers } });
    if (!response.ok) throw new Error(`WhatsApp service returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  beginPairing(input: { userId: string; connectionId: string }): Promise<WhatsAppPairingResult> {
    return this.json('/sessions', { method: 'POST', body: JSON.stringify(input) });
  }

  readSession(input: { userId: string; connectionId: string }): Promise<WhatsAppPairingResult | null> {
    return this.json(`/sessions/${encodeURIComponent(input.connectionId)}?userId=${encodeURIComponent(input.userId)}`);
  }

  async disconnect(input: { userId: string; connectionId: string }): Promise<void> {
    await this.json(`/sessions/${encodeURIComponent(input.connectionId)}/disconnect`, {
      method: 'POST', body: JSON.stringify({ userId: input.userId }),
    });
  }

  listChats(input: { userId: string; connectionId: string }): Promise<WhatsAppChat[]> {
    return this.json(`/sessions/${encodeURIComponent(input.connectionId)}/chats?userId=${encodeURIComponent(input.userId)}`);
  }
}

export interface TrelloMember {
  id: string;
  username?: string;
  fullName?: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url?: string;
  closed?: boolean;
}

export interface TrelloList {
  id: string;
  name: string;
  closed?: boolean;
  pos?: number;
}

export interface TrelloAdapter {
  verify(token: string): Promise<TrelloMember>;
  listBoards(token: string): Promise<TrelloBoard[]>;
  listLists(token: string, boardId: string): Promise<TrelloList[]>;
}

export class ServerKeyTrelloAdapter implements TrelloAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, token: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('token', token);
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Trello returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  verify(token: string): Promise<TrelloMember> {
    return this.request('/members/me?fields=id,username,fullName', token);
  }

  listBoards(token: string): Promise<TrelloBoard[]> {
    return this.request('/members/me/boards?fields=id,name,url,closed&filter=open', token);
  }

  listLists(token: string, boardId: string): Promise<TrelloList[]> {
    return this.request(`/boards/${encodeURIComponent(boardId)}/lists?fields=id,name,closed,pos&filter=open`, token);
  }
}
