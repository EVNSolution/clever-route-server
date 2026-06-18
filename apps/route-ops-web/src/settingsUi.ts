import type { RouteOpsUiReminderPlanDto, RouteOpsUiSettingsDto } from "./types";

export type TemplateVariableKey =
  | "customerName"
  | "orderNumber"
  | "deliveryDate"
  | "deliveryWeekday"
  | "eta"
  | "storeName"
  | "deliveryAddress";

export type TemplateVariableMetadata = {
  example: string;
  key: TemplateVariableKey;
  label: string;
};

export const TEMPLATE_VARIABLES: TemplateVariableMetadata[] = [
  { example: "Jane Kim", key: "customerName", label: "Customer name" },
  { example: "#1042", key: "orderNumber", label: "Order number" },
  { example: "2026-06-20", key: "deliveryDate", label: "Delivery date" },
  { example: "Saturday", key: "deliveryWeekday", label: "Delivery weekday" },
  { example: "4:30 PM", key: "eta", label: "ETA" },
  { example: "Tomatono Food", key: "storeName", label: "Store name" },
  {
    example: "123 Depot St, Toronto",
    key: "deliveryAddress",
    label: "Delivery address",
  },
];

const TEMPLATE_VARIABLE_SET = new Set(
  TEMPLATE_VARIABLES.map((item) => item.key),
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
  value: RouteOpsUiSettingsDto | null | undefined,
): RouteOpsUiSettingsDto {
  const defaults = defaultRouteOpsUiSettings();
  if (value === null || value === undefined || value.version !== 1)
    return defaults;
  return {
    destinationDwellMinutes: Number.isInteger(value.destinationDwellMinutes)
      ? value.destinationDwellMinutes
      : null,
    emailNotifications: {
      enabled: value.emailNotifications.enabled,
      reminderPlans: value.emailNotifications.reminderPlans.map((plan) => ({
        ...plan,
      })),
      template: {
        body: value.emailNotifications.template.body,
        subject: value.emailNotifications.template.subject,
      },
    },
    version: 1,
  };
}

export function createReminderPlan(
  existing: RouteOpsUiReminderPlanDto[],
): RouteOpsUiReminderPlanDto {
  for (let daysBefore = 1; daysBefore <= 30; daysBefore += 1) {
    const candidate = {
      daysBefore,
      id: createReminderId(),
      timeOfDay: "09:00",
    };
    if (!hasReminderDuplicate([...existing, candidate])) return candidate;
  }
  return { daysBefore: 0, id: createReminderId(), timeOfDay: "09:00" };
}

export function hasReminderDuplicate(
  plans: RouteOpsUiReminderPlanDto[],
): boolean {
  const seen = new Set<string>();
  for (const plan of plans) {
    const key = `${plan.daysBefore}|${plan.timeOfDay}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function listUnknownTemplateTokens(value: string): string[] {
  const unknown = new Set<string>();
  for (const match of value.matchAll(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu,
  )) {
    const token = match[1];
    if (
      token !== undefined &&
      !TEMPLATE_VARIABLE_SET.has(token as TemplateVariableKey)
    )
      unknown.add(token);
  }
  return [...unknown].sort();
}

export function insertTemplateToken(
  value: string,
  token: TemplateVariableKey,
): string {
  const suffix = value.endsWith(" ") || value.length === 0 ? "" : " ";
  return `${value}${suffix}{{${token}}}`;
}

function createReminderId(): string {
  return `reminder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
