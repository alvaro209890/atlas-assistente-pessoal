import { BaileysSessionManager } from "./whatsapp.js";

export type NotificationKind =
  | "task_created"
  | "task_updated"
  | "needs_review"
  | "reply_suggestion"
  | "brief"
  | "reminder"
  | "integration_error";

export interface Notification {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  links?: readonly { label: string; url: string }[];
}

export interface NotificationReceipt {
  channel: string;
  externalMessageId: string;
}

export interface NotificationChannel {
  readonly kind: string;
  send(notification: Notification): Promise<NotificationReceipt>;
}

export class WhatsAppSelfNotificationChannel implements NotificationChannel {
  readonly kind = "primary_self";

  constructor(private readonly sessions: BaileysSessionManager) {}

  async send(notification: Notification): Promise<NotificationReceipt> {
    const links = notification.links?.length
      ? `\n\n${notification.links.map((link) => `${link.label}: ${link.url}`).join("\n")}`
      : "";
    const externalMessageId = await this.sessions.sendSelf(
      notification.userId,
      `🧠 *${notification.title}*\n${notification.body}${links}`,
    );
    return { channel: this.kind, externalMessageId };
  }
}
