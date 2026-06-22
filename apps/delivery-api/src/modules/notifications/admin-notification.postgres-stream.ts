import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';

import { Client } from 'pg';

import type { AdminNotificationChangePublisher } from './admin-notification.service.js';
import type { AdminNotificationStreamHub } from './admin-notification.stream.js';

const DEFAULT_CHANNEL = 'clever_route_admin_notifications_changed';

type PgNotification = {
  channel: string;
  payload?: string;
};

type PgClientLike = EventEmitter & {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<unknown>;
};

type LoggerLike = {
  error?(bindings: unknown, message?: string): void;
  info?(bindings: unknown, message?: string): void;
  warn?(bindings: unknown, message?: string): void;
};

type AdminNotificationPostgresPayload = {
  notificationId: string;
  occurredAt: string;
  originId: string;
  shopId: string;
  type: 'notifications_changed';
};

export class PostgresAdminNotificationStreamBridge
  implements AdminNotificationChangePublisher
{
  private listenClient: PgClientLike | null = null;
  private notifyClient: PgClientLike | null = null;
  private readonly originId: string;
  private started = false;

  constructor(
    private readonly input: {
      channel?: string | undefined;
      clientFactory?: (() => PgClientLike) | undefined;
      connectionString: string;
      logger?: LoggerLike | undefined;
      streamHub: AdminNotificationStreamHub;
    },
  ) {
    this.originId = randomUUID();
  }

  async start(): Promise<void> {
    if (this.started) return;
    const listenClient = this.createClient();
    const notifyClient = this.createClient();

    listenClient.on('notification', (message: PgNotification) => {
      this.handleNotification(message);
    });
    listenClient.on('error', (error: unknown) => {
      this.input.logger?.error?.(
        { error },
        'admin notification postgres listener connection error',
      );
    });

    await listenClient.connect();
    await listenClient.query(`LISTEN ${this.channel}`);
    await notifyClient.connect();

    this.listenClient = listenClient;
    this.notifyClient = notifyClient;
    this.started = true;
    this.input.logger?.info?.(
      { channel: this.channel },
      'admin notification postgres stream bridge started',
    );
  }

  async close(): Promise<void> {
    const clients = [this.listenClient, this.notifyClient].filter(
      (client): client is PgClientLike => client !== null,
    );
    this.listenClient = null;
    this.notifyClient = null;
    this.started = false;
    await Promise.allSettled(clients.map((client) => client.end()));
  }

  async publishNotificationsChanged(input: {
    notificationId: string;
    occurredAt?: Date;
    shopId: string;
  }): Promise<void> {
    if (!this.started || this.notifyClient === null) {
      this.input.streamHub.publishNotificationsChanged(input);
      return;
    }

    const payload: AdminNotificationPostgresPayload = {
      notificationId: input.notificationId,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      originId: this.originId,
      shopId: input.shopId,
      type: 'notifications_changed',
    };

    await this.notifyClient.query('SELECT pg_notify($1, $2)', [
      this.channel,
      JSON.stringify(payload),
    ]);
  }

  private handleNotification(message: PgNotification): void {
    if (message.channel !== this.channel || message.payload === undefined) return;

    const payload = parsePayload(message.payload);
    if (payload === null) {
      this.input.logger?.warn?.(
        { channel: message.channel },
        'ignored malformed admin notification postgres payload',
      );
      return;
    }

    this.input.streamHub.publishNotificationsChanged({
      notificationId: payload.notificationId,
      occurredAt: new Date(payload.occurredAt),
      shopId: payload.shopId,
    });
  }

  private createClient(): PgClientLike {
    if (this.input.clientFactory !== undefined) return this.input.clientFactory();
    return new Client({ connectionString: this.input.connectionString });
  }

  private get channel(): string {
    return this.input.channel ?? DEFAULT_CHANNEL;
  }
}

function parsePayload(raw: string): AdminNotificationPostgresPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AdminNotificationPostgresPayload>;
    if (
      parsed.type !== 'notifications_changed' ||
      typeof parsed.notificationId !== 'string' ||
      typeof parsed.shopId !== 'string' ||
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.originId !== 'string'
    ) {
      return null;
    }
    return {
      notificationId: parsed.notificationId,
      occurredAt: parsed.occurredAt,
      originId: parsed.originId,
      shopId: parsed.shopId,
      type: 'notifications_changed',
    };
  } catch {
    return null;
  }
}
