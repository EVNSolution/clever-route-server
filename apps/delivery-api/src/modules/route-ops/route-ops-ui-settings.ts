export type RouteOpsUiReminderPlanDto = {
  daysBefore: number;
  id: string;
  timeOfDay: string;
};

export type RouteOpsUiSettingsDto = {
  destinationDwellMinutes: number | null;
  emailNotifications: {
    enabled: boolean;
    reminderPlans: RouteOpsUiReminderPlanDto[];
    template: {
      body: string;
      subject: string;
    };
  };
  version: 1;
};

export const ROUTE_OPS_TEMPLATE_VARIABLES = [
  "customerName",
  "orderNumber",
  "deliveryDate",
  "deliveryWeekday",
  "eta",
  "storeName",
  "deliveryAddress",
] as const;

const ROUTE_OPS_TEMPLATE_VARIABLE_SET = new Set<string>(
  ROUTE_OPS_TEMPLATE_VARIABLES,
);

export function defaultRouteOpsUiSettings(): RouteOpsUiSettingsDto {
  return {
    destinationDwellMinutes: null,
    emailNotifications: {
      enabled: false,
      reminderPlans: [],
      template: {
        body: "",
        subject: "",
      },
    },
    version: 1,
  };
}

export function normalizeRouteOpsUiSettings(
  value: unknown,
): RouteOpsUiSettingsDto {
  if (value === null || value === undefined) return defaultRouteOpsUiSettings();
  return validateRouteOpsUiSettingsPayload(value);
}

export function validateRouteOpsUiSettingsPayload(
  value: unknown,
): RouteOpsUiSettingsDto {
  if (!isRecord(value)) {
    throw new Error("Route Ops UI settings must be an object.");
  }
  if (value.version !== 1) {
    throw new Error("Route Ops UI settings version must be 1.");
  }
  const destinationDwellMinutes = readNullableIntegerInRange(
    value.destinationDwellMinutes,
    0,
    240,
    "Destination dwell minutes",
  );
  const emailNotifications = value.emailNotifications;
  if (!isRecord(emailNotifications)) {
    throw new Error("Email notification settings must be an object.");
  }
  if (typeof emailNotifications.enabled !== "boolean") {
    throw new Error("Email notification enabled flag must be boolean.");
  }
  const reminderPlans = readReminderPlans(emailNotifications.reminderPlans);
  const template = readTemplate(emailNotifications.template);
  return {
    destinationDwellMinutes,
    emailNotifications: {
      enabled: emailNotifications.enabled,
      reminderPlans,
      template,
    },
    version: 1,
  };
}

function readReminderPlans(value: unknown): RouteOpsUiReminderPlanDto[] {
  if (!Array.isArray(value)) {
    throw new Error("Reminder plans must be an array.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Reminder plan ${index + 1} must be an object.`);
    }
    const id = readString(entry.id, `Reminder plan ${index + 1} id`);
    const daysBefore = readIntegerInRange(
      entry.daysBefore,
      0,
      30,
      `Reminder plan ${index + 1} daysBefore`,
    );
    const timeOfDay = readTimeOfDay(
      entry.timeOfDay,
      `Reminder plan ${index + 1} timeOfDay`,
    );
    const key = `${daysBefore}|${timeOfDay}`;
    if (seen.has(key)) {
      throw new Error(
        "Reminder plans cannot duplicate daysBefore and timeOfDay.",
      );
    }
    seen.add(key);
    return { daysBefore, id, timeOfDay };
  });
}

function readTemplate(value: unknown): { body: string; subject: string } {
  if (!isRecord(value)) {
    throw new Error("Email template must be an object.");
  }
  const subject = readString(value.subject, "Email template subject");
  const body = readString(value.body, "Email template body");
  assertAllowedTemplateTokens(subject);
  assertAllowedTemplateTokens(body);
  return { body, subject };
}

function assertAllowedTemplateTokens(value: string): void {
  for (const match of value.matchAll(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu,
  )) {
    const token = match[1];
    if (token === undefined || !ROUTE_OPS_TEMPLATE_VARIABLE_SET.has(token)) {
      throw new Error(`Unsupported template variable: ${token ?? "unknown"}.`);
    }
  }
}

function readNullableIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  return readIntegerInRange(value, min, max, label);
}

function readIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function readTimeOfDay(value: unknown, label: string): string {
  const timeOfDay = readString(value, label);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
    throw new Error(`${label} must use HH:mm from 00:00 through 23:59.`);
  }
  return timeOfDay;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
