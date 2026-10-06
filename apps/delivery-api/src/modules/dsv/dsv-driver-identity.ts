export function normalizeDsvDriverLoginId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDsvDriverPhone(value: string): string {
  return value.replace(/\D/gu, '');
}
